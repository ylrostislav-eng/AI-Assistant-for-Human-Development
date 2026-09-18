import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Уровень и накопленное в боте (P3-02).
 *
 * XP, которого человек не видит, не существует. Но и показывать его можно
 * только так, как он записан в журнале: число, названное ботом от себя,
 * разойдётся с журналом, и сойдутся они лишь в тот день, когда человек
 * перестанет доверять обоим.
 *
 * Отдельно проверяется, что новичку не врут: ноль называется нулём, а не
 * прячется за бодрой формулировкой.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-уровней';

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;

let nextSender = 440000000;
function sender(): string {
  nextSender += 1;
  return String(nextSender);
}

let nextUpdateId = 24000;

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

async function press(token: string, from: string): Promise<void> {
  nextUpdateId += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    payload: {
      update_id: nextUpdateId,
      callback_query: {
        id: `cb-${nextUpdateId}`,
        from: { id: Number(from), is_bot: false, first_name: 'Владелец' },
        message: { message_id: 1, chat: { id: Number(from), type: 'private' } },
        data: token,
      },
    },
  });
  expect(response.statusCode).toBe(200);
}

async function run(from: string): Promise<void> {
  await processPendingUpdates(workerDb, { allowedUserIds: [from] });
}

async function lastReply(from: string): Promise<{
  kind: string;
  body: string;
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } | null;
}> {
  const rows = await ownerDb.query<{
    kind: string;
    body: string;
    reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } | null;
  }>(
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

async function doneButton(from: string): Promise<string> {
  const markup = (await lastReply(from)).reply_markup;
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (button.text.startsWith('Сделал')) {
        return button.callback_data;
      }
    }
  }
  throw new Error('Кнопки «Сделал» нет в ответе');
}

async function started(): Promise<string> {
  const from = sender();
  await deliver('/start', from);
  await run(from);
  return from;
}

/** Задание на указанную меру, выполненное кнопкой. */
async function doQuest(from: string, measure: string, title = 'Английский'): Promise<void> {
  await deliver(`/new ${title} ${measure}`, from);
  await run(from);
  await deliver('/today', from);
  await run(from);
  await press(await doneButton(from), from);
  await run(from);
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

describe('команда /me', () => {
  it('новичку называет ноль, а не подбадривает', async () => {
    const from = await started();
    await deliver('/me', from);
    await run(from);

    const reply = await lastReply(from);
    expect(reply.kind).toBe('me');
    expect(reply.body).toContain('Уровень 0');
    // Все показатели начинаются с нуля (AGENTS.md). Спрятать ноль за бодрой
    // формулировкой значит начать отношения со вранья.
    expect(reply.body).toContain('0 XP');
  });

  it('показывает накопленное после выполнения', async () => {
    const from = await started();
    await doQuest(from, '40м');

    await deliver('/me', from);
    await run(from);

    // Сорок минут по базовой ставке — 20 XP, до первого уровня не хватает.
    const reply = await lastReply(from);
    expect(reply.body).toContain('20 XP');
    expect(reply.body).toContain('Уровень 0');
  });

  it('называет, сколько осталось до следующего уровня', async () => {
    const from = await started();
    await doQuest(from, '40м');

    await deliver('/me', from);
    await run(from);

    // Порог первого уровня — 28.25 XP, набрано 20: осталось 8.25.
    expect((await lastReply(from)).body).toContain('8.25');
  });
});

describe('повышение уровня', () => {
  it('называется сразу в ответе на кнопку', async () => {
    const from = await started();
    await doQuest(from, '60м');

    // Час — это 30 XP, порог первого уровня 28.25.
    const reply = await lastReply(from);
    expect(reply.body).toContain('30 XP');
    expect(reply.body).toContain('Уровень 1');
  });

  it('без повышения об уровне не сообщается', async () => {
    const from = await started();
    await doQuest(from, '10м');

    // Пять XP — до уровня далеко. Сообщать о неслучившемся повышении значило
    // бы обесценить сообщение о случившемся.
    const reply = await lastReply(from);
    expect(reply.body).toContain('5 XP');
    expect(reply.body).not.toContain('Уровень');
  });
});
