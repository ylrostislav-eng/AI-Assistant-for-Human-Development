import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Чтения для клиента: снимок и лента изменений (T-06, docs/06, раздел 7).
 *
 * Главное здесь не «endpoint отвечает 200», а два свойства, без которых клиент
 * молча теряет данные:
 *
 * 1. Лента не имеет дыр. Устройство двигает курсор только по непрерывной
 *    последовательности; пропущенная пачка означает изменения, которых оно не
 *    увидит никогда.
 * 2. Снимок и курсор согласованы. Если снимок собран до пачки 20, а курсор
 *    выдан на 25, то пачки 21–25 не попадут ни в снимок, ни в ленту.
 */

let ownerDb: Database;
let runtimeDb: Database;
let app: FastifyInstance;
let token: string;
let strangerToken: string;

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const url = new URL(base.database.connectionString);
  url.username = 'app_runtime';
  url.password = '';
  runtimeDb = createPool({ ...base.database, connectionString: url.toString(), maxConnections: 4 });

  const config: AppConfig = { ...base, devAuthEnabled: true };
  app = createApp({ config, database: runtimeDb });

  token = (
    await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { subject: 'чтения' } })
  ).json().access_token;
  strangerToken = (
    await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { subject: 'посторонний' } })
  ).json().access_token;
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

/**
 * Отдельный пользователь под проверку.
 *
 * Лента — состояние пользователя, и проверки, которые её меняют (особенно
 * удаление пачки), портят её для всех остальных. Перемешанный порядок это и
 * показал: первая версия набора рассчитывала на то, что проверки идут подряд.
 */
async function newUser(subject: string): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { subject: `${subject}-${randomUUID()}` },
  });
  return login.json().access_token;
}

async function createGoal(title: string, accessToken = token) {
  return app.inject({
    method: 'POST',
    url: '/commands',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      schema_version: 1,
      command_id: randomUUID(),
      device_id: randomUUID(),
      kind: 'create_goal',
      aggregate_id: null,
      expected_version: null,
      client_created_at: '2026-09-16T12:00:00Z',
      depends_on_command_id: null,
      payload: { title, start_date: '2026-09-01' },
    },
  });
}

async function pull(query: string, accessToken = token) {
  return app.inject({
    method: 'GET',
    url: `/sync/pull${query}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

async function bootstrap(accessToken = token) {
  return app.inject({
    method: 'GET',
    url: '/bootstrap',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

describe('лента изменений', () => {
  it('без токена не отдаётся', async () => {
    const response = await app.inject({ method: 'GET', url: '/sync/pull?after=0' });

    expect(response.statusCode).toBe(401);
  });

  it('пустая лента у нового пользователя', async () => {
    const response = await pull('?after=0', await newUser('пустая-лента'));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ batches: [], has_more: false, next_after: 0 });
  });

  it('возвращает пачки по порядку без пропусков', async () => {
    const own = await newUser('без-пропусков');
    await createGoal('Лента 1', own);
    await createGoal('Лента 2', own);
    await createGoal('Лента 3', own);

    const body = (await pull('?after=0', own)).json() as {
      batches: { seq: string; changes: unknown[] }[];
      next_after: number;
      has_more: boolean;
    };

    const numbers = body.batches.map((batch) => Number(batch.seq));
    expect(numbers).toEqual([1, 2, 3]);
    expect(body.next_after).toBe(3);
    expect(body.has_more).toBe(false);
  });

  it('курсор выдаёт только новое', async () => {
    const own = await newUser('курсор');
    await createGoal('До курсора', own);
    const before = (await pull('?after=0', own)).json() as { next_after: number };
    await createGoal('После курсора', own);

    const body = (await pull(`?after=${before.next_after}`, own)).json() as {
      batches: { seq: string }[];
    };

    expect(body.batches.map((batch) => Number(batch.seq))).toEqual([before.next_after + 1]);
  });

  it('страница ограничена, продолжение отмечено', async () => {
    const own = await newUser('страница');
    await createGoal('Страница 1', own);
    await createGoal('Страница 2', own);
    await createGoal('Страница 3', own);

    const body = (await pull('?after=0&limit=2', own)).json() as {
      batches: unknown[];
      has_more: boolean;
      next_after: number;
    };

    expect(body.batches).toHaveLength(2);
    expect(body.has_more).toBe(true);
    expect(body.next_after).toBe(2);
  });

  it('предел страницы нельзя поднять выше потолка', async () => {
    // Иначе один запрос вытягивает всю историю и кладёт и сервер, и клиента.
    const response = await pull('?after=0&limit=100000');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_limit' });
  });

  it('вторая страница не видит изменений, появившихся между страницами', async () => {
    const own = await newUser('границы-страниц');
    for (const title of ['Первая', 'Вторая', 'Третья']) {
      await createGoal(title, own);
    }

    const first = (await pull('?after=0&limit=2', own)).json() as {
      upper_bound_seq: string;
      next_after: number;
    };
    await createGoal('Появилась между страницами', own);

    const second = (await pull(
      `?after=${first.next_after}&upper_bound_seq=${first.upper_bound_seq}`,
      own,
    )).json() as { batches: { seq: string }[] };

    // Граница первой страницы держится на всех последующих: иначе постраничный
    // обход смешивает старое и новое состояние.
    for (const batch of second.batches) {
      expect(Number(batch.seq)).toBeLessThanOrEqual(Number(first.upper_bound_seq));
    }
  });

  it('дыра в ленте требует нового снимка', async () => {
    // Проверка портит ленту необратимо, поэтому пользователь у неё свой.
    const own = await newUser('дыра');
    const goal = await createGoal('Будет вырезана', own);
    const seq = Number(goal.json().committed_seq);
    // Следующая пачка нужна обязательно: без неё дыра оказывается в самом
    // конце ленты и неотличима от «новых изменений нет».
    await createGoal('После вырезанной', own);
    // Удержание изменений ограничено по сроку: старые пачки удаляются, и
    // отставший клиент не может продолжить с места, которого уже нет.
    const mine = (await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${own}` },
    })).json() as { user_id: string };
    await ownerDb.query('DELETE FROM sync_change_batches WHERE user_id = $1 AND seq = $2', [
      mine.user_id,
      seq,
    ]);

    const response = await pull(`?after=${seq - 1}`, own);

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: 'cursor_expired' });
  });

  it('курсор из будущего отклоняется', async () => {
    const own = await newUser('будущее');
    const body = (await pull('?after=0', own)).json() as { upper_bound_seq: string };

    const response = await pull(`?after=${Number(body.upper_bound_seq) + 100}`, own);

    // Такой курсор означает чужую или повреждённую ленту; молча отдать пустоту
    // значит оставить устройство навсегда без изменений.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_cursor' });
  });

  it('чужие пачки не видны', async () => {
    const own = await newUser('изоляция-ленты');
    await createGoal('Своя цель', own);
    await createGoal('Чужая цель', strangerToken);

    const mine = (await pull('?after=0', own)).json() as { batches: unknown[] };

    expect(JSON.stringify(mine.batches)).not.toContain('Чужая цель');
    // Отрицательный контроль: собственные изменения при этом видны, иначе
    // проверка прошла бы и на пустом ответе.
    expect(JSON.stringify(mine.batches)).toContain('goal');
  });
});

