#!/usr/bin/env python3
"""Negative controls for AI/Telegram/progression. No external provider requests.

Integration controls require an explicit DATABASE_URL to a disposable local DB;
those suites reset its schema. Unit-only index ranges do not need a database.

Run without simultaneous edits/tests of the touched sources: temporarily mutates
the selected source and restores all touched sources in finally. Optional positional bounds select [start, stop).
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
# Имя отличается от DURABLE_TESTS ниже намеренно: то описывает проверки самого
# ядра. Совпадение имён однажды увело эти контроли на чужой файл, и они
# «проходили», не запустив ни одной нужной проверки.
TELEGRAM_DURABLE_TESTS = 'telegram-durable'
RECUR_TESTS = 'tests/integration/telegram-recurring.test.ts'
STOP_TESTS = 'tests/integration/telegram-stop.test.ts'
RENAME_TESTS = 'tests/integration/telegram-rename.test.ts'
LEDGER_TESTS = 'tests/integration/xp-ledger.test.ts'
CLOSE_TESTS = 'tests/integration/day-close.test.ts'
PROGRESS_TESTS = 'tests/integration/telegram-progress.test.ts'
LEVELS = 'services/backend/src/modules/progression/levels.ts'
TURN = 'services/backend/src/modules/ai/turn.ts'
TURN_TESTS = 'tests/unit/ai-turn.test.ts'
TURN_STORE = 'services/backend/src/modules/ai/turn-store.ts'
TURN_STORE_SQL = 'services/backend/db/migrations/020_ai_turn_store.sql'
STORE_TESTS = 'tests/integration/ai-turn-store.test.ts'
BUS = 'services/backend/src/shared/commands/bus.ts'
SYNC = 'services/backend/src/modules/sync/routes.ts'
FENCE_TESTS = 'tests/integration/ai-command-fence.test.ts'
INTENTS = 'services/backend/src/modules/ai/command-intents.ts'
INTENTS_SQL = 'services/backend/db/migrations/021_ai_command_intents.sql'
INTENT_TESTS = 'tests/integration/ai-command-intents.test.ts'
DURABLE = 'services/backend/src/modules/ai/durable-turn.ts'
DURABLE_TESTS = 'tests/integration/ai-durable-turn.test.ts'
GATEWAY = 'services/backend/src/modules/ai/gateway.ts'
GATEWAY_STATE = 'services/backend/src/modules/ai/gateway-state.ts'
STATE_TESTS = 'tests/unit/ai-gateway-state.test.ts'
EGRESS = 'services/backend/src/modules/ai/egress.ts'
EGRESS_TESTS = 'tests/unit/ai-egress.test.ts'
DAY_CLOSE = 'services/backend/src/modules/scheduling/day-close.ts'
ENGINE = 'services/backend/src/modules/progression/engine.ts'
AWARD = 'services/backend/src/modules/progression/award.ts'
QUEST_COMMANDS = 'services/backend/src/modules/quests/commands.ts'

# Исходники читаются один раз и восстанавливаются все разом: контроль, упавший
# на середине, не должен оставить репозиторий с подменённым файлом.
originals = {path: Path(path).read_text() for path in (HTTP, ROUTING, CONFIG, INBOX, QUEST_COMMANDS, ENGINE, AWARD, DAY_CLOSE, LEVELS, EGRESS, TURN, TURN_STORE, TURN_STORE_SQL, BUS, SYNC, INTENTS, INTENTS_SQL, DURABLE, GATEWAY, GATEWAY_STATE)}
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
# Честный отказ переехал из catch в ветку по stopReason: провайдерская ошибка
# теперь ловится внутри runTurn. Подмена по старому месту ничего не роняла, то
# есть защита стояла непроверенной.
add('honest unavailability', 'отвечает честно и ничего не выдумывает', "        kind: outcome.result.stopReason === 'provider_error' ? 'ai_unavailable' : 'ai_reply',", "        kind: 'ai_reply',", INBOX, BOT_TESTS)
# Контроля на вывод идентификатора хода больше нет: он стоял на прежнем,
# неустойчивом разборе. Свойство переехало в хранилище ходов — повтор по той же
# области возвращает сохранённый ход, а случайный идентификатор упирается в
# ограничение уникальности и даёт ошибку, а не неверный ответ. Закреплено
# проверками ai-turn-store и ai-durable-turn.
add('manual path independence', 'не ломает ручной путь', "  if (text.startsWith('/new') || text.startsWith('/every')) {", '  if (false) {', INBOX, BOT_TESTS)

# Отмена задания: она не должна ни засчитываться выполнением, ни тихо
# применяться к состоянию, которого человек не видел.
add('cancel not completion', 'отмена не засчитывается как выполнение', "    const cancel = await issueActionToken(client, userId, quest, 'cancel_quest');", "    const cancel = await issueActionToken(client, userId, quest, 'complete_quest');", INBOX, CANCEL_TESTS)
add('cancel wording', 'убирает задание из списка', "      return { kind: 'button_cancelled', body: 'Убрал. Отправьте /today, чтобы увидеть остальное.' };", "      return { kind: 'button_done', body: 'Записал. Отправьте /today, чтобы увидеть остальное.' };", INBOX, CANCEL_TESTS)
add('cancel version check', 'устаревшая кнопка даёт честный отказ', '    expected_version: Number(token.expected_version),', '    expected_version: null,', INBOX, CANCEL_TESTS)
# Контроля на проверку владельца ключа здесь нет намеренно: снять её нельзя так,
# чтобы проверка упала. Политика изоляции не покажет чужую строку и без неё, так
# что проверка в запросе — второй рубеж, а не единственный. Отсутствие контроля
# тут означает «защита избыточна», а не «защита не проверена»; поставить
# контроль, который не может упасть, значит соврать самим себе.

# Повторение: разовое задание не должно становиться ежедневным само, а
# ежедневное — не появляться на следующий день.
add('recurring only', 'разовое задание на следующий день не появляется', "        AND t.recurrence ->> 'kind' = 'daily'\n", '', INBOX, RECUR_TESTS)
add('once stays once', 'разовое задание на следующий день не появляется', "      ...(repeating ? { recurrence: { kind: 'daily' } } : {}),", "      recurrence: { kind: 'daily' },", INBOX, RECUR_TESTS)
add('recurring clock', 'возвращается на следующий день', '  const day = await localDay(client, userId, now);\n  const templates', '  const day = await localDay(client, userId, () => new Date());\n  const templates', INBOX, RECUR_TESTS)
add('every command', 'создаётся командой и сразу попадает', "  if (text.startsWith('/new') || text.startsWith('/every')) {", "  if (text.startsWith('/new')) {", INBOX, RECUR_TESTS)

# Остановка повторения: не наугад и только про будущее.
add('stop ambiguity', 'два одинаковых названия', '  if (matched.length > 1) {', '  if (false) {', INBOX, STOP_TESTS)
add('stop title normalization', 'без учёта регистра', ".replace(/\\s+/gu, ' ').toLocaleLowerCase('ru');", ";", INBOX, STOP_TESTS)
# Удалить экземпляры контролем нельзя: внешние ключи и так не дадут, и мутация
# проверяла бы схему, а не код. Правдоподобная ошибка здесь другая — отменить
# уже созданные дни заодно с повторением.
add('stop keeps past days', 'сегодняшнее задание остаётся в списке', '    const updated = await context.client.query<{ version: string }>(\n      `UPDATE quest_templates SET recurrence = NULL', "    await context.client.query(\"UPDATE quest_occurrences SET execution_status = 'cancelled' WHERE template_id = $1\", [templateId]);\n    const updated = await context.client.query<{ version: string }>(\n      `UPDATE quest_templates SET recurrence = NULL", QUEST_COMMANDS, STOP_TESTS)

# Переименование: живое берёт новое имя, прожитое сохраняет прежнее, и наугад
# не переименовывается ничего.
add('rename keeps history', 'прожитый день сохраняет прежнее название', "          AND execution_status IN ('planned', 'active', 'partial')", '', QUEST_COMMANDS, RENAME_TESTS)
add('rename touches live', 'меняет название шаблона и сегодняшнего задания', "    const renamed = await context.client.query(", '    const renamed = { rowCount: 0 };\n    await Promise.resolve(', QUEST_COMMANDS, RENAME_TESTS)
add('rename ambiguity', 'два одинаковых названия переименовывать', '  if (matched.length > 1) {\n    // Тупик признаётся вслух', '  if (false) {\n    // Тупик признаётся вслух', INBOX, RENAME_TESTS)
add('rename separator', 'строка без разделителя объясняет формат', '  if (separator === -1) {', '  if (false) {', INBOX, RENAME_TESTS)

# Прогрессия: одна награда на одно выполнение, предел не обходится, полосы
# считают чужие минуты, а число в ответе берётся из квитанции.
add('award delta by root', 'не складывает награду дважды', "  const already = await sumOf(client, 'amount_mxp', 'user_id = $1 AND activity_root_id = $2', [", "  const already = 0n;\n  await sumOf(client, 'amount_mxp', 'user_id = $1 AND activity_root_id = $2', [", AWARD, LEDGER_TESTS)
add('daily cap', 'дневной предел обрезает награду', '    headroom(DAILY_CAP_MXP, dayOther),', '    DAILY_CAP_MXP * 1000n,', AWARD, LEDGER_TESTS)
add('rolling cap', 'скользящее окно обрезает награду', '    headroom(ROLLING_CAP_MXP, rollingOther),', '    ROLLING_CAP_MXP * 1000n,', AWARD, LEDGER_TESTS)
add('global band counter', 'день ограничен полосами', "    'user_id = $1 AND bucket_key = $2 AND activity_root_id <> $3',\n    [request.userId, bucketKey, request.activityRootId],\n  );\n\n  const seconds", "    'user_id = $1 AND bucket_key = $2 AND activity_root_id <> $3 AND false',\n    [request.userId, bucketKey, request.activityRootId],\n  );\n\n  const seconds", AWARD, LEDGER_TESTS)
add('award floor rounding', '45 минут, сложность C', '  const amountMxp = (weighted * RATE_MXP_PER_MINUTE * multipliers) / denominator;', '  const amountMxp = (weighted * RATE_MXP_PER_MINUTE * multipliers * 2n) / denominator;', ENGINE, 'tests/unit/progression-award.test.ts')
add('band boundaries', '90 минут одной семьи', '    const chunk = Math.min(remaining, untilFamily, untilGlobal);', '    const chunk = remaining;', ENGINE, 'tests/unit/progression-award.test.ts')
add('button reports planned measure', 'названа числом из квитанции', "    payload: token.action === 'complete_quest' ? await completionPayload(token.occurrence_id) : {},", '    payload: {},', INBOX, CANCEL_TESTS)

# Закрытие дня: только прошедшего и только по границе самого человека.
add('day still running', 'сегодняшнее не трогается', '    if (row.recurrence_key >= today) {', '    if (false) {', DAY_CLOSE, CLOSE_TESTS)
add('own timezone', 'часовой пояс человека решает', 'const today = userDayAt(now(), row.timezone, row.day_boundary_minutes).localDate;', "const today = userDayAt(now(), 'Europe/Moscow', row.day_boundary_minutes).localDate;", DAY_CLOSE, CLOSE_TESTS)

# Уровни: порог точный, повышение объявляется только случившееся.
add('level threshold search', 'ровно на пороге уровень уже получен', '    if (lifetimeThresholdMxp(middle) <= totalMxp) {', '    if (lifetimeThresholdMxp(middle) < totalMxp) {', LEVELS, 'tests/unit/progression-levels.test.ts')
add('level integer division', 'на милли-XP меньше порога', '  let low = Math.floor(high / 2);', '  let low = high / 2;', LEVELS, 'tests/unit/progression-levels.test.ts')
add('level up only when earned', 'без повышения об уровне не сообщается', "      outcome.result?.['leveled_up'] === true && typeof level === 'number'", "      typeof level === 'number'", INBOX, PROGRESS_TESTS)
add('progress from ledger', 'показывает накопленное после выполнения', "    'SELECT COALESCE(SUM(amount_mxp), 0)::text AS total FROM xp_ledger WHERE user_id = $1',", "    'SELECT 0::text AS total FROM xp_ledger WHERE user_id = $1 LIMIT 1',", INBOX, PROGRESS_TESTS)

# Постоянство: считается по закрытым прошлым дням и ступенями по три.
add('consistency steps', 'успешных дней дают', '  const steps = Math.min(rules.max_steps, Math.floor(successDays / rules.days_per_step));', '  const steps = Math.min(rules.max_steps, successDays);', ENGINE, 'tests/unit/progression-award.test.ts')
add('consistency ceiling', 'потолок не пробивается', '  const steps = Math.min(rules.max_steps, Math.floor(successDays / rules.days_per_step));', '  const steps = Math.floor(successDays / rules.days_per_step);', ENGINE, 'tests/unit/progression-award.test.ts')
add('consistency excludes today', 'не поднимает множитель самому себе', "        AND recurrence_key < $2", "        AND recurrence_key <= $2", AWARD, LEDGER_TESTS)
add('consistency applied', 'три успешных дня подряд', '    consistencyBp: consistencyBasisPoints(await successDays(client, request.userId, bucketKey)),', '    consistencyBp: NEUTRAL_BP,', AWARD, LEDGER_TESTS)

# Политика исходящих: запрет по умолчанию, проверка у самого выхода и отказ,
# не пересказывающий то, что отказался отправлять.
add('egress allowlist', 'незнакомое поле в результате инструмента', '    if (!ALLOWED_RESULT_KEYS.has(key)) {', '    if (false) {', EGRESS, EGRESS_TESTS)
add('egress identifiers', 'идентификаторы не уходят', '    if (UUID.test(value)) {', '    if (false) {', EGRESS, EGRESS_TESTS)
add('egress framing', 'сообщение человека без обрамления', '      if (!UNTRUSTED_OPEN.test(message.content) || !UNTRUSTED_CLOSE.test(message.content)) {', '      if (false) {', EGRESS, EGRESS_TESTS)
add('egress system prompt', 'чужая системная подсказка', '  if (!request.system.startsWith(`Версия правил: ${PROMPT_VERSION}`)) {', '  if (false) {', EGRESS, EGRESS_TESTS)
add('egress unparsable', 'нечитаемый результат инструмента', "    throw new EgressPolicyError(`результат инструмента ${message.name} не разбирается`);", '    return;', EGRESS, EGRESS_TESTS)
add('egress error redaction', 'в сообщении об ошибке нет самого содержимого', "      throw new EgressPolicyError(`поле ${path === '' ? key : `${path}.${key}`} не разрешено`);", "      throw new EgressPolicyError(`поле ${key} со значением ${String(nested)} не разрешено`);", EGRESS, EGRESS_TESTS)
add('egress at transport exit', 'политика исходящих', '      assertOutboundAllowed(request);', '      void assertOutboundAllowed;', HTTP, TRANSPORT_TESTS)

# T-04b-3a: failure after commit must retain receipts without replay or drafts.
add('provider recovery result', 'возвращает квитанции при отказе следующего раунда', "return { text: '', receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };", "throw new Error('removed recovery');", TURN, TURN_TESTS)
add('committed receipts on failure', 'возвращает квитанции при отказе следующего раунда', "return { text: '', receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };", "return { text: '', receipts: [], failures, rounds, stopReason: 'provider_error' };", TURN, TURN_TESTS)
add('failed round draft removal', 'возвращает квитанции при отказе следующего раунда', "return { text: '', receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };", "return { text, receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };", TURN, TURN_TESTS)
add('previous tool failures retained', 'отказ модели сохраняет предыдущие отказы инструментов', "return { text: '', receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };", "return { text: '', receipts: options.gateway.receipts(), failures: [], rounds, stopReason: 'provider_error' };", TURN, TURN_TESTS)
add('failed request not counted as completed round', 'отказ первого раунда возвращает пустой результат', "return { text: '', receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };", "return { text: '', receipts: options.gateway.receipts(), failures, rounds: rounds + 1, stopReason: 'provider_error' };", TURN, TURN_TESTS)
add('no turn retry after provider failure', 'отказ первого раунда возвращает пустой результат', "    } catch {\n      return { text: '', receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };", "    } catch {\n      await options.provider.generateTurn(request).catch(() => undefined);\n      return { text: '', receipts: options.gateway.receipts(), failures, rounds, stopReason: 'provider_error' };", TURN, TURN_TESTS)
add('gateway failures are not provider failures', 'ошибка исполнения инструмента не маскируется', '      const result = await options.gateway.invoke(call);', "      const result = await options.gateway.invoke(call).catch(() => ({ callId: call.id, name: call.name, status: 'rejected' as const, content: { error: 'masked' } }));", TURN, TURN_TESTS)
add('Telegram displays committed receipt on outage', 'сохраняет подтверждение записи при отказе модели после commit', '  if (result.receipts.length > 0) {', '  if (false) {', INBOX, 'tests/integration/telegram-ai.test.ts')
add('Telegram distinguishes provider outage', 'сохраняет подтверждение записи при отказе модели после commit', "kind: outcome.result.stopReason === 'provider_error' ? 'ai_unavailable' : 'ai_reply',", "kind: 'ai_reply',", INBOX, 'tests/integration/telegram-ai.test.ts')
add('provider outage is not round limit', 'сохраняет подтверждение записи при отказе модели после commit', "  if (result.stopReason === 'provider_error') {", '  if (false) {', INBOX, 'tests/integration/telegram-ai.test.ts')

# T-04b-3b1: durable storage, no tool execution or paid model calls.
add('turn canonical semantic hash', 'replay preserves checkpoint', 'Object.getOwnPropertyNames(v).sort()', 'Object.getOwnPropertyNames(v)', TURN_STORE, STORE_TESTS)
add('turn source uniqueness', 'rejects changed input', 'CONSTRAINT ai_turn_source_identity UNIQUE (user_id, channel, source_scope, source_request_id),', '', TURN_STORE_SQL, STORE_TESTS)
add('turn input identity', 'rejects changed input', 'row.input_hash !== inputHash || ', '', TURN_STORE, STORE_TESTS)
add('turn prompt compatibility', 'rejects changed input', 'row.prompt_version !== args.versions.prompt\n      || ', '', TURN_STORE, STORE_TESTS)
add('turn policy compatibility', 'rejects changed input', 'row.policy_version !== args.versions.policy || ', '', TURN_STORE, STORE_TESTS)
add('turn checkpoint compatibility', 'rejects changed input', 'row.checkpoint_version !== args.versions.checkpoint\n      || ', '', TURN_STORE, STORE_TESTS)
add('turn identity reuse', 'rejects changed input', 'row.id !== args.id || ', '', TURN_STORE, STORE_TESTS)
add('turn single executor', 'concurrent executors', "       AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())\n", '', TURN_STORE, STORE_TESTS)
add('turn lease fencing', 'old lease cannot', 'AND lease_token = $3 AND revision = $4', 'AND $3::uuid IS NOT NULL AND revision = $4', TURN_STORE, STORE_TESTS)
add('turn revision fencing', 'same holder stale revision', 'AND lease_token = $3 AND revision = $4', 'AND lease_token = $3 AND $4::bigint > 0', TURN_STORE, STORE_TESTS)
add('turn live lease fencing', 'expired lease cannot save', 'AND lease_expires_at > clock_timestamp()', '', TURN_STORE, STORE_TESTS)
add('turn lock before expiry validation', 'lease expiry is checked after waiting', 'AND id = $2 FOR UPDATE', 'AND id = $2', TURN_STORE, STORE_TESTS)
add('turn terminal status', 'renew advances revision', "AND status IN ('pending', 'running')", '', TURN_STORE, STORE_TESTS)
add('turn attempt exhaustion result', 'expired attempts cannot exceed', '       AND attempts < max_attempts RETURNING *', '       RETURNING *', TURN_STORE, STORE_TESTS)
add('turn bounded checkpoint bytes', 'invalid or oversized JSON', '  if (Buffer.byteLength(encoded) > maxBytes) invalid();', '', TURN_STORE, STORE_TESTS)
add('turn finite JSON numbers', 'invalid or oversized JSON', 'if (!Number.isFinite(v)) invalid(); ', '', TURN_STORE, STORE_TESTS)
add('turn valid JSONB text', 'JSONB-invalid text', "  if (value.includes('\\0')) invalid();", '', TURN_STORE, STORE_TESTS)
add('turn no accessors', 'JSONB-invalid text', "      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();\n      return [key, canonical(descriptor.value, depth + 1)];", "      return [key, canonical((v as Record<string, unknown>)[key], depth + 1)];", TURN_STORE, STORE_TESTS)
add('turn RLS no context', 'tenant isolation applies', "  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)\n  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);", '  USING (true) WITH CHECK (true);', TURN_STORE_SQL, STORE_TESTS)
add('turn account deletion cleanup', 'deleting the account', 'REFERENCES users(id) ON DELETE CASCADE', 'REFERENCES users(id)', TURN_STORE_SQL, STORE_TESTS)

add('turn positive bounded limits', 'invalid or oversized JSON', '  if (!Number.isSafeInteger(value) || value <= 0 || value > max) invalid();', '', TURN_STORE, STORE_TESTS)
add('turn object checkpoint', 'invalid or oversized JSON', "  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();", '', TURN_STORE, STORE_TESTS)
add('turn bounded nesting', 'invalid or oversized JSON', '    if (depth > 32 || ++nodes > 20_000) invalid();', '', TURN_STORE, STORE_TESTS)
add('turn plain JSON objects', 'invalid or oversized JSON', "    if (typeof v !== 'object' || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) invalid();", "    if (typeof v !== 'object') invalid();", TURN_STORE, STORE_TESTS)
add('turn valid Unicode surrogate pairs', 'JSONB-invalid text.*surrogate', 'function jsonText(value: string): string {', 'function jsonText(value: string): string { return value;', TURN_STORE, STORE_TESTS)

add('turn persisted attempt policy identity', 'rejects changed input', '      || row.max_attempts !== args.maxAttempts', '', TURN_STORE, STORE_TESTS)
add('turn source channel identity', 'rejects changed input', 'row.channel !== args.source.channel\n      || ', '', TURN_STORE, STORE_TESTS)
add('turn source scope identity', 'rejects changed input', 'row.source_scope !== args.source.scope || ', '', TURN_STORE, STORE_TESTS)

add('turn arrays do not run accessors or drop fields', 'array serialization', "    if (Array.isArray(v)) {\n      if (v.length > 20_000 || Object.getPrototypeOf(v) !== Array.prototype\n        || Object.getOwnPropertySymbols(v).length !== 0 || Object.getOwnPropertyNames(v).length !== v.length + 1) invalid();\n      return Array.from({ length: v.length }, (_, index) => {\n        const item = Object.getOwnPropertyDescriptor(v, String(index));\n        if (!item || !('value' in item) || !item.enumerable) invalid();\n        return canonical(item.value, depth + 1);\n      });\n    }", '    if (Array.isArray(v)) return Array.from(v, (item) => canonical(item, depth + 1));', TURN_STORE, STORE_TESTS)

add('command fence required before effects', 'expired lease rejects before effects', '      if (turnFence !== undefined) await lockTurnFence(client, request.userId, turnFence);', '', BUS, FENCE_TESTS)
add('command fence token', 'wrong token rejects', 'AND lease_token = $3 AND revision = $4', 'AND $3::uuid IS NOT NULL AND revision = $4', BUS, FENCE_TESTS)
add('command fence revision', 'old revision rejects', 'AND lease_token = $3 AND revision = $4', 'AND lease_token = $3 AND $4::bigint IS NOT NULL', BUS, FENCE_TESTS)
add('command fence expiry after user contention', 'expiry while waiting for user lock', 'AND lease_expires_at > clock_timestamp()', '', BUS, FENCE_TESTS)
add('command fence holds turn lock', 'turn row stays locked', 'AND id = $2 FOR UPDATE', 'AND id = $2', BUS, FENCE_TESTS)
add('envelope forwards trusted fence', 'envelope fencing blocks stale XP', 'executeCommand(database, command, handler, turnFence)', 'executeCommand(database, command, handler)', SYNC, FENCE_TESTS)
add('command fence malformed revision safe error', 'missing turn and malformed lease', ' || BigInt(fence.revision) > 9223372036854775807n', '', BUS, FENCE_TESTS)
cases.append(('command fence not a preflight', 'expiry while waiting for user lock', [
    ('      if (turnFence !== undefined) await lockTurnFence(client, request.userId, turnFence);', ''),
    ('      await setUser(client, request.userId);', '      await setUser(client, request.userId);\n      if (turnFence !== undefined) await lockTurnFence(client, request.userId, turnFence);'),
], BUS, FENCE_TESTS))

cases.append(('command fence checked after turn contention', 'expiry while waiting for turn lock', [
    ("  await client.query('SELECT id FROM ai_turns WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, fence.id]);", ''),
    ("  if (valid.rowCount !== 1) throw new LostTurnLeaseError();", "  await client.query('SELECT id FROM ai_turns WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, fence.id]);\n  if (valid.rowCount !== 1) throw new LostTurnLeaseError();"),
], BUS, FENCE_TESTS))
cases.append(('command fence also protects duplicate receipts', 'takeover fences previous owner', [
    ('      if (turnFence !== undefined) await lockTurnFence(client, request.userId, turnFence);', ''),
    ('      const outcome = await handler', '      if (turnFence !== undefined) await lockTurnFence(client, request.userId, turnFence);\n      const outcome = await handler'),
], BUS, FENCE_TESTS))
add('command fence rejects foreign lease', 'foreign tenant cannot fence', '      if (turnFence !== undefined) await lockTurnFence(client, request.userId, turnFence);', '', BUS, FENCE_TESTS)

add('prepared payload identity before receipt', 'changed payload same step', 'stored.hash !== value.hash', 'false', INTENTS, INTENT_TESTS)
add('prepared snapshot identity before receipt', 'changed valid snapshot same step', 'stored.hash !== value.hash', 'false', INTENTS, INTENT_TESTS)
add('prepared closed snapshot input', 'closed validation rejects', '!validInput(copy) || ', '', INTENTS, INTENT_TESTS)
add('prepared closed envelope', 'closed validation rejects', '!validEnvelope(copy.envelope) || ', '', INTENTS, INTENT_TESTS)
add('prepared tool kind allowlist', 'closed validation rejects', "? 'occurrence' : invalid();", "? 'occurrence' : 'template';", INTENTS, INTENT_TESTS)
add('prepared derived command ID', 'closed validation rejects', "copy.envelope.command_id !== derivedCommandId('ai', turnId, step)", 'false', INTENTS, INTENT_TESTS)
add('prepared derived actor ID', 'closed validation rejects', "copy.envelope.device_id !== derivedCommandId('ai', turnId, 'device')", 'false', INTENTS, INTENT_TESTS)
add('prepared day semantics', 'closed validation rejects', '|| userDayAt(new Date(snap.clock), snap.timezone, snap.dayBoundaryMinutes).localDate !== snap.localDate', '', INTENTS, INTENT_TESTS)
add('prepared frozen instant', 'closed validation rejects', '|| copy.envelope.client_created_at !== snap.clock', '', INTENTS, INTENT_TESTS)
add('prepared ref target', 'completion must match both identity', 'ref.occurrenceId !== command.targetId || ', '', INTENTS, INTENT_TESTS)
add('prepared ref version', 'completion must match both identity', ' || ref.version !== command.expectedVersion', '', INTENTS, INTENT_TESTS)
add('prepared transaction semantic hash', 'transaction rejects changed command before first receipt', 'AND command_hash = $6', 'AND $6::text IS NOT NULL', BUS, INTENT_TESTS)
add('prepared transaction digest', 'transaction rejects missing intent wrong digest', 'AND intent_hash = $4', 'AND $4::text IS NOT NULL', BUS, INTENT_TESTS)
add('prepared transaction command ID', 'transaction rejects missing intent wrong digest', 'AND command_id = $5', 'AND $5::uuid IS NOT NULL', BUS, INTENT_TESTS)
add('prepared transaction step', 'transaction rejects missing intent wrong digest', 'AND step = $3', 'AND $3::text IS NOT NULL', BUS, INTENT_TESTS)
add('prepared transaction effect guard', 'intent check occurs after user lock', '      if (turnFence !== undefined) await assertCommandIntent(client, request, turnFence);', '', BUS, INTENT_TESTS)
add('prepared RLS owner policy', 'both app roles cannot update', "user_id = NULLIF(current_setting('app.user_id', true), '')::uuid", 'true', INTENTS_SQL, INTENT_TESTS)
add('prepared append-only update permission', 'both app roles cannot update', 'GRANT SELECT, INSERT ON', 'GRANT SELECT, INSERT, UPDATE ON', INTENTS_SQL, INTENT_TESTS)
add('prepared append-only delete permission', 'both app roles cannot update', 'GRANT SELECT, INSERT ON', 'GRANT SELECT, INSERT, DELETE ON', INTENTS_SQL, INTENT_TESTS)
add('prepared call ID identity', 'same model call ID cannot become', "CREATE UNIQUE INDEX ai_tool_call_identity ON ai_command_intents(user_id, turn_id, call_id) WHERE phase <> 'occurrence';", '', INTENTS_SQL, INTENT_TESTS)
add('prepared receipt required for occurrence', 'occurrence preparation requires the template commit', "  if (!receipt || typeof receipt.result['template_id'] !== 'string') throw new CommandIntentError('intent_not_ready');\n  return receipt.result['template_id'];", "  return '11111111-1111-4111-8111-111111111111';", INTENTS, INTENT_TESTS)
cases.append(('prepared occurrence uses frozen settings', 'crash after template commit preserves', [
    ('callId, snapshot: template.snapshot, questRef: null', "callId, snapshot: { ...template.snapshot, timezone: 'UTC', dayBoundaryMinutes: 0 }, questRef: null"),
    ('timezone: template.snapshot.timezone }', "timezone: 'UTC' }"),
], INTENTS, INTENT_TESTS))
add('prepared payload uses shared closed schema', 'closed validation rejects', '  assertPayloadMatchesSchema(envelope.kind, envelope.payload);', '', SYNC, INTENT_TESTS)

add('prepared occurrence receipt kind', 'occurrence receipt must match template kind', "AND kind = 'create_quest_template'", '', INTENTS, INTENT_TESTS)
add('prepared occurrence receipt hash', 'occurrence receipt must match prepared template semantic hash', 'AND payload_hash = $3', 'AND $3::text IS NOT NULL', INTENTS, INTENT_TESTS)
add('prepared occurrence receipt hash version', 'occurrence receipt must match semantic hash version', 'AND hash_version = $4', 'AND $4::integer IS NOT NULL', INTENTS, INTENT_TESTS)

add('durable assistant persisted before effects', 'persists assistant response before executing', '    // Must persist and revalidate the lease AFTER provider await, BEFORE any tool effects.\n    await save();', '', DURABLE, DURABLE_TESTS)
add('durable mutation counter restoration', 'gateway mutation counters survive restart', 'let mutations = restored.mutations;', 'let mutations = 0;', GATEWAY, DURABLE_TESTS)
add('durable call counter restoration', 'gateway read call counter survives restart', 'let calls = restored.calls;', 'let calls = 0;', GATEWAY, DURABLE_TESTS)
add('durable reference restoration', 'persisted read refs remain stale', '    byRef.set(ref, { ...snapshot }); refByOccurrence.set(snapshot.occurrenceId, ref);', '', GATEWAY, DURABLE_TESTS)
add('durable cursor matches persisted results', 'cursor cannot skip saved', ' || cursor !== state.nextToolIndex', '', DURABLE, DURABLE_TESTS)
add('durable provider call ID uniqueness', 'duplicate provider call IDs', 'if (seen.has(call.id)) invalid();', '', DURABLE, DURABLE_TESTS)
add('durable closed checkpoint schema', 'unsupported versions and closed checkpoint', '!validCheckpoint(state)', 'false', DURABLE, DURABLE_TESTS)
add('durable malformed response schema', 'malformed provider response', '!validCheckpoint(state)', 'false', DURABLE, DURABLE_TESTS)
add('durable supported checkpoint version', 'unsupported versions and closed checkpoint', '|| turn.versions.checkpoint !== DURABLE_TURN_VERSIONS.checkpoint', '', DURABLE, DURABLE_TESTS)
add('durable transcript call ID correlation', 'transcript tool results retain call ID', ' || message.callId !== call.id', '', DURABLE, DURABLE_TESTS)
add('durable transcript tool name correlation', 'transcript tool results retain call ID', ' || message.name !== call.name', '', DURABLE, DURABLE_TESTS)
add('durable global tool effect bound', 'global tool limit stops before another', "        if (state.executed >= state.limits.maxToolCalls) return finish('call_limit');", '', DURABLE, DURABLE_TESTS)
cases.append(('durable interrupted round bound', 'saved rounds bound interrupted provider', [
    ("    if (state.rounds >= state.limits.maxRounds) return finish('round_limit');", ''),
    ('state.rounds > state.limits.maxRounds || ', ''),
], DURABLE, DURABLE_TESTS))
add('durable provider attempt reserved before HTTP', 'provider attempt is reserved durably', "state.rounds++; state.phase = 'awaiting';", "state.phase = 'awaiting';", DURABLE, DURABLE_TESTS)
add('durable lease renewal', 'renews live lease before each provider', '    lease = (await renewTurnLease(options.database, options.userId, lease, options.leaseMs ?? 120_000)).lease;', '', DURABLE, DURABLE_TESTS)
add('gateway state schema', 'gateway rejects closed schema', '!valid(state)', 'false', GATEWAY_STATE, STATE_TESTS)
add('gateway reference identity uniqueness', 'gateway rejects duplicated occurrence', 'new Set(Object.values(state.refs).map(ref => ref.occurrenceId)).size !== refs.length', 'false', GATEWAY_STATE, STATE_TESTS)
add('gateway contiguous reference IDs', 'gateway rejects gaps', 'refs.some((_, index) => !Object.hasOwn(state.refs, `q${index + 1}`))', 'false', GATEWAY_STATE, STATE_TESTS)
add('gateway receipt counter consistency', 'gateway rejects receipt and mutation', ' || state.receipts.length > state.mutations', '', GATEWAY_STATE, STATE_TESTS)
add('gateway mutation counter consistency', 'gateway rejects receipt and mutation', ' || state.mutations > state.calls', '', GATEWAY_STATE, STATE_TESTS)
add('gateway copy snapshot isolation', 'gateway state copies data', 'JSON.parse(jsonDocument(value as JsonObject, 524_288)) as GatewayState', 'value as GatewayState', GATEWAY_STATE, STATE_TESTS)
add('durable complete forwards command fence', 'durable completion forwards fence', '    if (options.durable) {\n      const durable = options.durable;\n      const prepared = await prepareCommandIntent', '    if (false) {\n      const durable = options.durable;\n      const prepared = await prepareCommandIntent', GATEWAY, DURABLE_TESTS)
add('durable create uses prepared frozen commands', 'commit then crash restores same intent', '    if (options.durable) {\n      const durable = options.durable;\n      const spec', '    if (false) {\n      const durable = options.durable;\n      const spec', GATEWAY, DURABLE_TESTS)

add('durable provider request copy', 'provider cannot mutate stored transcript', 'structuredClone(state.messages)', 'state.messages', DURABLE, DURABLE_TESTS)
add('durable reverse reference restoration', 'restored reverse reference map keeps q2', 'refByOccurrence.set(snapshot.occurrenceId, ref);', '', GATEWAY, DURABLE_TESTS)

# Telegram на устойчивом ядре: занятый ход не разобран, исчерпанные попытки
# отвечают по записанному, повторная доставка не считает ход заново.
add('busy is not processed', 'остаётся неразобранным', '    return null;\n  } catch (error) {', '    return exhaustedReply([]);\n  } catch (error) {', INBOX, TELEGRAM_DURABLE_TESTS)
add('exhausted answers', 'исчерпанные попытки дают ответ', '    if (stored !== null && stored.attempts >= stored.maxAttempts) {', '    if (false) {', INBOX, TELEGRAM_DURABLE_TESTS)
# Контроля на вывод идентификатора хода из обновления здесь нет намеренно.
# Случайный идентификатор при той же области упирается в ограничение
# уникальности хранилища и даёт ошибку, а не неверный ответ: подмена проверяет
# схему, а не код. Само свойство закреплено проверками хранилища
# (ai-turn-store, ai-durable-turn): повтор по прежней области возвращает
# сохранённый ход, а не заводит второй.

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
