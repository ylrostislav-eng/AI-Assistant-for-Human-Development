import { createHmac, randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Вход через Telegram на реальной схеме (T-01, docs/14, раздел 3).
 *
 * Токен бота здесь синтетический: проверяется наш протокол, а не связь с
 * Telegram. Живой запуск Mini App — отдельная проверка на устройстве, и она
 * этим набором не заменяется.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const OWNER_ID = '42';
const SECOND_ID = '43';

let ownerDb: Database;
let runtimeDb: Database;
let app: FastifyInstance;
let closedApp: FastifyInstance;

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const url = new URL(base.database.connectionString);
  url.username = 'app_runtime';
  url.password = '';
  runtimeDb = createPool({ ...base.database, connectionString: url.toString(), maxConnections: 4 });

  const config: AppConfig = {
    ...base,
    telegram: {
      botToken: BOT_TOKEN,
      webhookSecret: null,
      allowedUserIds: [OWNER_ID, SECOND_ID],
      maxAgeSeconds: 300,
      futureSkewSeconds: 30,
    },
  };
  app = createApp({ config, database: runtimeDb });

  // Второе приложение без токена: маршрута для него не существует.
  closedApp = createApp({
    config: { ...base, telegram: { ...config.telegram, botToken: null } },
    database: runtimeDb,
  });
});

afterAll(async () => {
  await app.close();
  await closedApp.close();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key] as string}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');

  const params = new URLSearchParams(fields);
  params.append('hash', hash);
  return params.toString();
}

function launch(telegramId: string, marker = randomUUID()): string {
  return signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: marker,
    user: JSON.stringify({ id: Number(telegramId), first_name: 'Владелец' }),
  });
}

async function login(initData: string, installationId?: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/telegram',
    payload: {
      init_data: initData,
      ...(installationId === undefined ? {} : { installation_id: installationId }),
    },
  });
}

describe('вход через Telegram', () => {
  it('подлинный запуск выдаёт сессию', async () => {
    const response = await login(launch(OWNER_ID));

    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, string>;
    expect(body['access_token']).toBeTruthy();
    expect(body['refresh_token']).toBeTruthy();
  });

  it('выданный токен открывает доступ к собственным данным', async () => {
    const session = (await login(launch(OWNER_ID))).json() as Record<string, string>;

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session['access_token'] as string}` },
    });

    // Доказательство Telegram дальше не пересылается: работает собственная
    // сессия (docs/14, раздел 3).
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user_id: session['user_id'] });
  });

  it('повторный запуск того же человека ведёт в тот же аккаунт', async () => {
    const first = (await login(launch(OWNER_ID))).json() as Record<string, string>;
    const second = (await login(launch(OWNER_ID))).json() as Record<string, string>;

    // Внутренний идентификатор неизменен: иначе каждый вход создавал бы
    // нового человека и терял всю историю.
    expect(second['user_id']).toBe(first['user_id']);
  });

  it('разные люди попадают в разные аккаунты', async () => {
    const owner = (await login(launch(OWNER_ID))).json() as Record<string, string>;
    const other = (await login(launch(SECOND_ID))).json() as Record<string, string>;

    expect(other['user_id']).not.toBe(owner['user_id']);
  });

  it('подделанная подпись не пускает', async () => {
    const forged = launch(OWNER_ID).replace(/hash=[0-9a-f]+$/, `hash=${'0'.repeat(64)}`);

    const response = await login(forged);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'initdata_forged' });
  });

  it('человек вне allowlist не пускается', async () => {
    const stranger = signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: randomUUID(),
      user: JSON.stringify({ id: 999, first_name: 'Чужой' }),
    });

    const response = await login(stranger);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'user_not_allowed' });
    // Аккаунт при отказе не заводится: иначе список допущенных не значил бы
    // ничего, кроме отказа в выдаче токена.
    const created = await ownerDb.query('SELECT id FROM users WHERE auth_subject = $1', ['999']);
    expect(created.rowCount).toBe(0);
  });

  it('повторное предъявление того же доказательства отклоняется', async () => {
    const proof = launch(OWNER_ID);

    const first = await login(proof);
    const again = await login(proof);

    // Украденную строку подпись безопасной не делает, поэтому одно
    // доказательство обменивается ровно на одну семью сессий. Цена известна:
    // потерянный ответ требует нового запуска Mini App.
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ error: 'initdata_already_used' });
  });

  it('перестановка ключей не обходит защиту от повтора', async () => {
    const proof = launch(OWNER_ID);
    await login(proof);

    const reordered = new URLSearchParams([...new URLSearchParams(proof).entries()].reverse());

    expect((await login(reordered.toString())).statusCode).toBe(401);
  });

  it('лишнее поле в теле запроса отклоняется', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/telegram',
      payload: { init_data: launch(OWNER_ID), bot_token: BOT_TOKEN },
    });

    // Токен бота клиенту передавать нечего, и принимать его тем более.
    expect(response.statusCode).toBe(400);
  });

  it('без настроенного токена бота маршрута не существует', async () => {
    const response = await closedApp.inject({
      method: 'POST',
      url: '/auth/telegram',
      payload: { init_data: launch(OWNER_ID) },
    });

    expect(response.statusCode).toBe(404);
  });

  it('приостановленный аккаунт не входит', async () => {
    const session = (await login(launch(SECOND_ID))).json() as Record<string, string>;
    await ownerDb.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [
      session['user_id'],
    ]);

    const response = await login(launch(SECOND_ID));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'account_unavailable' });

    await ownerDb.query(`UPDATE users SET status = 'active' WHERE id = $1`, [session['user_id']]);
  });

  it('строка initData не попадает в лог при отказе', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };

    try {
      await login(launch(OWNER_ID).replace(/hash=[0-9a-f]+$/, `hash=${'1'.repeat(64)}`));
    } finally {
      console.error = original;
    }

    // Доказательство действует минутами: попав в лог, оно станет ключом к
    // аккаунту для любого, кто до лога доберётся.
    expect(lines.join('\n')).not.toContain('query_id');
  });
});
