#!/usr/bin/env python3
"""Negative controls for T-04b-1 (synthetic HTTP, no DB or external requests).

Run without simultaneous edits/tests of http.ts: temporarily mutates that file
and restores it in finally. Optional positional bounds select [start, stop).
Detailed reports go to a unique temporary directory. Needs installed npm deps.
"""
from pathlib import Path
import subprocess, json, sys, os, tempfile

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
ARTIFACTS = Path(tempfile.mkdtemp(prefix='ai-transport-controls-'))
print(f'Reports: {ARTIFACTS}', flush=True)
p = Path('services/backend/src/modules/ai/providers/http.ts')
original = p.read_text()
cases = []
def add(name, selector, old, new):
    cases.append((name, selector, [(old, new)]))
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
    ("  if ((choice['finish_reason'] === 'tool_calls') !== (calls.length > 0)) throw new AiProviderError('invalid_response');\n", '')]))
cases.append(('Anthropic finish guard', 'rejects unfinished/unsupported', [
    ("  if (root['stop_reason'] === 'max_tokens') throw new AiProviderError('truncated');\n", ''),
    ("  if (root['stop_reason'] === 'refusal') throw new AiProviderError('refused');\n", ''),
    ("  if (!['end_turn', 'tool_use'].includes(String(root['stop_reason']))) throw new AiProviderError('invalid_response');\n", ''),
    ("  if ((root['stop_reason'] === 'tool_use') !== (toolCalls.length > 0)) throw new AiProviderError('invalid_response');\n", '')]))
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
start = int(sys.argv[1]) if len(sys.argv)>1 else 0
stop = int(sys.argv[2]) if len(sys.argv)>2 else len(cases)
if not 0 <= start < stop <= len(cases):
    raise SystemExit('Expected 0 <= start < stop <= ' + str(len(cases)))
results = []
try:
    for index, (name, selector, replacements) in enumerate(cases[start:stop], start):
        mutated = original
        for old, new in replacements:
            if old not in mutated: raise RuntimeError(f'missing mutation {name}: {old}')
            mutated = mutated.replace(old, new)
        p.write_text(mutated)
        out = ARTIFACTS / f'control-{index}.json'
        run = subprocess.run(['npm','exec','--workspace','services/backend','--','vitest','run','tests/unit/ai-http-provider.test.ts','-t',selector,'--testTimeout','1000','--reporter=json',f'--outputFile={out}'], capture_output=True, text=True, timeout=30)
        (ARTIFACTS / f'control-{index}.log').write_text(run.stdout+run.stderr)
        report = json.loads(out.read_text()) if out.exists() else {}
        failed = [r for suite in report.get('testResults',[]) for r in suite.get('assertionResults',[]) if r.get('status')=='failed']
        caught = run.returncode != 0 and bool(failed) and all(any(marker in '\n'.join(r.get('failureMessages',[])) for marker in ['AssertionError', '_Assertion']) or 'instead of rejecting' in '\n'.join(r.get('failureMessages',[])) or 'Test timed out' in '\n'.join(r.get('failureMessages',[])) for r in failed)
        row = dict(index=index, control=name, caught=caught, failed=[r['fullName'] for r in failed])
        results.append(row)
        print(json.dumps(row,ensure_ascii=False),flush=True)
        p.write_text(original)
        if not caught: raise RuntimeError('Control did not fail as an assertion; inspect log')
finally:
    p.write_text(original)
    (ARTIFACTS / 'summary.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
