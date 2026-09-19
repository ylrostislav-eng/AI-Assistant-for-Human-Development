import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import {
  BudgetExhaustedError,
  databaseAccounting,
  reconcileExpiredAttempts,
  remainingBudget,
  type BudgetLimits,
} from '../../src/modules/ai/budget.ts';
import {
  AiProviderError,
  createFallbackAiProvider,
  createHttpAiProvider,
} from '../../src/modules/ai/providers/http.ts';
import { systemPrompt, untrustedBlock } from '../../src/modules/ai/prompt.ts';
import type { AiProvider } from '../../src/modules/ai/provider.ts';
import { processPendingUpdates } from '../../src/modules/telegram/inbox.ts';
import { runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Бюджет обращений к поставщику (T-04b-3c).
 *
 * Проверяется не «расход записывается», а четыре вещи, которых по коду не
 * видно и каждая из которых уже стоила бы денег.
 *
 * Первая: резерв ставится **до** HTTP. Считать после ответа поздно — деньги
 * потрачены, и предел превращается в отчёт о перерасходе.
 * Вторая: два одновременных хода не проскакивают мимо предела. Без блокировки
 * оба видят свободный остаток, и предел перестаёт быть пределом ровно тогда,
 * когда он нужен.
 * Третья: неизвестный расход не считается нулём. Поставщик не всегда возвращает
 * `usage`; ноль здесь означал бы способ не платить — достаточно, чтобы ответ
 * приходил без счётчиков.
 * Четвёртая: брошенный резерв закрывается **по оценке**, а не освобождается.
 * Процесс мог умереть уже после отправки запроса.
 */

let owner: Database;
let runtime: Database;
let worker: Database;

/** Окно вмещает ровно одну попытку: вторая обязана упереться в предел. */
const TIGHT: BudgetLimits = { windowTokens: 1500, estimateTokens: 1000, reservationMs: 60_000 };
const ROOMY: BudgetLimits = { windowTokens: 1_000_000, estimateTokens: 1000, reservationMs: 60_000 };

beforeAll(async () => {
  const config = loadConfig();
  owner = createPool(config.database);
  await resetSchema(owner);
  await runMigrations(owner);
  const withRole = (role: string): Database => {
    const url = new URL(config.database.connectionString);
    url.username = role;
    url.password = '';
    return createPool({ ...config.database, connectionString: url.toString(), maxConnections: 5 });
  };
  runtime = withRole('app_runtime');
  worker = withRole('app_worker');
});

afterAll(async () => {
  await runtime?.end();
  await worker?.end();
  if (owner) {
    await resetSchema(owner);
    await owner.end();
  }
});

async function makeUser(): Promise<string> {
  const userId = randomUUID();
  await owner.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    userId,
    'dev',
    userId,
  ]);
  await owner.query(
    "INSERT INTO user_profiles (user_id, timezone, day_boundary_minutes) VALUES ($1, 'Europe/Moscow', 240)",
    [userId],
  );
  return userId;
}

interface AttemptRow {
  readonly state: string;
  readonly charged_tokens: string;
  readonly reserved_tokens: string;
  readonly input_tokens: string | null;
  readonly output_tokens: string | null;
  readonly usage_known: boolean;
  readonly model: string;
  readonly provider: string;
}

async function attempts(userId: string): Promise<AttemptRow[]> {
  const rows = await owner.query<AttemptRow>(
    `SELECT state, charged_tokens, reserved_tokens, input_tokens, output_tokens,
            usage_known, model, provider
       FROM ai_provider_attempts WHERE user_id = $1 ORDER BY reserved_at, id`,
    [userId],
  );
  return rows.rows;
}

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) => value,
    (error: unknown) => error,
  );

