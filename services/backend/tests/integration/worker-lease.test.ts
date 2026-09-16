import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  claimJobs,
  completeJob,
  failJob,
  renewLease,
  runJobBatch,
  type Job,
} from '../../src/modules/sync/worker.ts';
import { loadConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки владения арендой по аудиту `docs/15-backend-review.md` (R3).
 *
 * Сценарии написаны до исправления. Прежние проверки их не ловили, потому что
 * в них всегда работал один исполнитель: чужую аренду некому было перебить.
 *
 * Аренда истекает не по таймеру теста, а сдвигом `lease_until` в прошлое
 * запросом: ожидание реального времени сделало бы проверку и медленной, и
 * недостоверной.
 */

const USER = '34343434-3434-4434-8434-343434343434';

let ownerDb: Database;
let workerDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  await ownerDb.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    USER,
    'dev',
    'lease',
  ]);

  const url = new URL(config.database.connectionString);
  url.username = 'app_worker';
  url.password = '';
  workerDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 4 });
});

afterAll(async () => {
  await workerDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

async function insertJob(kind: string, maxAttempts = 8): Promise<string> {
  const result = await ownerDb.query<{ id: string }>(
    `INSERT INTO jobs (user_id, kind, dedupe_key, payload, max_attempts)
     VALUES ($1, $2, $3, '{}'::jsonb, $4)
     RETURNING id`,
    [USER, kind, `lease:${randomUUID()}`, maxAttempts],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Задание не создано');
  }
  return row.id;
}

/** Аренда считается истёкшей: прежний исполнитель признан умершим. */
async function expireLease(jobId: string): Promise<void> {
  await ownerDb.query(`UPDATE jobs SET lease_until = now() - interval '1 minute' WHERE id = $1`, [
    jobId,
  ]);
}

async function readJob(jobId: string): Promise<{ status: string; attempts: number }> {
  const result = await ownerDb.query<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM jobs WHERE id = $1',
    [jobId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Задание не найдено');
  }
  return row;
}

function only(jobs: readonly Job[], jobId: string): Job {
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (job === undefined) {
    throw new Error('Задание не зарезервировано');
  }
  return job;
}

describe('R3: владение арендой', () => {
  it('устаревший исполнитель не завершает работу, взятую другим', async () => {
    const jobId = await insertJob('lease-complete');

    const first = only(await claimJobs(workerDb, { limit: 5 }), jobId);
    await expireLease(jobId);
    const second = only(await claimJobs(workerDb, { limit: 5 }), jobId);
    expect(second.attempts).toBeGreaterThan(first.attempts);

    // A ожил и досчитал свою работу. Аренда уже у B, и работа, возможно,
    // выполняется прямо сейчас: пометив её done, A отменил бы чужой повтор и
    // событие осталось бы недоставленным.
    await completeJob(workerDb, first);

    expect((await readJob(jobId)).status).toBe('running');
  });

  it('поздняя неудача не возвращает в очередь чужую работу', async () => {
    const jobId = await insertJob('lease-fail');

    const first = only(await claimJobs(workerDb, { limit: 5 }), jobId);
    await expireLease(jobId);
    only(await claimJobs(workerDb, { limit: 5 }), jobId);

    await failJob(workerDb, first, 'late_failure');

    // Задание должно остаться у нового исполнителя, а не уехать в pending:
    // иначе работа, которая прямо сейчас идёт, будет взята третьим worker.
    expect((await readJob(jobId)).status).toBe('running');
  });

  it('повторный захват не выдаёт попыток сверх max_attempts', async () => {
    const jobId = await insertJob('lease-attempts', 1);

    const first = only(await claimJobs(workerDb, { limit: 5 }), jobId);
    expect(first.attempts).toBe(1);

    await expireLease(jobId);
    const reclaimed = await claimJobs(workerDb, { limit: 5 });

    // Попытки кончились. Выдать вторую значит обойти собственный предел: при
    // внешней отправке это лишнее сообщение человеку.
    expect(reclaimed.some((job) => job.id === jobId)).toBe(false);
    const after = await readJob(jobId);
    expect(after.status).toBe('dead_letter');
    expect(after.attempts).toBe(1);
  });

  it('долгая работа продлевает аренду и остаётся своей', async () => {
    const jobId = await insertJob('lease-renew');
    const job = only(await claimJobs(workerDb, { limit: 5, leaseMs: 200 }), jobId);

    await waitUntilLeaseExpired(jobId);
    // Аренда истекла во время работы. Продление её возвращает, потому что
    // задание ещё никем не перехвачено.
    expect(await renewLease(workerDb, job, 30_000)).toBe(true);
    expect(await completeJob(workerDb, job)).toBe(true);
  });

  it('потерянную аренду продлить нельзя', async () => {
    const jobId = await insertJob('lease-renew-lost');
    const first = only(await claimJobs(workerDb, { limit: 5 }), jobId);
    await expireLease(jobId);
    only(await claimJobs(workerDb, { limit: 5 }), jobId);

    // Задание уже у другого исполнителя: продлевая аренду, прежний отодвинул бы
    // срок чужой работы и сломал бы возврат по истечению.
    expect(await renewLease(workerDb, first)).toBe(false);
  });

  it('обработчик начинает работу с действующей арендой', async () => {
    const ids = [
      await insertJob('lease-batch'),
      await insertJob('lease-batch'),
      await insertJob('lease-batch'),
    ];
    const leaseValidAtStart: boolean[] = [];
    let firstJob = true;

    const result = await runJobBatch(
      workerDb,
      {
        'lease-batch': async (job) => {
          const state = await ownerDb.query<{ valid: boolean }>(
            'SELECT lease_until > now() AS valid FROM jobs WHERE id = $1',
            [job.id],
          );
          leaseValidAtStart.push(state.rows[0]?.valid ?? false);

          if (firstJob) {
            firstJob = false;
            // Первый обработчик работает дольше своей аренды. Если пачка взята
            // разом, у остальных заданий аренда истечёт ещё до их запуска, и
            // их подберёт второй worker — та же работа уедет дважды.
            await waitUntilLeaseExpired(job.id);
          }
        },
      },
      { limit: 3, leaseMs: 300 },
    );

    expect(result.done).toBe(3);
    expect(leaseValidAtStart).toEqual([true, true, true]);
    for (const id of ids) {
      expect((await readJob(id)).attempts).toBe(1);
    }
  });
});

async function waitUntilLeaseExpired(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await ownerDb.query<{ expired: boolean }>(
      'SELECT lease_until <= now() AS expired FROM jobs WHERE id = $1',
      [jobId],
    );
    if (state.rows[0]?.expired === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Аренда не истекла за отведённое время');
}
