import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { findTablesWithoutRls } from '../../src/shared/db/rls-audit.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки миграции 004: форма события календаря, интервалы доступности и
 * история размещения задания.
 */

const USER_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let ownerDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  const applied = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  expect(applied.applied).toContain('004_calendar.sql');

  await ownerDb.query(
    'INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3), ($4, $5, $6)',
    [USER_A, 'apple', 'cal-a', USER_B, 'apple', 'cal-b'],
  );
});

afterAll(async () => {
  await resetSchema(ownerDb);
  await ownerDb.end();
});

describe('покрытие RLS после миграции 004', () => {
  it('новые таблицы закрыты политиками', async () => {
    const missing = await findTablesWithoutRls(ownerDb);

    expect(missing.map((row) => row.table)).toEqual([]);
  });
});

describe('форма события календаря', () => {
  it('событие со временем создаётся', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO calendar_events (user_id, title, starts_at, ends_at, timezone)
         VALUES ($1, 'Работа', TIMESTAMPTZ '2026-09-15T06:00:00Z',
                 TIMESTAMPTZ '2026-09-15T15:00:00Z', 'Europe/Moscow')`,
        [USER_A],
      ),
    ).resolves.toBeDefined();
  });

  it('событие на весь день создаётся локальными датами', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO calendar_events
           (user_id, title, all_day, local_start_date, local_end_date_exclusive, timezone)
         VALUES ($1, 'Отпуск', true, DATE '2026-10-01', DATE '2026-10-08', 'Europe/Moscow')`,
        [USER_A],
      ),
    ).resolves.toBeDefined();
  });

  it('смешанная форма отклоняется', async () => {
    // И мгновение, и локальная дата в одной записи: после смены пояса они
    // разойдутся, и правильного значения уже не восстановить.
    await expect(
      ownerDb.query(
        `INSERT INTO calendar_events
           (user_id, all_day, starts_at, ends_at, local_start_date, local_end_date_exclusive, timezone)
         VALUES ($1, true, TIMESTAMPTZ '2026-09-15T06:00:00Z', TIMESTAMPTZ '2026-09-15T15:00:00Z',
                 DATE '2026-09-15', DATE '2026-09-16', 'Europe/Moscow')`,
        [USER_A],
      ),
    ).rejects.toThrow(/calendar_events_shape_consistent/);
  });

  it('событие на весь день без локальных дат отклоняется', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO calendar_events (user_id, all_day, starts_at, ends_at, timezone)
         VALUES ($1, true, TIMESTAMPTZ '2026-09-15T06:00:00Z',
                 TIMESTAMPTZ '2026-09-15T15:00:00Z', 'Europe/Moscow')`,
        [USER_A],
      ),
    ).rejects.toThrow(/calendar_events_shape_consistent/);
  });

  it('конец не позже начала отклоняется', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO calendar_events (user_id, starts_at, ends_at, timezone)
         VALUES ($1, TIMESTAMPTZ '2026-09-15T10:00:00Z',
                 TIMESTAMPTZ '2026-09-15T10:00:00Z', 'Europe/Moscow')`,
        [USER_A],
      ),
    ).rejects.toThrow(/calendar_events_timed_order/);
  });

  it('смежные события допускаются', async () => {
    // Диапазоны полуоткрытые: конец одного совпадает с началом следующего и
    // пересечением не считается.
    await ownerDb.query(
      `INSERT INTO calendar_events (user_id, starts_at, ends_at, timezone)
       VALUES ($1, TIMESTAMPTZ '2026-09-16T08:00:00Z', TIMESTAMPTZ '2026-09-16T09:00:00Z', 'UTC')`,
      [USER_A],
    );

    await expect(
      ownerDb.query(
        `INSERT INTO calendar_events (user_id, starts_at, ends_at, timezone)
         VALUES ($1, TIMESTAMPTZ '2026-09-16T09:00:00Z', TIMESTAMPTZ '2026-09-16T10:00:00Z', 'UTC')`,
        [USER_A],
      ),
    ).resolves.toBeDefined();
  });

  it('повторный импорт того же внешнего события отклоняется', async () => {
    await ownerDb.query(
      `INSERT INTO calendar_events (user_id, starts_at, ends_at, timezone, origin, external_ref)
       VALUES ($1, TIMESTAMPTZ '2026-09-17T08:00:00Z', TIMESTAMPTZ '2026-09-17T09:00:00Z',
               'UTC', 'apple_calendar', 'event-123')`,
      [USER_A],
    );

    await expect(
      ownerDb.query(
        `INSERT INTO calendar_events (user_id, starts_at, ends_at, timezone, origin, external_ref)
         VALUES ($1, TIMESTAMPTZ '2026-09-17T08:00:00Z', TIMESTAMPTZ '2026-09-17T09:00:00Z',
                 'UTC', 'apple_calendar', 'event-123')`,
        [USER_A],
      ),
    ).rejects.toThrow(/calendar_events_external_unique/);
  });
});