describe('учёт обращений к поставщику', () => {
  it('известный расход заменяет оценку', async () => {
    const userId = await makeUser();
    const accounting = databaseAccounting(runtime, { userId, turnId: randomUUID() }, ROOMY);

    const ticket = await accounting.reserve({ provider: 'anthropic-messages', model: 'claude-x' });
    const [reserved] = await attempts(userId);
    expect(reserved?.state).toBe('reserved');
    expect(reserved?.charged_tokens).toBe('1000');

    await ticket.settle({ inputTokens: 120, outputTokens: 33 });

    const [settled] = await attempts(userId);
    expect(settled?.state).toBe('settled');
    expect(settled?.charged_tokens).toBe('153');
    expect(settled?.usage_known).toBe(true);
    expect(settled?.input_tokens).toBe('120');
    expect(settled?.model).toBe('claude-x');
  });

  it('неизвестный расход остаётся оценкой и не равен нулю', async () => {
    const userId = await makeUser();
    const accounting = databaseAccounting(runtime, { userId, turnId: randomUUID() }, ROOMY);

    const ticket = await accounting.reserve({ provider: 'openai-chat', model: 'gpt-x' });
    await ticket.settle(null);

    const [row] = await attempts(userId);
    expect(row?.state).toBe('settled');
    expect(row?.charged_tokens).toBe('1000');
    expect(row?.usage_known).toBe(false);
    expect(row?.input_tokens).toBeNull();
  });

  it('нулевой расход от поставщика считается неизвестным, а не бесплатным', async () => {
    // Ответ с `usage: {0, 0}` — не подарок, а сломанный счётчик. Принять его
    // как факт значит открыть тот же способ не платить, что и отсутствие usage.
    const userId = await makeUser();
    const accounting = databaseAccounting(runtime, { userId, turnId: randomUUID() }, ROOMY);

    const ticket = await accounting.reserve({ provider: 'openai-chat', model: 'gpt-x' });
    await ticket.settle({ inputTokens: 0, outputTokens: 0 });

    const [row] = await attempts(userId);
    expect(row?.charged_tokens).toBe('1000');
    expect(row?.usage_known).toBe(false);
  });

  it('одновременные ходы не переступают предел', async () => {
    const userId = await makeUser();
    const first = databaseAccounting(runtime, { userId, turnId: randomUUID() }, TIGHT);
    const second = databaseAccounting(runtime, { userId, turnId: randomUUID() }, TIGHT);

    const attempt = { provider: 'openai-chat', model: 'gpt-x' };
    const outcomes = await Promise.all([
      caught(first.reserve(attempt)),
      caught(second.reserve(attempt)),
    ]);

    const refused = outcomes.filter((value) => value instanceof BudgetExhaustedError);
    expect(refused).toHaveLength(1);
    expect(await attempts(userId)).toHaveLength(1);
    expect(await remainingBudget(runtime, userId, TIGHT)).toBe(500);
  });

  it('брошенный резерв закрывается сверкой по оценке, а не освобождается', async () => {
    const userId = await makeUser();
    const accounting = databaseAccounting(runtime, { userId, turnId: randomUUID() }, ROOMY);
    await accounting.reserve({ provider: 'openai-chat', model: 'gpt-x' });
    // Процесс умер между запросом и уточнением: строка осталась незакрытой.
    await owner.query(
      "UPDATE ai_provider_attempts SET expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1",
      [userId],
    );

    expect(await reconcileExpiredAttempts(worker, 50)).toBe(1);

    const [row] = await attempts(userId);
    expect(row?.state).toBe('settled');
    // Именно оценка: запрос, скорее всего, ушёл, и считать его бесплатным нельзя.
    expect(row?.charged_tokens).toBe('1000');
    expect(await remainingBudget(runtime, userId, ROOMY)).toBe(999_000);
    // Повторный проход не закрывает ту же строку второй раз.
    expect(await reconcileExpiredAttempts(worker, 50)).toBe(0);
  });

  it('незакрытый резерв занимает бюджет, пока не истёк', async () => {
    // Иначе предел обходится темпом: пока первая попытка висит в полёте,
    // следующие видят свободный остаток.
    const userId = await makeUser();
    const accounting = databaseAccounting(runtime, { userId, turnId: randomUUID() }, TIGHT);
    await accounting.reserve({ provider: 'openai-chat', model: 'gpt-x' });

    const second = databaseAccounting(runtime, { userId, turnId: randomUUID() }, TIGHT);
    expect(await caught(second.reserve({ provider: 'openai-chat', model: 'gpt-x' }))).toBeInstanceOf(
      BudgetExhaustedError,
    );
  });
});

