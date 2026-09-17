import type { Database, TransactionClient } from '../../shared/db/pool.ts';
import { withTransaction } from '../../shared/db/pool.ts';

/**
 * Разбор принятых обновлений Telegram (T-02b, docs/14, разделы 2 и 4).
 *
 * Разбор отделён от приёма намеренно: внешний вызов внутри приёма упёрся бы в
 * таймаут Telegram и задержал бы подтверждение, из-за которого он перестаёт
 * повторять доставку.
 *
 * Ответ не отправляется здесь, а кладётся в очередь исходящих. Таймаут запроса
 * к Telegram может означать уже доставленное сообщение: без записи о намерении
 * неизвестный исход не отличить от неотправленного, и повтор рассылает одно и
 * то же (docs/01, раздел 6, пункт 6).
 */

/** Сколько обновлений разбирать за проход. */
const DEFAULT_LIMIT = 20;

/**
 * Сколько сырое тело живёт после обработки. Это личная переписка: она нужна на
 * разбор поломки и дальше хранится без причины (docs/14, раздел 4).
 */
const PAYLOAD_RETENTION_HOURS = 24;

export interface ProcessOptions {
  /** Кто допущен к пилоту. Пустой список означает «никого». */
  readonly allowedUserIds: readonly string[];
  readonly limit?: number;
}

export interface ProcessResult {
  readonly processed: number;
  readonly replies: number;
}

interface PendingUpdate {
  readonly id: string;
  readonly update_id: string;
  readonly kind: string | null;
  readonly sender_telegram_id: string | null;
  readonly payload: Record<string, unknown>;
}

interface Reply {
  readonly kind: string;
  readonly body: string;
}

/** Текст сообщения, если он есть; у нажатия кнопки его нет. */
function messageText(payload: Record<string, unknown>): string | null {
  const message = payload['message'] ?? payload['edited_message'];
  const text = (message as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : null;
}

/** Чат, в который отвечаем. Берётся из того же раздела, что и отправитель. */
function chatId(payload: Record<string, unknown>): string | null {
  for (const field of ['message', 'edited_message', 'callback_query']) {
    const section = payload[field];
    if (typeof section !== 'object' || section === null) {
      continue;
    }
    const chat = (section as { chat?: { id?: unknown } }).chat;
    if (typeof chat?.id === 'number' && Number.isSafeInteger(chat.id)) {
      return String(chat.id);
    }
    const from = (section as { from?: { id?: unknown } }).from;
    if (typeof from?.id === 'number' && Number.isSafeInteger(from.id)) {
      // У нажатия кнопки чат лежит в сообщении, а если его нет — отвечаем
      // отправителю напрямую.
      return String(from.id);
    }
  }
  return null;
}

/**
 * Сегодняшние задания по серверному состоянию.
 *
 * Именно по состоянию, а не разбором прежних сообщений бота (docs/14, раздел 2):
 * сообщение устаревает в тот момент, когда то же задание завершают в другом
 * месте, и пересказ переписки показал бы человеку прошлое.
 */
async function composeToday(client: TransactionClient, userId: string): Promise<string> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
  const quests = await client.query<{ template_snapshot: { title?: string } }>(
    `SELECT template_snapshot FROM quest_occurrences
      WHERE execution_status IN ('planned', 'active', 'partial')
      ORDER BY created_at
      LIMIT 20`,
  );

  if (quests.rowCount === 0) {
    return 'Сегодня заданий нет. Их пока некому создать: планирование появится дальше.';
  }

  const titles = quests.rows.map((row) => `• ${row.template_snapshot.title ?? 'без названия'}`);
  return [`Сегодня заданий: ${quests.rowCount}`, ...titles].join('\n');
}

/**
 * Ответ на обновление.
 *
 * Незнакомый текст получает понятный ответ, а не молчание: человек, которому не
 * ответили, пишет снова и снова и считает, что сломалось.
 */
