import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { findTablesWithoutRls } from '../../src/shared/db/rls-audit.ts';
import { withTenantTransaction } from '../../src/shared/db/tenant.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки миграции 003: две оси состояния задания, связи и пользовательский
 * день.
 *
 * Проверяется не наличие таблиц, а то, что база не даёт построить бессмысленное
 * состояние: экземпляр чужого шаблона, вариант завершения у незавершённого
 * задания, два дня на одну дату.
 */

const RUNTIME_ROLE = 'app_runtime';

const USER_A = '99999999-9999-4999-8999-999999999999';
const USER_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const SPEC = JSON.stringify({ duration_seconds: 1800, unit: 'seconds', success_rule: 'duration' });

let ownerDb: Database;
let runtimeDb: Database;
let templateA: string;
let templateB: string;
let dayA: string;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  const applied = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  expect(applied.applied).toContain('003_quests.sql');

  await ownerDb.query(
    'INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3), ($4, $5, $6)',
    [USER_A, 'apple', 'quest-a', USER_B, 'apple', 'quest-b'],
  );

  const templates = await ownerDb.query<{ id: string; user_id: string }>(
    `INSERT INTO quest_templates (user_id, title, normal_spec)
     VALUES ($1, 'Английский 30 минут', $3::jsonb), ($2, 'Бег 5 км', $3::jsonb)
     RETURNING id, user_id`,
    [USER_A, USER_B, SPEC],
  );
  templateA = templates.rows.find((row) => row.user_id === USER_A)?.id ?? '';
  templateB = templates.rows.find((row) => row.user_id === USER_B)?.id ?? '';

  const day = await ownerDb.query<{ id: string }>(
    `INSERT INTO user_days (user_id, local_date, zone_snapshot, boundary_snapshot, starts_at, ends_at)
     VALUES ($1, DATE '2026-09-15', 'Europe/Moscow', 240,
             TIMESTAMPTZ '2026-09-15T01:00:00Z', TIMESTAMPTZ '2026-09-16T01:00:00Z')
     RETURNING id`,
    [USER_A],
  );
  dayA = day.rows[0]?.id ?? '';

  const url = new URL(config.database.connectionString);
  url.username = RUNTIME_ROLE;
  url.password = '';
  runtimeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 2 });
});