let nextUpdateId = 900000;
let nextSender = 660000000;

async function deliver(sender: string, text: string): Promise<number> {
  nextUpdateId += 1;
  await owner.query(
    `INSERT INTO telegram_updates (bot_id, update_id, kind, sender_telegram_id, payload)
     VALUES ('budget-bot', $1, 'message', $2, $3::jsonb)`,
    [
      nextUpdateId,
      sender,
      JSON.stringify({
        update_id: nextUpdateId,
        message: {
          message_id: nextUpdateId,
          date: 1789600000,
          from: { id: Number(sender), is_bot: false, first_name: 'Владелец' },
          chat: { id: Number(sender), type: 'private' },
          text,
        },
      }),
    ],
  );
  return nextUpdateId;
}

async function lastReply(sender: string): Promise<string> {
  const rows = await owner.query<{ body: string }>(
    `SELECT body FROM telegram_messages WHERE chat_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [sender],
  );
  const body = rows.rows[0]?.body;
  if (body === undefined) {
    throw new Error('Ответ не поставлен в очередь');
  }
  return body;
}

async function userIdOf(sender: string): Promise<string> {
  const rows = await owner.query<{ id: string }>(
    "SELECT id FROM users WHERE auth_issuer = 'telegram' AND auth_subject = $1",
    [sender],
  );
  const found = rows.rows[0]?.id;
  if (found === undefined) {
    throw new Error('Личность не заведена');
  }
  return found;
}

const TRANSPORT_TURN = randomUUID();

/** Ответ поставщика в родной форме OpenAI, со счётчиками или без них. */
function reply(usage: { prompt: number; completion: number } | null): Response {
  return new Response(
    JSON.stringify({
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: 'Готово', refusal: null } },
      ],
      ...(usage === null
        ? {}
        : { usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const TRANSPORT = {
  protocol: 'openai-chat' as const,
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'синтетический-ключ',
  timeoutMs: 5000,
  maxOutputTokens: 512,
  maxResponseBytes: 65_536,
};

/** Уже израсходованные сутки: одна закрытая попытка дороже, чем осталось. */
async function exhaust(userId: string): Promise<void> {
  await owner.query(
    `INSERT INTO ai_provider_attempts
       (user_id, turn_id, provider, model, state, reserved_tokens, charged_tokens,
        expires_at, settled_at)
     VALUES ($1, gen_random_uuid(), 'openai-chat', 'gpt-x', 'settled', 1000, 1400,
             now() + interval '1 hour', now())`,
    [userId],
  );
}

describe('учёт на границе транспорта', () => {
  // Запрос строится теми же функциями, что и в бою: политика исходящих
  // отвергнет подделанную системную часть или необрамлённые данные, и проверка
  // измеряла бы её, а не учёт.
  const request = {
    system: systemPrompt(),
    messages: [
      {
        role: 'user' as const,
        content: untrustedBlock({
          turnId: TRANSPORT_TURN,
          source: 'telegram message',
          text: 'привет',
        }),
      },
    ],
    tools: [],
  };

  it('резерв ставится до HTTP: исчерпанный предел не отправляет запрос', async () => {
    const userId = await makeUser();
    await exhaust(userId);

    let sent = 0;
    const provider = createHttpAiProvider(
      { ...TRANSPORT, model: 'gpt-x' },
      {
        fetch: async () => {
          sent += 1;
          return reply(null);
        },
        accounting: databaseAccounting(runtime, { userId, turnId: randomUUID() }, TIGHT),
      },
    );

    expect(await caught(provider.generateTurn(request))).toBeInstanceOf(BudgetExhaustedError);
    // Главное: денег не потрачено ни копейки.
    expect(sent).toBe(0);
  });

  it('каждая попытка перебора считается отдельно', async () => {
    // Ход с перебором стоит столько, сколько было попыток. Посчитать его одним
    // значит недосчитать ровно в тот день, когда основная модель лежит и
    // перебор работает постоянно (17 сентября, handoff 3.19).
    const userId = await makeUser();
    const accounting = databaseAccounting(runtime, { userId, turnId: randomUUID() }, ROOMY);

    const failing = createHttpAiProvider(
      { ...TRANSPORT, model: 'gpt-x' },
      { fetch: async () => new Response('{}', { status: 503 }), accounting },
    );
    const working = createHttpAiProvider(
      { ...TRANSPORT, model: 'claude-x' },
      { fetch: async () => reply({ prompt: 7, completion: 5 }), accounting },
    );

    const chain = createFallbackAiProvider([failing, working]);
    expect((await chain.generateTurn(request)).text).toBe('Готово');

    const rows = await attempts(userId);
    expect(rows.map((row) => [row.model, row.charged_tokens, row.usage_known])).toEqual([
      // Отказ расход не отменяет: запрос ушёл и был обработан, а счётчиков при
      // отказе почти никогда нет — это та самая «неизвестная» попытка.
      ['gpt-x', '1000', false],
      ['claude-x', '12', true],
    ]);
    expect(rows.every((row) => row.state === 'settled')).toBe(true);
  });

  it('оборванный запрос закрывается оценкой, а не остаётся в полёте', async () => {
    const userId = await makeUser();
    const provider = createHttpAiProvider(
      { ...TRANSPORT, model: 'gpt-x' },
      {
        fetch: async () => {
          throw new TypeError('сеть оборвалась');
        },
        accounting: databaseAccounting(runtime, { userId, turnId: randomUUID() }, ROOMY),
      },
    );

    expect(await caught(provider.generateTurn(request))).toBeInstanceOf(AiProviderError);

    const [row] = await attempts(userId);
    expect(row?.state).toBe('settled');
    expect(row?.charged_tokens).toBe('1000');
  });
});

describe('отказ по пределу в боте', () => {
  it('исчерпанный предел не доходит до модели и оставляет ручной путь', async () => {
    nextSender += 1;
    const sender = String(nextSender);
    await deliver(sender, '/start');
    await processPendingUpdates(worker, { allowedUserIds: [sender], ai: null });
    const userId = await userIdOf(sender);
    await exhaust(userId);

    let sent = 0;
    const factory = (identity: { userId: string; turnId: string }): AiProvider =>
      createHttpAiProvider(
        { ...TRANSPORT, model: 'gpt-x' },
        {
          fetch: async () => {
            sent += 1;
            return reply(null);
          },
          accounting: databaseAccounting(worker, identity, TIGHT),
        },
      );

    await deliver(sender, 'запиши английский на полчаса');
    await processPendingUpdates(worker, { allowedUserIds: [sender], ai: factory });

    expect(sent).toBe(0);
    const refusal = await lastReply(sender);
    // Названа настоящая причина: «ИИ недоступен» отправило бы человека ждать
    // восстановления того, что не ломалось.
    expect(refusal).toContain('Дневной предел обращений');
    expect(refusal).not.toContain('ИИ сейчас недоступен');

    // Ручной путь не зависит от модели (ADR-011): команда обязана работать.
    await deliver(sender, '/new Английский 30м');
    await processPendingUpdates(worker, { allowedUserIds: [sender], ai: factory });
    expect(await lastReply(sender)).toContain('Английский');
    expect(sent).toBe(0);
  });
});
