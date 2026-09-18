import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Убрать задание кнопкой (T-07).
 *
 * До этого ошибку было не исправить никак: задание, созданное с опечаткой или
 * по ошибке, оставалось в списке навсегда и мозолило глаза каждый день.
 *
 * Отмена идёт отдельной командой автомата, а не «выполнением задним числом».
 * Разница не косметическая: выполнение записывает факт и однажды даст награду,
 * а отмена означает, что действия не было. Свести их значило бы получать
 * награду за то, что передумал.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-отмены';

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;

/** Свой отправитель у каждой проверки: очередь исходящих — общее состояние. */
let nextSender = 880000000;
function sender(): string {
  nextSender += 1;
  return String(nextSender);
}

let nextUpdateId = 12000;

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
        id: randomUUID(),
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

/** Ключ кнопки по её подписи: искать по позиции значит зависеть от вёрстки. */
async function buttonFor(from: string, prefix: string): Promise<string> {
  const markup = (await lastReply(from)).reply_markup;
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (button.text.startsWith(prefix)) {
        return button.callback_data;
      }
    }
  }
  throw new Error(`Кнопки «${prefix}» нет в ответе`);
}

interface QuestRow {
  readonly execution_status: string;
  readonly completion_variant: string | null;
  readonly version: string;
  readonly id: string;
}

async function quests(from: string): Promise<QuestRow[]> {
  const rows = await ownerDb.query<QuestRow>(
    `SELECT o.id, o.execution_status, o.completion_variant, o.version
       FROM quest_occurrences o
       JOIN users u ON u.id = o.user_id
      WHERE u.auth_subject = $1
      ORDER BY o.created_at`,
    [from],
  );
  return rows.rows;
}

async function activityCount(occurrenceId: string): Promise<number> {
  const rows = await ownerDb.query(
    'SELECT id FROM activity_records WHERE occurrence_id = $1',
    [occurrenceId],
  );
  return rows.rowCount ?? 0;
}

/** Готовый пользователь с одним заданием на сегодня. */
async function withQuest(title = 'Английский'): Promise<string> {
  const from = sender();
  await deliver('/start', from);
  await run(from);
  await deliver(`/new ${title} 30м`, from);
  await run(from);
  await deliver('/today', from);
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

describe('кнопка «Убрать»', () => {
  it('появляется у каждого задания рядом с «Сделал»', async () => {
    const from = await withQuest();
    await expect(buttonFor(from, 'Убрать')).resolves.toMatch(/^[0-9a-f]{32}$/);
    await expect(buttonFor(from, 'Сделал')).resolves.toMatch(/^[0-9a-f]{32}$/);
  });

  it('убирает задание из списка и подтверждает это', async () => {
    const from = await withQuest();
    await press(await buttonFor(from, 'Убрать'), from);
    await run(from);

    const reply = await lastReply(from);
    expect(reply.kind).toBe('button_cancelled');
    // Подтверждение говорит именно об отмене: «записал» после нажатия «Убрать»
    // читается как «выполнено», и человек решит, что задание засчитано.
    expect(reply.body).toContain('Убрал');

    expect((await quests(from))[0]?.execution_status).toBe('cancelled');

    await deliver('/today', from);
    await run(from);
    expect((await lastReply(from)).body).toContain('Сегодня заданий нет');
  });

  it('отмена не засчитывается как выполнение', async () => {
    const from = await withQuest();
    await press(await buttonFor(from, 'Убрать'), from);
    await run(from);

    const quest = (await quests(from))[0];
    // Факт выполнения и вариант завершения обязаны остаться пустыми: иначе
    // отменённое задание однажды получит награду за действие, которого не было.
    expect(quest?.completion_variant).toBeNull();
    expect(await activityCount(quest?.id ?? '')).toBe(0);
  });

  it('повторное нажатие не даёт второго эффекта', async () => {
    const from = await withQuest();
    const token = await buttonFor(from, 'Убрать');

    await press(token, from);
    await run(from);
    const afterFirst = (await quests(from))[0]?.version;

    await press(token, from);
    await run(from);

    // Идентификатор команды взят из ключа и не меняется, поэтому шина узнаёт
    // повтор и возвращает прежнюю квитанцию вместо второго перехода.
    expect((await quests(from))[0]?.version).toBe(afterFirst);
    expect((await lastReply(from)).kind).toBe('button_cancelled');
  });

  it('устаревшая кнопка даёт честный отказ, а не молчаливую отмену', async () => {
    const from = await withQuest();
    const stale = await buttonFor(from, 'Убрать');

    // Задание успели завершить в другом месте — кнопкой «Сделал».
    await press(await buttonFor(from, 'Сделал'), from);
    await run(from);

    await press(stale, from);
    await run(from);

    expect((await lastReply(from)).kind).toBe('stale_button');
    // Выполненное задание не должно превратиться в отменённое задним числом.
    expect((await quests(from))[0]?.execution_status).toBe('completed');
  });

  it('чужой ключ не срабатывает', async () => {
    const mine = await withQuest();
    const token = await buttonFor(mine, 'Убрать');
    const stranger = await withQuest('Чужое');

    await press(token, stranger);
    await run(stranger);

    // Ключ принадлежит другому человеку: политика изоляции его не покажет, но
    // владелец проверяется и отдельно — полагаться на один лишь контекст
    // значит зависеть от того, что он всегда выставлен верно.
    expect((await lastReply(stranger)).kind).toBe('expired_button');
    expect((await quests(mine))[0]?.execution_status).toBe('planned');
  });
});
