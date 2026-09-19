import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import type { AiProvider, AiTurnResponse } from '../../src/modules/ai/provider.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Telegram на устойчивом ядре (T-04b-3b3b).
 *
 * Прежний разбор держал внешнюю транзакцию всё время, пока отвечала модель:
 * строка обновления была заблокирована до тридцати секунд. Здесь проверяется
 * не то, что «ответ приходит», а три вещи, которых по коду не видно.
 *
 * Первая: обращение к модели идёт **вне** транзакции и без блокировки строки.
 * Вторая: повторная доставка того же обновления не обращается к модели заново —
 * иначе одно сообщение оплачивается дважды и отвечается дважды.
 * Третья: «ход занят» не равно «обновление разобрано». Занятый другим
 * процессом ход должен достаться следующему проходу, а исчерпанные попытки —
 * получить ответ по сохранённым квитанциям, иначе обновление висит вечно.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const WEBHOOK_SECRET = 'секрет-вебхука-устойчивости';

let ownerDb: Database;
let runtimeDb: Database;
let workerDb: Database;
let app: FastifyInstance;

let nextSender = 120000000;
function sender(): string {
  nextSender += 1;
  return String(nextSender);
}

let nextUpdateId = 40000;

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

async function processedAt(updateId: number): Promise<Date | null> {
  const rows = await ownerDb.query<{ processed_at: Date | null }>(
    'SELECT processed_at FROM telegram_updates WHERE update_id = $1',
    [updateId],
  );
  return rows.rows[0]?.processed_at ?? null;
}

async function questTitles(from: string): Promise<string[]> {
  const rows = await ownerDb.query<{ title: string }>(
    `SELECT o.template_snapshot ->> 'title' AS title
       FROM quest_occurrences o JOIN users u ON u.id = o.user_id
      WHERE u.auth_subject = $1 ORDER BY o.created_at`,
    [from],
  );
  return rows.rows.map((row) => row.title);
}

async function turnRow(from: string): Promise<{ id: string; status: string; attempts: number } | undefined> {
  const rows = await ownerDb.query<{ id: string; status: string; attempts: number }>(
    `SELECT t.id, t.status, t.attempts FROM ai_turns t JOIN users u ON u.id = t.user_id
      WHERE u.auth_subject = $1 ORDER BY t.created_at DESC LIMIT 1`,
    [from],
  );
  return rows.rows[0];
}

const NEW_QUEST = {
  title: 'Английский',
  success_rule: 'duration',
  unit: 'минута',
  duration_seconds: 1800,
  amount: null,
};

function wantsCreate(id = 'c1'): AiTurnResponse {
  return { text: '', toolCalls: [{ id, name: 'create_quest', arguments: NEW_QUEST }] };
}

