import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toolCatalog } from '../../src/modules/ai/catalog.ts';
import type { AiMessage, AiProvider, AiTurnRequest } from '../../src/modules/ai/provider.ts';
import type { CommandReceiptSummary, ToolGateway } from '../../src/modules/ai/gateway.ts';
import { runTurn } from '../../src/modules/ai/turn.ts';
import {
  AiProviderError, createHttpAiProvider, createFallbackAiProvider,
  type HttpAiProviderOptions,
} from '../../src/modules/ai/providers/http.ts';

const request: AiTurnRequest = {
  system: 'Тестовые правила',
  messages: [{ role: 'user', content: 'Синтетическое задание' }],
  tools: toolCatalog(),
};
const options: HttpAiProviderOptions = {
  protocol: 'openai-chat', baseUrl: 'https://example.invalid/v1',
  apiKey: 'EXAMPLE-credential', model: 'fixture-model',
  timeoutMs: 100, maxOutputTokens: 256, maxResponseBytes: 4096,
};
const openai = (extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ответ' } }], ...extra,
});
const anthropic = (extra: Record<string, unknown> = {}) => ({
  role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ответ' }], ...extra,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup(body: unknown = openai(), override: Partial<HttpAiProviderOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body));
  return { fetch, provider: createHttpAiProvider({ ...options, ...override }, { fetch }) };
}
function sent(fetch: ReturnType<typeof setup>['fetch']) {
  const [url, init] = fetch.mock.calls[0]!;
  return { url: String(url), init: init!, body: JSON.parse(String(init?.body)) };
}
afterEach(() => vi.useRealTimers());

describe('HTTP AI: protocol boundary', () => {
  it('OpenAI: explicit fields, credentials only in header, bounded generation', async () => {
    const { provider, fetch } = setup();
    const dirty = { ...request, internalUserId: 'PRIVATE_SENTINEL' };
    await provider.generateTurn(dirty);
    const { url, init, body } = sent(fetch);
    expect(url).toBe('https://example.invalid/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer EXAMPLE-credential');
    expect(init.redirect).toBe('error');
    expect(body).toMatchObject({ model: 'fixture-model', max_completion_tokens: 256, stream: false, store: false, parallel_tool_calls: false });
    expect(body.messages[0]).toEqual({ role: 'system', content: request.system });
    expect(body.tools[0]).toEqual({ type: 'function', function: {
      name: request.tools[0]!.name, description: request.tools[0]!.description,
      parameters: request.tools[0]!.parameters, strict: true,
    } });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_SENTINEL|EXAMPLE-credential|commandKinds|mutates/);
  });

  it('Anthropic: native endpoint and grouped tool results, no OpenAI fields', async () => {
    const { provider, fetch } = setup(anthropic(), { protocol: 'anthropic-messages' });
    await provider.generateTurn({ ...request, messages: [
      ...request.messages,
      { role: 'assistant', content: '', toolCalls: [
        { id: 'a', name: 'get_today_quests', arguments: {} },
        { id: 'b', name: 'get_today_quests', arguments: {} },
      ] },
      { role: 'tool', name: 'get_today_quests', callId: 'a', content: '{"quests":[]}' },
      { role: 'tool', name: 'get_today_quests', callId: 'b', content: '{"quests":[]}' },
    ] });
    const { url, init, body } = sent(fetch);
    expect(url).toBe('https://example.invalid/v1/messages');
    expect(new Headers(init.headers).get('x-api-key')).toBe('EXAMPLE-credential');
    expect(new Headers(init.headers).get('anthropic-version')).toBe('2023-06-01');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(body).toMatchObject({ system: request.system, max_tokens: 256, stream: false });
    expect(body.tools[0].input_schema).toEqual(request.tools[0]!.parameters);
    expect(body.tools[0]).not.toHaveProperty('function');
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content.map((b: { type: string }) => b.type)).toEqual(['tool_use', 'tool_use']);
    expect(body.messages[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a', content: '{"quests":[]}' },
      { type: 'tool_result', tool_use_id: 'b', content: '{"quests":[]}' },
    ] });
  });

  it('OpenAI: tool round trip preserves IDs, object arguments and results', async () => {
    const { provider, fetch } = setup(openai({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'get_today_quests', arguments: '{}' } },
      ],
    } }] }));
    const first = await provider.generateTurn(request);
    expect(first).toMatchObject({ text: '', toolCalls: [{ id: 'call-a', name: 'get_today_quests', arguments: {} }] });
    fetch.mockResolvedValueOnce(response(openai()));
    await provider.generateTurn({ ...request, messages: [...request.messages,
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
      { role: 'tool', name: 'get_today_quests', callId: 'call-a', content: '{"quests":[]}' },
    ] });
    const body = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
    expect(body.messages[2].tool_calls[0].function.arguments).toBe('{}');
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call-a', content: '{"quests":[]}' });
  });

  it('Anthropic: text and tool_use normalized without vendor objects', async () => {
    const { provider } = setup(anthropic({ stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Проверю.' },
      { type: 'tool_use', id: 'tool-a', name: 'get_today_quests', input: {} },
    ], usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } }), { protocol: 'anthropic-messages' });
    expect(await provider.generateTurn(request)).toEqual({ text: 'Проверю.', toolCalls: [
      { id: 'tool-a', name: 'get_today_quests', arguments: {} },
    ], usage: { inputTokens: 20, outputTokens: 8 } });
  });

  it.each(['length', 'content_filter'])('does not execute incomplete/filtered OpenAI output: %s', async (finish_reason) => {
    const { provider } = setup(openai({ choices: [{ finish_reason, message: {
      role: 'assistant', content: 'partial', tool_calls: [{ id: 'a', type: 'function', function: { name: 'complete_quest', arguments: '{}' } }],
    } }] }));
    await expect(provider.generateTurn(request)).rejects.toMatchObject({ code: finish_reason === 'length' ? 'truncated' : 'refused' });
  });
  it.each(['max_tokens', 'refusal', 'pause_turn'])('rejects unfinished/unsupported Anthropic stop: %s', async (stop_reason) => {
    const { provider } = setup(anthropic({ stop_reason }), { protocol: 'anthropic-messages' });
    await expect(provider.generateTurn(request)).rejects.toMatchObject({ code: stop_reason === 'max_tokens' ? 'truncated' : stop_reason === 'refusal' ? 'refused' : 'invalid_response' });
  });

  it.each(['{bad', 'null', '[]'])('rejects malformed/non-object tool arguments atomically: %s', async (args) => {
    const { provider } = setup(openai({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'ok', type: 'function', function: { name: 'get_today_quests', arguments: '{}' } },
      { id: 'bad', type: 'function', function: { name: 'complete_quest', arguments: args } },
    ] } }] }));
    await expect(provider.generateTurn(request)).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('rejects duplicate tool IDs', async () => {
    const tool = { type: 'tool_use', id: 'same', name: 'get_today_quests', input: {} };
    const { provider } = setup(anthropic({ stop_reason: 'tool_use', content: [tool, tool] }), { protocol: 'anthropic-messages' });
    await expect(provider.generateTurn(request)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects unsupported content instead of silently dropping blocks', async () => {
    const { provider } = setup(anthropic({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'ok' }] }), { protocol: 'anthropic-messages' });
    await expect(provider.generateTurn(request)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('body read also has deadline, even after headers arrived', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const provider = createHttpAiProvider(options, { fetch });
    let rejection: unknown;
    const pending = provider.generateTurn(request).catch((error: unknown) => { rejection = error; });
    await vi.advanceTimersByTimeAsync(101);
    expect(rejection).toMatchObject({ code: 'timeout', retryable: true });
    await pending;
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('rejects oversized streaming body without relying on Content-Length', async () => {
    const { provider } = setup(openai({ padding: 'x'.repeat(5000) }));
    await expect(provider.generateTurn(request)).rejects.toMatchObject({ code: 'response_too_large', retryable: false });
  });

  it('opoznav — код берётся из тела ошибки, а сам текст не сохраняется', async () => {
    // Тело чужой ошибки может содержать кусок переписки и учётные данные.
    // Из него берётся короткий код и ничего больше: исключение не должно
    // становиться местом, куда утекает то, что мы отказались хранить.
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(response({ error: { message: 'PRIVATE_SENTINEL', type: 'invalid_request_error',
      code: 'upstream_unavailable' } }, 400));

    const error = await provider.generateTurn(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'http_error', httpStatus: 400, retryable: true });
    expect(inspect(error, { depth: null })).not.toMatch(/PRIVATE_SENTINEL|EXAMPLE-credential/);
  });

  it('нечитаемое тело ошибки не делает отказ временным и не роняет разбор', async () => {
    const { provider, fetch } = setup();
    fetch.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 400 }));

    await expect(provider.generateTurn(request)).rejects.toMatchObject({ httpStatus: 400, retryable: false });
  });

  it.each([401, 403, 429, 500, 503])('safe HTTP %i classification: no remote text/credentials retained', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: 'PRIVATE_SENTINEL' }, status));
    const provider = createHttpAiProvider(options, { fetch });
    const error = await provider.generateTurn(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'http_error', httpStatus: status, retryable: status === 429 || status >= 500 });
    expect(inspect(error)).not.toMatch(/PRIVATE_SENTINEL|EXAMPLE-credential/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('network exceptions do not retain sensitive cause', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('PRIVATE_SENTINEL EXAMPLE-credential'));
    const error = await createHttpAiProvider(options, { fetch }).generateTurn(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'network_error', retryable: true });
    expect(inspect(error)).not.toMatch(/PRIVATE_SENTINEL|EXAMPLE-credential/);
  });

  it.each(['http://example.invalid/v1', 'https://u:EXAMPLE@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'https://example.invalid/v1#fragment'])('rejects unsafe base URL %s', (baseUrl) => {
    expect(() => createHttpAiProvider({ ...options, baseUrl })).toThrow(AiProviderError);
  });

  it('fails before network on invalid limits', () => {
    for (const field of ['timeoutMs', 'maxOutputTokens', 'maxResponseBytes'] as const) {
      expect(() => createHttpAiProvider({ ...options, [field]: 0 })).toThrow(AiProviderError);
      expect(() => createHttpAiProvider({ ...options, [field]: NaN })).toThrow(AiProviderError);
      expect(() => createHttpAiProvider({ ...options, [field]: 0.5 })).toThrow(AiProviderError);
    }
  });

  const assistant: AiMessage = { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'get_today_quests', arguments: {} }] };
  const tool: AiMessage = { role: 'tool', callId: 'a', name: 'get_today_quests', content: '{}' };
  const brokenHistories: { name: string; messages: AiMessage[] }[] = [
    { name: 'orphan result', messages: [tool] },
    { name: 'missing result', messages: [assistant] },
    { name: 'wrong name', messages: [assistant, { ...tool, name: 'complete_quest' }] },
    { name: 'interrupted results', messages: [assistant, request.messages[0]!, tool] },
    { name: 'reused ID', messages: [assistant, tool, assistant, tool] },
  ];
  it.each(brokenHistories)('rejects broken tool history before HTTP: $name', async ({ messages }) => {
    const { provider, fetch } = setup();
    await expect(provider.generateTurn({ ...request, messages })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hard upper caps cannot be disabled through config', () => {
    for (const [field, cap] of [['timeoutMs', 60_000], ['maxOutputTokens', 16_384], ['maxResponseBytes', 2_097_152]] as const) {
      expect(() => createHttpAiProvider({ ...options, [field]: cap + 1 })).toThrow(AiProviderError);
    }
  });

  it('request size cap applies before HTTP', async () => {
    const { provider, fetch } = setup();
    await expect(provider.generateTurn({ ...request, messages: [{ role: 'user', content: 'я'.repeat(140_000) }] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('deadline also bounds waiting for headers', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    let rejection: unknown;
    const pending = createHttpAiProvider(options, { fetch }).generateTurn(request).catch((error: unknown) => { rejection = error; });
    await vi.advanceTimersByTimeAsync(101);
    expect(rejection).toMatchObject({ code: 'timeout' });
    await pending;
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('config mutation cannot redirect credentials or change the model', async () => {
    const mutable = { ...options };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(openai()));
    const provider = createHttpAiProvider(mutable, { fetch });
    mutable.baseUrl = 'https://untrusted.invalid'; mutable.apiKey = 'changed'; mutable.model = 'changed';
    await provider.generateTurn(request);
    expect(sent(fetch).url).toBe('https://example.invalid/v1/chat/completions');
    expect(sent(fetch).body.model).toBe(options.model);
    expect(new Headers(sent(fetch).init.headers).get('authorization')).toBe(`Bearer ${options.apiKey}`);
  });

  it('OpenAI usage is optional and preserves cached-inclusive input count', async () => {
    expect((await setup().provider.generateTurn(request)).usage).toBeUndefined();
    expect((await setup(openai({ usage: { prompt_tokens: 12, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 5 } } })).provider.generateTurn(request)).usage).toEqual({ inputTokens: 12, outputTokens: 8 });
    await expect(setup(openai({ usage: { prompt_tokens: -1, completion_tokens: 8 } })).provider.generateTurn(request)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('malformed response JSON fails closed with safe error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{PRIVATE_SENTINEL'));
    const error = await createHttpAiProvider(options, { fetch }).generateTurn(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect(inspect(error)).not.toContain('PRIVATE_SENTINEL');
  });
});

describe('bounded provider fallback', () => {
  it('requires one to three configured providers', () => {
    expect(() => createFallbackAiProvider([])).toThrow(AiProviderError);
    expect(() => createFallbackAiProvider(Array.from({ length: 4 }, () => setup().provider))).toThrow(AiProviderError);
  });

  it('transient failure tries secondary once, preserving transcript/results', async () => {
    const a = setup(); a.fetch.mockResolvedValue(response({}, 503));
    const b = setup(anthropic(), { protocol: 'anthropic-messages' });
    const provider = createFallbackAiProvider([a.provider, b.provider]);
    expect((await provider.generateTurn({ ...request, messages: [...request.messages,
      { role: 'assistant', content: '', toolCalls: [{ id: 'done', name: 'complete_quest', arguments: { quest_ref: 'q1' } }] },
      { role: 'tool', callId: 'done', name: 'complete_quest', content: '{"committed":true}' },
    ] })).text).toBe('Ответ');
    expect(a.fetch).toHaveBeenCalledTimes(1); expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(sent(b.fetch).body.messages[0].content).toBe(request.messages[0]!.content);
    expect(sent(b.fetch).body.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'done', content: '{"committed":true}' }]);
  });

  it('auth/protocol failure is not silently retried or routed to another vendor', async () => {
    const a = setup(); a.fetch.mockResolvedValue(response({}, 401));
    const b = setup();
    await expect(createFallbackAiProvider([a.provider, b.provider]).generateTurn(request)).rejects.toMatchObject({ httpStatus: 401 });
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('exhaustion remains bounded and does not expose previous errors', async () => {
    const a = setup(); a.fetch.mockResolvedValue(response({}, 429));
    const b = setup(); b.fetch.mockResolvedValue(response({}, 503));
    await expect(createFallbackAiProvider([a.provider, b.provider]).generateTurn(request)).rejects.toMatchObject({ httpStatus: 503 });
    expect(a.fetch).toHaveBeenCalledTimes(1); expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('temporarily unavailable 400 — недоступность поставщика считается временной и включает перебор', async () => {
    // Шлюз, через который куплен доступ, отдаёт именно так: HTTP 400 с
    // `invalid_request_error`, хотя запрос верен, а недоступен его канал к
    // поставщику. Проверено живыми запросами 17 сентября (handoff 3.19): весь
    // вечер вся линия Claude отвечала так, пока gpt-6-astra работал. Считать
    // это негодным запросом значит не включить перебор ровно в том случае,
    // ради которого он написан.
    const upstream = { error: { message: 'API is temporarily unavailable. Try again later.',
      type: 'invalid_request_error', code: 'upstream_unavailable', request_id: 'synthetic' } };
    const a = setup(); a.fetch.mockResolvedValue(response(upstream, 400));
    const b = setup(anthropic(), { protocol: 'anthropic-messages' });

    // Отказ ловится, а не всплывает: проверка должна падать утверждением, иначе
    // отрицательный контроль не отличит снятую защиту от сломанной сборки.
    const answer = await createFallbackAiProvider([a.provider, b.provider])
      .generateTurn(request)
      .catch(() => null);

    expect(answer?.text).toBe('Ответ');
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('genuine bad request 400 — настоящий негодный запрос не повторяется', async () => {
    // Иначе перебор оплачивает второй попыткой каждую собственную ошибку:
    // запрос, который не понравился одному поставщику, не понравится и второму.
    const a = setup();
    a.fetch.mockResolvedValue(response({ error: { message: 'Unknown parameter', type: 'invalid_request_error' } }, 400));
    const b = setup();

    await expect(createFallbackAiProvider([a.provider, b.provider]).generateTurn(request))
      .rejects.toMatchObject({ httpStatus: 400, retryable: false });
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('unknown programming error does not trigger paid fallback', async () => {
    const a: AiProvider = { name: 'bug', generateTurn: async () => { throw new Error('bug'); } };
    const b = setup();
    await expect(createFallbackAiProvider([a, b.provider]).generateTurn(request)).rejects.toThrow('bug');
    expect(b.fetch).not.toHaveBeenCalled();
  });

  it('fallback after a tool commit does not execute the tool again in runTurn', async () => {
    const a = setup();
    a.fetch.mockReset().mockResolvedValueOnce(response(openai({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [{ id: 'commit', type: 'function', function: { name: 'complete_quest', arguments: '{"quest_ref":"q1"}' } }],
    } }] }))).mockResolvedValueOnce(response({}, 503));
    const b = setup(anthropic(), { protocol: 'anthropic-messages' });
    const receipt: CommandReceiptSummary = { tool: 'complete_quest', status: 'committed', title: 'Тест', occurrenceId: 'synthetic', executionStatus: 'completed' };
    const invoke = vi.fn<ToolGateway['invoke']>().mockResolvedValue({ callId: 'commit', name: 'complete_quest', status: 'ok', content: { committed: true }, receipt });
    const result = await runTurn({
      provider: createFallbackAiProvider([a.provider, b.provider]),
      gateway: { definitions: () => toolCatalog(), invoke, receipts: () => [receipt] },
      turnId: 'synthetic-turn', message: 'Тестовое выполнение',
    });
    expect(result).toMatchObject({ rounds: 2, stopReason: 'answered', receipts: [receipt] });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({ id: 'commit', name: 'complete_quest', arguments: { quest_ref: 'q1' } });
    expect(a.fetch).toHaveBeenCalledTimes(2); expect(b.fetch).toHaveBeenCalledTimes(1);
    expect(sent(b.fetch).body.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'commit', content: '{"committed":true}' }]);
  });
});
