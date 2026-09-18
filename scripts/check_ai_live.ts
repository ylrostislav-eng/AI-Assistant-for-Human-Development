/**
 * Живая проверка транспорта на настоящем шлюзе.
 *
 * Проверяется не «отвечает ли модель», а наш собственный код: тот же каталог
 * инструментов, тот же сборщик тела и тот же разбор ответа, что пойдут в работу.
 * Отдельный запрос, написанный руками, доказывает только то, что руками можно
 * составить рабочий запрос.
 *
 * Два открытых вопроса к OpenAI-форме (handoff 3.20): принимает ли шлюз
 * `max_completion_tokens` вместо `max_tokens` и переживает ли `strict: true`
 * схему с `allOf`/`if`/`then`. При отказе шаг 2 сужается до одного из них
 * шагами 3 и 4 — иначе «не работает» не отличить от «не работает вот из-за
 * чего».
 *
 * Ключ берётся из окружения или из `.env` и никуда не печатается. Запросы
 * платные, но крошечные: ответ ограничен сверху, и дальше первого успеха
 * сужение не идёт.
 *
 * Запуск: npx tsx scripts/check_ai_live.ts
 */
import { readFileSync } from 'node:fs';

import { toolCatalog } from '../services/backend/src/modules/ai/catalog.ts';
import type { AiTurnRequest } from '../services/backend/src/modules/ai/provider.ts';
import {
  AiProviderError,
  createHttpAiProvider,
} from '../services/backend/src/modules/ai/providers/http.ts';

const BASE_URL = process.env['AI_BASE_URL'] ?? 'https://api.smartapi.shop/v1';
const CLAUDE_MODEL = process.env['AI_CHAT_MODEL'] ?? 'claude-sonnet-5';
const OPENAI_MODEL = process.env['AI_FALLBACK_MODEL'] ?? 'gpt-6-astra';

/** Ключ из окружения или из `.env`. Печатать его нельзя ни при каком исходе. */
function apiKey(): string {
  const found = readKey();
  // Ключ уходит заголовком, а заголовок принимает только однобайтовые символы.
  // Проверка общая для обоих источников: в первой версии она стояла только на
  // пути из файла, и ключ из окружения ронял скрипт невнятной ошибкой
  // кодировки вместо «ключ не похож на ключ».
  if (!/^[\x21-\x7e]+$/.test(found)) {
    throw new Error('Ключ содержит недопустимые символы: ожидаются только печатные ASCII');
  }
  return found;
}

function readKey(): string {
  const fromEnv = process.env['AI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  let file: string;
  try {
    file = readFileSync('.env', 'utf8');
  } catch {
    // Понятное сообщение вместо ENOENT: скрипт запускают руками, и «нет такого
    // файла» не подсказывает, что делать.
    throw new Error('Нет ключа: задайте AI_API_KEY в окружении или создайте .env в корне репозитория');
  }
  const found = /^(?:AI_API_KEY|OPENAI_API_KEY)=(.*)$/m.exec(file)?.[1]?.trim();
  if (found === undefined || found === '') {
    throw new Error('Нет ключа: в .env нет строки AI_API_KEY или OPENAI_API_KEY');
  }
  return found;
}

/** Заполняется в начале работы: чтение ключа должно попадать в общий перехват. */
let KEY = '';

const request: AiTurnRequest = {
  system: 'Ты помогаешь вести день. Отвечай по-русски, коротко.',
  messages: [{ role: 'user', content: 'Запиши мне на сегодня: английский 30 минут' }],
  tools: toolCatalog(),
};

const LIMITS = { timeoutMs: 30_000, maxOutputTokens: 512, maxResponseBytes: 262_144 };

/** Короткий отчёт: имя вызванного инструмента и аргументы — это и есть результат. */
function describe(result: { text: string; toolCalls: readonly { name: string; arguments: unknown }[] }): string {
  if (result.toolCalls.length === 0) {
    return `   БЕЗ ВЫЗОВА, текст: ${result.text.slice(0, 120)}`;
  }
  return result.toolCalls
    .map((call) => `   вызвал ${call.name} с ${JSON.stringify(call.arguments)}`)
    .join('\n');
}

function reportFailure(error: unknown): string {
  if (error instanceof AiProviderError) {
    return `   ОТКАЗ: ${error.code}${error.httpStatus === undefined ? '' : ` (HTTP ${error.httpStatus})`}, повторяемый: ${error.retryable}`;
  }
  return `   ОТКАЗ: ${(error as Error).message}`;
}

interface Attempt {
  readonly ok: boolean;
  /** Ответил ли шлюз вообще. Сужать поля имеет смысл только тогда. */
  readonly answered: boolean;
}

async function viaProvider(
  protocol: 'openai-chat' | 'anthropic-messages',
  model: string,
): Promise<Attempt> {
  const provider = createHttpAiProvider({ protocol, baseUrl: BASE_URL, apiKey: KEY, model, ...LIMITS });
  try {
    const result = await provider.generateTurn(request);
    console.log(describe(result));
    if (result.usage !== undefined) {
      console.log(`   токены: вход ${result.usage.inputTokens}, выход ${result.usage.outputTokens}`);
    }
    return { ok: true, answered: true };
  } catch (error) {
    console.log(reportFailure(error));
    const answered = error instanceof AiProviderError
      && (error.code === 'http_error' || error.code === 'invalid_response');
    return { ok: false, answered };
  }
}

/**
 * Сужение: сырой запрос мимо нашего провайдера, чтобы менять по одному полю.
 * Возвращает код состояния и первые строки тела — тут это диагностика, а не
 * рабочий путь, поэтому тело показывается.
 */
async function raw(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  console.log(`   HTTP ${response.status}: ${text.slice(0, 260)}`);
}

function openAiTools(strict: boolean): unknown[] {
  return toolCatalog().map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters, ...(strict ? { strict: true } : {}) },
  }));
}

const messages = [
  { role: 'system', content: request.system },
  { role: 'user', content: request.messages[0]?.role === 'user' ? request.messages[0].content : '' },
];

async function main(): Promise<void> {
  KEY = apiKey();

  console.log(`Шлюз: ${BASE_URL}\n`);

  console.log(`1. Родная форма Anthropic, ${CLAUDE_MODEL}`);
  const anthropic = await viaProvider('anthropic-messages', CLAUDE_MODEL);

  console.log(`\n2. OpenAI-форма нашим кодом, ${OPENAI_MODEL}`);
  const openAi = await viaProvider('openai-chat', OPENAI_MODEL);

  // Сужать поля есть смысл только если шлюз ответил: при мёртвой сети
  // ответом будет та же мёртвая сеть, и виновное поле она не назовёт.
  if (!openAi.ok && openAi.answered) {
    console.log('\n3. Сужение: то же, но max_tokens вместо max_completion_tokens');
    await raw({ model: OPENAI_MODEL, messages, max_tokens: 512, tools: openAiTools(true), parallel_tool_calls: false });

    console.log('\n4. Сужение: max_completion_tokens, но без strict');
    await raw({ model: OPENAI_MODEL, messages, max_completion_tokens: 512, tools: openAiTools(false), parallel_tool_calls: false });
  }

  console.log('\nИтог:');
  console.log(`  родная форма Anthropic: ${anthropic.ok ? 'работает' : 'НЕ работает'}`);
  console.log(`  OpenAI-форма нашим кодом: ${openAi.ok ? 'работает' : 'НЕ работает'}`);
  if (!openAi.ok && openAi.answered) {
    console.log('  Смотрите шаги 3 и 4: успех в одном из них называет виновное поле.');
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
