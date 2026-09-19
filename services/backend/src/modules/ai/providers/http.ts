import { assertOutboundAllowed } from '../egress.ts';
import type {
  AiMessage, AiProvider, AiTurnRequest, AiTurnResponse, AttemptAccounting, ToolCall,
} from '../provider.ts';

/** Transport only. Not wired to the bot until egress policy, durable turns and quotas exist. */
export interface HttpAiProviderOptions {
  readonly protocol: 'openai-chat' | 'anthropic-messages';
  /** Trusted server config including API version, e.g. https://host/v1. Never model input. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
}

type ErrorCode = 'invalid_config' | 'invalid_request' | 'invalid_response' | 'http_error'
  | 'network_error' | 'timeout' | 'response_too_large' | 'truncated' | 'refused';

/** No upstream body, URL, headers or cause: those may contain private text and credentials. */
export class AiProviderError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ErrorCode, readonly httpStatus?: number, upstreamTransient = false) {
    super(`AI provider: ${code}`);
    this.name = 'AiProviderError';
    this.retryable = code === 'timeout' || code === 'network_error'
      || (code === 'http_error'
        && (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500) || upstreamTransient));
  }
}

/**
 * Коды, которыми посредник сообщает о собственной временной недоступности,
 * оставаясь при этом в HTTP 400.
 *
 * По коду состояния такой отказ неотличим от негодного запроса, и перебор
 * провайдеров не включается — ровно в том случае, ради которого он написан.
 * Проверено живыми запросами 17 сентября (handoff 3.19): шлюз отвечал
 * `400 upstream_unavailable` на всю линию Claude, пока модель другого
 * семейства работала.
 *
 * Список закрытый. Открывать его до «любой 400 с кодом» нельзя: тогда перебор
 * начнёт оплачивать вторую попытку для каждой нашей собственной ошибки в
 * запросе, а она не станет верной у второго поставщика.
 */
const TRANSIENT_UPSTREAM_CODES = new Set(['upstream_unavailable', 'overloaded_error']);

/** Сколько байт тела ошибки читаем ради одного опознавательного кода. */
const ERROR_PROBE_BYTES = 4096;

/**
 * Опознание временной недоступности по телу ошибки.
 *
 * Из чужого тела берётся короткий идентификатор и ничего больше: сообщение об
 * ошибке у посредника нередко содержит кусок отправленного текста, а он у нас
 * личный. Наружу отсюда выходит только `true`/`false`, поэтому сохранить
 * что-либо лишнее физически негде.
 *
 * Любая неудача разбора означает «не временная»: догадка в сторону повтора
 * стоит денег, догадка в сторону отказа — нет.
 */
async function readsAsTransient(response: Response): Promise<boolean> {
  const stream = response.body;
  if (stream === null) return false;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_PROBE_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      chunks.push(part.value);
    }
  } catch {
    return false;
  } finally {
    void reader.cancel().catch(() => {});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).subarray(0, ERROR_PROBE_BYTES).toString('utf8')) as unknown;
  } catch {
    return false;
  }
  const error = (parsed as JsonObject | null)?.['error'];
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return false;
  return ['code', 'type'].some((key) => {
    const value = (error as JsonObject)[key];
    // Длина и алфавит ограничены: это опознавательный код, а не свободный текст.
    return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value)
      && TRANSIENT_UPSTREAM_CODES.has(value);
  });
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiProviderError('invalid_response');
  }
  return value as JsonObject;
}
function nonempty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new AiProviderError('invalid_response');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new AiProviderError('invalid_response');
  return value;
}
function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new AiProviderError('invalid_response'); }
}
function tokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AiProviderError('invalid_response');
  return value;
}

function endpoint(options: HttpAiProviderOptions): string {
  try {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || !options.model.trim()
      || !['openai-chat', 'anthropic-messages'].includes(options.protocol)) {
      throw new AiProviderError('invalid_config');
    }
    for (const [value, max] of [[options.timeoutMs, 60_000], [options.maxOutputTokens, 16_384], [options.maxResponseBytes, 2_097_152]]) {
      if (value === undefined || max === undefined || !Number.isSafeInteger(value) || value <= 0 || value > max) {
        throw new AiProviderError('invalid_config');
      }
    }
    url.pathname = url.pathname.replace(/\/+$/, '')
      + (options.protocol === 'openai-chat' ? '/chat/completions' : '/messages');
    return url.toString();
  } catch { throw new AiProviderError('invalid_config'); }
}