async function composeReply(
  client: TransactionClient,
  update: PendingUpdate,
  userId: string | null,
): Promise<Reply | null> {
  if (userId === null) {
    // Чужому отправителю отвечаем, но аккаунт ему не заводим.
    return {
      kind: 'not_allowed',
      body: 'Это личная система развития, и доступ к ней закрыт. Если бот нужен вам — напишите владельцу.',
    };
  }

  const text = messageText(update.payload)?.trim() ?? '';

  if (text.startsWith('/start')) {
    return {
      kind: 'start',
      body: [
        'Система развития на связи.',
        '',
        'Сейчас умею немного: /today покажет задания на сегодня.',
        'Награды, уровни и планирование появятся дальше — обещать их сейчас было бы нечестно.',
      ].join('\n'),
    };
  }

  if (text.startsWith('/today')) {
    return { kind: 'today', body: await composeToday(client, userId) };
  }

  if (text === '') {
    // Нажатие кнопки и прочее без текста разберёт T-02c; молча промолчать
    // здесь лучше, чем ответить не на то.
    return null;
  }

  return {
    kind: 'unknown_command',
    body: 'Пока понимаю только /today. Свободный разбор появится вместе с ИИ.',
  };
}

/**
 * Один проход разбора.
 *
 * Обновления берутся `FOR UPDATE SKIP LOCKED`: второй проход не ждёт первого и
 * не разбирает то же самое. Пометка обработки и постановка ответа идут одной
 * транзакцией — иначе сбой между ними оставил бы ответ без пометки, и человек
 * получил бы его дважды.
 */
export async function processPendingUpdates(
  db: Database,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  return withTransaction(db, async (client) => {
    const pending = await client.query<PendingUpdate>(
      `SELECT id, update_id, kind, sender_telegram_id, payload
         FROM telegram_updates
        WHERE processed_at IS NULL
        ORDER BY received_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    let replies = 0;
    for (const update of pending.rows) {
      // Контекст пользователя сбрасывается перед каждым обновлением: иначе он
      // достаётся следующему от предыдущего, и однажды кто-то прочитает чужие
      // строки, потому что контекст просто не успели сменить.
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', '']);

      const sender = update.sender_telegram_id;
      let userId: string | null = null;

      if (sender !== null && options.allowedUserIds.includes(sender)) {
        const resolved = await client.query<{ identity_resolve_telegram: string }>(
          'SELECT identity_resolve_telegram($1)',
          [sender],
        );
        userId = resolved.rows[0]?.identity_resolve_telegram ?? null;
      }

      const target = chatId(update.payload);
      const reply = sender === null || target === null ? null : await composeReply(client, update, userId);

      if (reply !== null && target !== null) {
        await client.query(
          `INSERT INTO telegram_messages (user_id, chat_id, kind, body, dedupe_key)
           VALUES ($1::uuid, $2, $3, $4, $5)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [userId, target, reply.kind, reply.body, `update:${update.update_id}`],
        );
        replies += 1;
      }

      await client.query('UPDATE telegram_updates SET processed_at = now() WHERE id = $1', [
        update.id,
      ]);
    }

    return { processed: pending.rowCount ?? 0, replies };
  });
}

/**
 * Стирание сырых тел обработанных обновлений по сроку.
 *
 * Стирается только тело: строка остаётся, потому что на ней держится
 * дедупликация. Без неё старое обновление, доставленное повторно, сработало бы
 * второй раз. Необработанные не трогаются ни при каком возрасте — стереть тело
 * до разбора значит потерять сообщение человека.
 */
export async function purgeProcessedPayloads(db: Database): Promise<number> {
  const result = await db.query(
    `UPDATE telegram_updates
        SET payload = '{}'::jsonb, payload_purged_at = now()
      WHERE processed_at IS NOT NULL
        AND payload_purged_at IS NULL
        AND processed_at < now() - make_interval(hours => $1)`,
    [PAYLOAD_RETENTION_HOURS],
  );
  return result.rowCount ?? 0;
}
