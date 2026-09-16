import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки входа и закрытого по умолчанию доступа.
 *
 * Приложение работает через роль времени выполнения: именно под ней действуют
 * политики изоляции, и именно так оно будет запущено.
 */

const RUNTIME_ROLE = 'app_runtime';

let ownerDb: Database;
let runtimeDb: Database;
let app: FastifyInstance;
let config: AppConfig;

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);

  await resetSchema(ownerDb);
  const applied = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  expect(applied.applied).toContain('007_access_tokens.sql');

  const url = new URL(base.database.connectionString);
  url.username = RUNTIME_ROLE;
  url.password = '';
  runtimeDb = createPool({ ...base.database, connectionString: url.toString(), maxConnections: 4 });

  config = { ...base, devAuthEnabled: true };
  app = createApp({ config, database: runtimeDb });
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

async function login(subject: string): Promise<{
  userId: string;
  accessToken: string;
  refreshToken: string;
  familyId: string;
}> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { subject },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return {
    userId: body.user_id,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    familyId: body.family_id,
  };
}

describe('закрытый по умолчанию доступ', () => {
  it('без токена защищённый маршрут отвечает 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/me' });

    expect(response.statusCode).toBe(401);
  });

  it('с выдуманным токеном отвечает 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer выдуманный' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('заголовок не в формате Bearer отклоняется', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('пробы состояния доступны без токена', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });

  it('ответ 401 не раскрывает причину отказа', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer выдуманный' },
    });

    // Различие «нет такого токена» и «истёк» помогает подбирающему и ничего
    // не даёт владельцу.
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('вход по синтетической личности', () => {
  it('выдаёт пару токенов и пользователя', async () => {
    const session = await login('первый');

    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).not.toBe(session.accessToken);
    expect(session.userId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('тот же subject даёт того же пользователя', async () => {
    const first = await login('повторный');
    const second = await login('повторный');

    // Иначе каждый вход разработчика создавал бы нового пользователя.
    expect(second.userId).toBe(first.userId);
  });

  it('разные subject дают разных пользователей', async () => {
    const first = await login('человек-а');
    const second = await login('человек-б');

    expect(second.userId).not.toBe(first.userId);
  });

  it('при выключенном флаге маршрут отвечает 404', async () => {
    const closed = createApp({
      config: { ...config, devAuthEnabled: false },
      database: runtimeDb,
    });
    try {
      const response = await closed.inject({ method: 'POST', url: '/auth/dev-login', payload: {} });

      // Не 403: отключённый маршрут не подтверждает своё существование.
      expect(response.statusCode).toBe(404);
    } finally {
      await closed.close();
    }
  });
});

describe('доступ по access-токену', () => {
  it('возвращает того пользователя, которому выдан токен', async () => {
    const session = await login('владелец');

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user_id: session.userId });
  });

  it('токен одного пользователя не выдаёт другого', async () => {
    const first = await login('пользователь-1');
    const second = await login('пользователь-2');

    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${second.accessToken}` },
    });

    expect(response.json()).toEqual({ user_id: second.userId });
    expect(response.json()).not.toEqual({ user_id: first.userId });
  });
});

describe('обновление сессии', () => {
  it('выдаёт новую пару и гасит прежний access', async () => {
    const session = await login('обновление');

    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: session.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const next = refreshed.json();

    const withNew = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    expect(withNew.statusCode).toBe(200);

    // Прежний access гасится вместе с refresh: иначе он отвечал бы ещё
    // пятнадцать минут после обновления сессии.
    const withOld = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(withOld.statusCode).toBe(401);
  });

  it('без токена в теле отвечает 400', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} });

    expect(response.statusCode).toBe(400);
  });

  it('повторное использование refresh отзывает семью и сообщает об этом', async () => {
    const session = await login('кража');
    const first = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: session.refreshToken },
    });
    expect(first.statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: session.refreshToken },
    });

    expect(reuse.statusCode).toBe(401);
    // Отдельный код: клиенту нужно понять, что требуется полный вход заново.
    expect(reuse.json()).toEqual({ error: 'token_reuse_detected' });

    const stolenAccess = first.json().access_token;
    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${stolenAccess}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });
});

describe('выход', () => {
  it('отзывает семью, после чего токены не работают', async () => {
    const session = await login('выход');

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { family_id: session.familyId },
    });
    expect(logout.statusCode).toBe(204);

    const afterAccess = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(afterAccess.statusCode).toBe(401);

    const afterRefresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refresh_token: session.refreshToken },
    });
    expect(afterRefresh.statusCode).toBe(401);
  });

  it('без access-токена выход невозможен', async () => {
    const session = await login('выход-без-токена');

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { family_id: session.familyId },
    });

    expect(response.statusCode).toBe(401);
  });

  it('чужую семью отозвать нельзя', async () => {
    const victim = await login('жертва');
    const attacker = await login('нападающий');

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${attacker.accessToken}` },
      payload: { family_id: victim.familyId },
    });
    // Ответ одинаковый: политика изоляции просто не находит чужих строк, и
    // подтверждать существование чужой семьи незачем.
    expect(response.statusCode).toBe(204);

    const victimStillWorks = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${victim.accessToken}` },
    });
    expect(victimStillWorks.statusCode).toBe(200);
  });
});

describe('ошибки сервера', () => {
  it('не пересказывают клиенту внутренности', async () => {
    // Приложение с непригодной базой: любой запрос к ней падает.
    const broken = createApp({
      config,
      database: {
        query: () => Promise.reject(new Error('column "секрет" of relation "sessions" does not exist')),
        connect: () => Promise.reject(new Error('column "секрет" of relation "sessions" does not exist')),
      } as unknown as Database,
    });

    try {
      const response = await broken.inject({
        method: 'POST',
        url: '/auth/dev-login',
        payload: { subject: 'ошибка' },
      });

      expect(response.statusCode).toBe(500);
      // Кроме кода ошибки — только идентификатор запроса: без него человек не
      // может сослаться на свой случай, а с текстом ошибки уехали бы
      // внутренности.
      expect(Object.keys(response.json() as object).sort()).toEqual(['error', 'request_id']);
      expect(response.json()).toMatchObject({ error: 'internal_error' });
      // Живая проверка показала в ответе имя колонки базы — это разведка
      // схемы бесплатно.
      expect(response.body).not.toContain('секрет');
      expect(response.body).not.toContain('relation');
    } finally {
      await broken.close();
    }
  });
});
