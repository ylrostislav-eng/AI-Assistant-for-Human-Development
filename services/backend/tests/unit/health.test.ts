import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import type { AppConfig } from '../../src/config.ts';
import type { Database } from '../../src/shared/db/pool.ts';

const config: AppConfig = {
  environment: 'test',
  devAuthEnabled: false,
  telegram: {
    botToken: null,
    webhookSecret: null,
    allowedUserIds: [],
    maxAgeSeconds: 300,
    futureSkewSeconds: 30,
  },
  server: { host: '127.0.0.1', port: 0 },
  database: {
    connectionString: 'postgres://unused',
    maxConnections: 1,
    connectionTimeoutMillis: 1000,
  },
};

/**
 * База, обращение к которой считается ошибкой теста: так проверяется, что
 * liveness действительно не зависит от БД, а не просто «обычно отвечает».
 */
const forbiddenDatabase = {
  query: () => {
    throw new Error('liveness не должен обращаться к базе данных');
  },
} as unknown as Database;

describe('GET /health', () => {
  it('отвечает ok, не обращаясь к базе данных', async () => {
    const app = createApp({ config, database: forbiddenDatabase });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', environment: 'test' });
    } finally {
      await app.close();
    }
  });
});

describe('GET /health/ready', () => {
  it('возвращает 503 при недоступной базе данных', async () => {
    const brokenDatabase = {
      query: () => Promise.reject(new Error('connection refused')),
    } as unknown as Database;

    const app = createApp({ config, database: brokenDatabase });
    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: 'not_ready', database: 'down' });
      // Детали подключения не должны утекать наружу.
      expect(response.body).not.toContain('connection refused');
    } finally {
      await app.close();
    }
  });
});
