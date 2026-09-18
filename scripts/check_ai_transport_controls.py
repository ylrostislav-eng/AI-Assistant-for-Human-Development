#!/usr/bin/env python3
"""Negative controls for T-04b (synthetic HTTP, no DB or external requests).

Run without simultaneous edits/tests of the touched sources: temporarily mutates
http.ts, routing.ts or config.ts and restores all of them in finally. Optional positional bounds select [start, stop).
Detailed reports go to a unique temporary directory. Needs installed npm deps.
"""
from pathlib import Path
import subprocess, json, sys, os, tempfile

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
ARTIFACTS = Path(tempfile.mkdtemp(prefix='ai-transport-controls-'))
print(f'Reports: {ARTIFACTS}', flush=True)
HTTP = 'services/backend/src/modules/ai/providers/http.ts'
ROUTING = 'services/backend/src/modules/ai/providers/routing.ts'
CONFIG = 'services/backend/src/config.ts'
INBOX = 'services/backend/src/modules/telegram/inbox.ts'
TRANSPORT_TESTS = 'tests/unit/ai-http-provider.test.ts'
ROUTING_TESTS = 'tests/unit/ai-config.test.ts'
BOT_TESTS = 'tests/integration/telegram-ai.test.ts'
CANCEL_TESTS = 'tests/integration/telegram-cancel.test.ts'

# Исходники читаются один раз и восстанавливаются все разом: контроль, упавший
# на середине, не должен оставить репозиторий с подменённым файлом.
originals = {path: Path(path).read_text() for path in (HTTP, ROUTING, CONFIG, INBOX)}
cases = []
def add(name, selector, old, new, path=HTTP, tests=TRANSPORT_TESTS):
    cases.append((name, selector, [(old, new)], path, tests))
add('wire allowlist', 'OpenAI: explicit fields', 'model: options.model, stream: false, store: false,', '...request, model: options.model, stream: false, store: false,')
add('redirect restriction', 'OpenAI: explicit fields', "redirect: 'error'", "redirect: 'follow'")
add('generation bound', 'OpenAI: explicit fields', 'max_completion_tokens: options.maxOutputTokens', 'max_completion_tokens: undefined')
add('native Anthropic format', 'Anthropic: native endpoint', "'/chat/completions' : '/messages'", "'/chat/completions' : '/chat/completions'")
add('grouped tool results', 'Anthropic: native endpoint', "if (last?.role === 'user' && Array.isArray(last.content))", 'if (false)')
add('call result correlation', 'OpenAI: tool round trip', 'tool_call_id: m.callId', "tool_call_id: 'wrong'")
add('tool argument encoding', 'OpenAI: tool round trip', 'arguments: JSON.stringify(call.arguments)', 'arguments: call.arguments')
cases.append(('OpenAI finish guard', 'does not execute incomplete/filtered', [
    ("  if (choice['finish_reason'] === 'length') throw new AiProviderError('truncated');\n", ''),
    ("  if (choice['finish_reason'] === 'content_filter') throw new AiProviderError('refused');\n", ''),
    ("  if (!['stop', 'tool_calls'].includes(String(choice['finish_reason']))) throw new AiProviderError('invalid_response');\n", ''),
    ("  if ((choice['finish_reason'] === 'tool_calls') !== (calls.length > 0)) throw new AiProviderError('invalid_response');\n", '')], HTTP, TRANSPORT_TESTS))
cases.append(('Anthropic finish guard', 'rejects unfinished/unsupported', [
    ("  if (root['stop_reason'] === 'max_tokens') throw new AiProviderError('truncated');\n", ''),
    ("  if (root['stop_reason'] === 'refusal') throw new AiProviderError('refused');\n", ''),
    ("  if (!['end_turn', 'tool_use'].includes(String(root['stop_reason']))) throw new AiProviderError('invalid_response');\n", ''),
    ("  if ((root['stop_reason'] === 'tool_use') !== (toolCalls.length > 0)) throw new AiProviderError('invalid_response');\n", '')], HTTP, TRANSPORT_TESTS))
