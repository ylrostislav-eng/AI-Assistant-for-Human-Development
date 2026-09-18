import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Повторяющиеся задания (T-08).
 *
 * Писать `/new` каждый день заново — работа, которую система должна взять на
 * себя: это первое, что надоедает при ежедневном пользовании.
 *
 * Экземпляры создаются лениво, при показе списка, а не по расписанию. Причин
 * две. Отдельный планировщик пришлось бы будить в границу дня каждого
 * пользователя и следить, чтобы он не проспал и не сработал дважды; а список,
 * который человек не открыл, ему и не нужен. Ключ повторения — локальная дата
 * пользовательского дня, и уникальность по (пользователь, шаблон, ключ) делает
 * повторный показ безопасным без всякой блокировки.
 *
 * Главное, что проверяется: убранное или выполненное сегодня не возвращается
 * сегодня. Задание, всплывающее обратно после того, как его убрали, — это не
 * мелкая досада, а причина перестать доверять списку.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-повторов';

/** Полдень по Москве: далеко от границы пользовательского дня в 04:00. */
const TODAY = new Date('2026-09-18T09:00:00Z');
const TOMORROW = new Date('2026-09-19T09:00:00Z');

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;

let nextSender = 990000000;
function sender(): string {
  nextSender += 1;
  return String(nextSender);
}

let nextUpdateId = 15000;

async function deliver(text: string, from: string): Promise<void> {
  nextUpdateId += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    payload: {
      update_id: nextUpdateId,
      message: {
        message_id: nextUpdateId,
        date: 1789600000,
        from: { id: Number(from), is_bot: false, first_name: 'Владелец' },
        chat: { id: Number(from), type: 'private' },
        text,
      },
    },
  });
  expect(response.statusCode).toBe(200);
}

async function run(from: string, now: Date = TODAY): Promise<void> {
  await processPendingUpdates(workerDb, { allowedUserIds: [from], now: () => now });
}

interface Row {
  readonly kind: string;
  readonly body: string;
  readonly reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } | null;
}

async function lastReply(from: string): Promise<Row> {
  const rows = await ownerDb.query<Row>(
    `SELECT kind, body, reply_markup FROM telegram_messages
      WHERE chat_id = $1 AND method IS DISTINCT FROM 'answerCallbackQuery'
      ORDER BY created_at DESC LIMIT 1`,
    [from],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error('Ответ не поставлен в очередь');
  }
  return row;
}

async function occurrences(from: string): Promise<{ key: string; status: string }[]> {
  const rows = await ownerDb.query<{ recurrence_key: string; execution_status: string }>(
    `SELECT o.recurrence_key, o.execution_status
       FROM quest_occurrences o
       JOIN users u ON u.id = o.user_id
      WHERE u.auth_subject = $1
      ORDER BY o.recurrence_key, o.created_at`,
    [from],
  );
  return rows.rows.map((row) => ({ key: row.recurrence_key, status: row.execution_status }));
}

/** Первое задание в списке снимается прямо из базы: отмена идёт мимо кнопок. */
async function setStatus(from: string, status: string): Promise<void> {
  await ownerDb.query(
    `UPDATE quest_occurrences SET execution_status = $2
      WHERE user_id = (SELECT id FROM users WHERE auth_subject = $1)`,
    [from, status],
  );
}

async function started(): Promise<string> {
  const from = sender();
  await deliver('/start', from);
  await run(from);
  return from;
}

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);
  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const withRole = (role: string): Database => {
    const url = new URL(base.database.connectionString);
    url.username = role;
    url.password = '';
    return createPool({ ...base.database, connectionString: url.toString(), maxConnections: 3 });
  };
  runtimeDb = withRole('app_runtime');
  workerDb = withRole('app_worker');

  const config: AppConfig = {
    ...base,
    telegram: {
      botToken: BOT_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      allowedUserIds: [],
      maxAgeSeconds: 300,
      futureSkewSeconds: 30,
    },
  };
  app = createApp({ config, database: runtimeDb });
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await workerDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

describe('повторяющееся задание', () => {
  it('создаётся командой и сразу попадает в сегодняшний список', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);

    await deliver('/today', from);
    await run(from);
    expect((await lastReply(from)).body).toContain('Английский');
    expect(await occurrences(from)).toEqual([{ key: '2026-09-18', status: 'planned' }]);
  });

  it('повторный показ списка не создаёт второй экземпляр', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);

    for (let i = 0; i < 3; i += 1) {
      await deliver('/today', from);
      await run(from);
    }

    expect(await occurrences(from)).toHaveLength(1);
  });

  it('возвращается на следующий день', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);

    await deliver('/today', from);
    await run(from, TOMORROW);

    expect(await occurrences(from)).toEqual([
      { key: '2026-09-18', status: 'planned' },
      { key: '2026-09-19', status: 'planned' },
    ]);
  });

  it('убранное сегодня не возвращается сегодня', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);
    await setStatus(from, 'cancelled');

    await deliver('/today', from);
    await run(from);

    // Задание, всплывающее обратно после того, как его убрали, — причина
    // перестать доверять списку целиком.
    expect(await occurrences(from)).toEqual([{ key: '2026-09-18', status: 'cancelled' }]);
    expect((await lastReply(from)).body).toContain('Сегодня заданий нет');
  });

  it('выполненное сегодня не возвращается сегодня', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);
    await setStatus(from, 'completed');

    await deliver('/today', from);
    await run(from);

    expect(await occurrences(from)).toHaveLength(1);
  });

  it('разовое задание на следующий день не появляется', async () => {
    const from = await started();
    await deliver('/new Английский 30м', from);
    await run(from);

    await deliver('/today', from);
    await run(from, TOMORROW);

    // `/new` — это «сегодня», и молчаливое превращение его в ежедневное
    // означало бы, что система сама решила за человека.
    expect(await occurrences(from)).toEqual([{ key: '2026-09-18', status: 'planned' }]);
  });

  it('подсказка называет обе команды', async () => {
    const from = await started();
    expect((await lastReply(from)).body).toContain('/every');
    expect((await lastReply(from)).body).toContain('/new');
  });
});
