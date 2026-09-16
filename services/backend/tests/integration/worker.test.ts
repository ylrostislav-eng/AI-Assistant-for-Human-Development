import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { createGoalHandler, parseCreateGoalPayload } from '../../src/modules/goals/commands.ts';
import {
  backoffMs,
  claimJobs,
  completeJob,
  dispatchOutbox,
  failJob,
  runJobBatch,
  type Job,
} from '../../src/modules/sync/worker.ts';
import { executeCommand } from '../../src/shared/commands/bus.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки outbox и очереди заданий.
 *
 * Worker подключается собственной ролью: его доступ ко всем заданиям задан
 * политикой именно для этой роли. Под ролью API те же проверки прошли бы
 * иначе, и расширенный доступ остался бы непроверенным.
 */

const USER_A = '31313131-3131-4131-8131-313131313131';
const USER_B = '32323232-3232-4232-8232-323232323232';

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  const applied = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  expect(applied.applied).toContain('008_outbox_jobs.sql');

  await ownerDb.query(
    'INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3), ($4, $5, $6)',
    [USER_A, 'dev', 'worker-a', USER_B, 'dev', 'worker-b'],
  );

  const runtimeUrl = new URL(config.database.connectionString);
  runtimeUrl.username = 'app_runtime';
  runtimeUrl.password = '';
  runtimeDb = createPool({
    ...config.database,
    connectionString: runtimeUrl.toString(),
    maxConnections: 3,
  });

  const workerUrl = new URL(config.database.connectionString);
  workerUrl.username = 'app_worker';
  workerUrl.password = '';
  workerDb = createPool({
    ...config.database,
    connectionString: workerUrl.toString(),
    maxConnections: 3,
  });
});

