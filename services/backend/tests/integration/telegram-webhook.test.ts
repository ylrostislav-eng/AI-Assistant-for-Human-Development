import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Приём обновлений Telegram (T-02a, docs/14, раздел 4).
 *
 * Это отдельная граница доверия: сюда стучится не наш клиент, а Telegram, и
 * access-токена здесь нет. Подтверждение происхождения — секрет в заголовке,
 * и он не равен токену бота.
 *
 * Главное свойство: обновление сохраняется **до** ответа. Telegram не
 * повторяет то, что мы подтвердили успехом, поэтому ответ 200 за
 * несохранённое обновление теряет его навсегда.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-7f3a91';

let ownerDb: Database;
let runtimeDb: Database;
let app: FastifyInstance;
let closedApp: FastifyInstance;
let config: AppConfig;

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const url = new URL(base.database.connectionString);
  url.username = 'app_runtime';
  url.password = '';
  runtimeDb = createPool({ ...base.database, connectionString: url.toString(), maxConnections: 4 });

  config = {
    ...base,
    telegram: {
      botToken: BOT_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      allowedUserIds: ['554187947'],
      maxAgeSeconds: 300,
      futureSkewSeconds: 30,
    },
  };
  app = createApp({ config, database: runtimeDb });

  // Второе приложение без секрета: маршрута для него не существует.
  closedApp = createApp({
    config: { ...config, telegram: { ...config.telegram, webhookSecret: null } },
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

afterEach(() => {
  vi.restoreAllMocks();
});

let nextUpdateId = 1000;

function messageUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: 5,
      date: 1789600000,
      from: { id: 554187947, is_bot: false, first_name: 'Ростислав' },
      chat: { id: 554187947, type: 'private' },
      text: '/start',
    },
    ...overrides,
  };
}

async function send(
  update: Record<string, unknown>,
  secret: string | null = WEBHOOK_SECRET,
  target: FastifyInstance = app,
) {
  return target.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
    payload: update,
  });
}

interface StoredUpdate {
  readonly update_id: string;
  readonly bot_id: string;
  readonly kind: string | null;
  readonly sender_telegram_id: string | null;
  readonly payload: Record<string, unknown>;
}

async function stored(updateId: number): Promise<StoredUpdate[]> {
  const rows = await ownerDb.query<StoredUpdate>(
    'SELECT update_id, bot_id, kind, sender_telegram_id, payload FROM telegram_updates WHERE update_id = $1',
    [updateId],
  );
  return rows.rows;
}

describe('происхождение обновления', () => {
  it('без секрета не принимается и ничего не сохраняет', async () => {
    const update = messageUpdate();

    const response = await send(update, null);

    expect(response.statusCode).toBe(401);
    expect(await stored(update['update_id'] as number)).toHaveLength(0);
  });

  it('с чужим секретом не принимается', async () => {
    const update = messageUpdate();

    const response = await send(update, 'не тот секрет');

    expect(response.statusCode).toBe(401);
    expect(await stored(update['update_id'] as number)).toHaveLength(0);
  });

  it('с верным секретом принимается и сохраняется', async () => {
    const update = messageUpdate();

    const response = await send(update);

    expect(response.statusCode).toBe(200);
    const rows = await stored(update['update_id'] as number);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('message');
  });

  it('без настроенного секрета маршрута не существует', async () => {
    // 404, а не 503: ненастроенный приём не должен подтверждать своё
    // существование.
    expect((await send(messageUpdate(), WEBHOOK_SECRET, closedApp)).statusCode).toBe(404);
  });

  it('секрет не попадает в лог', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    await send(messageUpdate(), 'не тот секрет');

    expect(lines.join('\n')).not.toContain('секрет');
  });
});

describe('повторная доставка', () => {
  it('то же обновление не создаёт второй записи', async () => {
    const update = messageUpdate();

    const first = await send(update);
    const again = await send(update);

    // Telegram повторяет доставку при обрыве. Второй эффект от одного нажатия
    // кнопки — это вторая награда за одно действие.
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(await stored(update['update_id'] as number)).toHaveLength(1);
  });

  it('повтор отмечается в ответе', async () => {
    const update = messageUpdate();

    await send(update);
    const again = await send(update);

    expect(again.json()).toMatchObject({ duplicate: true });
  });
});

describe('отправитель', () => {
  it('берётся из подписанного поля, а не из чата', async () => {
    const update = messageUpdate({
      message: {
        message_id: 6,
        date: 1789600000,
        from: { id: 554187947, is_bot: false, first_name: 'Ростислав' },
        chat: { id: 999999, type: 'private' },
        text: 'привет',
      },
    });

    await send(update);

    // chat.id не заменяет from.id: в пересланном сообщении это разные люди, и
    // перепутать их значит выполнить чужую команду от имени владельца.
    expect((await stored(update['update_id'] as number))[0]?.sender_telegram_id).toBe('554187947');
  });

  it('у пересланного сообщения отправителем считается переславший', async () => {
    const update = messageUpdate({
      message: {
        message_id: 7,
        date: 1789600000,
        from: { id: 554187947, is_bot: false, first_name: 'Ростислав' },
        chat: { id: 554187947, type: 'private' },
        forward_from: { id: 111222, is_bot: false, first_name: 'Кто-то' },
        text: 'завершить задание',
      },
    });

    await send(update);

    // Пересланное содержимое — данные, а не полномочия его автора.
    expect((await stored(update['update_id'] as number))[0]?.sender_telegram_id).toBe('554187947');
  });

  it('у нажатия кнопки отправитель тоже подписанный', async () => {
    nextUpdateId += 1;
    const update = {
      update_id: nextUpdateId,
      callback_query: {
        id: 'cb-1',
        from: { id: 554187947, is_bot: false, first_name: 'Ростислав' },
        data: 'done:1',
      },
    };

    await send(update);

    const rows = await stored(update.update_id);
    expect(rows[0]?.kind).toBe('callback_query');
    expect(rows[0]?.sender_telegram_id).toBe('554187947');
  });

  it('неизвестный вид обновления сохраняется, а не отбрасывается', async () => {
    nextUpdateId += 1;
    const update = { update_id: nextUpdateId, chat_boost: { chat: { id: 1 } } };

    const response = await send(update);

    // Telegram добавляет виды обновлений со временем. Отбросить незнакомое
    // значит молча потерять то, что, возможно, было важным.
    expect(response.statusCode).toBe(200);
    const rows = await stored(update.update_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBeNull();
  });
});

describe('отказ вместо ложного подтверждения', () => {
  it('недоступная база не получает ответ «принято»', async () => {
    const broken = createApp({
      config,
      database: {
        query: () => Promise.reject(new Error('база недоступна')),
        connect: () => Promise.reject(new Error('база недоступна')),
      } as unknown as Database,
    });

    try {
      const response = await send(messageUpdate(), WEBHOOK_SECRET, broken);

      // Telegram не повторяет то, что мы подтвердили: ответив 200 за
      // несохранённое обновление, мы теряем его навсегда.
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await broken.close();
    }
  });

  it('обновление без номера отклоняется', async () => {
    const response = await send({ message: { text: 'без номера' } });

    // Без update_id нечем отличить повтор от нового сообщения.
    expect(response.statusCode).toBe(400);
  });

  it('слишком большое тело отклоняется', async () => {
    nextUpdateId += 1;
    const response = await send({
      update_id: nextUpdateId,
      message: { text: 'x'.repeat(200_000) },
    });

    expect(response.statusCode).toBe(413);
  });
});
