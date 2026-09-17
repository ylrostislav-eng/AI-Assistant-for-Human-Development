import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { processPendingUpdates, purgeProcessedPayloads } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Разбор принятых обновлений и очередь исходящих (T-02b, docs/14, раздел 4).
 *
 * Разбор идёт отдельно от приёма намеренно: внешний вызов внутри приёма упёрся
 * бы в таймаут Telegram, а ответ «принято» он бы задержал.
 *
 * Ответ не отправляется сразу, а записывается в очередь. Таймаут запроса к
 * Telegram может означать уже доставленное сообщение, и без отдельной записи о
 * намерении неизвестный исход не отличить от неотправленного — получилась бы
 * бесконечная рассылка одного и того же (docs/01, раздел 6).
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-7f3a91';
const OWNER = '554187947';
/**
 * Посторонний отправитель у каждой проверки свой: очередь исходящих — общее
 * состояние, и первая версия набора рассчитывала на то, что проверки идут
 * подряд. Перемешанный порядок такое ловит, но лучше не создавать.
 */
let nextStranger = 111000000;
function stranger(): string {
  nextStranger += 1;
  return String(nextStranger);
}

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;

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
    maxConnections: 3,
  });

  const workerUrl = new URL(base.database.connectionString);
  workerUrl.username = 'app_worker';
  workerUrl.password = '';
  workerDb = createPool({
    ...base.database,
    connectionString: workerUrl.toString(),
    maxConnections: 3,
  });

  const config: AppConfig = {
    ...base,
    telegram: {
      botToken: BOT_TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      allowedUserIds: [OWNER],
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

let nextUpdateId = 5000;

async function deliver(text: string, senderId = OWNER, chatId = senderId): Promise<number> {
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
        from: { id: Number(senderId), is_bot: false, first_name: 'Кто-то' },
        chat: { id: Number(chatId), type: 'private' },
        text,
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return nextUpdateId;
}

interface OutboundRow {
  readonly chat_id: string;
  readonly kind: string;
  readonly body: string;
  readonly state: string;
  readonly dedupe_key: string;
  readonly user_id: string | null;
}

async function outbound(chatId: string): Promise<OutboundRow[]> {
  const rows = await ownerDb.query<OutboundRow>(
    `SELECT chat_id, kind, body, state, dedupe_key, user_id
       FROM telegram_messages WHERE chat_id = $1 ORDER BY created_at`,
    [chatId],
  );
  return rows.rows;
}

async function updateRow(updateId: number) {
  const rows = await ownerDb.query<{ processed_at: Date | null; payload: Record<string, unknown> }>(
    'SELECT processed_at, payload FROM telegram_updates WHERE update_id = $1',
    [updateId],
  );
  return rows.rows[0];
}

describe('разбор обновлений', () => {
  it('команда /start заводит аккаунт и ставит ответ в очередь', async () => {
    const updateId = await deliver('/start');

    const result = await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    expect(result.processed).toBeGreaterThanOrEqual(1);
    // Проверяется ответ именно на это обновление: очередь общая, и
    // рассчитывать на её пустоту значит зависеть от соседних проверок.
    const mine = (await outbound(OWNER)).filter(
      (row) => row.dedupe_key === `update:${updateId}`,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.state).toBe('pending');
    expect(mine[0]?.user_id).not.toBeNull();
  });

  it('повторный разбор не берёт уже обработанное', async () => {
    const updateId = await deliver('/start');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });
    const before = (await outbound(OWNER)).length;

    const second = await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    // Второй проход по тому же обновлению — второе сообщение человеку за одно
    // его действие.
    expect(second.processed).toBe(0);
    expect((await outbound(OWNER)).length).toBe(before);
    expect((await updateRow(updateId))?.processed_at).not.toBeNull();
  });

  it('чужой отправитель не получает аккаунт', async () => {
    const outsider = stranger();
    await deliver('/start', outsider);

    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const created = await ownerDb.query('SELECT id FROM users WHERE auth_subject = $1', [outsider]);
    // Иначе любой, наткнувшийся на бота, заводит себе аккаунт в чужой системе.
    expect(created.rowCount).toBe(0);
  });

  it('чужому отправителю всё равно отвечают', async () => {
    const outsider = stranger();
    await deliver('/start', outsider);

    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    // Молчание выглядит как поломка: человек будет писать снова и снова.
    const messages = await outbound(outsider);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.user_id).toBeNull();
  });

  it('команда /today отвечает по серверному состоянию', async () => {
    await deliver('/start');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });
    await deliver('/today');

    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const today = (await outbound(OWNER)).filter((row) => row.kind === 'today');
    // Ответ строится по снимку состояния, а не разбором прежних сообщений
    // (docs/14, раздел 2).
    expect(today.length).toBeGreaterThanOrEqual(1);
    expect(today[today.length - 1]?.body).toContain('заданий');
  });

  it('незнакомый текст получает понятный ответ, а не молчание', async () => {
    const updateId = await deliver('надо бы заняться английским');

    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const mine = (await outbound(OWNER)).filter((row) => row.dedupe_key === `update:${updateId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.kind).toBe('unknown_command');
  });

  it('обновление без отправителя помечается обработанным без ответа', async () => {
    nextUpdateId += 1;
    const updateId = nextUpdateId;
    await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      payload: { update_id: updateId, chat_boost: { chat: { id: 1 } } },
    });

    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    // Отвечать некому, но и висеть вечно необработанным оно не должно.
    expect((await updateRow(updateId))?.processed_at).not.toBeNull();
  });
});

describe('очередь исходящих', () => {
  it('ответ на одно обновление не дублируется ключом', async () => {
    const updateId = await deliver('/start');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const messages = await outbound(OWNER);
    const forUpdate = messages.filter((row) => row.dedupe_key.includes(String(updateId)));
    // Ключ выводится из обновления: повторный разбор не создаст второго
    // сообщения, даже если пометка обработки не успела записаться.
    expect(forUpdate).toHaveLength(1);
  });

  it('новое сообщение ждёт отправки, а не считается доставленным', async () => {
    await deliver('/start');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    const messages = await outbound(OWNER);
    // Пока запрос к Telegram не сделан, исход неизвестен и считать сообщение
    // доставленным нельзя.
    expect(messages.every((row) => row.state === 'pending')).toBe(true);
  });
});

describe('срок хранения сырого тела', () => {
  it('тело обработанного обновления стирается по сроку, ключ дедупликации остаётся', async () => {
    const updateId = await deliver('/start');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });
    await ownerDb.query(
      `UPDATE telegram_updates SET processed_at = now() - interval '2 days' WHERE update_id = $1`,
      [updateId],
    );

    const purged = await purgeProcessedPayloads(workerDb);

    expect(purged).toBeGreaterThanOrEqual(1);
    const row = await updateRow(updateId);
    // Сырое тело — личная переписка, хранить её дольше нужного незачем.
    expect(row?.payload).toEqual({});
    // А метаданные дедупликации живут дольше: иначе старое обновление,
    // доставленное повторно, сработает второй раз.
    const kept = await ownerDb.query('SELECT bot_id FROM telegram_updates WHERE update_id = $1', [
      updateId,
    ]);
    expect(kept.rowCount).toBe(1);
  });

  it('свежее обновление не трогается', async () => {
    const updateId = await deliver('/start');
    await processPendingUpdates(workerDb, { allowedUserIds: [OWNER] });

    await purgeProcessedPayloads(workerDb);

    // Отрицательный контроль: очистка не должна стирать то, что ещё может
    // понадобиться при разборе поломки.
    expect((await updateRow(updateId))?.payload).not.toEqual({});
  });

  it('необработанное обновление не стирается, сколько бы ни ждало', async () => {
    const updateId = await deliver('/start');
    await ownerDb.query(
      `UPDATE telegram_updates SET received_at = now() - interval '10 days' WHERE update_id = $1`,
      [updateId],
    );

    await purgeProcessedPayloads(workerDb);

    // Стереть тело до обработки значит потерять сообщение человека.
    expect((await updateRow(updateId))?.payload).not.toEqual({});
  });
});
