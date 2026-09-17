import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { issueSession } from '../../src/modules/identity/sessions.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Кнопки бота и завершение заданий нажатием (T-02c, docs/14, раздел 4).
 *
 * В `callback_data` помещается 64 байта, и класть туда состояние нельзя:
 * клиент подменит его чем угодно. Кнопка несёт непрозрачный ключ, всё
 * остальное — на сервере.
 *
 * Защита от двойного нажатия держится не на дедупликации обновлений (двойное
 * нажатие даёт разные callback ID), а на стабильном `command_id`, выданном
 * вместе с кнопкой: шина команд возвращает прежнюю квитанцию вместо второго
 * эффекта.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-7f3a91';
const OWNER = '554187947';

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;
let accessToken: string;
let userId: string;

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const runtimeUrl = new URL(base.database.connectionString);
  runtimeUrl.username = 'app_runtime';
  runtimeUrl.password = '';
  runtimeDb = createPool({
    ...base.database,
    connectionString: runtimeUrl.toString(),
    maxConnections: 4,
  });

  const workerUrl = new URL(base.database.connectionString);
  workerUrl.username = 'app_worker';
  workerUrl.password = '';
  workerDb = createPool({
    ...base.database,
    connectionString: workerUrl.toString(),
    maxConnections: 4,
  });

  const config: AppConfig = {
    ...base,
    devAuthEnabled: true,
    telegram: {
      botToken: BOT_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      allowedUserIds: [OWNER],
      maxAgeSeconds: 300,
      futureSkewSeconds: 30,
    },
  };
  app = createApp({ config, database: runtimeDb });

  // Аккаунт заводится тем же путём, что и в жизни: первым сообщением боту.
  await deliver('/start');
  await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });
  const found = await ownerDb.query<{ id: string }>(
    'SELECT id FROM users WHERE auth_issuer = $1 AND auth_subject = $2',
    ['telegram', OWNER],
  );
  userId = found.rows[0]?.id as string;

  // Сессия выдаётся тому же пользователю, которого узнаёт бот. Так задание
  // создаётся тем же контрактом команд, что использует Mini App, и под тем же
  // владельцем — без правки строк в обход ограничений.
  accessToken = (await issueSession(runtimeDb, userId, null)).accessToken;
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await workerDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

let nextUpdateId = 9000;

async function deliver(text: string): Promise<number> {
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
        from: { id: Number(OWNER), is_bot: false, first_name: 'Ростислав' },
        chat: { id: Number(OWNER), type: 'private' },
        text,
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return nextUpdateId;
}

async function press(token: string, callbackId = randomUUID()): Promise<number> {
  nextUpdateId += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    payload: {
      update_id: nextUpdateId,
      callback_query: {
        id: callbackId,
        from: { id: Number(OWNER), is_bot: false, first_name: 'Ростислав' },
        message: { message_id: 1, chat: { id: Number(OWNER), type: 'private' } },
        data: token,
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return nextUpdateId;
}

/** Задание создаётся тем же контрактом команд, что и у Mini App. */
async function createOccurrence(key: string): Promise<{ id: string; version: number }> {
  const send = async (kind: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/commands',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        schema_version: 1,
        command_id: randomUUID(),
        device_id: randomUUID(),
        kind,
        aggregate_id: null,
        expected_version: null,
        client_created_at: '2026-09-17T09:00:00Z',
        depends_on_command_id: null,
        payload,
      },
    });

  const template = await send('create_quest_template', {
    title: `Задание ${key}`,
    normal_spec: { duration_seconds: 1800, unit: 'seconds', success_rule: 'duration' },
  });
  const occurrence = await send('materialize_occurrence', {
    template_id: template.json().result.template_id,
    recurrence_key: key,
    timezone: 'Europe/Moscow',
  });

  expect(occurrence.statusCode).toBe(200);
  return {
    id: occurrence.json().result.occurrence_id as string,
    version: Number(occurrence.json().result.version),
  };
}