/** Validate pairing before changing wire formats: missing results must never become user text. */
function validateHistory(messages: readonly AiMessage[]): void {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (pending.get(message.callId) !== message.name) throw new AiProviderError('invalid_request');
      pending.delete(message.callId);
    } else {
      if (pending.size !== 0) throw new AiProviderError('invalid_request');
      if (message.role === 'assistant') {
        for (const call of message.toolCalls) {
          if (seen.has(call.id) || !call.id || !call.name) throw new AiProviderError('invalid_request');
          seen.add(call.id);
          pending.set(call.id, call.name);
        }
      }
    }
  }
  if (pending.size !== 0) throw new AiProviderError('invalid_request');
}

function openAiBody(request: AiTurnRequest, options: HttpAiProviderOptions): JsonObject {
  return {
    model: options.model, stream: false, store: false,
    max_completion_tokens: options.maxOutputTokens, parallel_tool_calls: false,
    messages: [
      { role: 'system', content: request.system },
      ...request.messages.map((m) => {
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.callId, content: m.content };
        if (m.role === 'user') return { role: 'user', content: m.content };
        return {
          role: 'assistant', content: m.content || null,
          ...(m.toolCalls.length === 0 ? {} : { tool_calls: m.toolCalls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })) }),
        };
      }),
    ],
    tools: request.tools.map((t) => ({
      type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters, strict: true },
    })),
  };
}

function anthropicBody(request: AiTurnRequest, options: HttpAiProviderOptions): JsonObject {
  const messages: { role: 'user' | 'assistant'; content: string | JsonObject[] }[] = [];
  for (const m of request.messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.callId, content: m.content };
      const last = messages.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
      ] });
    } else messages.push({ role: 'user', content: m.content });
  }
  return {
    model: options.model, system: request.system, messages,
    max_tokens: options.maxOutputTokens, stream: false,
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
  };
}

function checkedResult(text: string, toolCalls: ToolCall[]): Pick<AiTurnResponse, 'text' | 'toolCalls'> {
  const ids = new Set<string>();
  for (const call of toolCalls) {
    if (ids.has(call.id)) throw new AiProviderError('invalid_response');
    ids.add(call.id);
  }
  if (!text && toolCalls.length === 0) throw new AiProviderError('invalid_response');
  return { text, toolCalls };
}

function parseOpenAi(data: unknown): AiTurnResponse {
  const root = object(data);
  const choices = array(root['choices']);
  if (choices.length !== 1) throw new AiProviderError('invalid_response');
  const choice = object(choices[0]);
  if (choice['finish_reason'] === 'length') throw new AiProviderError('truncated');
  if (choice['finish_reason'] === 'content_filter') throw new AiProviderError('refused');
  if (!['stop', 'tool_calls'].includes(String(choice['finish_reason']))) throw new AiProviderError('invalid_response');
  const message = object(choice['message']);
  if (message['role'] !== 'assistant') throw new AiProviderError('invalid_response');
  if (message['refusal'] != null) throw new AiProviderError('refused');
  const rawText = message['content'];
  if (rawText !== null && typeof rawText !== 'string') throw new AiProviderError('invalid_response');
  const calls = message['tool_calls'] == null ? [] : array(message['tool_calls']);
  if ((choice['finish_reason'] === 'tool_calls') !== (calls.length > 0)) throw new AiProviderError('invalid_response');
  const toolCalls = calls.map((raw): ToolCall => {
    const call = object(raw);
    if (call['type'] !== 'function') throw new AiProviderError('invalid_response');
    const fn = object(call['function']);
    return { id: nonempty(call['id']), name: nonempty(fn['name']), arguments: object(parseJson(nonempty(fn['arguments']))) };
  });
  const result = checkedResult(rawText ?? '', toolCalls);
  if (root['usage'] == null) return result;
  const usage = object(root['usage']);
  return { ...result, usage: { inputTokens: tokenCount(usage['prompt_tokens']), outputTokens: tokenCount(usage['completion_tokens']) } };
}

function parseAnthropic(data: unknown): AiTurnResponse {
  const root = object(data);
  if (root['role'] !== 'assistant') throw new AiProviderError('invalid_response');
  if (root['stop_reason'] === 'max_tokens') throw new AiProviderError('truncated');
  if (root['stop_reason'] === 'refusal') throw new AiProviderError('refused');
  if (!['end_turn', 'tool_use'].includes(String(root['stop_reason']))) throw new AiProviderError('invalid_response');
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const raw of array(root['content'])) {
    const block = object(raw);
    if (block['type'] === 'text' && typeof block['text'] === 'string') text.push(block['text']);
    else if (block['type'] === 'tool_use') toolCalls.push({
      id: nonempty(block['id']), name: nonempty(block['name']), arguments: object(block['input']),
    });
    else throw new AiProviderError('invalid_response');
  }
  if ((root['stop_reason'] === 'tool_use') !== (toolCalls.length > 0)) throw new AiProviderError('invalid_response');
  const result = checkedResult(text.join('\n'), toolCalls);
  if (root['usage'] == null) return result;
  const usage = object(root['usage']);
  const inputTokens = tokenCount(usage['input_tokens']) + tokenCount(usage['cache_read_input_tokens'] ?? 0)
    + tokenCount(usage['cache_creation_input_tokens'] ?? 0);
  return { ...result, usage: { inputTokens: tokenCount(inputTokens), outputTokens: tokenCount(usage['output_tokens']) } };
}

