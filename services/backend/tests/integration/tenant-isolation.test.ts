import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { createPool, withTransaction, type Database } from '../../src/shared/db/pool.ts';

/**
 * Прототип P0-04: изоляция арендаторов на уровне PostgreSQL.
 *
 * Это spike, а не production-модуль: настоящие таблицы и identity появляются в
 * P1-01/P1-02. Проверяется механизм, который docs/09 (раздел 2) объявляет
 * обязательным — RLS, runtime-роль без BYPASSRLS и транзакционный контекст
 * арендатора, не протекающий между соединениями пула.
 *
 * Почему это проверяется до написания доменных таблиц: если механизм окажется
 * неработоспособным, переделывать придётся все таблицы сразу, а обнаружится это
 * на реальных данных двух пользователей.
 */

const RUNTIME_ROLE = 'spike_app_runtime';
const TABLE = 'spike_goals';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

let ownerDb: Database;
let runtimeDb: Database;

/**
 * Контекст арендатора задаётся через set_config(..., is_local => true):
 * значение живёт до конца транзакции. `SET LOCAL` не принимает параметры, и
 * подстановка идентификатора в строку запроса открыла бы SQL-инъекцию через
 * данные токена.
 */
async function withTenant<T>(
  db: Database,
  userId: string,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
    return run(client);
  });
}

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await ownerDb.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await ownerDb.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
        EXECUTE 'DROP OWNED BY ${RUNTIME_ROLE}';
        EXECUTE 'DROP ROLE ${RUNTIME_ROLE}';
      END IF;
    END
    $$
  `);

  // Runtime-роль намеренно без SUPERUSER и BYPASSRLS: владелец таблицы и
  // суперпользователь обходят политики, и тест на них был бы бессмысленным.
  await ownerDb.query(
    `CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );

  await ownerDb.query(`
    CREATE TABLE ${TABLE} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      title TEXT NOT NULL
    )
  `);

  // FORCE обязателен: без него владелец таблицы читает чужие строки, и при
  // ошибочном запуске приложения под владельцем изоляция исчезает молча.
  await ownerDb.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  await ownerDb.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);

  // NULLIF: пустая строка в настройке иначе падает при приведении к uuid, и
  // ошибка выглядела бы как сбой запроса, а не как отсутствие контекста.
  await ownerDb.query(`
    CREATE POLICY tenant_isolation ON ${TABLE}
      USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  `);

  await ownerDb.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  await ownerDb.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${RUNTIME_ROLE}`);

  await ownerDb.query(`INSERT INTO ${TABLE} (user_id, title) VALUES ($1, $2), ($3, $4)`, [
    TENANT_A,
    'Цель арендатора A',
    TENANT_B,
    'Цель арендатора B',
  ]);

  const url = new URL(config.database.connectionString);
  url.username = RUNTIME_ROLE;
  url.password = '';
  runtimeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 1 });
});

afterAll(async () => {
  await runtimeDb.end();
  await ownerDb.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await ownerDb.query(`DROP OWNED BY ${RUNTIME_ROLE}`);
  await ownerDb.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`);
  await ownerDb.end();
});

describe('runtime-роль', () => {
  it('не является superuser и не обходит RLS', async () => {
    // Без этой проверки весь остальной файл мог бы проходить вхолостую.
    const result = await runtimeDb.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );

    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('изоляция арендаторов', () => {
  it('арендатор видит только свои строки', async () => {
    const rows = await withTenant(runtimeDb, TENANT_A, async (client) => {
      const result = await client.query<{ title: string }>(`SELECT title FROM ${TABLE}`);
      return result.rows;
    });

    expect(rows).toEqual([{ title: 'Цель арендатора A' }]);
  });

  it('арендатор не может изменить чужую строку', async () => {
    const updated = await withTenant(runtimeDb, TENANT_A, async (client) => {
      const result = await client.query(`UPDATE ${TABLE} SET title = $1 WHERE user_id = $2`, [
        'Перехвачено',
        TENANT_B,
      ]);
      return result.rowCount;
    });

    // Чужая строка не видна, поэтому UPDATE не находит цели и не сообщает об
    // ошибке: это ожидаемое поведение, а не признак успеха операции.
    expect(updated).toBe(0);

    const check = await ownerDb.query<{ title: string }>(
      `SELECT title FROM ${TABLE} WHERE user_id = $1`,
      [TENANT_B],
    );
    expect(check.rows[0]).toEqual({ title: 'Цель арендатора B' });
  });

  it('арендатор не может удалить чужую строку', async () => {
    const deleted = await withTenant(runtimeDb, TENANT_A, async (client) => {
      const result = await client.query(`DELETE FROM ${TABLE} WHERE user_id = $1`, [TENANT_B]);
      return result.rowCount;
    });

    expect(deleted).toBe(0);

    const check = await ownerDb.query(`SELECT 1 FROM ${TABLE} WHERE user_id = $1`, [TENANT_B]);
    expect(check.rowCount).toBe(1);
  });

  it('арендатор не может записать строку от чужого имени', async () => {
    await expect(
      withTenant(runtimeDb, TENANT_A, async (client) => {
        await client.query(`INSERT INTO ${TABLE} (user_id, title) VALUES ($1, $2)`, [
          TENANT_B,
          'Подложенная цель',
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);

    const check = await ownerDb.query(`SELECT 1 FROM ${TABLE} WHERE user_id = $1`, [TENANT_B]);
    expect(check.rowCount).toBe(1);
  });
});

describe('контекст арендатора', () => {
  it('без контекста не отдаёт ни одной строки', async () => {
    const result = await withTransaction(runtimeDb, async (client) => {
      return client.query(`SELECT title FROM ${TABLE}`);
    });

    // Запрет по умолчанию: забытый контекст должен приводить к пустому ответу,
    // а не к выдаче всех строк.
    expect(result.rowCount).toBe(0);
  });

  it('не протекает в следующую транзакцию того же соединения пула', async () => {
    // Пул на одно соединение: следующая транзакция гарантированно берёт тот же
    // физический сеанс, в котором контекст был задан.
    await withTenant(runtimeDb, TENANT_A, async (client) => {
      const result = await client.query(`SELECT title FROM ${TABLE}`);
      expect(result.rowCount).toBe(1);
    });

    const afterCommit = await withTransaction(runtimeDb, async (client) => {
      return client.query(`SELECT title FROM ${TABLE}`);
    });

    expect(afterCommit.rowCount).toBe(0);
  });

  it('разные арендаторы в одном пуле видят разные данные', async () => {
    const seenByA = await withTenant(runtimeDb, TENANT_A, async (client) => {
      const result = await client.query<{ title: string }>(`SELECT title FROM ${TABLE}`);
      return result.rows.map((row) => row.title);
    });
    const seenByB = await withTenant(runtimeDb, TENANT_B, async (client) => {
      const result = await client.query<{ title: string }>(`SELECT title FROM ${TABLE}`);
      return result.rows.map((row) => row.title);
    });

    expect(seenByA).toEqual(['Цель арендатора A']);
    expect(seenByB).toEqual(['Цель арендатора B']);
  });
});
