import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { findTablesWithoutRls, readTableRlsState } from '../../src/shared/db/rls-audit.ts';
import { withTenantTransaction } from '../../src/shared/db/tenant.ts';

/**
 * Проверки миграции 001: изоляция, составные внешние ключи и ограничения
 * домена (docs/02).
 *
 * Мигратор и приложение подключаются разными ролями: под владельцем таблиц RLS
 * не действует, и проверка изоляции под ним прошла бы вхолостую.
 */

const RUNTIME_ROLE = 'app_runtime';

const USER_A = '55555555-5555-4555-8555-555555555555';
const USER_B = '66666666-6666-4666-8666-666666666666';

const MIGRATED_TABLES = [
  'users',
  'user_profiles',
  'user_preferences',
  'consent_records',
  'devices',
  'sessions',
];

let ownerDb: Database;
let runtimeDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  // Состояние базы после других файлов проверок неизвестно, поэтому схема
  // приводится к чистому виду и миграции применяются заново.
  await ownerDb.query(`DROP TABLE IF EXISTS ${MIGRATED_TABLES.join(', ')} CASCADE`);
  await ownerDb.query('DROP TABLE IF EXISTS schema_migrations');

  const result = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  expect(result.applied).toContain('001_identity_profile.sql');

  await ownerDb.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    USER_A,
    'apple',
    'subject-a',
  ]);
  await ownerDb.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    USER_B,
    'apple',
    'subject-b',
  ]);
  await ownerDb.query('INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2), ($3, $4)', [
    USER_A,
    'Пользователь A',
    USER_B,
    'Пользователь B',
  ]);

  const url = new URL(config.database.connectionString);
  url.username = RUNTIME_ROLE;
  url.password = '';
  runtimeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 2 });
});

afterAll(async () => {
  await runtimeDb.end();
  await ownerDb.query(`DROP TABLE IF EXISTS ${MIGRATED_TABLES.join(', ')} CASCADE`);
  await ownerDb.query('DROP TABLE IF EXISTS schema_migrations');
  await ownerDb.end();
});

describe('миграция', () => {
  it('повторный прогон ничего не применяет', async () => {
    const second = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('001_identity_profile.sql');
  });

  it('создала все таблицы identity и profile', async () => {
    const state = await readTableRlsState(ownerDb);
    const tables = state.map((row) => row.table);

    for (const table of MIGRATED_TABLES) {
      expect(tables).toContain(table);
    }
  });
});

describe('покрытие RLS', () => {
  it('ни одна пользовательская таблица не осталась без ENABLE, FORCE и политики', async () => {
    const missing = await findTablesWithoutRls(ownerDb);

    // Сообщение важнее факта падения: оно называет забытую таблицу.
    expect(missing.map((row) => row.table)).toEqual([]);
  });

  it('проверка замечает таблицу без RLS', async () => {
    // Отрицательный контроль: без него проверка выше могла бы всегда возвращать
    // пустой список и ничего не значить.
    await ownerDb.query('CREATE TABLE rls_control (user_id UUID NOT NULL)');
    try {
      const missing = await findTablesWithoutRls(ownerDb);
      expect(missing.map((row) => row.table)).toEqual(['rls_control']);
    } finally {
      await ownerDb.query('DROP TABLE rls_control');
    }
  });
});

describe('изоляция на реальных таблицах', () => {
  it('пользователь видит только свой профиль', async () => {
    const names = await withTenantTransaction(runtimeDb, USER_A, async (client) => {
      const result = await client.query<{ display_name: string }>(
        'SELECT display_name FROM user_profiles',
      );
      return result.rows.map((row) => row.display_name);
    });

    expect(names).toEqual(['Пользователь A']);
  });

  it('пользователь видит в users только собственную запись', async () => {
    const ids = await withTenantTransaction(runtimeDb, USER_B, async (client) => {
      const result = await client.query<{ id: string }>('SELECT id FROM users');
      return result.rows.map((row) => row.id);
    });

    expect(ids).toEqual([USER_B]);
  });

  it('без контекста пользователя не видно ничего', async () => {
    const result = await runtimeDb.query('SELECT id FROM user_profiles');

    expect(result.rowCount).toBe(0);
  });
});

describe('составные внешние ключи', () => {
  it('сессия не может ссылаться на устройство другого пользователя', async () => {
    const device = await ownerDb.query<{ id: string }>(
      `INSERT INTO devices (user_id, installation_id, platform)
       VALUES ($1, $2, 'ios') RETURNING id`,
      [USER_B, 'install-b'],
    );
    const deviceId = device.rows[0]?.id;

    // Устройство принадлежит B, сессия создаётся для A: одиночный внешний ключ
    // такую связь пропустил бы.
    await expect(
      ownerDb.query(
        `INSERT INTO sessions (user_id, device_id, family_id, refresh_hash, expires_at)
         VALUES ($1, $2, gen_random_uuid(), 'hash-1', now() + interval '30 days')`,
        [USER_A, deviceId],
      ),
    ).rejects.toThrow(/sessions_device_same_owner|violates foreign key/i);
  });

  it('сессия со своим устройством создаётся', async () => {
    const device = await ownerDb.query<{ id: string }>(
      `INSERT INTO devices (user_id, installation_id, platform)
       VALUES ($1, $2, 'ios') RETURNING id`,
      [USER_A, 'install-a'],
    );

    await expect(
      ownerDb.query(
        `INSERT INTO sessions (user_id, device_id, family_id, refresh_hash, expires_at)
         VALUES ($1, $2, gen_random_uuid(), 'hash-2', now() + interval '30 days')`,
        [USER_A, device.rows[0]?.id],
      ),
    ).resolves.toBeDefined();
  });
});

describe('ограничения домена', () => {
  it('граница дня вне диапазона 0…1439 отклоняется', async () => {
    await expect(
      ownerDb.query('UPDATE user_profiles SET day_boundary_minutes = 1440 WHERE user_id = $1', [
        USER_A,
      ]),
    ).rejects.toThrow(/user_profiles_boundary_range/);
  });

  it('пара издатель и subject уникальна', async () => {
    await expect(
      ownerDb.query('INSERT INTO users (auth_issuer, auth_subject) VALUES ($1, $2)', [
        'apple',
        'subject-a',
      ]),
    ).rejects.toThrow(/users_identity_unique/);
  });

  it('срок действия сессии должен быть позже выпуска', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO sessions (user_id, family_id, refresh_hash, issued_at, expires_at)
         VALUES ($1, gen_random_uuid(), 'hash-3', now(), now() - interval '1 day')`,
        [USER_A],
      ),
    ).rejects.toThrow(/sessions_expiry_after_issue/);
  });
});