/** Модель, считающая обращения: по их числу видно, был ли ход посчитан заново. */
function countingProvider(script: readonly AiTurnResponse[]): AiProvider & { calls: () => number } {
  let calls = 0;
  return {
    name: 'считающая',
    calls: () => calls,
    generateTurn: async () => {
      const answer = script[calls];
      calls += 1;
      if (answer === undefined) {
        throw new Error(`Обращений к модели ${calls}, сценарий короче`);
      }
      return answer;
    },
  };
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
    return createPool({ ...base.database, connectionString: url.toString(), maxConnections: 5 });
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

describe('свободный текст на устойчивом ходе', () => {
  it('отвечает и помечает обновление разобранным', async () => {
    const from = await started();
    const updateId = await deliver('запиши английский на полчаса', from);

    await run(from, countingProvider([wantsCreate(), { text: 'Записал английский.', toolCalls: [] }]));

    expect((await lastReply(from)).body).toContain('Записал английский.');
    expect(await processedAt(updateId)).not.toBeNull();
    expect(await questTitles(from)).toEqual(['Английский']);
    expect((await turnRow(from))?.status).toBe('finished');
  });

  it('повторная доставка не обращается к модели заново', async () => {
    const from = await started();
    const updateId = await deliver('запиши английский на полчаса', from);
    const provider = countingProvider([
      wantsCreate(),
      { text: 'Записал английский.', toolCalls: [] },
      wantsCreate('c2'),
      { text: 'Второй раз.', toolCalls: [] },
    ]);

    await run(from, provider);
    // Пометка разбора могла не сохраниться после успешного хода: обновление
    // приходит на разбор второй раз.
    await ownerDb.query('UPDATE telegram_updates SET processed_at = NULL WHERE update_id = $1', [
      updateId,
    ]);
    await run(from, provider);

    // Ход уже завершён, его итог сохранён: обращаться к модели снова значит
    // платить за посчитанное и отвечать дважды на одно сообщение.
    expect(provider.calls()).toBe(2);
    expect(await questTitles(from)).toEqual(['Английский']);
    expect((await lastReply(from)).body).toContain('Записал английский.');
  });
});

describe('модель вызывается вне транзакции', () => {
  it('строка обновления не заблокирована, пока отвечает модель', async () => {
    const from = await started();
    const updateId = await deliver('запиши английский на полчаса', from);

    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => {};
    const inModel = new Promise<void>((resolve) => {
      reached = resolve;
    });

    const slow: AiProvider = {
      name: 'медленная',
      generateTurn: async () => {
        reached();
        await held;
        return { text: 'Готово.', toolCalls: [] };
      },
    };

    const pass = run(from, slow);
    await inModel;

    // Прежний разбор держал строку обновления заблокированной всё время
    // ответа модели: до тридцати секунд на каждое сообщение. Проверяется это
    // прямо — попыткой взять ту же строку без ожидания.
    const probe = await ownerDb.connect();
    try {
      await probe.query('BEGIN');
      await expect(
        probe.query('SELECT id FROM telegram_updates WHERE update_id = $1 FOR UPDATE NOWAIT', [
          updateId,
        ]),
      ).resolves.toBeDefined();
      await probe.query('ROLLBACK');
    } finally {
      probe.release();
    }

    release();
    await pass;
    expect((await lastReply(from)).body).toContain('Готово.');
  });
});

describe('занятый ход не считается разобранным', () => {
  it('обновление остаётся неразобранным, пока ход держит другой процесс', async () => {
    const from = await started();
    const updateId = await deliver('запиши английский на полчаса', from);

    // Первый проход доходит до модели и застревает в ней.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => {};
    const inModel = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slow: AiProvider = {
      name: 'медленная',
      generateTurn: async () => {
        reached();
        await held;
        return { text: 'Готово.', toolCalls: [] };
      },
    };
    const first = run(from, slow);
    await inModel;

    // Второй проход застаёт ход занятым. Пометить обновление разобранным здесь
    // значило бы потерять ответ: его поставит первый проход, а не этот.
    const never: AiProvider = {
      name: 'не должна вызываться',
      generateTurn: async () => {
        throw new Error('модель вызвана на занятом ходе');
      },
    };
    await run(from, never);
    expect(await processedAt(updateId)).toBeNull();

    release();
    await first;
    expect(await processedAt(updateId)).not.toBeNull();
  });

  it('исчерпанные попытки дают ответ по квитанциям, а не висят вечно', async () => {
    const from = await started();
    const updateId = await deliver('запиши английский на полчаса', from);

    // Первый проход: инструмент записал задание, дальше поставщик отказал.
    const brokenAfterTool: AiProvider = {
      name: 'ломается после инструмента',
      generateTurn: async (request) => {
        if (request.messages.some((message) => message.role === 'tool')) {
          throw new Error('поставщик отказал');
        }
        return wantsCreate();
      },
    };
    await run(from, brokenAfterTool);
    expect(await questTitles(from)).toEqual(['Английский']);

    // Дальше — то, чего поставщик изобразить не может: процесс умирал, не
    // завершив ход, пока не кончились попытки. Отказ поставщика ход завершает,
    // а гибель процесса оставляет его в работе с протухшей арендой. Состояние
    // задаётся прямо, потому что воспроизводится оно только падением.
    await ownerDb.query(
      `UPDATE ai_turns
          SET status = 'running',
              lease_token = gen_random_uuid(),
              lease_expires_at = clock_timestamp() - interval '1 minute',
              attempts = max_attempts
        WHERE user_id = (SELECT id FROM users WHERE auth_subject = $1)`,
      [from],
    );
    await ownerDb.query('UPDATE telegram_updates SET processed_at = NULL WHERE update_id = $1', [
      updateId,
    ]);
    // Ответа по этому обновлению ещё не было: процесс умер до его постановки в
    // очередь. Без этого ключ повторения отбросил бы новый ответ, и проверка
    // смотрела бы на ответ первого прохода вместо ответа при исчерпании.
    await ownerDb.query('DELETE FROM telegram_messages WHERE dedupe_key = $1', [
      `update:${updateId}`,
    ]);

    const never: AiProvider = {
      name: 'не должна вызываться',
      generateTurn: async () => {
        throw new Error('модель вызвана при исчерпанных попытках');
      },
    };
    await run(from, never);

    // Попыток больше нет: новых обращений к модели не будет никогда, и
    // обновление обязано получить ответ, иначе оно висит в очереди вечно.
    expect(await processedAt(updateId)).not.toBeNull();
    const reply = await lastReply(from);
    expect(reply.kind).toBe('ai_unavailable');
    // Записанное инструментом называется: иначе человек сделает это второй раз.
    expect(reply.body).toContain('Но записать успел');
    expect(reply.body).toContain('Английский');
    expect(await questTitles(from)).toEqual(['Английский']);
  });
});

describe('ручной путь не зависит от устойчивого ядра', () => {
  it('команды работают при настроенной модели', async () => {
    const from = await started();
    const never: AiProvider = {
      name: 'не должна вызываться',
      generateTurn: async () => {
        throw new Error('модель вызвана на команде');
      },
    };

    await deliver('/new Английский 30м', from);
    await run(from, never);
    expect(await questTitles(from)).toEqual(['Английский']);

    await deliver('/today', from);
    await run(from, never);
    expect((await lastReply(from)).kind).toBe('today');
  });
});
