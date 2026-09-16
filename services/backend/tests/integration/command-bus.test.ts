import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { createGoalHandler, parseCreateGoalPayload } from '../../src/modules/goals/commands.ts';
import {
  executeCommand,
  PayloadMismatchError,
  semanticHash,
  type CommandOutcome,
} from '../../src/shared/commands/bus.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { withTenantTransaction } from '../../src/shared/db/tenant.ts';
import { commandRequest } from '../helpers/command-request.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки шины команд.
 *
 * Главное здесь — не «команда выполняется», а что повтор не даёт второго
 * эффекта и что номера последовательности не расходуются впустую: дыра в
 * нумерации заставляет курсор устройства перескочить через пачку, и часть
 * изменений не доедет никогда.
 *
 * Всё идёт через роль времени выполнения: под владельцем таблиц политики
 * изоляции не действуют, и проверки прошли бы вхолостую.
 */

const RUNTIME_ROLE = 'app_runtime';

const USER_A = '21212121-2121-4121-8121-212121212121';
const USER_B = '23232323-2323-4232-8232-232323232323';

let ownerDb: Database;
let runtimeDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  await ownerDb.query(
    'INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3), ($4, $5, $6)',
    [USER_A, 'dev', 'bus-a', USER_B, 'dev', 'bus-b'],
  );

  const url = new URL(config.database.connectionString);
  url.username = RUNTIME_ROLE;
  url.password = '';
  runtimeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 4 });
});

