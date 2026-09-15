import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { findTablesWithoutRls } from '../../src/shared/db/rls-audit.ts';
import { withTenantTransaction } from '../../src/shared/db/tenant.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки миграции 005: идемпотентность команд и порядок изменений.
 *
 * Проверяется то, из-за чего повторная доставка приводит ко второму списанию
 * или начислению: ключ идемпотентности, уникальность номера пачки и
 * принадлежность курсора устройству своего пользователя.
 */

const RUNTIME_ROLE = 'app_runtime';

const USER_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const COMMAND = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

let ownerDb: Database;
let runtimeDb: Database;
let deviceA: string;
let deviceB: string;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  const applied = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  expect(applied.applied).toContain('005_sync.sql');

  await ownerDb.query(
    'INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3), ($4, $5, $6)',
    [USER_A, 'apple', 'sync-a', USER_B, 'apple', 'sync-b'],
  );

  const devices = await ownerDb.query<{ id: string; user_id: string }>(
    `INSERT INTO devices (user_id, installation_id, platform)
     VALUES ($1, 'install-a', 'ios'), ($2, 'install-b', 'ios')
     RETURNING id, user_id`,
    [USER_A, USER_B],
  );
  deviceA = devices.rows.find((row) => row.user_id === USER_A)?.id ?? '';
  deviceB = devices.rows.find((row) => row.user_id === USER_B)?.id ?? '';

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

describe('покрытие RLS после миграции 005', () => {
  it('служебные таблицы тоже закрыты политиками', async () => {
    const missing = await findTablesWithoutRls(ownerDb);

    expect(missing.map((row) => row.table)).toEqual([]);
  });
});

describe('идемпотентность команд', () => {
  it('повтор команды того же пользователя отклоняется', async () => {
    await ownerDb.query(
      `INSERT INTO command_receipts (user_id, command_id, payload_hash, committed_seq)
       VALUES ($1, $2, 'hash-1', 1)`,
      [USER_A, COMMAND],
    );

    // Второй вызов той же команды не создаёт вторую квитанцию: именно на этом
    // держится «один эффект на одну команду» при повторной доставке.
    await expect(
      ownerDb.query(
        `INSERT INTO command_receipts (user_id, command_id, payload_hash, committed_seq)
         VALUES ($1, $2, 'hash-1', 2)`,
        [USER_A, COMMAND],
      ),
    ).rejects.toThrow(/command_receipts_command_unique/);
  });

  it('тот же идентификатор команды у другого пользователя допускается', async () => {
    // Идентификаторы генерирует клиент, и совпадение между пользователями —
    // не конфликт. Глобальная уникальность отклоняла бы чужую команду.
    await expect(
      ownerDb.query(
        `INSERT INTO command_receipts (user_id, command_id, payload_hash, committed_seq)
         VALUES ($1, $2, 'hash-2', 1)`,
        [USER_B, COMMAND],
      ),
    ).resolves.toBeDefined();
  });

  it('номер фиксации должен быть положительным', async () => {
    await expect(
      ownerDb.query(
        `INSERT INTO command_receipts (user_id, command_id, payload_hash, committed_seq)
         VALUES ($1, gen_random_uuid(), 'hash-3', 0)`,
        [USER_A],
      ),
    ).rejects.toThrow(/command_receipts_seq_positive/);
  });
});

describe('порядок изменений', () => {
  it('две пачки с одним номером недопустимы', async () => {
    await ownerDb.query(
      `INSERT INTO sync_change_batches (user_id, seq, changes) VALUES ($1, 1, '[]'::jsonb)`,
      [USER_A],
    );

    // Неоднозначный номер означает, что часть изменений устройство пропустит:
    // курсор перескочит через недополученную пачку.
    await expect(
      ownerDb.query(
        `INSERT INTO sync_change_batches (user_id, seq, changes) VALUES ($1, 1, '[]'::jsonb)`,
        [USER_A],
      ),
    ).rejects.toThrow(/sync_change_batches_seq_unique/);
  });

  it('счётчик пользователя не может стать отрицательным', async () => {
    await ownerDb.query('INSERT INTO user_change_counters (user_id, seq) VALUES ($1, 5)', [USER_A]);

    await expect(
      ownerDb.query('UPDATE user_change_counters SET seq = -1 WHERE user_id = $1', [USER_A]),
    ).rejects.toThrow(/user_change_counters_seq_non_negative/);
  });
});

describe('курсоры устройств', () => {
  it('курсор не создаётся для устройства другого пользователя', async () => {
    await expect(
      ownerDb.query('INSERT INTO device_sync_cursors (user_id, device_id) VALUES ($1, $2)', [
        USER_A,
        deviceB,
      ]),
    ).rejects.toThrow(/device_sync_cursors_device_same_owner|violates foreign key/i);
  });

  it('у устройства один курсор', async () => {
    await ownerDb.query('INSERT INTO device_sync_cursors (user_id, device_id) VALUES ($1, $2)', [
      USER_A,
      deviceA,
    ]);

    await expect(
      ownerDb.query('INSERT INTO device_sync_cursors (user_id, device_id) VALUES ($1, $2)', [
        USER_A,
        deviceA,
      ]),
    ).rejects.toThrow(/device_sync_cursors_device_unique/);
  });
});

describe('изоляция служебных таблиц', () => {
  it('квитанции другого пользователя не видны', async () => {
    await ownerDb.query(
      `INSERT INTO command_receipts (user_id, command_id, payload_hash, committed_seq)
       VALUES ($1, gen_random_uuid(), 'видимость', 7)`,
      [USER_B],
    );

    const hashes = await withTenantTransaction(runtimeDb, USER_A, async (client) => {
      const result = await client.query<{ payload_hash: string }>(
        'SELECT payload_hash FROM command_receipts',
      );
      return result.rows.map((row) => row.payload_hash);
    });

    expect(hashes).not.toContain('видимость');
  });
});
