import type { Database } from '../../shared/db/pool.ts';
import { withTransaction } from '../../shared/db/pool.ts';
import { logError } from '../../shared/logging/logger.ts';

/**
 * Доставка сообщений в Telegram (T-02b, часть 2; docs/01, раздел 6, пункт 6).
 *
 * Telegram не даёт гарантии «ровно один раз», и мы её не изобретаем. Таймаут
 * запроса может означать уже доставленное сообщение, поэтому «неизвестно» —
 * отдельное состояние, а не разновидность неудачи, и вслепую оно не
 * повторяется. Повтор неизвестного исхода — это второе сообщение человеку за
 * одно событие.
 *
 * Порядок записи и запроса тоже не случаен: состояние `sending` фиксируется
 * **до** обращения к Telegram и отдельной транзакцией. Пометка после запроса
 * теряет факт попытки при падении процесса, и сообщение уходит второй раз.
 */

export type TransportResult =
  | { readonly outcome: 'sent'; readonly messageId: number }
  | {
      readonly outcome: 'rejected';
      readonly code: string;
      readonly retryable: boolean;
      readonly retryAfterSeconds?: number;
    }
  /** Запрос оборвался: доставка не подтверждена и не опровергнута. */
  | { readonly outcome: 'unknown'; readonly code: string };

export interface TelegramTransport {
  sendMessage(chatId: string, text: string): Promise<TransportResult>;
}

export interface DeliveryOptions {
  readonly limit?: number;
}

export interface DeliveryResult {
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  readonly unknown: number;
}

const DEFAULT_LIMIT = 10;

/**
 * Сколько ждать, прежде чем считать отправку оборванной. Запрос к Telegram
 * укладывается в секунды; несколько минут — это уже умерший процесс.
 */
const STUCK_SENDING_MINUTES = 5;

interface ClaimedMessage {
  readonly id: string;
  readonly chat_id: string;
  readonly body: string;
  readonly attempts: number;
  readonly max_attempts: number;
}

/**
 * Один проход доставки.
 *
 * Сообщения берутся `FOR UPDATE SKIP LOCKED`, помечаются `sending` и
 * фиксируются — только потом идёт запрос. Запрос делается вне транзакции:
 * транзакция, открытая на время внешнего вызова, держит соединение всё это
 * время, а вызов всё равно может не завершиться.
 */
export async function deliverPendingMessages(
  db: Database,
  transport: TelegramTransport,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  const claimed = await withTransaction(db, async (client) => {
    const result = await client.query<ClaimedMessage>(
      `UPDATE telegram_messages SET
         state = 'sending',
         attempts = attempts + 1,
         sending_since = now(),
         updated_at = now()
       WHERE id IN (
         SELECT id FROM telegram_messages
          WHERE state = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            AND attempts < max_attempts
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, chat_id, body, attempts, max_attempts`,
      [limit],
    );
    return result.rows;
  });

  let sent = 0;
  let retried = 0;
  let failed = 0;
  let unknown = 0;

  for (const message of claimed) {
    let outcome: TransportResult;
    try {
      outcome = await transport.sendMessage(message.chat_id, message.body);
    } catch (error) {
      // Исключение транспорта — это тоже неизвестный исход: запрос мог уйти.
      logError('telegram_send_failed', error, { job_id: message.id });
      outcome = { outcome: 'unknown', code: 'transport_error' };
    }

    if (outcome.outcome === 'sent') {
      await db.query(
        `UPDATE telegram_messages SET state = 'sent', telegram_message_id = $2,
                sending_since = NULL, updated_at = now()
          WHERE id = $1`,
        [message.id, outcome.messageId],
      );
      sent += 1;
      continue;
    }

    if (outcome.outcome === 'unknown') {
      await db.query(
        `UPDATE telegram_messages SET state = 'unknown', last_error_code = $2,
                sending_since = NULL, updated_at = now()
          WHERE id = $1`,
        [message.id, outcome.code],
      );
      unknown += 1;
      continue;
    }

    // Отказ с ответом Telegram: он либо просит подождать, либо сообщает, что
    // повторять бессмысленно.
    const exhausted = message.attempts >= message.max_attempts;
    if (!outcome.retryable || exhausted) {
      await db.query(
        `UPDATE telegram_messages SET state = 'failed', last_error_code = $2,
                sending_since = NULL, updated_at = now()
          WHERE id = $1`,
        [message.id, outcome.code],
      );
      failed += 1;
      continue;
    }

    await db.query(
      `UPDATE telegram_messages SET state = 'pending', last_error_code = $2,
              next_attempt_at = now() + make_interval(secs => $3::double precision),
              sending_since = NULL, updated_at = now()
        WHERE id = $1`,
      [message.id, outcome.code, outcome.retryAfterSeconds ?? 1],
    );
    retried += 1;
  }

  return { sent, retried, failed, unknown };
}

/**
 * Оборванные отправки.
 *
 * Строка, застрявшая в `sending`, означает процесс, умерший после запроса.
 * Доставка не подтверждена и не опровергнута, поэтому она уходит в `unknown`, а
 * не обратно в очередь: возврат в очередь отправил бы сообщение второй раз.
 */
export async function reapStuckSends(db: Database): Promise<number> {
  const result = await db.query(
    `UPDATE telegram_messages
        SET state = 'unknown', last_error_code = COALESCE(last_error_code, 'send_interrupted'),
            sending_since = NULL, updated_at = now()
      WHERE state = 'sending'
        AND sending_since < now() - make_interval(mins => $1)`,
    [STUCK_SENDING_MINUTES],
  );
  return result.rowCount ?? 0;
}

/**
 * Транспорт поверх Bot API.
 *
 * Разбор исходов здесь и есть главное. 429 — просьба подождать столько, сколько
 * назвал Telegram: игнорировать её значит получить запрет подольше. 403 —
 * человек закрыл бота, и повторы ничего не изменят. Обрыв, таймаут и ответ 5xx
 * — неизвестный исход: запрос мог дойти.
 */
export function createBotApiTransport(botToken: string, timeoutMs = 10_000): TelegramTransport {
  return {
    async sendMessage(chatId: string, text: string): Promise<TransportResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: controller.signal,
        });

        if (response.status >= 500) {
          return { outcome: 'unknown', code: `telegram_${response.status}` };
        }

        const payload = (await response.json()) as {
          ok?: boolean;
          result?: { message_id?: number };
          parameters?: { retry_after?: number };
          error_code?: number;
        };

        if (response.ok && payload.ok === true && typeof payload.result?.message_id === 'number') {
          return { outcome: 'sent', messageId: payload.result.message_id };
        }

        if (response.status === 429) {
          return {
            outcome: 'rejected',
            code: 'too_many_requests',
            retryable: true,
            ...(typeof payload.parameters?.retry_after === 'number'
              ? { retryAfterSeconds: payload.parameters.retry_after }
              : {}),
          };
        }

        if (response.status === 403) {
          return { outcome: 'rejected', code: 'bot_blocked', retryable: false };
        }

        // 400 и прочее — запрос негоден сам по себе, повтор его не исправит.
        return { outcome: 'rejected', code: `telegram_${response.status}`, retryable: false };
      } catch (error) {
        // Обрыв и таймаут: сообщение могло уйти, и объявлять неудачу нельзя.
        const code = (error as { name?: string }).name === 'AbortError' ? 'timeout' : 'network';
        return { outcome: 'unknown', code };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