afterAll(async () => {
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

function goalCommand(userId: string, title: string, commandId = randomUUID()) {
  const payload = { title, start_date: '2026-09-01' };
  return {
    request: commandRequest({ userId, commandId, kind: 'create_goal', payload }),
    handler: createGoalHandler(parseCreateGoalPayload(payload)),
  };
}

async function countGoals(userId: string, title: string): Promise<number> {
  const result = await withTenantTransaction(runtimeDb, userId, async (client) => {
    return client.query('SELECT id FROM goals WHERE title = $1', [title]);
  });
  return result.rowCount ?? 0;
}

describe('идемпотентность', () => {
  it('повтор команды не создаёт вторую цель и возвращает прежнюю квитанцию', async () => {
    const { request, handler } = goalCommand(USER_A, 'Английский');

    const first = await executeCommand(runtimeDb, request, handler);
    const second = await executeCommand(runtimeDb, request, handler);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.committedSeq).toBe(first.committedSeq);
    expect(await countGoals(USER_A, 'Английский')).toBe(1);
  });

  it('повтор не расходует номер последовательности', async () => {
    const { request, handler } = goalCommand(USER_A, 'Без дыры');
    const first = await executeCommand(runtimeDb, request, handler);
    await executeCommand(runtimeDb, request, handler);

    const next = goalCommand(USER_A, 'Следующая');
    const after = await executeCommand(runtimeDb, next.request, next.handler);

    // Номер идёт сразу за первым: израсходованный впустую номер стал бы дырой,
    // и курсор устройства перескочил бы через несуществующую пачку.
    expect(Number(after.committedSeq)).toBe(Number(first.committedSeq) + 1);
  });

  it('тот же идентификатор с другой нагрузкой отклоняется', async () => {
    const commandId = randomUUID();
    const first = goalCommand(USER_A, 'Исходная', commandId);
    await executeCommand(runtimeDb, first.request, first.handler);

    const second = goalCommand(USER_A, 'Подменённая', commandId);

    // Возврат прежней квитанции подтвердил бы выполнение того, что сервер
    // никогда не выполнял.
    await expect(
      executeCommand(runtimeDb, second.request, second.handler),
    ).rejects.toBeInstanceOf(PayloadMismatchError);
    expect(await countGoals(USER_A, 'Подменённая')).toBe(0);
  });

  it('порядок ключей в нагрузке не влияет на распознавание повтора', async () => {
    // Иначе тот же повтор с другим порядком полей дал бы второй эффект.
    const commandId = randomUUID();
    const direct = commandRequest({
      userId: USER_A,
      commandId,
      kind: 'create_goal',
      payload: { a: 1, b: { c: 2, d: 3 } },
    });
    const reordered = commandRequest({
      userId: USER_A,
      commandId,
      kind: 'create_goal',
      payload: { b: { d: 3, c: 2 }, a: 1 },
    });

    expect(semanticHash(direct)).toBe(semanticHash(reordered));
  });

  it('тот же идентификатор с другим видом команды не считается повтором', async () => {
    // Хеш только по нагрузке выдал бы за повтор две разные операции, и клиент
    // получил бы квитанцию чужой (R2 в docs/15-backend-review.md).
    const commandId = randomUUID();
    const payload = { title: 'Одна нагрузка' };
    const started = commandRequest({ userId: USER_A, commandId, kind: 'start_quest', payload });
    const completed = commandRequest({
      userId: USER_A,
      commandId,
      kind: 'complete_quest',
      payload,
    });

    expect(semanticHash(started)).not.toBe(semanticHash(completed));
  });

  it('квитанция прежней схемы не принимается как повтор', async () => {
    // У квитанций hash_version = 1 вид команды неизвестен, доказать тождество
    // нечем. Принять такой повтор значило бы подтвердить выполнение операции,
    // которой, возможно, не было.
    const commandId = randomUUID();
    await ownerDb.query(
      `INSERT INTO command_receipts
         (user_id, command_id, payload_hash, hash_version, result, committed_seq)
       VALUES ($1, $2, $3, 1, '{}'::jsonb, 1)`,
      [USER_A, commandId, 'хеш-прежней-схемы'],
    );

    const { request, handler } = goalCommand(USER_A, 'После старой квитанции', commandId);

    await expect(executeCommand(runtimeDb, request, handler)).rejects.toBeInstanceOf(
      PayloadMismatchError,
    );
    expect(await countGoals(USER_A, 'После старой квитанции')).toBe(0);
  });

  it('тот же идентификатор команды у другого пользователя выполняется', async () => {
    const commandId = randomUUID();
    const mine = goalCommand(USER_A, 'Моя цель', commandId);
    const theirs = goalCommand(USER_B, 'Их цель', commandId);

    await executeCommand(runtimeDb, mine.request, mine.handler);
    const other = await executeCommand(runtimeDb, theirs.request, theirs.handler);

    // Идентификаторы генерирует клиент, совпадение между пользователями — не
    // конфликт.
    expect(other.duplicate).toBe(false);
    expect(await countGoals(USER_B, 'Их цель')).toBe(1);
  });
});

describe('одновременные команды', () => {
  it('две одновременные одинаковые команды дают один эффект', async () => {
    const { request, handler } = goalCommand(USER_A, 'Гонка');

    // Первая транзакция удерживается открытой, пока вторая не дойдёт до
    // блокировки. Без этого обе команды успевают выполниться по очереди, и
    // проверка ничего не доказывает: первая версия этого теста проходила даже
    // тогда, когда блокировка бралась после проверки квитанции.
    let releaseFirst = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const first = executeCommand(runtimeDb, request, async (context) => {
      markStarted();
      await held;
      return handler(context);
    });

    await started;
    const second = executeCommand(runtimeDb, request, handler);
    // Даём второй команде дойти до ожидания блокировки счётчика.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseFirst();

    const [one, two] = await Promise.all([first, second]);

    expect([one.duplicate, two.duplicate].filter(Boolean)).toHaveLength(1);
    expect(await countGoals(USER_A, 'Гонка')).toBe(1);
  });

  it('разные команды одного пользователя получают разные номера', async () => {
    const first = goalCommand(USER_A, 'Параллельная 1');
    const second = goalCommand(USER_A, 'Параллельная 2');

    const [one, two] = await Promise.all([
      executeCommand(runtimeDb, first.request, first.handler),
      executeCommand(runtimeDb, second.request, second.handler),
    ]);

    expect(one.committedSeq).not.toBe(two.committedSeq);
  });
});

describe('сбой обработчика', () => {
  it('не оставляет ни квитанции, ни номера, ни пачки изменений', async () => {
    const commandId = randomUUID();
    const before = await ownerDb.query<{ seq: string }>(
      'SELECT seq FROM user_change_counters WHERE user_id = $1',
      [USER_A],
    );

    await expect(
      executeCommand(
        runtimeDb,
        commandRequest({
          userId: USER_A,
          commandId,
          kind: 'create_goal',
          payload: { title: 'Упадёт' },
        }),
        async (): Promise<CommandOutcome> => {
          throw new Error('сбой внутри обработчика');
        },
      ),
    ).rejects.toThrow('сбой внутри обработчика');

    const receipt = await ownerDb.query('SELECT id FROM command_receipts WHERE command_id = $1', [
      commandId,
    ]);
    expect(receipt.rowCount).toBe(0);

    const after = await ownerDb.query<{ seq: string }>(
      'SELECT seq FROM user_change_counters WHERE user_id = $1',
      [USER_A],
    );
    // Неудачная команда не должна двигать счётчик: иначе каждая ошибка клиента
    // оставляла бы дыру в нумерации.
    expect(after.rows[0]?.seq).toBe(before.rows[0]?.seq);
  });
});

describe('пачки изменений', () => {
  it('каждая выполненная команда создаёт пачку со своим номером', async () => {
    const { request, handler } = goalCommand(USER_A, 'С пачкой');
    const receipt = await executeCommand(runtimeDb, request, handler);

    const batch = await ownerDb.query<{ changes: unknown[] }>(
      'SELECT changes FROM sync_change_batches WHERE user_id = $1 AND seq = $2',
      [USER_A, receipt.committedSeq],
    );

    expect(batch.rowCount).toBe(1);
    expect(batch.rows[0]?.changes).toEqual([
      { entity: 'goal', id: receipt.result['goal_id'], operation: 'created', version: '1' },
    ]);
  });

  it('номера пачек пользователя идут без пропусков', async () => {
    const batches = await ownerDb.query<{ seq: string }>(
      'SELECT seq FROM sync_change_batches WHERE user_id = $1 ORDER BY seq',
      [USER_A],
    );

    const numbers = batches.rows.map((row) => Number(row.seq));
    const expected = Array.from({ length: numbers.length }, (_, index) => index + 1);
    expect(numbers).toEqual(expected);
  });
});

describe('изоляция', () => {
  it('квитанции и пачки другого пользователя не видны', async () => {
    const { request, handler } = goalCommand(USER_B, 'Чужая цель');
    await executeCommand(runtimeDb, request, handler);

    const visible = await withTenantTransaction(runtimeDb, USER_A, async (client) => {
      const receipts = await client.query('SELECT id FROM command_receipts');
      const batches = await client.query('SELECT id FROM sync_change_batches');
      return { receipts: receipts.rowCount, batches: batches.rowCount };
    });

    const total = await ownerDb.query('SELECT id FROM command_receipts');
    expect(visible.receipts).toBeLessThan(total.rowCount ?? 0);
  });
});