add('object arguments', 'rejects malformed/non-object', "arguments: object(parseJson(nonempty(fn['arguments'])))", "arguments: parseJson(nonempty(fn['arguments']))")
add('malformed arguments', 'rejects malformed/non-object', "try { return JSON.parse(text) as unknown; } catch { throw new AiProviderError('invalid_response'); }", 'try { return JSON.parse(text) as unknown; } catch { return {}; }')
add('unique response IDs', 'rejects duplicate tool IDs', "    if (ids.has(call.id)) throw new AiProviderError('invalid_response');", '')
add('unsupported block', 'rejects unsupported content', "    else throw new AiProviderError('invalid_response');", '    else continue;')
add('response deadline', 'body read also has deadline|deadline also bounds', '}, config.timeoutMs);', '}, config.timeoutMs * 2);')
add('response byte cap', 'rejects oversized streaming', "          if (size > config.maxResponseBytes) throw new AiProviderError('response_too_large');", '')
add('network redaction', 'network exceptions do not retain', "throw new AiProviderError(controller.signal.aborted ? 'timeout' : 'network_error');", "throw Object.assign(new AiProviderError(controller.signal.aborted ? 'timeout' : 'network_error'), { cause: error });")
add('HTTP redaction', 'safe HTTP|opoznav', "          throw new AiProviderError('http_error', response.status, await readsAsTransient(response));", "          const leak = response.clone();\n          throw Object.assign(new AiProviderError('http_error', response.status, await readsAsTransient(response)), { body: await leak.text() });")
add('transient 400 recognition', 'temporarily unavailable 400', "        && (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500) || upstreamTransient));", '        && (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500)));')
add('transient code allowlist', 'genuine bad request 400', "      && TRANSIENT_UPSTREAM_CODES.has(value);", '      ;')
add('HTTPS config', 'rejects unsafe base URL http:', "url.protocol !== 'https:' || ", '')
add('URL credential restriction', 'rejects unsafe base URL https://u:', 'url.username || url.password || ', '')
add('URL query restriction', 'rejects unsafe base URL.*key=secret', 'url.search || ', '')
add('URL fragment restriction', 'rejects unsafe base URL.*fragment', 'url.hash\n', 'false\n')
add('positive limits', 'fails before network on invalid limits', ' || value <= 0', '')
add('orphan history', 'rejects broken tool history', "      if (pending.get(message.callId) !== message.name) throw new AiProviderError('invalid_request');", '')
add('pending history', 'rejects broken tool history', "if (pending.size !== 0) throw new AiProviderError('invalid_request');", '')
add('unique history IDs', 'rejects broken tool history', 'seen.has(call.id) || ', '')
add('request cap', 'request size cap', "      if (Buffer.byteLength(body) > 262_144) throw new AiProviderError('invalid_request');", '')
add('immutable config', 'config mutation cannot', 'const config = { ...options };', 'const config = options;')
add('token validity', 'OpenAI usage is optional', ' || value < 0', '')
add('Anthropic cached usage', 'Anthropic: text and tool_use', "tokenCount(usage['input_tokens']) + tokenCount(usage['cache_read_input_tokens'] ?? 0)\n    + tokenCount(usage['cache_creation_input_tokens'] ?? 0)", "tokenCount(usage['input_tokens'])")
add('fallback transient only', 'auth/protocol failure', ' || !error.retryable', '')
add('fallback bounded chain', 'exhaustion remains bounded', 'const chain = [...providers];', 'const chain = [...providers, ...providers];')
add('fallback unknown error', 'unknown programming error', "if (!(error instanceof AiProviderError) || !error.retryable || index === chain.length - 1) throw error;", 'if (index === chain.length - 1) throw error;')
add('hard upper limits', 'hard upper caps', ' || value > max', '')
add('integer limits', 'fails before network on invalid limits', ' || !Number.isSafeInteger(value)', '')
add('bounded fallback config', 'requires one to three', "  if (providers.length < 1 || providers.length > 3) throw new AiProviderError('invalid_config');", '')
# Выбор формата запроса и настройки: ошибка здесь не видна глазами, потому что
# запрос выглядит правильным, а отказ неотличим от сбоя поставщика.
add('protocol by family', 'модели Claude идут родной формой', "  ['claude-', 'anthropic-messages'],", "  ['claude-', 'openai-chat'],", ROUTING, ROUTING_TESTS)
add('unknown family refusal', 'незнакомое семейство', "  if (found === undefined) {", '  if (false) {', ROUTING, ROUTING_TESTS)
add('fallback family split', 'запасная модель того же семейства', "  if (familyOf(config.fallbackModel) === familyOf(primary)) {", '  if (false) {', ROUTING, ROUTING_TESTS)
add('AI config completeness', 'ключ без адреса или без модели', "  const baseUrl = requireEnv('AI_BASE_URL', env).trim();", "  const baseUrl = (env['AI_BASE_URL'] ?? 'https://fallback.invalid/v1').trim();", CONFIG, ROUTING_TESTS)
add('AI transport encryption', 'адрес не по https', "  if (!baseUrl.startsWith('https://')) {", '  if (false) {', CONFIG, ROUTING_TESTS)
add('AI optional', 'без ключа ИИ просто нет', "    return null;\n  }\n\n  const baseUrl", "    throw new ConfigError('Не задан AI_API_KEY');\n  }\n\n  const baseUrl", CONFIG, ROUTING_TESTS)

