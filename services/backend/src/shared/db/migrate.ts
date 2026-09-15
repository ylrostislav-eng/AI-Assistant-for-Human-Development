import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../config.ts';
import { createPool, withTransaction, type Database } from './pool.ts';

/**
 * Команда миграций: применяет неприменённые .sql по возрастанию имени и
 * записывает их в ledger `schema_migrations`.
 *
 * Почему так, а не «применить все файлы заново»: повторный прогон на рабочей
 * базе обязан быть безопасным, иначе разворачивание превращается в ручную
 * операцию с проверкой глазами.
 *
 * Почему сверяется контрольная сумма: изменение уже применённого файла молча
 * разводит схему на разных серверах, и расхождение обнаруживается позже — на
 * данных, а не на развёртывании.
 */

export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations',
);

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export class MigrationChecksumError extends Error {}

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function ensureLedger(db: Database): Promise<void> {
  // Таблица ledger создаётся самой командой, а не миграцией: иначе первая
  // миграция не может быть записана — её некуда записать.
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readMigrationFiles(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export async function runMigrations(
  db: Database,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await ensureLedger(db);

  const files = await readMigrationFiles(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of files) {
    const sql = await readFile(path.join(migrationsDir, name), 'utf8');
    const hash = checksum(sql);

    const existing = await db.query<{ checksum: string }>(
      'SELECT checksum FROM schema_migrations WHERE name = $1',
      [name],
    );

    const previous = existing.rows[0];
    if (previous !== undefined) {
      if (previous.checksum !== hash) {
        throw new MigrationChecksumError(
          `Миграция ${name} изменилась после применения. Нужна новая миграция, а не правка применённой.`,
        );
      }
      skipped.push(name);
      continue;
    }

    // Миграция и запись о ней — одна транзакция: иначе падение между ними
    // оставляет схему применённой, но не учтённой, и следующий прогон
    // выполняет её второй раз.
    await withTransaction(db, async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        name,
        hash,
      ]);
    });

    applied.push(name);
  }

  return { applied, skipped };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config.database);
  try {
    const result = await runMigrations(db);
    console.log(
      `Миграции: применено ${result.applied.length}, уже применено ранее ${result.skipped.length}`,
    );
    for (const name of result.applied) {
      console.log(`  применена ${name}`);
    }
  } finally {
    await db.end();
  }
}

// Запуск как команды: `npm run migrate`. При импорте из тестов main не вызывается.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('Миграции не выполнены:', error);
    process.exit(1);
  });
}
