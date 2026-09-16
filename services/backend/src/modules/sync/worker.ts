import type { Database, TransactionClient } from '../../shared/db/pool.ts';
import { withTransaction } from '../../shared/db/pool.ts';

/**
 * Очередь заданий: перенос событий из outbox и их выполнение с повторами.
 *
 * Протокол взят из docs/01, раздел 6. Существенных решений три.
 *
 * Аренда вместо флага «занято». Упавший процесс не может снять флаг, и задание
 * зависло бы навсегда; истёкшая аренда возвращает его в работу сама.
 *
 * Резервирование через `FOR UPDATE SKIP LOCKED`. Без SKIP LOCKED второй worker
 * ждёт освобождения строки и берёт то же задание следом; с ним он сразу
 * переходит к следующему.
 *
 * Выполнение — вне транзакции резервирования. Транзакция, открытая на время
 * работы обработчика, держит блокировку и соединение всё это время; внешний
 * вызов при этом всё равно может не завершиться.
 */

export const DEFAULT_LEASE_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export interface Job {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface OutboxEvent {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/** Запись события в той же транзакции, что и команда. */
export async function enqueueOutboxEvent(
  client: TransactionClient,
  userId: string,
  event: OutboxEvent,
): Promise<void> {
  await client.query(
    'INSERT INTO outbox_events (user_id, kind, payload) VALUES ($1, $2, $3::jsonb)',
    [userId, event.kind, JSON.stringify(event.payload)],
  );
}

/**
 * Перенос событий в задания. Ключ дедупликации выводится из идентификатора
 * события, поэтому повторный проход диспетчера не создаёт второго задания даже
 * если пометка о переносе не успела записаться.
 *
 * Задание создаётся только для видов, у которых есть обработчик. Событие без
 * потребителя остаётся записанным в outbox как факт, но в очередь не попадает:
 * иначе каждое такое событие проходит все восемь попыток и оседает в
 * dead_letter, заваливая разбор шумом. Это выяснилось на живой проверке —
 * события `goal_created` копились именно так.
 *
 * Проверка неизвестного вида в `runJobBatch` при этом остаётся: обработчик
 * может исчезнуть между выкладками, когда задание уже в очереди.
 */
export async function dispatchOutbox(
  db: Database,
  options: { kinds?: readonly string[]; limit?: number } = {},
): Promise<{ queued: number; recordedOnly: number }> {
  const limit = options.limit ?? 50;
  const kinds = options.kinds;

  return withTransaction(db, async (client) => {
    const events = await client.query<{
      id: string;
      user_id: string;
      kind: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, user_id, kind, payload FROM outbox_events
        WHERE dispatched_at IS NULL
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    let queued = 0;
    let recordedOnly = 0;

    for (const event of events.rows) {
      if (kinds === undefined || kinds.includes(event.kind)) {
        await client.query(
          `INSERT INTO jobs (user_id, kind, dedupe_key, payload)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [event.user_id, event.kind, `outbox:${event.id}`, JSON.stringify(event.payload)],
        );
        queued += 1;
      } else {
        recordedOnly += 1;
      }
      await client.query('UPDATE outbox_events SET dispatched_at = now() WHERE id = $1', [event.id]);
    }

    return { queued, recordedOnly };
  });
}

/**
 * Резервирование пачки заданий. Забираются готовые по времени, а также те, чья
 * аренда истекла: их прежний исполнитель считается умершим.
 */
export async function claimJobs(
  db: Database,
  options: { limit?: number; leaseMs?: number } = {},
): Promise<readonly Job[]> {
  const limit = options.limit ?? 10;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  return withTransaction(db, async (client) => {
    const claimed = await client.query<{
      id: string;
      user_id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>(
      `UPDATE jobs SET
         status = 'running',
         attempts = attempts + 1,
         lease_until = now() + make_interval(secs => $2::double precision),
         updated_at = now()
       WHERE id IN (
         SELECT id FROM jobs
          WHERE (status = 'pending' AND due_at <= now())
             OR (status = 'running' AND lease_until < now())
          ORDER BY due_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, user_id, kind, payload, attempts, max_attempts`,
      [limit, leaseMs / 1000],
    );

    return claimed.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  });
}

export async function completeJob(db: Database, jobId: string): Promise<void> {
  await db.query(
    `UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = now() WHERE id = $1`,
    [jobId],
  );
}

/** Экспоненциальная отсрочка с разбросом: одновременно упавшие задания не должны возвращаться разом. */
export function backoffMs(attempts: number, random = Math.random): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/**
 * Неудача: задание возвращается в очередь с отсрочкой либо уходит в
 * dead_letter. Бесконечные повторы скрывают поломку — попытки кончаются, и
 * задание остаётся видимым для разбора, а не исчезает.
 */
export async function failJob(
  db: Database,
  job: Job,
  errorCode: string,
  random = Math.random,
): Promise<'retry' | 'dead_letter'> {
  if (job.attempts >= job.maxAttempts) {
    await db.query(
      `UPDATE jobs SET status = 'dead_letter', lease_until = NULL, last_error_code = $2,
              updated_at = now()
        WHERE id = $1`,
      [job.id, errorCode],
    );
    return 'dead_letter';
  }

  await db.query(
    `UPDATE jobs SET status = 'pending', lease_until = NULL, last_error_code = $2,
            due_at = now() + make_interval(secs => $3::double precision), updated_at = now()
      WHERE id = $1`,
    [job.id, errorCode, backoffMs(job.attempts, random) / 1000],
  );
  return 'retry';
}

export type JobHandler = (job: Job) => Promise<void>;

/**
 * Один проход worker: зарезервировать пачку и выполнить. Обработчики
 * вызываются последовательно — задания одного пользователя должны применяться
 * по порядку, а параллельность внутри пачки этого не гарантирует.
 */
export async function runJobBatch(
  db: Database,
  handlers: Record<string, JobHandler>,
  options: { limit?: number; leaseMs?: number } = {},
): Promise<{ done: number; retried: number; deadLettered: number }> {
  const jobs = await claimJobs(db, options);
  let done = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const job of jobs) {
    const handler = handlers[job.kind];
    if (handler === undefined) {
      // Неизвестный вид задания — не молчаливый пропуск: иначе задание
      // навсегда остаётся в очереди и никто об этом не узнает.
      const outcome = await failJob(db, job, 'unknown_job_kind');
      if (outcome === 'retry') retried += 1;
      else deadLettered += 1;
      continue;
    }

    try {
      await handler(job);
      await completeJob(db, job.id);
      done += 1;
    } catch (error) {
      const code = error instanceof Error ? error.name : 'unknown_error';
      const outcome = await failJob(db, job, code);
      if (outcome === 'retry') retried += 1;
      else deadLettered += 1;
    }
  }

  return { done, retried, deadLettered };
}