describe('начальный снимок', () => {
  it('без токена не отдаётся', async () => {
    expect((await app.inject({ method: 'GET', url: '/bootstrap' })).statusCode).toBe(401);
  });

  it('содержит профиль, цели и курсор', async () => {
    const body = (await bootstrap()).json() as Record<string, unknown>;

    expect(body['user']).toMatchObject({ id: expect.any(String) });
    expect(body['profile']).toMatchObject({ timezone: expect.any(String) });
    expect(Array.isArray(body['goals'])).toBe(true);
    expect(typeof body['snapshot_cursor']).toBe('string');
    expect(typeof body['server_time']).toBe('string');
  });

  it('курсор снимка совпадает со счётчиком изменений', async () => {
    const own = await newUser('курсор-снимка');
    await createGoal('Для счётчика', own);
    const body = (await bootstrap(own)).json() as { snapshot_cursor: string; user: { id: string } };

    const counter = await ownerDb.query<{ seq: string }>(
      'SELECT seq FROM user_change_counters WHERE user_id = $1',
      [body.user.id],
    );

    // Расхождение здесь — это пачки, которые не попадут ни в снимок, ни в
    // ленту: клиент не узнает о них никогда.
    expect(body.snapshot_cursor).toBe(counter.rows[0]?.seq);
  });

  it('изменение после снимка приходит лентой, а не теряется', async () => {
    const own = await newUser('снимок-и-лента');
    const snapshot = (await bootstrap(own)).json() as { snapshot_cursor: string };
    const goal = await createGoal('После снимка', own);

    const body = (await pull(`?after=${snapshot.snapshot_cursor}`, own)).json() as {
      batches: { seq: string }[];
    };

    expect(body.batches.map((batch) => batch.seq)).toContain(goal.json().committed_seq);
  });

  it('снимок не показывает чужих целей', async () => {
    const own = await newUser('изоляция-снимка');
    await createGoal('Своя в снимке', own);
    await createGoal('Совсем чужая', strangerToken);

    const body = (await bootstrap(own)).json() as { goals: { title: string }[] };

    const titles = body.goals.map((goal) => goal.title);
    expect(titles).not.toContain('Совсем чужая');
    expect(titles).toContain('Своя в снимке');
  });

  it('снимок ограничен по объёму и честно об этом сообщает', async () => {
    const body = (await bootstrap()).json() as { truncated: Record<string, boolean> };

    // Молчаливое обрезание хуже пустоты: клиент считает, что получил всё.
    expect(body['truncated']).toMatchObject({ goals: false, quests: false });
  });
});
