import type { FastifyInstance } from 'fastify';

import type { Database } from '../../shared/db/pool.ts';
import { withTenantTransaction } from '../../shared/db/tenant.ts';

/**
 * Чтения для клиента: начальный снимок и лента подтверждённых изменений
 * (T-06, docs/06, раздел 7).
 *
 * Клиент синхронизирует команды и подтверждённые изменения, а не копии таблиц.
 * Отсюда два свойства, без которых он молча теряет данные.
 *
 * Лента не имеет дыр. Устройство двигает курсор только по непрерывной
 * последовательности; пропущенная пачка означает изменения, которых оно не
 * увидит никогда. Поэтому разрыв — это отказ с требованием нового снимка, а не
 * тихая выдача того, что осталось.
 *
 * Снимок и курсор согласованы. Снимок собирается в одной транзакции
 * `repeatable read` вместе со счётчиком: собранный из разных мгновений, он
 * противоречил бы собственному курсору, и часть изменений не попала бы ни в
 * него, ни в последующую ленту.
 */

/** Потолок страницы. Один запрос не должен вытягивать всю историю. */
const MAX_PULL_LIMIT = 200;
const DEFAULT_PULL_LIMIT = 100;

/**
 * Предел снимка. Больше этого клиент дочитывает отдельными bounded-запросами;
 * молчаливое обрезание хуже пустоты — человек считает, что получил всё.
 */
const SNAPSHOT_LIMIT = 200;

/** Схема изменений, ниже которой клиент не поймёт ленту. */
const MIN_SUPPORTED_SCHEMA = 1;

interface PullQuery {
  readonly after?: string;
  readonly limit?: string;
  readonly upper_bound_seq?: string;
}

class BadQueryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function readNonNegative(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadQueryError(name);
  }
  return value;
}

