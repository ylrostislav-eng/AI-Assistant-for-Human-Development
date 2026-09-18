import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import type { AiProvider } from '../../src/modules/ai/provider.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { scriptedProvider } from '../helpers/fake-provider.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Свободный текст в боте через модель (T-04b-3).
 *
 * Проверяется не качество ответа, а три вещи, которые нельзя увидеть по коду.
 * Первая: подтверждение человеку строится из квитанций сервера, а не из слов
 * модели — «готово» без записи это ложь, и человек обнаружит её через неделю.
 * Вторая: мёртвая модель не ломает ручной путь, а говорит об этом честно
 * (ADR-011) — за два дня наблюдений шлюз падал дважды, так что это основной
 * режим, а не редкий. Третья: повтор обновления не даёт второго эффекта.
 *
 * Модель подставная: проверки границ не должны зависеть ни от сети, ни от
 * денег, ни от того, работает ли сегодня шлюз.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-ии';

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;

/** Свой отправитель у каждой проверки: очередь исходящих — общее состояние. */
let nextSender = 770000000;
function sender(): string {
  nextSender += 1;
  return String(nextSender);
}

let nextUpdateId = 9000;
async function deliver(text: string, from: string): Promise<number> {
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
  return nextUpdateId;
}

async function run(from: string, ai: AiProvider | null = null): Promise<void> {
  await processPendingUpdates(workerDb, { allowedUserIds: [from], ai });
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

async function questTitles(from: string): Promise<string[]> {
  const rows = await ownerDb.query<{ title: string }>(
    `SELECT o.template_snapshot ->> 'title' AS title
       FROM quest_occurrences o
       JOIN users u ON u.id = o.user_id
      WHERE u.auth_subject = $1
      ORDER BY o.created_at`,
    [from],
  );
  return rows.rows.map((row) => row.title);
}

const NEW_QUEST = {
  title: 'Английский',
  success_rule: 'duration',
  unit: 'минута',
  duration_seconds: 1800,
  amount: null,
};

function wantsCreate(id = 'c1') {
  return { text: '', toolCalls: [{ id, name: 'create_quest', arguments: NEW_QUEST }] };
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

describe('свободный текст через модель', () => {
  it('выполняет предложенное моделью и подтверждает из квитанции', async () => {
    const from = sender();
    await deliver('/start', from);
    await run(from);

    await deliver('запиши английский на полчаса', from);
    await run(
      from,
      scriptedProvider([wantsCreate(), { text: 'Записал английский на сегодня.', toolCalls: [] }]),
    );

    const reply = await lastReply(from);
    expect(reply.body).toContain('Записал английский на сегодня.');
    // Подтверждение отдельной строкой и из квитанции: текст модели — это слова,
    // а название в списке взято из того, что сервер действительно записал.
    expect(reply.body).toContain('Английский');
    expect(await questTitles(from)).toEqual(['Английский']);
  });

  it('не подтверждает то, чего сервер не записал', async () => {
    const from = sender();
    await deliver('/start', from);
    await run(from);

    // Модель объявляет выполнение, а инструмент отказал: ссылки не выдавали.
    await deliver('отметь английский сделанным', from);
    await run(
      from,
      scriptedProvider([
        {
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'complete_quest',
              arguments: {
                quest_ref: 'q1',
                variant: null,
                actual_duration_seconds: null,
                actual_amount: null,
              },
            },
          ],
        },
        { text: 'Готово, всё отметил.', toolCalls: [] },
      ]),
    );

    const reply = await lastReply(from);
    // Слова модели остаются как есть — переписывать их мы не можем, — но рядом
    // стоит правда сервера. Без неё человек узнает об отсутствии записи через
    // неделю, когда восстановить факт будет неоткуда.
    expect(reply.body).not.toContain('Записано:');
    expect(reply.body).toContain('Не получилось');
  });

  it('повтор того же обновления не создаёт второе задание', async () => {
    const from = sender();
    await deliver('/start', from);
    await run(from);

    const text = 'запиши английский на полчаса';
    await deliver(text, from);
    await run(from, scriptedProvider([wantsCreate(), { text: 'Записал.', toolCalls: [] }]));

    // Разбор того же обновления во второй раз: пометка обработки могла не
    // сохраниться после успешной команды.
    await ownerDb.query('UPDATE telegram_updates SET processed_at = NULL WHERE update_id = $1', [
      nextUpdateId,
    ]);
    await run(from, scriptedProvider([wantsCreate(), { text: 'Записал.', toolCalls: [] }]));

    expect(await questTitles(from)).toEqual(['Английский']);
  });
});

describe('мёртвая модель', () => {
  it('сохраняет подтверждение записи при отказе модели после commit', async () => {
    const from = sender();
    await deliver('/start', from);
    await run(from);
    await deliver('запиши английский', from);
    let rounds = 0;
    const provider: AiProvider = { name: 'отказ после commit', generateTurn: async () => {
      if (rounds++ === 0) return { ...wantsCreate(), text: 'STALE_DRAFT' };
      throw new Error('PRIVATE_SENTINEL');
    } };
    await run(from, provider);
    const reply = await lastReply(from);
    expect(reply.kind).toBe('ai_unavailable');
    expect(reply.body).toContain('Записано:\n• Английский — записано');
    expect(reply.body).toContain('ИИ сейчас недоступен');
    expect(reply.body).toContain('/today');
    expect(reply.body).not.toMatch(/PRIVATE_SENTINEL|STALE_DRAFT|пределе шагов/);
    expect(await questTitles(from)).toEqual(['Английский']);
    expect(rounds).toBe(2);
    const updates = await ownerDb.query('SELECT processed_at FROM telegram_updates WHERE update_id = $1', [nextUpdateId]);
    expect(updates.rows[0]?.processed_at).not.toBeNull();
    await run(from, provider);
    expect(rounds).toBe(2);
    expect(await questTitles(from)).toEqual(['Английский']);
  });

  const broken: AiProvider = {
    name: 'сломанная',
    generateTurn: async () => {
      throw new Error('поставщик недоступен');
    },
  };

  it('отвечает честно и ничего не выдумывает', async () => {
    const from = sender();
    await deliver('/start', from);
    await run(from);

    await deliver('запиши английский на полчаса', from);
    await run(from, broken);

    const reply = await lastReply(from);
    expect(reply.kind).toBe('ai_unavailable');
    expect(reply.body).toContain('/new');
    expect(await questTitles(from)).toEqual([]);
  });

  it('не ломает ручной путь', async () => {
    const from = sender();
    await deliver('/start', from);
    await run(from);

    // Ради этого и писалось правило «ручное управление работает без ИИ»
    // (ADR-011). Шлюз падал дважды за два дня: это основной режим.
    await deliver('/new Английский 30м', from);
    await run(from, broken);
    expect(await questTitles(from)).toEqual(['Английский']);

    await deliver('/today', from);
    await run(from, broken);
    expect((await lastReply(from)).kind).toBe('today');
  });

  it('без настроенной модели свободный текст получает понятный ответ', async () => {
    const from = sender();
    await deliver('/start', from);
    await run(from);

    await deliver('запиши английский на полчаса', from);
    await run(from, null);

    const reply = await lastReply(from);
    expect(reply.kind).toBe('unknown_command');
    expect(reply.body).toContain('/new');
  });
});
