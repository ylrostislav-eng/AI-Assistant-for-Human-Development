import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import {
  assertSafeDatabaseRole,
  readRolePrivileges,
  UnsafeDatabaseRoleError,
} from '../../src/shared/db/role-guard.ts';

/**
 * Проверка идёт на двух ролях сразу: только так видно, что запрет срабатывает
 * на опасной роли и не срабатывает на безопасной. Проверка, которая всегда
 * запрещает, прошла бы половину этих тестов и была бы бесполезна.
 */

const SAFE_ROLE = 'guard_safe_role';

let ownerDb: Database;
let safeDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await ownerDb.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SAFE_ROLE}') THEN
        EXECUTE 'DROP OWNED BY ${SAFE_ROLE}';
        EXECUTE 'DROP ROLE ${SAFE_ROLE}';
      END IF;
    END
    $$
  `);
  await ownerDb.query(`CREATE ROLE ${SAFE_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`);

  const url = new URL(config.database.connectionString);
  url.username = SAFE_ROLE;
  url.password = '';
  safeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 1 });
});

afterAll(async () => {
  await safeDb.end();
  await ownerDb.query(`DROP OWNED BY ${SAFE_ROLE}`);
  await ownerDb.query(`DROP ROLE IF EXISTS ${SAFE_ROLE}`);
  await ownerDb.end();
});

describe('readRolePrivileges', () => {
  it('различает суперпользователя и обычную роль', async () => {
    const owner = await readRolePrivileges(ownerDb);
    const safe = await readRolePrivileges(safeDb);

    // Тестовый кластер создан initdb -U system, поэтому владелец —
    // суперпользователь; на этом и строится проверка.
    expect(owner.isSuperuser).toBe(true);
    expect(safe).toEqual({ role: SAFE_ROLE, isSuperuser: false, bypassesRls: false });
  });
});

describe('assertSafeDatabaseRole', () => {
  it('отклоняет запуск в production под суперпользователем', async () => {
    await expect(assertSafeDatabaseRole(ownerDb, 'production')).rejects.toBeInstanceOf(
      UnsafeDatabaseRoleError,
    );
  });

  it('в разработке предупреждает, но не мешает запуску', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(assertSafeDatabaseRole(ownerDb, 'development')).resolves.toMatchObject({
        isSuperuser: true,
      });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('пропускает безопасную роль в production', async () => {
    await expect(assertSafeDatabaseRole(safeDb, 'production')).resolves.toEqual({
      role: SAFE_ROLE,
      isSuperuser: false,
      bypassesRls: false,
    });
  });
});
