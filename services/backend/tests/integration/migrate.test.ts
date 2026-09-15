import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { MigrationChecksumError, runMigrations } from '../../src/shared/db/migrate.ts';

/**
 * Каталог миграций собирается во временной папке: проверяется поведение самой
 * команды, а не содержимое доменных миграций (они появляются в P1-01).
 */

let db: Database;
let migrationsDir: string;

beforeAll(async () => {
  db = createPool(loadConfig().database);
});

afterAll(async () => {
  await db.query('DROP TABLE IF EXISTS schema_migrations');
  await db.end();
});

afterEach(async () => {
  await db.query('DROP TABLE IF EXISTS migration_smoke_a');
  await db.query('DROP TABLE IF EXISTS migration_smoke_b');
  await db.query('DROP TABLE IF EXISTS schema_migrations');
  if (migrationsDir !== undefined) {
    await rm(migrationsDir, { recursive: true, force: true });
  }
});

async function createMigrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql, 'utf8');
  }
  return dir;
}

describe('runMigrations', () => {
  it('применяет миграции по порядку имён и записывает их в ledger', async () => {
    migrationsDir = await createMigrationsDir({
      '002_b.sql': 'CREATE TABLE migration_smoke_b (id INTEGER PRIMARY KEY)',
      '001_a.sql': 'CREATE TABLE migration_smoke_a (id INTEGER PRIMARY KEY)',
    });

    const result = await runMigrations(db, migrationsDir);

    expect(result.applied).toEqual(['001_a.sql', '002_b.sql']);
    expect(result.skipped).toEqual([]);

    const ledger = await db.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(ledger.rows.map((row) => row.name)).toEqual(['001_a.sql', '002_b.sql']);
  });

  it('при повторном запуске не применяет ничего заново', async () => {
    migrationsDir = await createMigrationsDir({
      '001_a.sql': 'CREATE TABLE migration_smoke_a (id INTEGER PRIMARY KEY)',
    });

    await runMigrations(db, migrationsDir);
    const second = await runMigrations(db, migrationsDir);

    // Повторное применение CREATE TABLE упало бы с ошибкой: успех второго
    // прогона и есть доказательство идемпотентности.
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['001_a.sql']);
  });

  it('отказывается работать, если применённая миграция изменена', async () => {
    migrationsDir = await createMigrationsDir({
      '001_a.sql': 'CREATE TABLE migration_smoke_a (id INTEGER PRIMARY KEY)',
    });
    await runMigrations(db, migrationsDir);

    await writeFile(
      path.join(migrationsDir, '001_a.sql'),
      'CREATE TABLE migration_smoke_a (id INTEGER PRIMARY KEY, extra TEXT)',
      'utf8',
    );

    await expect(runMigrations(db, migrationsDir)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('не оставляет запись в ledger, если миграция упала', async () => {
    migrationsDir = await createMigrationsDir({
      '001_broken.sql': 'CREATE TABLE migration_smoke_a (id INTEGER PRIMARY KEY); SELECT bad_column',
    });

    await expect(runMigrations(db, migrationsDir)).rejects.toThrow();

    const ledger = await db.query('SELECT name FROM schema_migrations');
    expect(ledger.rowCount).toBe(0);

    // Транзакция должна откатить и созданную таблицу: иначе повторный запуск
    // упадёт на «таблица уже существует» и потребует ручной правки базы.
    const table = await db.query(
      "SELECT to_regclass('public.migration_smoke_a') AS table_name",
    );
    expect(table.rows[0]).toEqual({ table_name: null });
  });
});
