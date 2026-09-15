import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { findTablesWithoutRls } from '../../src/shared/db/rls-audit.ts';
import { withTenantTransaction } from '../../src/shared/db/tenant.ts';

/**
 * Проверки миграции 002: связи слоя целей и изоляция.
 *
 * Главное здесь — не «таблицы создались», а что база не даёт связать цель,
 * веху и проект разных пользователей или разных целей.
 */

const RUNTIME_ROLE = 'app_runtime';

const USER_A = '77777777-7777-4777-8777-777777777777';
const USER_B = '88888888-8888-4888-8888-888888888888';

const ALL_TABLES = [
  'goal_dependencies',
  'projects',
  'milestones',
  'goal_metrics',
  'goals',
  'sessions',
  'devices',
  'consent_records',
  'user_preferences',
  'user_profiles',
  'users',
];

let ownerDb: Database;
let runtimeDb: Database;
let goalA: string;
let goalB: string;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await ownerDb.query(`DROP TABLE IF EXISTS ${ALL_TABLES.join(', ')} CASCADE`);
  await ownerDb.query('DROP TABLE IF EXISTS schema_migrations');
  const applied = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  expect(applied.applied).toContain('002_goals.sql');

  await ownerDb.query(
    'INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3), ($4, $5, $6)',
    [USER_A, 'apple', 'goal-a', USER_B, 'apple', 'goal-b'],
  );

  const goals = await ownerDb.query<{ id: string; user_id: string }>(
    `INSERT INTO goals (user_id, title, start_date)
     VALUES ($1, 'Английский', DATE '2026-09-01'), ($2, 'Бег', DATE '2026-09-01')
     RETURNING id, user_id`,
    [USER_A, USER_B],
  );
  goalA = goals.rows.find((row) => row.user_id === USER_A)?.id ?? '';
  goalB = goals.rows.find((row) => row.user_id === USER_B)?.id ?? '';

  const url = new URL(config.database.connectionString);
  url.username = RUNTIME_ROLE;
  url.password = '';
  runtimeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 2 });
});

afterAll(async () => {
  await runtimeDb.end();
  await ownerDb.query(`DROP TABLE IF EXISTS ${ALL_TABLES.join(', ')} CASCADE`);
  await ownerDb.query('DROP TABLE IF EXISTS schema_migrations');
  await ownerDb.end();
});

describe('покрытие RLS после миграции 002', () => {
  it('новые таблицы тоже закрыты политиками', async () => {
    const missing = await findTablesWithoutRls(ownerDb);

    expect(missing.map((row) => row.table)).toEqual([]);
  });
});

describe('связи между пользователями', () => {
  it('веха не может принадлежать цели другого пользователя', async () => {
    await expect(
      ownerDb.query(
        'INSERT INTO milestones (user_id, goal_id, title, ordinal) VALUES ($1, $2, $3, 1)',
        [USER_A, goalB, 'Чужая веха'],
      ),
    ).rejects.toThrow(/milestones_goal_same_owner|violates foreign key/i);
  });

  it('метрика не может принадлежать цели другого пользователя', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO goal_metrics (user_id, goal_id, name, unit, direction, aggregation)
         VALUES ($1, $2, 'Слова', 'шт', 'increase', 'sum')`,
        [USER_A, goalB],
      ),
    ).rejects.toThrow(/goal_metrics_goal_same_owner|violates foreign key/i);
  });
});

describe('связь проекта с вехой', () => {
  it('проект не может ссылаться на веху другой цели', async () => {
    const otherGoal = await ownerDb.query<{ id: string }>(
      `INSERT INTO goals (user_id, title, start_date)
       VALUES ($1, 'Вторая цель', DATE '2026-09-01') RETURNING id`,
      [USER_A],
    );
    const otherGoalId = otherGoal.rows[0]?.id;

    const milestone = await ownerDb.query<{ id: string }>(
      `INSERT INTO milestones (user_id, goal_id, title, ordinal)
       VALUES ($1, $2, 'Веха второй цели', 1) RETURNING id`,
      [USER_A, otherGoalId],
    );

    // Оба объекта принадлежат одному пользователю: проверка владельца это
    // пропустила бы. Ограничение требует совпадения цели, как в docs/02.
    await expect(
      ownerDb.query(
        'INSERT INTO projects (user_id, goal_id, milestone_id, title) VALUES ($1, $2, $3, $4)',
        [USER_A, goalA, milestone.rows[0]?.id, 'Проект'],
      ),
    ).rejects.toThrow(/projects_milestone_same_goal|violates foreign key/i);
  });

  it('проект с вехой своей цели создаётся', async () => {
    const milestone = await ownerDb.query<{ id: string }>(
      `INSERT INTO milestones (user_id, goal_id, title, ordinal)
       VALUES ($1, $2, 'Своя веха', 9) RETURNING id`,
      [USER_A, goalA],
    );

    await expect(
      ownerDb.query(
        'INSERT INTO projects (user_id, goal_id, milestone_id, title) VALUES ($1, $2, $3, $4)',
        [USER_A, goalA, milestone.rows[0]?.id, 'Свой проект'],
      ),
    ).resolves.toBeDefined();
  });
});

describe('зависимости целей', () => {
  it('цель не может зависеть от самой себя', async () => {
    await expect(
      ownerDb.query(
        'INSERT INTO goal_dependencies (user_id, predecessor_goal_id, successor_goal_id) VALUES ($1, $2, $2)',
        [USER_A, goalA],
      ),
    ).rejects.toThrow(/goal_dependencies_no_self/);
  });
});

describe('ограничения домена', () => {
  it('целевая дата раньше начала отклоняется', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO goals (user_id, title, start_date, target_date)
         VALUES ($1, 'Назад во времени', DATE '2026-09-10', DATE '2026-09-01')`,
        [USER_A],
      ),
    ).rejects.toThrow(/goals_target_after_start/);
  });

  it('неизвестный способ агрегации метрики отклоняется', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO goal_metrics (user_id, goal_id, name, unit, direction, aggregation)
         VALUES ($1, $2, 'Метрика', 'шт', 'increase', 'среднее')`,
        [USER_A, goalA],
      ),
    ).rejects.toThrow(/goal_metrics_aggregation_known/);
  });
});

describe('изоляция слоя целей', () => {
  it('пользователь видит только свои цели', async () => {
    const titles = await withTenantTransaction(runtimeDb, USER_B, async (client) => {
      const result = await client.query<{ title: string }>('SELECT title FROM goals');
      return result.rows.map((row) => row.title);
    });

    expect(titles).toEqual(['Бег']);
  });

  it('пользователь не может создать цель от чужого имени', async () => {
    await expect(
      withTenantTransaction(runtimeDb, USER_A, async (client) => {
        await client.query(
          `INSERT INTO goals (user_id, title, start_date)
           VALUES ($1, 'Подложенная цель', DATE '2026-09-01')`,
          [USER_B],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});