/**
 * Учёт, который ничего не считает.
 *
 * Только для проверок транспорта, где базы нет вовсе. В рабочих путях учёт
 * обязателен и приходит из `buildAiProvider`: умолчание «не считать» здесь
 * означало бы, что забытая зависимость молча отключает предел и замечается
 * по счёту.
 */
export const unmeteredAttempts: AttemptAccounting = {
  reserve: async () => ({ settle: async () => {} }),
};

export function createHttpAiProvider(
  options: HttpAiProviderOptions,
  dependencies: {
    readonly fetch?: typeof globalThis.fetch;
    readonly accounting?: AttemptAccounting;
  } = {},
): AiProvider {
  const url = endpoint(options);
  // Capture immutable config: another caller changing an object must not redirect credentials.
  const config = { ...options };
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const accounting = dependencies.accounting ?? unmeteredAttempts;
  return {
    name: config.protocol,
    async generateTurn(request) {
      // Политика исходящих стоит здесь, у самого выхода: так она срабатывает на
      // каждом раунде и на каждом поставщике цепочки, включая пути, которые
      // появятся позже и про неё знать не будут (T-04b-2).
      assertOutboundAllowed(request);
      validateHistory(request.messages);
      let body: string;
      try {
        body = JSON.stringify(config.protocol === 'openai-chat' ? openAiBody(request, config) : anthropicBody(request, config));
      } catch { throw new AiProviderError('invalid_request'); }
      if (Buffer.byteLength(body) > 262_144) throw new AiProviderError('invalid_request');
      // Резерв ставится здесь: после сборки тела — негодный запрос не уходит
      // и платить за него не за что, — но строго **до** fetch. Проверять предел
      // после ответа бессмысленно: деньги уже потрачены.
      const ticket = await accounting.reserve({ provider: config.protocol, model: config.model });
      let charged = false;
      const settle = async (usage: AiTurnResponse['usage'] | null): Promise<void> => {
        if (charged) return;
        charged = true;
        // Неудача учёта не отменяет ответ и не подменяет исходную ошибку:
        // незакрытый резерв закроет сверка, по оценке. Потерять здесь ответ
        // человека было бы хуже, чем разойтись в учёте на одну попытку.
        await ticket.settle(usage).catch(() => {});
      };
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AiProviderError('timeout')); }, config.timeoutMs);
      });
      const exchange = async (): Promise<AiTurnResponse> => {
        const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
        if (config.protocol === 'openai-chat') headers['authorization'] = `Bearer ${config.apiKey}`;
        else { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01'; }
        const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
          throw new AiProviderError('http_error', response.status, await readsAsTransient(response));
        }
        if (!response.body) throw new AiProviderError('invalid_response');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > config.maxResponseBytes) throw new AiProviderError('response_too_large');
          chunks.push(part.value);
        }
        const data = parseJson(Buffer.concat(chunks).toString('utf8'));
        return config.protocol === 'openai-chat' ? parseOpenAi(data) : parseAnthropic(data);
      };
      try {
        const result = await Promise.race([exchange(), deadline]);
        await settle(result.usage ?? null);
        return result;
      }
      catch (error) {
        // Отказ расход не отменяет: запрос ушёл и был обработан, а счётчиков
        // при отказе почти никогда нет — это та самая «неизвестная» попытка.
        await settle(null);
        if (error instanceof AiProviderError) throw error;
        throw new AiProviderError(controller.signal.aborted ? 'timeout' : 'network_error');
      } finally {
        clearTimeout(timer);
        controller.abort();
        void reader?.cancel().catch(() => {});
      }
    },
  };
}

/** Each entry once per generateTurn; never retries tools or restarts a conversation. */
export function createFallbackAiProvider(providers: readonly AiProvider[]): AiProvider {
  if (providers.length < 1 || providers.length > 3) throw new AiProviderError('invalid_config');
  const chain = [...providers];
  return {
    name: 'fallback',
    async generateTurn(request) {
      for (const [index, provider] of chain.entries()) {
        try { return await provider.generateTurn(request); }
        catch (error) {
          if (!(error instanceof AiProviderError) || !error.retryable || index === chain.length - 1) throw error;
        }
      }
      throw new AiProviderError('invalid_config');
    },
  };
}