export function registerSyncReadRoutes(app: FastifyInstance, database: Database): void {
  app.get('/sync/pull', async (request, reply) => {
    const userId = request.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const query = request.query as PullQuery;
    let after: number;
    let limit: number;
    let requestedBound: number | null;
    try {
      after = readNonNegative(query.after, 'invalid_cursor', 0);
      limit = readNonNegative(query.limit, 'invalid_limit', DEFAULT_PULL_LIMIT);
      const bound = query.upper_bound_seq;
      requestedBound =
        bound === undefined || bound === '' ? null : readNonNegative(bound, 'invalid_cursor', 0);
    } catch (error) {
      return reply.code(400).send({ error: (error as BadQueryError).code });
    }
    if (limit < 1 || limit > MAX_PULL_LIMIT) {
      return reply.code(400).send({ error: 'invalid_limit' });
    }

    const result = await withTenantTransaction(database, userId, async (client) => {
      const counter = await client.query<{ seq: string }>(
        'SELECT seq FROM user_change_counters WHERE user_id = $1',
        [userId],
      );
      const committed = Number(counter.rows[0]?.seq ?? 0);

      // Граница первой страницы держится на всех последующих: иначе
      // постраничный обход смешивает состояние до и после новых команд.
      // Клиентскую границу поднимать выше подтверждённой нельзя.
      const upperBound = requestedBound === null ? committed : Math.min(requestedBound, committed);

      if (after > upperBound) {
        return { status: 400 as const, body: { error: 'invalid_cursor' } };
      }

      const next = await client.query<{ min: string | null }>(
        'SELECT MIN(seq)::text AS min FROM sync_change_batches WHERE seq > $1',
        [after],
      );
      const firstAvailable = next.rows[0]?.min;
      if (firstAvailable !== null && firstAvailable !== undefined) {
        if (Number(firstAvailable) > after + 1) {
          // Пачки между курсором и первой доступной удалены по сроку
          // удержания. Продолжать с места, которого больше нет, нельзя:
          // клиент решит, что получил всё.
          return { status: 410 as const, body: { error: 'cursor_expired' } };
        }
      }

      const page = await client.query<{
        seq: string;
        changes: unknown[];
        schema_version: number;
        created_at: Date;
      }>(
        `SELECT seq, changes, schema_version, created_at
           FROM sync_change_batches
          WHERE seq > $1 AND seq <= $2
          ORDER BY seq
          LIMIT $3`,
        [after, upperBound, limit + 1],
      );

      const hasMore = page.rows.length > limit;
      const batches = hasMore ? page.rows.slice(0, limit) : page.rows;
      const last = batches[batches.length - 1];

      return {
        status: 200 as const,
        body: {
          batches: batches.map((row) => ({
            seq: row.seq,
            changes: row.changes,
            schema_version: row.schema_version,
            created_at: row.created_at.toISOString(),
          })),
          next_after: last === undefined ? after : Number(last.seq),
          has_more: hasMore,
          upper_bound_seq: String(upperBound),
          min_supported_schema: MIN_SUPPORTED_SCHEMA,
          server_time: new Date().toISOString(),
        },
      };
    });

    return reply.code(result.status).send(result.body);
  });

  app.get('/bootstrap', async (request, reply) => {
    const userId = request.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const snapshot = await withTenantTransaction(
      database,
      userId,
      async (client) => {
        // Счётчик читается первым и в той же транзакции: курсор снимка обязан
        // относиться ровно к тому состоянию, которое ниже и собирается.
        const counter = await client.query<{ seq: string }>(
          'SELECT seq FROM user_change_counters WHERE user_id = $1',
          [userId],
        );

        const user = await client.query<{ id: string; locale: string; status: string }>(
          'SELECT id, locale, status FROM users WHERE id = $1',
          [userId],
        );

        const profile = await client.query<{
          display_name: string | null;
          onboarding_state: string;
          system_style: string;
          timezone: string;
          day_boundary_minutes: number;
          schedule_confirmed: boolean;
        }>(
          `SELECT display_name, onboarding_state, system_style, timezone,
                  day_boundary_minutes, schedule_confirmed
             FROM user_profiles WHERE user_id = $1`,
          [userId],
        );

        const goals = await client.query(
          `SELECT id, title, why, start_date, target_date, status, priority, version
             FROM goals
            WHERE deleted_at IS NULL
            ORDER BY priority DESC, created_at
            LIMIT $1`,
          [SNAPSHOT_LIMIT + 1],
        );

        const quests = await client.query(
          `SELECT id, template_id, recurrence_key, execution_status, placement_state,
                  completion_variant, assigned_user_day, template_snapshot, version
             FROM quest_occurrences
            WHERE execution_status IN ('planned', 'active', 'partial')
            ORDER BY created_at
            LIMIT $1`,
          [SNAPSHOT_LIMIT + 1],
        );

        return { counter, user, profile, goals, quests };
      },
      { isolation: 'repeatable read' },
    );

    const userRow = snapshot.user.rows[0];
    if (userRow === undefined) {
      // Токен действителен, а строки нет: аккаунт удалён между проверкой и
      // чтением. Отдавать пустой снимок нельзя — клиент примет его за «всё
      // потеряно» и затрёт локальные записи.
      return reply.code(404).send({ error: 'account_unavailable' });
    }

    const truncate = <T>(rows: readonly T[]): { rows: T[]; truncated: boolean } => ({
      rows: rows.slice(0, SNAPSHOT_LIMIT) as T[],
      truncated: rows.length > SNAPSHOT_LIMIT,
    });
    const goals = truncate(snapshot.goals.rows);
    const quests = truncate(snapshot.quests.rows);

    return reply.send({
      server_time: new Date().toISOString(),
      snapshot_cursor: snapshot.counter.rows[0]?.seq ?? '0',
      min_supported_schema: MIN_SUPPORTED_SCHEMA,
      user: userRow,
      profile: snapshot.profile.rows[0] ?? null,
      goals: goals.rows,
      quests: quests.rows,
      // Обрезание объявляется явно: молча укороченный список клиент примет за
      // полный и решит, что остальное удалено.
      truncated: { goals: goals.truncated, quests: quests.truncated },
    });
  });
}