interface OutboundRow {
  readonly kind: string;
  readonly body: string;
  readonly method: string;
  readonly callback_query_id: string | null;
  readonly reply_markup: { inline_keyboard?: { text: string; callback_data: string }[][] } | null;
}

async function lastOutbound(kind?: string): Promise<OutboundRow | undefined> {
  const rows = await ownerDb.query<OutboundRow>(
    `SELECT kind, body, method, callback_query_id, reply_markup
       FROM telegram_messages
      ${kind === undefined ? '' : 'WHERE kind = $1'}
      ORDER BY created_at DESC, id LIMIT 1`,
    kind === undefined ? [] : [kind],
  );
  return rows.rows[0];
}

/**
 * Кнопка для конкретного задания. Искать первую в списке нельзя: заданий у
 * пользователя накапливается несколько, и проверка зависела бы от порядка.
 */
async function todayButton(occurrenceId: string): Promise<string> {
  await deliver('/today');
  await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

  const today = await lastOutbound('today');
  const buttons = (today?.reply_markup?.inline_keyboard ?? []).flat();
  const tokens = await ownerDb.query<{ token: string }>(
    `SELECT token FROM telegram_action_tokens
      WHERE occurrence_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [occurrenceId],
  );

  const token = tokens.rows[0]?.token;
  if (token === undefined || !buttons.some((button) => button.callback_data === token)) {
    throw new Error('В ответе /today нет кнопки для этого задания');
  }
  return token;
}

async function occurrenceState(id: string): Promise<{ execution_status: string; version: string }> {
  const rows = await ownerDb.query<{ execution_status: string; version: string }>(
    'SELECT execution_status, version FROM quest_occurrences WHERE id = $1',
    [id],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error('Задание не найдено');
  }
  return row;
}

describe('кнопки в ответе на /today', () => {
  it('у задания есть кнопка с непрозрачным ключом', async () => {
    const occurrence = await createOccurrence(`кнопка-${randomUUID()}`);

    const data = await todayButton(occurrence.id);

    // В callback_data нельзя класть состояние: клиент подменит его чем угодно.
    expect(data).not.toContain('-');
    expect(data.length).toBeLessThanOrEqual(64);
  });

  it('ключ живёт на сервере вместе с целью, версией и командой', async () => {
    const occurrence = await createOccurrence(`ключ-${randomUUID()}`);

    const data = await todayButton(occurrence.id);

    const stored = await ownerDb.query<{
      occurrence_id: string;
      expected_version: string;
      command_id: string;
      action: string;
    }>(
      'SELECT occurrence_id, expected_version, command_id, action FROM telegram_action_tokens WHERE token = $1',
      [data],
    );
    expect(stored.rows[0]).toMatchObject({
      occurrence_id: occurrence.id,
      action: 'complete_quest',
    });
    // Версия снимается в момент показа: нажатие по вчерашнему списку честно
    // упрётся в конфликт, а не изменит то, чего человек не видел.
    expect(Number(stored.rows[0]?.expected_version)).toBe(occurrence.version);
  });
});

describe('нажатие кнопки', () => {
  it('завершает задание', async () => {
    const occurrence = await createOccurrence(`нажатие-${randomUUID()}`);
    const data = await todayButton(occurrence.id);

    await press(data);
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    expect((await occurrenceState(occurrence.id)).execution_status).toBe('completed');
  });

  it('подтверждает нажатие, чтобы кнопка не крутилась', async () => {
    const occurrence = await createOccurrence(`подтверждение-${randomUUID()}`);
    const data = await todayButton(occurrence.id);

    const callbackId = randomUUID();
    await press(data, callbackId);
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const ack = await lastOutbound('callback_ack');
    expect(ack?.method).toBe('answerCallbackQuery');
    expect(ack?.callback_query_id).toBe(callbackId);
  });

  it('двойное нажатие не даёт второго эффекта', async () => {
    const occurrence = await createOccurrence(`двойное-${randomUUID()}`);
    const data = await todayButton(occurrence.id);

    await press(data);
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });
    const afterFirst = await occurrenceState(occurrence.id);

    // Второе нажатие приходит с другим callback ID, поэтому дедупликация
    // обновлений здесь не помогает. Спасает стабильный command_id.
    await press(data);
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    expect((await occurrenceState(occurrence.id)).version).toBe(afterFirst.version);
  });

  it('кнопка от устаревшего списка не меняет состояние', async () => {
    const occurrence = await createOccurrence(`устаревшая-${randomUUID()}`);
    const stale = await todayButton(occurrence.id);
    // Задание изменилось в другом месте — например, в Mini App.
    await app.inject({
      method: 'POST',
      url: '/commands',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        schema_version: 1,
        command_id: randomUUID(),
        device_id: randomUUID(),
        kind: 'start_quest',
        aggregate_id: occurrence.id,
        expected_version: occurrence.version,
        client_created_at: '2026-09-17T09:00:00Z',
        depends_on_command_id: null,
        payload: {},
      },
    });

    await press(stale);
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    // Состояние менять нельзя: человек нажимал по экрану, которого уже нет.
    expect((await occurrenceState(occurrence.id)).execution_status).toBe('active');
    const reply = await lastOutbound('stale_button');
    expect(reply?.body).toContain('/today');
  });

  it('просроченная кнопка предлагает обновить список', async () => {
    const occurrence = await createOccurrence(`просроченная-${randomUUID()}`);
    const data = await todayButton(occurrence.id);
    await ownerDb.query(
      `UPDATE telegram_action_tokens SET expires_at = now() - interval '1 hour' WHERE token = $1`,
      [data],
    );

    await press(data);
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const reply = await lastOutbound('expired_button');
    expect(reply?.body).toContain('/today');
  });

  it('неизвестный ключ не подтверждает существование чужих кнопок', async () => {
    await press('нетакогоключа1234');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const reply = await lastOutbound('expired_button');
    // Тот же ответ, что и на просроченную: различие подсказало бы
    // подбирающему, какие ключи существуют.
    expect(reply?.body).toContain('/today');
  });
});

describe('создание задания из бота', () => {
  it('замыкает цикл: создал, увидел, нажал, записалось', async () => {
    await deliver('/new Английский 30м');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const created = await lastOutbound('new_created');
    expect(created?.body).toContain('Английский');

    // Задание видно в списке, и у него есть кнопка.
    await deliver('/today');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });
    const today = await lastOutbound('today');
    expect(today?.body).toContain('Английский');

    const found = await ownerDb.query<{ id: string }>(
      `SELECT o.id FROM quest_occurrences o
        WHERE o.user_id = $1 AND o.template_snapshot->>'title' = 'Английский'`,
      [userId],
    );
    const occurrenceId = found.rows[0]?.id as string;
    const token = (today?.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => button.callback_data);
    const stored = await ownerDb.query<{ token: string }>(
      'SELECT token FROM telegram_action_tokens WHERE occurrence_id = $1 ORDER BY created_at DESC LIMIT 1',
      [occurrenceId],
    );
    expect(token).toContain(stored.rows[0]?.token);

    await press(stored.rows[0]?.token as string);
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    expect((await occurrenceState(occurrenceId)).execution_status).toBe('completed');
  });

  it('неразобранная строка получает пример, а не «ошибка»', async () => {
    await deliver('/new Английский');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const reply = await lastOutbound('new_usage');
    // «Неверный формат» без образца ничему не учит.
    expect(reply?.body).toContain('/new Английский 30м');
  });

  it('повторный разбор того же обновления не создаёт второго задания', async () => {
    const updateId = await deliver('/new Бег 5км');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    // Так выглядит падение процесса между командой и пометкой: обновление
    // возвращается в работу.
    await ownerDb.query('UPDATE telegram_updates SET processed_at = NULL WHERE update_id = $1', [
      updateId,
    ]);
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const created = await ownerDb.query(
      `SELECT id FROM quest_occurrences
        WHERE user_id = $1 AND template_snapshot->>'title' = 'Бег'`,
      [userId],
    );
    // Идентификатор команды выведен из обновления, поэтому шина узнаёт повтор.
    expect(created.rowCount).toBe(1);
  });
});
