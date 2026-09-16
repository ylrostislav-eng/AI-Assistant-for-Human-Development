import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Классификация ошибок и утечки в ответе — проверки по аудиту
 * `docs/15-backend-review.md` (R7).
 *
 * Общий `catch` в обновлении сессии отвечал 401 и при недоступной базе. Для
 * клиента 401 на refresh означает «сессия недействительна»: он стирает
 * локальный журнал и требует войти заново. Временный сбой базы не должен
 * приводить к потере несинхронизированных записей.
 */

const UNREACHABLE_PORT = 5599;

let ownerDb: Database;
let runtimeDb: Database;
let app: FastifyInstance;
let brokenApp: FastifyInstance;
let brokenDb: Database;
let refreshToken: string;

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const url = new URL(base.database.connectionString);
  url.username = 'app_runtime';
  url.password = '';
  runtimeDb = createPool({ ...base.database, connectionString: url.toString(), maxConnections: 3 });

  const config: AppConfig = { ...base, devAuthEnabled: true };
  app = createApp({ config, database: runtimeDb });

  const login = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { subject: 'классификация-ошибок' },
  });
  refreshToken = login.json().refresh_token;

  // Второе приложение с заведомо недоступной базой: сбой инфраструктуры
  // воспроизводится честно, без подмены внутренних функций.
  const brokenUrl = new URL(base.database.connectionString);
  brokenUrl.port = String(UNREACHABLE_PORT);
  brokenDb = createPool({
    ...base.database,
    connectionString: brokenUrl.toString(),
    maxConnections: 1,
    connectionTimeoutMillis: 1_000,
  });
  brokenApp = createApp({ config, database: brokenDb });
});

afterAll(async () => {
  await app.close();
  await brokenApp.close();
  await brokenDb.end();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R7: классификация ошибок обновления сессии', () => {
  it('недоступная база не выдаётся за недействительный токен', async () => {
    const response = await brokenApp.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: refreshToken },
    });

    // 401 заставил бы клиента стереть локальный журнал из-за временного сбоя.
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.json()).toMatchObject({ error: 'service_unavailable' });
  });

  it('недействительный токен по-прежнему отклоняется как 401', async () => {
    // Отрицательный контроль: исправление не должно превращать настоящий отказ
    // в сбой сервера.
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: 'нет такого токена' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'invalid_refresh_token' });
  });
});

describe('R7: ответ и запись при внутренней ошибке', () => {
  it('ответ не пересказывает внутренности и даёт идентификатор запроса', async () => {
    const response = await brokenApp.inject({
      method: 'GET',
      url: '/health/ready',
    });

    const body = response.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(String(UNREACHABLE_PORT));
    expect(JSON.stringify(body)).not.toContain('127.0.0.1');
  });

  it('текст ошибки базы не попадает в лог', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    // Ошибка PostgreSQL с `detail`: там лежит значение строки, нарушившей
    // ограничение, то есть пользовательский текст.
    const failure = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      detail: 'Key (title)=(МАЯК-встреча с врачом) already exists.',
    });
    const leaking = createApp({
      config: { ...loadConfig(), devAuthEnabled: true },
      database: {
        query: () => Promise.reject(failure),
        connect: () => Promise.reject(failure),
      } as unknown as Database,
    });

    try {
      await leaking.inject({ method: 'POST', url: '/auth/dev-login', payload: { subject: 'x' } });
    } finally {
      await leaking.close();
    }

    const output = lines.join('\n');
    expect(output).toContain('request_failed');
    expect(output).not.toContain('МАЯК');
    expect(output).not.toContain('duplicate key');
    // Код нарушения безопасен и нужен для разбора.
    expect(output).toContain('23505');
  });

  it('адрес и порт базы не попадают в лог', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    await brokenApp.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: refreshToken },
    });

    const output = lines.join('\n');
    // Сбой обязан быть записан: пустой вывод прошёл бы проверку на утечку
    // вхолостую.
    expect(output).toContain('session_refresh_failed');
    // Печать объекта ошибки целиком вывела бы адрес и порт, а для ошибки
    // PostgreSQL — значение строки, нарушившей ограничение.
    expect(output).not.toContain(String(UNREACHABLE_PORT));
    expect(output).not.toContain('127.0.0.1');
  });
});