afterAll(async () => {
  await runtimeDb.end();
  await workerDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

async function createGoalViaCommand(userId: string, title: string): Promise<void> {
  const payload = { title, start_date: '2026-09-01' };
  await executeCommand(
    runtimeDb,
    { userId, commandId: randomUUID(), kind: 'create_goal', payload },
    createGoalHandler(parseCreateGoalPayload(payload)),
  );
}

async function insertJob(
  userId: string,
  kind: string,
  options: { dueAt?: string; attempts?: number; maxAttempts?: number } = {},
): Promise<Job> {
  const result = await ownerDb.query<{ id: string; attempts: number; max_attempts: number }>(
    `INSERT INTO jobs (user_id, kind, dedupe_key, payload, due_at, attempts, max_attempts)
     VALUES ($1, $2, $3, '{}'::jsonb, COALESCE($4::timestamptz, now()), $5, $6)
     RETURNING id, attempts, max_attempts`,
    [userId, kind, `test:${randomUUID()}`, options.dueAt ?? null, options.attempts ?? 0, options.maxAttempts ?? 8],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Задание не создано');
  }
  return {
    id: row.id,
    userId,
    kind,
    payload: {},
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

describe('транзакционный outbox', () => {
  it('событие записывается той же транзакцией, что и команда', async () => {
    await createGoalViaCommand(USER_A, 'С событием');

    const events = await ownerDb.query<{ kind: string }>(
      'SELECT kind FROM outbox_events WHERE user_id = $1',
      [USER_A],
    );
    expect(events.rows.map((row) => row.kind)).toContain('goal_created');
  });

  it('при сбое команды событие не остаётся', async () => {
    const before = await ownerDb.query('SELECT id FROM outbox_events WHERE user_id = $1', [USER_B]);

    await expect(
      executeCommand(
        runtimeDb,
        { userId: USER_B, commandId: randomUUID(), kind: 'create_goal', payload: {} },
        async () => {
          throw new Error('сбой после записи события');
        },
      ),
    ).rejects.toThrow('сбой после записи события');

    const after = await ownerDb.query('SELECT id FROM outbox_events WHERE user_id = $1', [USER_B]);
    // Событие о том, чего не произошло, привело бы к напоминанию про
    // несуществующую цель.
    expect(after.rowCount).toBe(before.rowCount);
  });
});

describe('диспетчер', () => {
  it('переносит событие в задание и не создаёт второго при повторе', async () => {
    await createGoalViaCommand(USER_A, 'Для диспетчера');

    const moved = await dispatchOutbox(workerDb, { kinds: ['goal_created'] });
    expect(moved.queued).toBeGreaterThan(0);

    const jobsAfterFirst = await ownerDb.query('SELECT id FROM jobs WHERE kind = $1', [
      'goal_created',
    ]);
    await dispatchOutbox(workerDb, { kinds: ['goal_created'] });
    const jobsAfterSecond = await ownerDb.query('SELECT id FROM jobs WHERE kind = $1', [
      'goal_created',
    ]);

    expect(jobsAfterSecond.rowCount).toBe(jobsAfterFirst.rowCount);
  });

  it('событие без обработчика записывается, но в очередь не попадает', async () => {
    await createGoalViaCommand(USER_A, 'Без обработчика');

    // Список видов пуст: обработчика нет.
    const moved = await dispatchOutbox(workerDb, { kinds: [] });

    expect(moved.recordedOnly).toBeGreaterThan(0);
    expect(moved.queued).toBe(0);

    // Живая проверка показала, зачем это нужно: событие без потребителя
    // проходило все восемь попыток и оседало в dead_letter при каждой созданной
    // цели, заваливая разбор шумом.
    const undispatched = await ownerDb.query(
      'SELECT id FROM outbox_events WHERE dispatched_at IS NULL',
    );
    expect(undispatched.rowCount).toBe(0);
  });
});

describe('резервирование заданий', () => {
  it('два резервирования подряд не берут одно задание дважды', async () => {
    const job = await insertJob(USER_A, 'ручное');

    const first = await claimJobs(workerDb, { limit: 10 });
    const second = await claimJobs(workerDb, { limit: 10 });

    expect(first.map((claimed) => claimed.id)).toContain(job.id);
    expect(second.map((claimed) => claimed.id)).not.toContain(job.id);
  });

  it('два одновременных исполнителя не получают одно задание', async () => {
    const created = await Promise.all([
      insertJob(USER_A, 'параллельное'),
      insertJob(USER_A, 'параллельное'),
      insertJob(USER_A, 'параллельное'),
      insertJob(USER_A, 'параллельное'),
    ]);
    const ids = new Set(created.map((job) => job.id));

    const [left, right] = await Promise.all([
      claimJobs(workerDb, { limit: 4 }),
      claimJobs(workerDb, { limit: 4 }),
    ]);

    const leftIds = left.map((job) => job.id).filter((id) => ids.has(id));
    const rightIds = right.map((job) => job.id).filter((id) => ids.has(id));
    const overlap = leftIds.filter((id) => rightIds.includes(id));

    // Правильность держится на блокировке строки и условиях по статусу и
    // аренде; SKIP LOCKED влияет на пропускную способность — второй исполнитель
    // не ждёт освобождения, а сразу берёт следующее задание.
    expect(overlap).toEqual([]);
    expect(leftIds.length + rightIds.length).toBeGreaterThan(0);
  });

  it('не берёт задание, время которого не наступило', async () => {
    const job = await insertJob(USER_A, 'будущее', {
      dueAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const claimed = await claimJobs(workerDb, { limit: 10 });

    expect(claimed.map((row) => row.id)).not.toContain(job.id);
  });

  it('возвращает в работу задание с истёкшей арендой', async () => {
    const job = await insertJob(USER_A, 'упавший-исполнитель');
    await claimJobs(workerDb, { limit: 10, leaseMs: 1 });
    // Аренда взята на миллисекунду; ждём, чтобы она наверняка истекла.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reclaimed = await claimJobs(workerDb, { limit: 10 });

    // Упавший процесс не снимет флаг сам: аренда истекает и задание
    // возвращается в очередь.
    expect(reclaimed.map((row) => row.id)).toContain(job.id);
  });

  it('выполненное задание не резервируется снова', async () => {
    const job = await insertJob(USER_A, 'завершённое');
    await claimJobs(workerDb, { limit: 10 });
    await completeJob(workerDb, job.id);

    const claimed = await claimJobs(workerDb, { limit: 10, leaseMs: 1 });

    expect(claimed.map((row) => row.id)).not.toContain(job.id);
  });
});

describe('повторы и dead letter', () => {
  it('неудача возвращает задание в очередь с отсрочкой', async () => {
    const job = await insertJob(USER_A, 'падающее');
    const claimed = (await claimJobs(workerDb, { limit: 10 })).find((row) => row.id === job.id);
    expect(claimed).toBeDefined();

    const outcome = await failJob(workerDb, claimed as Job, 'boom');

    expect(outcome).toBe('retry');
    const row = await ownerDb.query<{ status: string; due_at: Date; last_error_code: string }>(
      'SELECT status, due_at, last_error_code FROM jobs WHERE id = $1',
      [job.id],
    );
    expect(row.rows[0]?.status).toBe('pending');
    expect(row.rows[0]?.last_error_code).toBe('boom');
    expect(row.rows[0]?.due_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('исчерпав попытки, задание уходит в dead_letter', async () => {
    const job = await insertJob(USER_A, 'безнадёжное', { attempts: 7, maxAttempts: 8 });
    const claimed = (await claimJobs(workerDb, { limit: 10 })).find((row) => row.id === job.id);

    const outcome = await failJob(workerDb, claimed as Job, 'boom');

    // Бесконечные повторы скрывают поломку: задание остаётся видимым для
    // разбора, а не исчезает и не крутится вечно.
    expect(outcome).toBe('dead_letter');
    const row = await ownerDb.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [
      job.id,
    ]);
    expect(row.rows[0]?.status).toBe('dead_letter');
  });

  it('отсрочка растёт с числом попыток и имеет разброс', async () => {
    const early = backoffMs(1, () => 0.5);
    const late = backoffMs(5, () => 0.5);
    const lowJitter = backoffMs(3, () => 0);
    const highJitter = backoffMs(3, () => 1);

    expect(late).toBeGreaterThan(early);
    // Разброс нужен, чтобы одновременно упавшие задания не возвращались разом.
    expect(highJitter).toBeGreaterThan(lowJitter);
  });
});

describe('проход worker', () => {
  it('выполняет задание известного вида и отмечает его', async () => {
    const job = await insertJob(USER_A, 'известное');
    const seen: string[] = [];

    const result = await runJobBatch(workerDb, {
      известное: async (claimed) => {
        seen.push(claimed.id);
      },
    });

    expect(seen).toContain(job.id);
    expect(result.done).toBeGreaterThan(0);
  });

  it('неизвестный вид задания не пропускается молча', async () => {
    const job = await insertJob(USER_A, 'никому_не_известное');

    const result = await runJobBatch(workerDb, {});

    // Молчаливый пропуск оставил бы задание в очереди навсегда.
    expect(result.retried + result.deadLettered).toBeGreaterThan(0);
    const row = await ownerDb.query<{ last_error_code: string }>(
      'SELECT last_error_code FROM jobs WHERE id = $1',
      [job.id],
    );
    expect(row.rows[0]?.last_error_code).toBe('unknown_job_kind');
  });
});

describe('изоляция служебных таблиц', () => {
  it('роль API не видит задания другого пользователя', async () => {
    await insertJob(USER_B, 'чужое-задание');

    const visible = await runtimeDb.query('SELECT id FROM jobs');

    // Без контекста пользователя роль API не видит ничего, а worker видит всё:
    // именно это различие и задано политиками.
    expect(visible.rowCount).toBe(0);
  });

  it('роль worker видит задания всех пользователей', async () => {
    // Задания создаются здесь же: первая версия опиралась на строку, созданную
    // соседней проверкой, и падала при перемешанном порядке.
    const mine = await insertJob(USER_A, 'видимость-а');
    const theirs = await insertJob(USER_B, 'видимость-б');

    const all = await workerDb.query<{ id: string }>('SELECT id FROM jobs WHERE id = ANY($1)', [
      [mine.id, theirs.id],
    ]);

    expect(all.rows.map((row) => row.id).sort()).toEqual([mine.id, theirs.id].sort());
  });
});
