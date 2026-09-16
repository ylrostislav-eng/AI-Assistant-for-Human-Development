import { createHash } from 'node:crypto';

import { enqueueOutboxEvent } from '../../modules/sync/worker.ts';
import { withTransaction, type Database, type TransactionClient } from '../db/pool.ts';

/**
 * Шина команд: один бизнес-эффект на одну команду при повторной доставке.
 *
 * Клиент повторяет команду при обрыве сети, не зная, дошла ли она. Сервер
 * обязан узнать повтор и вернуть прежний результат, а не выполнить действие
 * второй раз (docs/01, раздел 5; docs/06).
 *
 * Порядок внутри транзакции важен и выбран не случайно:
 *
 * 1. Счётчик пользователя увеличивается первым. Это же берёт блокировку строки,
 *    поэтому две одновременные команды одного пользователя выстраиваются в
 *    очередь; без блокировки обе прошли бы проверку квитанций и дали два
 *    эффекта.
 * 2. Затем проверяется квитанция. Второй вызов к этому моменту уже дождался
 *    первого и видит его запись.
 * 3. Обработчик выполняется последним, когда известно, что это не повтор.
 *
 * Обнаружив повтор, транзакция откатывается целиком: иначе израсходованный
 * номер последовательности остался бы дырой, а курсор синхронизации перескочил
 * бы через несуществующую пачку.
 */

export interface CommandRequest {
  readonly userId: string;
  readonly commandId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

export interface CommandContext {
  readonly client: TransactionClient;
  readonly userId: string;
  readonly seq: string;
}

export interface CommandOutcome {
  /** Результат для клиента; попадает в квитанцию. */
  readonly result: Record<string, unknown>;
  /** Изменения для синхронизации устройств. */
  readonly changes: readonly Record<string, unknown>[];
  /**
   * События для фоновой обработки. Пишутся той же транзакцией: отправка
   * отдельным вызовом после фиксации теряется при падении процесса, а отправка
   * до фиксации сообщает о том, чего может не случиться.
   */
  readonly events?: readonly { kind: string; payload: Record<string, unknown> }[];
}

export type CommandHandler = (context: CommandContext) => Promise<CommandOutcome>;

export interface CommandReceipt {
  readonly result: Record<string, unknown>;
  readonly committedSeq: string;
  /** true, если команда уже выполнялась и эффект не повторялся. */
  readonly duplicate: boolean;
}

export class PayloadMismatchError extends Error {}

/** Внутренний сигнал отката при обнаружении повтора. */
class DuplicateCommandSignal extends Error {}

/**
 * Канонический вид полезной нагрузки: порядок ключей не должен влиять на хеш.
 * Иначе тот же повтор с другим порядком полей выглядел бы новой командой и дал
 * бы второй эффект.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload)), 'utf8').digest('hex');
}

async function setUser(client: TransactionClient, userId: string): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
}

async function readReceipt(db: Database, request: CommandRequest): Promise<CommandReceipt | null> {
  return withTransaction(db, async (client) => {
    await setUser(client, request.userId);
    const stored = await client.query<{
      payload_hash: string;
      result: Record<string, unknown> | null;
      committed_seq: string;
    }>('SELECT payload_hash, result, committed_seq FROM command_receipts WHERE command_id = $1', [
      request.commandId,
    ]);

    const receipt = stored.rows[0];
    if (receipt === undefined) {
      return null;
    }
    if (receipt.payload_hash !== payloadHash(request.payload)) {
      // Тот же идентификатор с другим содержимым — ошибка клиента, а не
      // повтор. Вернуть прежнюю квитанцию значило бы подтвердить выполнение
      // того, что сервер никогда не выполнял.
      throw new PayloadMismatchError(
        `Команда ${request.commandId} уже выполнена с другой полезной нагрузкой`,
      );
    }
    return { result: receipt.result ?? {}, committedSeq: receipt.committed_seq, duplicate: true };
  });
}

export async function executeCommand(
  db: Database,
  request: CommandRequest,
  handler: CommandHandler,
): Promise<CommandReceipt> {
  const hash = payloadHash(request.payload);

  try {
    return await withTransaction(db, async (client) => {
      await setUser(client, request.userId);

      // Шаг 1: номер и блокировка пользователя одним запросом.
      const counter = await client.query<{ seq: string }>(
        `INSERT INTO user_change_counters (user_id, seq) VALUES ($1, 1)
         ON CONFLICT (user_id) DO UPDATE SET seq = user_change_counters.seq + 1
         RETURNING seq`,
        [request.userId],
      );
      const seq = counter.rows[0]?.seq;
      if (seq === undefined) {
        throw new Error('Счётчик изменений не выдал номер');
      }

      // Шаг 2: повтор?
      const existing = await client.query<{ payload_hash: string }>(
        'SELECT payload_hash FROM command_receipts WHERE command_id = $1',
        [request.commandId],
      );
      if (existing.rows.length > 0) {
        throw new DuplicateCommandSignal();
      }

      // Шаг 3: собственно действие.
      const outcome = await handler({ client, userId: request.userId, seq });

      await client.query(
        `INSERT INTO sync_change_batches (user_id, seq, changes) VALUES ($1, $2, $3::jsonb)`,
        [request.userId, seq, JSON.stringify(outcome.changes)],
      );
      await client.query(
        `INSERT INTO command_receipts (user_id, command_id, payload_hash, result, committed_seq)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [request.userId, request.commandId, hash, JSON.stringify(outcome.result), seq],
      );

      for (const event of outcome.events ?? []) {
        await enqueueOutboxEvent(client, request.userId, event);
      }

      return { result: outcome.result, committedSeq: seq, duplicate: false };
    });
  } catch (error) {
    if (!(error instanceof DuplicateCommandSignal)) {
      throw error;
    }
  }

  // Повтор: транзакция откачена, номер не израсходован. Прежняя квитанция
  // читается отдельно — она уже зафиксирована другой транзакцией.
  const receipt = await readReceipt(db, request);
  if (receipt === null) {
    // Возможно, если параллельная транзакция откатилась между шагами.
    // Повторять действие вслепую нельзя: клиент должен прислать команду заново.
    throw new Error(`Квитанция команды ${request.commandId} не найдена после обнаружения повтора`);
  }
  return receipt;
}
