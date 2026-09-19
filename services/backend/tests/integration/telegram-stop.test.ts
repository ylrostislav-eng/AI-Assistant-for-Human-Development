import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Отмена повторения (T-09).
 *
 * Команда `/every` была выпущена без выключателя: завести ежедневное задание
 * можно, а перестать — нечем. Это хуже отсутствия возможности: человек
 * забрасывает привычку через неделю, а бот напоминает о ней вечно, и список
 * превращается в кладбище чужих намерений.
 *
 * Остановка трогает шаблон, а не сегодняшний экземпляр: «Убрать» — это про
 * один день, «не повторять» — про все следующие. Свести их нельзя, потому что
 * человек пропускает день гораздо чаще, чем бросает дело.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-остановки';

/**
 * Даты намеренно далеко от настоящего дня.
 *
 * Раньше здесь стояло 18–19 сентября 2026 года, и 19 сентября подставные часы
 * стали неотличимы от системных: отрицательный контроль «взять системные часы
 * вместо переданных» перестал ловиться, а проверка осталась зелёной. Дата
 * рядом с настоящей превращает проверку часов в проверку календаря.
 */
const TODAY = new Date('2019-03-05T09:00:00Z');
const TOMORROW = new Date('2019-03-06T09:00:00Z');

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;

let nextSender = 660000000;
function sender(): string {
  nextSender += 1;
  return String(nextSender);
}

let nextUpdateId = 18000;

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

async function occurrenceKeys(from: string): Promise<string[]> {
  const rows = await ownerDb.query<{ recurrence_key: string }>(
    `SELECT o.recurrence_key FROM quest_occurrences o
       JOIN users u ON u.id = o.user_id
      WHERE u.auth_subject = $1 ORDER BY o.recurrence_key`,
    [from],
  );
  return rows.rows.map((row) => row.recurrence_key);
}

async function templates(from: string): Promise<{ title: string; repeats: boolean }[]> {
  const rows = await ownerDb.query<{ title: string; kind: string | null }>(
    `SELECT t.title, t.recurrence ->> 'kind' AS kind FROM quest_templates t
       JOIN users u ON u.id = t.user_id
      WHERE u.auth_subject = $1 ORDER BY t.created_at`,
    [from],
  );
  return rows.rows.map((row) => ({ title: row.title, repeats: row.kind === 'daily' }));
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

describe('остановка повторения', () => {
  it('задание перестаёт приходить на следующий день', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);

    await deliver('/stop Английский', from);
    await run(from);
    expect((await lastReply(from)).kind).toBe('stop_done');
    expect(await templates(from)).toEqual([{ title: 'Английский', repeats: false }]);

    await deliver('/today', from);
    await run(from, TOMORROW);
    // Сегодняшний экземпляр остаётся: остановка отменяет будущее, а не стирает
    // прошедший день. Стирать день значило бы терять записанный факт.
    expect(await occurrenceKeys(from)).toEqual(['2019-03-05']);
  });

  it('сегодняшнее задание остаётся в списке', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);
    await deliver('/stop Английский', from);
    await run(from);

    await deliver('/today', from);
    await run(from);
    // Человек сказал «больше не напоминай», а не «я этого не делал сегодня».
    expect((await lastReply(from)).body).toContain('Английский');
  });

  it('название сверяется без учёта регистра и лишних пробелов', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);

    await deliver('/stop   английский  ', from);
    await run(from);
    expect(await templates(from)).toEqual([{ title: 'Английский', repeats: false }]);
  });

  it('незнакомое название не останавливает наугад', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);

    await deliver('/stop Испанский', from);
    await run(from);

    const reply = await lastReply(from);
    expect(reply.kind).toBe('stop_not_found');
    // Подсказка перечисляет то, что повторяется: иначе человек гадает, как
    // именно он это назвал.
    expect(reply.body).toContain('Английский');
    expect(await templates(from)).toEqual([{ title: 'Английский', repeats: true }]);
  });

  it('два одинаковых названия останавливать наугад нельзя', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);
    await deliver('/every Английский 45м', from);
    await run(from);

    await deliver('/stop Английский', from);
    await run(from);

    const reply = await lastReply(from);
    expect(reply.kind).toBe('stop_ambiguous');
    // Выбрать первое попавшееся значит остановить не то, и человек узнает об
    // этом через неделю отсутствия напоминаний.
    expect((await templates(from)).every((row) => row.repeats)).toBe(true);
  });

  it('повторная остановка не считается ошибкой', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);
    await deliver('/stop Английский', from);
    await run(from);

    await deliver('/stop Английский', from);
    await run(from);
    // Уже остановленное не числится повторяющимся, и ответ должен быть
    // понятным, а не «не найдено» без объяснений.
    expect((await lastReply(from)).kind).toBe('stop_not_found');
  });

  it('без названия команда объясняет себя и перечисляет повторяющееся', async () => {
    const from = await started();
    await deliver('/every Английский 30м', from);
    await run(from);

    await deliver('/stop', from);
    await run(from);

    const reply = await lastReply(from);
    expect(reply.kind).toBe('stop_usage');
    expect(reply.body).toContain('Английский');
  });
});