afterAll(async () => {
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

async function insertOccurrence(
  userId: string,
  templateId: string,
  key: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await ownerDb.query<{ id: string }>(
    `INSERT INTO quest_occurrences
       (user_id, template_id, recurrence_key, timezone_snapshot, template_snapshot,
        execution_status, placement_state, completion_variant, assigned_user_day)
     VALUES ($1, $2, $3, 'Europe/Moscow', '{}'::jsonb,
             COALESCE($4, 'planned'), COALESCE($5, 'unscheduled'), $6, $7)
     RETURNING id`,
    [
      userId,
      templateId,
      key,
      extra['execution_status'] ?? null,
      extra['placement_state'] ?? null,
      extra['completion_variant'] ?? null,
      extra['assigned_user_day'] ?? null,
    ],
  );
  return result.rows[0]?.id ?? '';
}

describe('покрытие RLS после миграции 003', () => {
  it('новые таблицы закрыты политиками', async () => {
    const missing = await findTablesWithoutRls(ownerDb);

    expect(missing.map((row) => row.table)).toEqual([]);
  });
});

describe('две оси состояния', () => {
  it('перенос не меняет состояние выполнения', async () => {
    const id = await insertOccurrence(USER_A, templateA, 'ось-1', {
      placement_state: 'rescheduled',
    });

    const row = await ownerDb.query<{ execution_status: string; placement_state: string }>(
      'SELECT execution_status, placement_state FROM quest_occurrences WHERE id = $1',
      [id],
    );

    // Перенесённая задача остаётся запланированной: перенос — не пропуск.
    expect(row.rows[0]).toEqual({ execution_status: 'planned', placement_state: 'rescheduled' });
  });

  it('вариант завершения невозможен у незавершённого задания', async () => {
    await expect(
      insertOccurrence(USER_A, templateA, 'ось-2', {
        execution_status: 'planned',
        completion_variant: 'minimum',
      }),
    ).rejects.toThrow(/quest_occurrences_variant_needs_completion/);
  });

  it('неизвестное состояние выполнения отклоняется', async () => {
    await expect(
      insertOccurrence(USER_A, templateA, 'ось-3', { execution_status: 'почти_сделал' }),
    ).rejects.toThrow(/quest_occurrences_execution_known/);
  });
});

describe('связи заданий', () => {
  it('экземпляр не может ссылаться на шаблон другого пользователя', async () => {
    await expect(insertOccurrence(USER_A, templateB, 'чужой-шаблон')).rejects.toThrow(
      /quest_occurrences_template_same_owner|violates foreign key/i,
    );
  });

  it('повтор ключа у одного шаблона отклоняется', async () => {
    await insertOccurrence(USER_A, templateA, 'день-2026-09-15');

    await expect(insertOccurrence(USER_A, templateA, 'день-2026-09-15')).rejects.toThrow(
      /quest_occurrences_key_unique/,
    );
  });

  it('шаблон не может иметь веху без цели', async () => {
    const goal = await ownerDb.query<{ id: string }>(
      `INSERT INTO goals (user_id, title, start_date)
       VALUES ($1, 'Цель', DATE '2026-09-01') RETURNING id`,
      [USER_A],
    );
    const milestone = await ownerDb.query<{ id: string }>(
      `INSERT INTO milestones (user_id, goal_id, title, ordinal)
       VALUES ($1, $2, 'Веха', 1) RETURNING id`,
      [USER_A, goal.rows[0]?.id],
    );

    await expect(
      ownerDb.query(
        `INSERT INTO quest_templates (user_id, milestone_id, title, normal_spec)
         VALUES ($1, $2, 'Без цели', $3::jsonb)`,
        [USER_A, milestone.rows[0]?.id, SPEC],
      ),
    ).rejects.toThrow(/quest_templates_links_need_goal/);
  });

  it('задание не может зависеть от самого себя', async () => {
    const id = await insertOccurrence(USER_A, templateA, 'зависимость-1');

    await expect(
      ownerDb.query(
        `INSERT INTO quest_dependencies (user_id, predecessor_occurrence_id, successor_occurrence_id)
         VALUES ($1, $2, $2)`,
        [USER_A, id],
      ),
    ).rejects.toThrow(/quest_dependencies_no_self/);
  });
});

describe('пользовательский день', () => {
  it('на одну дату не создаётся второй день', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO user_days (user_id, local_date, zone_snapshot, boundary_snapshot, starts_at, ends_at)
         VALUES ($1, DATE '2026-09-15', 'Europe/Moscow', 240,
                 TIMESTAMPTZ '2026-09-15T01:00:00Z', TIMESTAMPTZ '2026-09-16T01:00:00Z')`,
        [USER_A],
      ),
    ).rejects.toThrow(/user_days_date_unique/);
  });

  it('конец дня не может быть раньше начала', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO user_days (user_id, local_date, zone_snapshot, boundary_snapshot, starts_at, ends_at)
         VALUES ($1, DATE '2026-09-20', 'Europe/Moscow', 240,
                 TIMESTAMPTZ '2026-09-20T01:00:00Z', TIMESTAMPTZ '2026-09-19T01:00:00Z')`,
        [USER_A],
      ),
    ).rejects.toThrow(/user_days_ends_after_starts/);
  });

  it('обязательство дня не берёт задание другого пользователя', async () => {
    const foreign = await insertOccurrence(USER_B, templateB, 'чужое-задание');

    await expect(
      ownerDb.query(
        'INSERT INTO day_commitments (user_id, user_day_id, occurrence_id) VALUES ($1, $2, $3)',
        [USER_A, dayA, foreign],
      ),
    ).rejects.toThrow(/day_commitments_occurrence_same_owner|violates foreign key/i);
  });

  it('минимум не может превышать ожидаемый объём', async () => {
    const own = await insertOccurrence(USER_A, templateA, 'обязательство-1');

    await expect(
      ownerDb.query(
        `INSERT INTO day_commitments (user_id, user_day_id, occurrence_id, frozen_expected_amount, minimum_amount)
         VALUES ($1, $2, $3, 30, 45)`,
        [USER_A, dayA, own],
      ),
    ).rejects.toThrow(/day_commitments_minimum_not_greater/);
  });
});

describe('изоляция заданий', () => {
  it('пользователь видит только свои экземпляры', async () => {
    await insertOccurrence(USER_A, templateA, 'изоляция-a');
    await insertOccurrence(USER_B, templateB, 'изоляция-b');

    const keys = await withTenantTransaction(runtimeDb, USER_B, async (client) => {
      const result = await client.query<{ recurrence_key: string }>(
        'SELECT recurrence_key FROM quest_occurrences ORDER BY recurrence_key',
      );
      return result.rows.map((row) => row.recurrence_key);
    });

    // Утверждения только о собственных строках этой проверки. Первая версия
    // сравнивала весь список целиком и падала при перемешанном порядке: в него
    // попадала строка, созданную соседней проверкой, и результат зависел от
    // того, выполнилась ли она раньше.
    expect(keys).toContain('изоляция-b');
    expect(keys).not.toContain('изоляция-a');
  });
});
