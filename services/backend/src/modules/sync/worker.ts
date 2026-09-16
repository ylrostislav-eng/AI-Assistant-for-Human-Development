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
  /**
   * Маркер владения арендой, выданный при резервировании. Предъявляется при
   * завершении: без него ожившая после паузы задача меняет чужую работу
   * (R3 в docs/15-backend-review.md).
   */
  readonly leaseToken: string;
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
 * Задания, чья аренда истекла, а попытки кончились.
 *
 * Без этого прохода такое задание навсегда остаётся в статусе `running`:
 * повторно его не берут (попыток нет), и никто о нём не узнаёт. В dead_letter
 * оно хотя бы видно при разборе.
 */
async function reapExhaustedLeases(client: TransactionClient): Promise<void> {
  await client.query(
    `UPDATE jobs SET
       status = 'dead_letter',
       lease_until = NULL,
       lease_token = NULL,
       last_error_code = COALESCE(last_error_code, 'lease_expired'),
       updated_at = now()
     WHERE status = 'running' AND lease_until < now() AND attempts >= max_attempts`,
  );
}

/**
 * Резервирование заданий. Забираются готовые по времени, а также те, чья
 * аренда истекла: их прежний исполнитель считается умершим.
 *
 * Условие `attempts < max_attempts` стоит именно здесь. Раньше истёкшая аренда
 * возвращала задание в работу независимо от израсходованных попыток, и задание
 * с пределом в одну попытку получало вторую: для внешней отправки это лишнее
 * сообщение человеку.
 *
 * Пачкой больше одного задания резервировать опасно: обработчики выполняются
 * последовательно, и у последнего задания аренда истечёт раньше, чем до него
 * дойдёт очередь. Поэтому `runJobBatch` берёт по одному; параметр `limit`
 * оставлен для разбора очереди и проверок.
 */
export async function claimJobs(
  db: Database,
  options: { limit?: number; leaseMs?: number } = {},
): Promise<readonly Job[]> {
  const limit = options.limit ?? 1;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  return withTransaction(db, async (client) => {
    await reapExhaustedLeases(client);

    const claimed = await client.query<{
      id: string;
      user_id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
      lease_token: string;
    }>(
      `UPDATE jobs SET
         status = 'running',
         attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => $2::double precision),
         updated_at = now()
       WHERE id IN (
         SELECT id FROM jobs
          WHERE ((status = 'pending' AND due_at <= now())
              OR (status = 'running' AND lease_until < now()))
            AND attempts < max_attempts
          ORDER BY due_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, user_id, kind, payload, attempts, max_attempts, lease_token`,
      [limit, leaseMs / 1000],
    );

    return claimed.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      leaseToken: row.lease_token,
    }));
  });
}

/**
 * Продление аренды во время долгой работы.
 *
 * Резервирование по одному защищает от истечения аренды у ждущих своей очереди
 * заданий, но не от задания, которое само работает дольше срока. Такое задание
 * подберёт второй worker, и внешняя отправка уйдёт дважды. Продлевать аренду
 * может только её владелец: маркер проверяется тем же compare-and-set.
 *
 * Возвращает false, если аренда уже потеряна — работу пора прекращать, её
 * результат всё равно не будет засчитан.
 */
export async function renewLease(db: Database, job: Job, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  const result = await db.query(
    `UPDATE jobs SET lease_until = now() + make_interval(secs => $3::double precision),
            updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_token = $2`,
    [job.id, job.leaseToken, leaseMs / 1000],
  );
  return result.rowCount === 1;
}

/**
 * Завершение своей работы.
 *
 * Возвращает false, если аренда уже не принадлежит вызывающему: задание успел
 * забрать другой исполнитель, и трогать его нельзя. Пометив такую работу done,
 * прежний исполнитель отменил бы чужой повтор, и событие осталось бы
 * недоставленным.
 */