describe('правила доступности', () => {
  it('интервал через полночь допускается', async () => {
    // Сон с 23:00 до 07:00 — обычное правило. Проверка «конец позже начала»
    // запретила бы его, поэтому её в схеме нет.
    await expect(
      ownerDb.query(
        `INSERT INTO availability_rules
           (user_id, kind, weekdays, wall_start, wall_end, timezone, effective_from)
         VALUES ($1, 'sleep', ARRAY[1,2,3,4,5,6,7]::SMALLINT[], TIME '23:00', TIME '07:00',
                 'Europe/Moscow', DATE '2026-09-01')`,
        [USER_A],
      ),
    ).resolves.toBeDefined();
  });

  it('несуществующий день недели отклоняется', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO availability_rules
           (user_id, kind, weekdays, wall_start, wall_end, timezone, effective_from)
         VALUES ($1, 'work', ARRAY[8]::SMALLINT[], TIME '09:00', TIME '18:00',
                 'Europe/Moscow', DATE '2026-09-01')`,
        [USER_A],
      ),
    ).rejects.toThrow(/availability_rules_weekdays_valid/);
  });
});

describe('история размещения', () => {
  it('ревизия не может ссылаться на план другого пользователя', async () => {
    const template = await ownerDb.query<{ id: string }>(
      `INSERT INTO quest_templates (user_id, title, normal_spec)
       VALUES ($1, 'Задание', '{}'::jsonb) RETURNING id`,
      [USER_A],
    );
    const occurrence = await ownerDb.query<{ id: string }>(
      `INSERT INTO quest_occurrences
         (user_id, template_id, recurrence_key, timezone_snapshot, template_snapshot)
       VALUES ($1, $2, 'once', 'UTC', '{}'::jsonb) RETURNING id`,
      [USER_A, template.rows[0]?.id],
    );
    const foreignPlan = await ownerDb.query<{ id: string }>(
      `INSERT INTO plan_versions (user_id, scope, date_from, date_to)
       VALUES ($1, 'day', DATE '2026-09-15', DATE '2026-09-15') RETURNING id`,
      [USER_B],
    );

    await expect(
      ownerDb.query(
        `INSERT INTO schedule_revisions (user_id, occurrence_id, placement_state, plan_version_id)
         VALUES ($1, $2, 'scheduled', $3)`,
        [USER_A, occurrence.rows[0]?.id, foreignPlan.rows[0]?.id],
      ),
    ).rejects.toThrow(/schedule_revisions_plan_same_owner|violates foreign key/i);
  });
});

describe('ограничения плана', () => {
  it('план, заканчивающийся раньше начала, отклоняется', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO plan_versions (user_id, scope, date_from, date_to)
         VALUES ($1, 'week', DATE '2026-09-15', DATE '2026-09-01')`,
        [USER_A],
      ),
    ).rejects.toThrow(/plan_versions_period_valid/);
  });
});