# Ответ человеку: подтверждение обязано приходить из квитанций сервера, а не
# из слов модели, и мёртвая модель не должна выглядеть поломкой бота.
add('failure disclosure', 'не подтверждает то, чего сервер не записал', '  if (result.failures.length > 0) {', '  if (false) {', INBOX, BOT_TESTS)
add('receipt gating', 'не подтверждает то, чего сервер не записал', '  if (result.receipts.length > 0) {', '  if (true) {', INBOX, BOT_TESTS)
add('honest unavailability', 'отвечает честно и ничего не выдумывает', "      kind: 'ai_unavailable',", "      kind: 'ai_reply',", INBOX, BOT_TESTS)
add('turn id determinism', 'повтор того же обновления', "  const turnId = derivedCommandId('ai-turn', update.update_id);", '  const turnId = randomUUID();', INBOX, BOT_TESTS)
add('manual path independence', 'не ломает ручной путь', "  if (text.startsWith('/new')) {", '  if (false) {', INBOX, BOT_TESTS)

# Отмена задания: она не должна ни засчитываться выполнением, ни тихо
# применяться к состоянию, которого человек не видел.
add('cancel not completion', 'отмена не засчитывается как выполнение', "    const cancel = await issueActionToken(client, userId, quest, 'cancel_quest');", "    const cancel = await issueActionToken(client, userId, quest, 'complete_quest');", INBOX, CANCEL_TESTS)
add('cancel wording', 'убирает задание из списка', "      ? { kind: 'button_cancelled', body: 'Убрал. Отправьте /today, чтобы увидеть остальное.' }", "      ? { kind: 'button_done', body: 'Записал. Отправьте /today, чтобы увидеть остальное.' }", INBOX, CANCEL_TESTS)
add('cancel version check', 'устаревшая кнопка даёт честный отказ', '    expected_version: Number(token.expected_version),', '    expected_version: null,', INBOX, CANCEL_TESTS)
# Контроля на проверку владельца ключа здесь нет намеренно: снять её нельзя так,
# чтобы проверка упала. Политика изоляции не покажет чужую строку и без неё, так
# что проверка в запросе — второй рубеж, а не единственный. Отсутствие контроля
# тут означает «защита избыточна», а не «защита не проверена»; поставить
# контроль, который не может упасть, значит соврать самим себе.

start = int(sys.argv[1]) if len(sys.argv)>1 else 0
stop = int(sys.argv[2]) if len(sys.argv)>2 else len(cases)
if not 0 <= start < stop <= len(cases):
    raise SystemExit('Expected 0 <= start < stop <= ' + str(len(cases)))
results = []
try:
    for index, (name, selector, replacements, path, tests) in enumerate(cases[start:stop], start):
        mutated = originals[path]
        for old, new in replacements:
            if old not in mutated: raise RuntimeError(f'missing mutation {name}: {old}')
            mutated = mutated.replace(old, new)
        Path(path).write_text(mutated)
        out = ARTIFACTS / f'control-{index}.json'
        run = subprocess.run(['npm','exec','--workspace','services/backend','--','vitest','run',tests,'-t',selector,'--testTimeout','1000','--reporter=json',f'--outputFile={out}'], capture_output=True, text=True, timeout=30)
        (ARTIFACTS / f'control-{index}.log').write_text(run.stdout+run.stderr)
        report = json.loads(out.read_text()) if out.exists() else {}
        failed = [r for suite in report.get('testResults',[]) for r in suite.get('assertionResults',[]) if r.get('status')=='failed']
        caught = run.returncode != 0 and bool(failed) and all(any(marker in '\n'.join(r.get('failureMessages',[])) for marker in ['AssertionError', '_Assertion']) or 'instead of rejecting' in '\n'.join(r.get('failureMessages',[])) or 'Test timed out' in '\n'.join(r.get('failureMessages',[])) for r in failed)
        row = dict(index=index, control=name, caught=caught, failed=[r['fullName'] for r in failed])
        results.append(row)
        print(json.dumps(row,ensure_ascii=False),flush=True)
        Path(path).write_text(originals[path])
        if not caught: raise RuntimeError('Control did not fail as an assertion; inspect log')
finally:
    for path, text in originals.items():
        Path(path).write_text(text)
    (ARTIFACTS / 'summary.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