export async function completeJob(db: Database, job: Job): Promise<boolean> {
  const result = await db.query(
    `UPDATE jobs SET status = 'done', lease_until = NULL, lease_token = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_token = $2`,
    [job.id, job.leaseToken],
  );
  return result.rowCount === 1;
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
): Promise<'retry' | 'dead_letter' | 'lease_lost'> {
  // Маркер проверяется и здесь: поздняя неудача без него возвращала в pending
  // работу, которую уже выполняет другой исполнитель, и её брал третий.
  if (job.attempts >= job.maxAttempts) {
    const dead = await db.query(
      `UPDATE jobs SET status = 'dead_letter', lease_until = NULL, lease_token = NULL,
              last_error_code = $2, updated_at = now()
        WHERE id = $1 AND status = 'running' AND lease_token = $3`,
      [job.id, errorCode, job.leaseToken],
    );
    return dead.rowCount === 1 ? 'dead_letter' : 'lease_lost';
  }

  const retried = await db.query(
    `UPDATE jobs SET status = 'pending', lease_until = NULL, lease_token = NULL,
            last_error_code = $2,
            due_at = now() + make_interval(secs => $3::double precision), updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_token = $4`,
    [job.id, errorCode, backoffMs(job.attempts, random) / 1000, job.leaseToken],
  );
  return retried.rowCount === 1 ? 'retry' : 'lease_lost';
}

/**
 * Обработчику передаётся продление аренды, а не только задание: сам он о сроке
 * аренды ничего не знает, а решение «работа затянулась» принимается внутри
 * него.
 */
export interface JobContext {
  /** Продлить аренду; false означает, что она уже потеряна и работу пора бросить. */
  readonly renewLease: () => Promise<boolean>;
}

export type JobHandler = (job: Job, context: JobContext) => Promise<void>;

/**
 * Один проход worker.
 *
 * Задания берутся по одному и выполняются последовательно. Последовательность
 * нужна по существу: задания одного пользователя должны применяться по
 * порядку. А резервирование по одному — следствие этой последовательности:
 * взятая разом пачка начинает аренду всем заданиям одновременно, и у
 * последнего она истечёт ещё до того, как до него дойдёт очередь. Тогда его
 * подберёт второй worker, и та же работа уедет дважды.
 *
 * `limit` здесь — сколько заданий обработать за проход, а не сколько
 * зарезервировать разом.
 */
export async function runJobBatch(
  db: Database,
  handlers: Record<string, JobHandler>,
  options: { limit?: number; leaseMs?: number } = {},
): Promise<{ done: number; retried: number; deadLettered: number; leasesLost: number }> {
  const limit = options.limit ?? 10;
  const leaseOptions = options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs };
  let done = 0;
  let retried = 0;
  let deadLettered = 0;
  let leasesLost = 0;

  const count = (outcome: 'retry' | 'dead_letter' | 'lease_lost'): void => {
    if (outcome === 'retry') retried += 1;
    else if (outcome === 'dead_letter') deadLettered += 1;
    else leasesLost += 1;
  };

  for (let processed = 0; processed < limit; processed += 1) {
    const [job] = await claimJobs(db, { ...leaseOptions, limit: 1 });
    if (job === undefined) {
      break;
    }

    const handler = handlers[job.kind];
    if (handler === undefined) {
      // Неизвестный вид задания — не молчаливый пропуск: иначе задание
      // навсегда остаётся в очереди и никто об этом не узнает.
      count(await failJob(db, job, 'unknown_job_kind'));
      continue;
    }

    try {
      await handler(job, {
        renewLease: () =>
          options.leaseMs === undefined ? renewLease(db, job) : renewLease(db, job, options.leaseMs),
      });
      if (await completeJob(db, job)) {
        done += 1;
      } else {
        // Аренда ушла к другому исполнителю, пока шла работа. Результат этого
        // прохода не засчитывается: задание выполнит владелец аренды.
        leasesLost += 1;
      }
    } catch (error) {
      const code = error instanceof Error ? error.name : 'unknown_error';
      count(await failJob(db, job, code));
    }
  }

  return { done, retried, deadLettered, leasesLost };
}
