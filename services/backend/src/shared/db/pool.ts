import pg from 'pg';

import type { DatabaseConfig } from '../../config.ts';

/**
 * Доступ к PostgreSQL через параметризованный SQL (docs/01, раздел 2).
 * ORM намеренно нет: командная транзакция держит явные locks и пишет ledger,
 * и скрытые запросы ORM в этом месте мешают рассуждать о порядке блокировок.
 */

export type Database = pg.Pool;
export type TransactionClient = pg.PoolClient;

export function createPool(config: DatabaseConfig): Database {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
  });
}

/**
 * Одна транзакция на одну команду. Клиент возвращается в пул в любом случае:
 * утечка клиента при исключении исчерпывает пул и выглядит позже как зависание
 * несвязанного запроса.
 */
export interface TransactionOptions {
  /**
   * Уровень изоляции. `repeatable read` нужен там, где несколько запросов
   * обязаны видеть одно состояние: снимок, собранный из разных мгновений,
   * противоречит собственному курсору, и часть изменений не попадёт ни в него,
   * ни в последующую ленту.
   *
   * Задаётся в самом `BEGIN`: отдельная команда `SET TRANSACTION` допустима
   * только до первого запроса, а контекст пользователя устанавливается раньше.
   */
  readonly isolation?: 'repeatable read';
}

export async function withTransaction<T>(
  db: Database,
  run: (client: TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query(
      options.isolation === undefined ? 'BEGIN' : `BEGIN ISOLATION LEVEL ${options.isolation}`,
    );
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // ROLLBACK может сам упасть на разорванном соединении; исходную ошибку
    // важно не потерять, она объясняет причину отката.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Соединение всё равно будет закрыто при release.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Проверка живости соединения для readiness-пробы. */
export async function checkConnection(db: Database): Promise<void> {
  await db.query('SELECT 1');
}
