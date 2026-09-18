import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Переименование задания (T-10).
 *
 * Нужно и само по себе, и ради `/stop`: при двух одинаковых названиях
 * остановка советует переименовать одно из них, а переименовать было нечем.
 * Совет, который невозможно выполнить, хуже отсутствия совета.
 *
 * Главное здесь — граница между «поправить название» и «переписать историю».
 * Живое задание берёт новое имя: человек именно этого и хотел. Прожитый день
 * сохраняет то имя, под которым он прожит, — иначе запись о сделанном начинает
 * зависеть от сегодняшнего настроения, и через месяц в истории будет не то,
 * что было на самом деле.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-переименования';

const TODAY = new Date('2026-09-18T09:00:00Z');
const TOMORROW = new Date('2026-09-19T09:00:00Z');

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;

let nextSender = 550000000;
function sender(): string {
  nextSender += 1;
  return String(nextSender);
}

let nextUpdateId = 21000;

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

async function lastReply(from: string): Promise<{ kind: string; body: string }> {
  const rows = await ownerDb.query<{ kind: string; body: string }>(
    `SELECT kind, body FROM telegram_messages
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

async function templateTitles(from: string): Promise<string[]> {
  const rows = await ownerDb.query<{ title: string }>(
    `SELECT t.title FROM quest_templates t JOIN users u ON u.id = t.user_id
      WHERE u.auth_subject = $1 ORDER BY t.created_at`,
    [from],
  );
  return rows.rows.map((row) => row.title);
}

async function occurrenceTitles(from: string): Promise<{ title: string; status: string }[]> {
  const rows = await ownerDb.query<{ title: string; execution_status: string }>(
    `SELECT o.template_snapshot ->> 'title' AS title, o.execution_status
       FROM quest_occurrences o JOIN users u ON u.id = o.user_id
      WHERE u.auth_subject = $1 ORDER BY o.recurrence_key`,
    [from],
  );
  return rows.rows.map((row) => ({ title: row.title, status: row.execution_status }));
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

describe('переименование', () => {
  it('меняет название шаблона и сегодняшнего задания', async () => {
    const from = await started();
    await deliver('/new Англиский 30м', from);
    await run(from);

    await deliver('/rename Англиский -> Английский', from);
    await run(from);

    expect((await lastReply(from)).kind).toBe('rename_done');
    expect(await templateTitles(from)).toEqual(['Английский']);
    // Живое задание берёт новое имя: человек поправил опечатку и ждёт увидеть
    // исправление там, где её и видел.
    expect(await occurrenceTitles(from)).toEqual([
      { title: 'Английский', status: 'planned' },
    ]);
  });

  it('прожитый день сохраняет прежнее название', async () => {
    const from = await started();
    await deliver('/every Зарядка 10м', from);
    await run(from);

    // Вчерашнее задание выполнено под старым именем.
    await ownerDb.query(
      `UPDATE quest_occurrences SET execution_status = 'completed'
        WHERE user_id = (SELECT id FROM users WHERE auth_subject = $1)`,
      [from],
    );
    await deliver('/today', from);
    await run(from, TOMORROW);

    await deliver('/rename Зарядка -> Зарядка утром', from);
    await run(from, TOMORROW);

    const titles = await occurrenceTitles(from);
    // Запись о сделанном не должна зависеть от сегодняшнего настроения: через
    // месяц в истории будет не то, что было на самом деле.
    expect(titles).toEqual([
      { title: 'Зарядка', status: 'completed' },
      { title: 'Зарядка утром', status: 'planned' },
    ]);
  });

  it('после переименования остановка находит по новому названию', async () => {
    const from = await started();
    await deliver('/every Зарядка 10м', from);
    await run(from);
    await deliver('/rename Зарядка -> Зарядка утром', from);
    await run(from);

    await deliver('/stop Зарядка утром', from);
    await run(from);
    expect((await lastReply(from)).kind).toBe('stop_done');
  });

  it('незнакомое название не переименовывает наугад', async () => {
    const from = await started();
    await deliver('/new Английский 30м', from);
    await run(from);

    await deliver('/rename Испанский -> Другое', from);
    await run(from);

    expect((await lastReply(from)).kind).toBe('rename_not_found');
    expect(await templateTitles(from)).toEqual(['Английский']);
  });

  it('два одинаковых названия переименовывать наугад нельзя', async () => {
    const from = await started();
    await deliver('/new Английский 30м', from);
    await run(from);
    await deliver('/new Английский 45м', from);
    await run(from);

    await deliver('/rename Английский -> Английский язык', from);
    await run(from);

    // Тупик из `/stop` разрешается не здесь: `/rename` натыкается на ту же
    // неоднозначность. Это записано как известное ограничение, а не скрыто
    // выбором первого попавшегося.
    expect((await lastReply(from)).kind).toBe('rename_ambiguous');
    expect(await templateTitles(from)).toEqual(['Английский', 'Английский']);
  });

  it('пустое новое название отклоняется', async () => {
    const from = await started();
    await deliver('/new Английский 30м', from);
    await run(from);

    await deliver('/rename Английский ->    ', from);
    await run(from);

    expect((await lastReply(from)).kind).toBe('rename_usage');
    expect(await templateTitles(from)).toEqual(['Английский']);
  });

  it('строка без разделителя объясняет формат', async () => {
    const from = await started();
    await deliver('/rename Английский Английский язык', from);
    await run(from);

    const reply = await lastReply(from);
    expect(reply.kind).toBe('rename_usage');
    expect(reply.body).toContain('->');
  });
});
