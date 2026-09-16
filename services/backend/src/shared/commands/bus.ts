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

/** Версия схемы семантического хеша; см. миграцию 009. */
export const SEMANTIC_HASH_VERSION = 2;

export interface CommandRequest {
  readonly userId: string;
  readonly commandId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  /** Изменяемый объект команды; null для создания. */
  readonly targetId: string | null;
  /** Ожидаемая версия объекта; null, если клиент её не утверждает. */
  readonly expectedVersion: number | null;
  readonly dependsOnCommandId: string | null;
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
 * Канонический вид значения: порядок ключей не должен влиять на хеш. Иначе тот
 * же повтор с другим порядком полей выглядел бы новой командой и дал бы второй
 * эффект.
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

/**
 * Семантический хеш команды.
 *
 * В него входит всё, что определяет смысл операции: схема, вид, цель,
 * ожидаемая версия, зависимость и нагрузка. Хеш только по нагрузке (схема 1)
 * считал повтором `start_quest` и `complete_quest` с одинаковой нагрузкой —
 * клиент получал квитанцию чужой операции (R2 в docs/15-backend-review.md).
 *
 * Транспортные поля — идентификатор устройства и время клиента — намеренно не
 * входят: при повторе после обрыва сети они меняются законно.
 */
export function semanticHash(request: CommandRequest): string {
  const semantic = {
    schema_version: request.schemaVersion,
    kind: request.kind,
    target_id: request.targetId,
    expected_version: request.expectedVersion,
    depends_on_command_id: request.dependsOnCommandId,
    payload: request.payload,
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(semantic)), 'utf8').digest('hex');
}

async function setUser(client: TransactionClient, userId: string): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
}

interface StoredReceipt {
  readonly payload_hash: string;
  readonly kind: string | null;
  readonly hash_version: number;
  readonly result: Record<string, unknown> | null;
  readonly committed_seq: string;
}

/**
 * Совпадает ли сохранённая квитанция с предъявленной командой.
 *
 * Для квитанций прежней схемы вид команды неизвестен, и доказать тождество
 * невозможно. Принимать такой повтор на веру означало бы вернуть результат
 * операции, которой, возможно, не было; поэтому он считается конфликтом.
 */
function receiptMatches(receipt: StoredReceipt, request: CommandRequest): boolean {
  if (receipt.hash_version !== SEMANTIC_HASH_VERSION) {
    return false;
  }
  return receipt.kind === request.kind && receipt.payload_hash === semanticHash(request);
}

async function readReceipt(db: Database, request: CommandRequest): Promise<CommandReceipt | null> {
  return withTransaction(db, async (client) => {
    await setUser(client, request.userId);
    const stored = await client.query<StoredReceipt>(
      `SELECT payload_hash, kind, hash_version, result, committed_seq
         FROM command_receipts WHERE command_id = $1`,
      [request.commandId],
    );

    const receipt = stored.rows[0];
    if (receipt === undefined) {
      return null;
    }
    if (!receiptMatches(receipt, request)) {
      // Тот же идентификатор с другим смыслом — ошибка клиента, а не повтор.
      // Вернуть прежнюю квитанцию значило бы подтвердить выполнение того, что
      // сервер никогда не выполнял.
      throw new PayloadMismatchError(
        `Команда ${request.commandId} уже выполнена с другим содержанием`,
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
  const hash = semanticHash(request);

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
      const existing = await client.query<{ command_id: string }>(
        'SELECT command_id FROM command_receipts WHERE command_id = $1',
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
        `INSERT INTO command_receipts
           (user_id, command_id, payload_hash, kind, hash_version, result, committed_seq)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          request.userId,
          request.commandId,
          hash,
          request.kind,
          SEMANTIC_HASH_VERSION,
          JSON.stringify(outcome.result),
          seq,
        ],
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
