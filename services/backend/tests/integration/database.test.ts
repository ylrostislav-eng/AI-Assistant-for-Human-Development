import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { createPool, withTransaction, type Database } from '../../src/shared/db/pool.ts';

/**
 * Интеграционные проверки требуют реальный тестовый PostgreSQL: транзакции,
 * блокировки и миграции нельзя проверить заглушкой — именно поведение сервера
 * и есть предмет проверки (docs/01, раздел 2).
 */

let config: AppConfig;
let db: Database;

beforeAll(async () => {
  config = loadConfig();
  db = createPool(config.database);
  await db.query('DROP TABLE IF EXISTS transaction_smoke');
  await db.query('CREATE TABLE transaction_smoke (id INTEGER PRIMARY KEY)');
});

afterAll(async () => {
  await db.query('DROP TABLE IF EXISTS transaction_smoke');
  await db.end();
});

describe('withTransaction', () => {
  it('фиксирует изменения при успешном выполнении', async () => {
    await withTransaction(db, async (client) => {
      await client.query('INSERT INTO transaction_smoke (id) VALUES (1)');
    });

    const result = await db.query('SELECT id FROM transaction_smoke WHERE id = 1');
    expect(result.rowCount).toBe(1);
  });

  it('откатывает изменения при ошибке и пробрасывает исходную ошибку', async () => {
    await expect(
      withTransaction(db, async (client) => {
        await client.query('INSERT INTO transaction_smoke (id) VALUES (2)');
        throw new Error('сбой посреди команды');
      }),
    ).rejects.toThrow('сбой посреди команды');

    const result = await db.query('SELECT id FROM transaction_smoke WHERE id = 2');
    expect(result.rowCount).toBe(0);
  });

  it('возвращает клиента в пул после отката', async () => {
    // Пул на 10 соединений: утечка клиента проявится зависанием, а не ошибкой,
    // поэтому проверяется серия неудачных транзакций подряд.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await expect(
        withTransaction(db, async () => {
          throw new Error('сбой');
        }),
      ).rejects.toThrow('сбой');
    }

    const result = await db.query('SELECT 1 AS alive');
    expect(result.rows[0]).toEqual({ alive: 1 });
  });
});

describe('GET /health/ready с реальной базой', () => {
  it('возвращает 200 и database: up', async () => {
    const app = createApp({ config, database: db });
    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ready', database: 'up' });
    } finally {
      await app.close();
    }
  });
});
