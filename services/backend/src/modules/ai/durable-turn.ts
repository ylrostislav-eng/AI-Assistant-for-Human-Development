import type { Database } from '../../shared/db/pool.ts';
import type { AiProvider, AiMessage, ToolCall, AiTurnResponse } from './provider.ts';
import { openTurn, readTurn, claimTurn, saveTurnCheckpoint, finishTurn, renewTurnLease, jsonDocument,
  type JsonObject, type OpenTurnInput, type StoredTurn } from './turn-store.ts';
import type { TurnResult, TurnFailure } from './turn.ts';
import { createToolGateway } from './gateway.ts';
import { gatewayStateSchema, receiptSchema, parseGatewayState, type GatewayState } from './gateway-state.ts';
import { createValidator } from '../../shared/schema/validator.ts';
import { withTenantTransaction } from '../../shared/db/tenant.ts';
import { userDayAt } from '../../shared/time/user-day.ts';
import { systemPrompt, untrustedBlock } from './prompt.ts';
import type { IntentSnapshot } from './command-intents.ts';
import { BudgetExhaustedError } from './budget.ts';
export const DURABLE_TURN_VERSIONS = { prompt: 'coach-1', policy: 'egress-1', checkpoint: 'durable-turn-1' } as const;
export interface DurableLimits { readonly maxRounds: number; readonly maxToolCalls: number; readonly maxCalls: number; readonly maxMutations: number }
export interface OpenDurableTurnOptions {
  readonly database: Database; readonly userId: string; readonly turnId: string;
  readonly source: OpenTurnInput['source']; readonly message: string;
  readonly now?: Date; readonly limits?: Partial<DurableLimits>; readonly maxAttempts?: number;
}
export type DurableTurnResult = { readonly status: 'busy' } | { readonly status: 'finished'; readonly result: TurnResult };
export class DurableTurnError extends Error {
  constructor() { super('Invalid durable AI turn state'); this.name = 'DurableTurnError'; }
}
const DEFAULT_LIMITS: DurableLimits = { maxRounds: 6, maxToolCalls: 12, maxCalls: 12, maxMutations: 4 };
interface Checkpoint {
  version: 'durable-turn-1'; system: string; context: Omit<IntentSnapshot, 'refs'>; limits: DurableLimits;
  phase: 'ready' | 'awaiting' | 'tools' | 'done'; messages: AiMessage[];
  rounds: number; executed: number; nextToolIndex: number; gateway: GatewayState;
  failures: TurnFailure[]; result: TurnResult | null;
}
const integer = (maximum: number, minimum = 0) => ({ type: 'integer', minimum, maximum });
const text = { type: 'string', maxLength: 65_536 };
const callSchema = { type: 'object', additionalProperties: false, required: ['id', 'name', 'arguments'], properties: {
  id: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 128 }, arguments: {},
} };
const messageSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['role', 'content'], properties: { role: { const: 'user' }, content: text } },
  { type: 'object', additionalProperties: false, required: ['role', 'content', 'toolCalls'], properties: {
    role: { const: 'assistant' }, content: text, toolCalls: { type: 'array', maxItems: 64, items: callSchema },
  } },
  { type: 'object', additionalProperties: false, required: ['role', 'content', 'callId', 'name'], properties: {
    role: { const: 'tool' }, content: text, callId: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 128 },
  } },
] };
const failureSchema = { type: 'object', additionalProperties: false, required: ['tool', 'status', 'error'], properties: {
  tool: { type: 'string', maxLength: 128 }, status: { enum: ['rejected', 'conflict', 'not_found'] }, error: text,
} };
const resultSchema = { type: 'object', additionalProperties: false, required: ['text', 'receipts', 'failures', 'rounds', 'stopReason'], properties: {
  text, receipts: { type: 'array', maxItems: 64, items: receiptSchema }, failures: { type: 'array', maxItems: 64, items: failureSchema },
  rounds: integer(16), stopReason: { enum: ['answered', 'round_limit', 'call_limit', 'provider_error', 'budget_exhausted'] },
} };
const limitsSchema = { type: 'object', additionalProperties: false, required: Object.keys(DEFAULT_LIMITS), properties: {
  maxRounds: integer(16, 1), maxToolCalls: integer(64, 1), maxCalls: integer(64, 1), maxMutations: integer(64),
} };
const validator = createValidator();
const validLimits = validator.compile(limitsSchema);
const validCheckpoint = validator.compile({ type: 'object', additionalProperties: false,
  required: ['version', 'system', 'context', 'limits', 'phase', 'messages', 'rounds', 'executed', 'nextToolIndex', 'gateway', 'failures', 'result'],
  properties: {
    version: { const: 'durable-turn-1' }, system: text, limits: limitsSchema,
    phase: { enum: ['ready', 'awaiting', 'tools', 'done'] }, messages: { type: 'array', minItems: 1, maxItems: 97, items: messageSchema },
    rounds: integer(16), executed: integer(64), nextToolIndex: integer(64), gateway: gatewayStateSchema,
    failures: { type: 'array', maxItems: 64, items: failureSchema }, result: { anyOf: [{ type: 'null' }, resultSchema] },
    context: { type: 'object', additionalProperties: false, required: ['clock', 'localDate', 'timezone', 'dayBoundaryMinutes'], properties: {
      clock: { type: 'string', format: 'date-time' }, localDate: { type: 'string', format: 'date' },
      timezone: { type: 'string', minLength: 1, maxLength: 128 }, dayBoundaryMinutes: integer(1439),
    } },
  },
});
function invalid(): never { throw new DurableTurnError(); }
function document(value: unknown): JsonObject { return JSON.parse(jsonDocument(value as JsonObject, 524_288)) as JsonObject; }
export function parseDurableCheckpoint(value: unknown): Checkpoint {
  try {
    const state = document(value) as unknown as Checkpoint;
    if (!validCheckpoint(state) || state.limits.maxMutations > state.limits.maxCalls
      || state.rounds > state.limits.maxRounds || state.executed > state.limits.maxToolCalls
      || state.gateway.calls > state.executed || state.failures.length > state.executed) invalid();
    parseGatewayState(state.gateway);
    const context = state.context;
    if (new Date(context.clock).toISOString() !== context.clock
      || userDayAt(new Date(context.clock), context.timezone, context.dayBoundaryMinutes).localDate !== context.localDate) invalid();
    let pending: readonly ToolCall[] = []; let cursor = 0; let tools = 0; let assistants = 0;
    const seen = new Set<string>();
    if (state.messages[0]?.role !== 'user') invalid();
    for (const message of state.messages.slice(1)) {
      if (message.role === 'assistant') {
        if (cursor !== pending.length) invalid();
        assistants++; pending = message.toolCalls; cursor = 0;
        for (const call of pending) { if (seen.has(call.id)) invalid(); seen.add(call.id); }
      } else if (message.role === 'tool') {
        const call = pending[cursor];
        if (!call || message.callId !== call.id || message.name !== call.name) invalid();
        cursor++; tools++;
      } else invalid();
    }
    if (tools !== state.executed || assistants > state.rounds || cursor !== state.nextToolIndex
      || (state.phase === 'ready' || state.phase === 'awaiting') && cursor !== pending.length
      || state.phase === 'tools' && pending.length === 0
      || (state.phase === 'done') !== (state.result !== null)) invalid();
    if (state.result && (state.result.rounds !== state.rounds
      || JSON.stringify(state.result.receipts) !== JSON.stringify(state.gateway.receipts)
      || JSON.stringify(state.result.failures) !== JSON.stringify(state.failures)
      || state.result.stopReason === 'answered' && cursor !== pending.length)) invalid();
    return state;
  } catch { return invalid(); }
}
const parse = parseDurableCheckpoint;
function checkVersions(turn: StoredTurn): void {
  if (turn.versions.prompt !== DURABLE_TURN_VERSIONS.prompt || turn.versions.policy !== DURABLE_TURN_VERSIONS.policy
    || turn.versions.checkpoint !== DURABLE_TURN_VERSIONS.checkpoint) invalid();
}
export async function openDurableTurn(options: OpenDurableTurnOptions): Promise<StoredTurn> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (!validLimits(limits) || limits.maxMutations > limits.maxCalls) invalid();
  const profile = await withTenantTransaction(options.database, options.userId, client => client.query<{ timezone: string; day_boundary_minutes: number }>(
    'SELECT timezone, day_boundary_minutes FROM user_profiles WHERE user_id = $1', [options.userId]));
  const settings = profile.rows[0]; if (!settings) invalid();
  const now = options.now ?? new Date();
  const context = { clock: now.toISOString(), localDate: userDayAt(now, settings.timezone, settings.day_boundary_minutes).localDate,
    timezone: settings.timezone, dayBoundaryMinutes: settings.day_boundary_minutes };
  const initial = parse({ version: 'durable-turn-1', system: systemPrompt(), context, limits, phase: 'ready',
    messages: [{ role: 'user', content: untrustedBlock({ turnId: options.turnId, source: `${options.source.channel} message`, text: options.message }) }],
    rounds: 0, executed: 0, nextToolIndex: 0, gateway: { refs: {}, receipts: [], calls: 0, mutations: 0 }, failures: [], result: null });
  return openTurn(options.database, options.userId, { id: options.turnId, source: options.source,
    input: { message: options.message, limits: { ...limits } }, versions: DURABLE_TURN_VERSIONS,
    initialCheckpoint: document(initial), maxAttempts: options.maxAttempts ?? 5 });
}
export async function resumeDurableTurn(options: { readonly database: Database; readonly userId: string; readonly turnId: string; readonly provider: AiProvider; readonly leaseMs?: number }): Promise<DurableTurnResult> {
  const stored = await readTurn(options.database, options.userId, options.turnId); if (!stored) invalid();
  checkVersions(stored); const initial = parse(stored.checkpoint);
  if (stored.status === 'finished') {
    if (initial.phase !== 'done' || !initial.result) invalid();
    return { status: 'finished', result: initial.result };
  }
  const claimed = await claimTurn(options.database, options.userId, options.turnId, options.leaseMs ?? 120_000);
  if (!claimed) return { status: 'busy' };
  checkVersions(claimed.turn); let state = parse(claimed.turn.checkpoint); let lease = claimed.lease;
  if (state.phase === 'done') invalid();
  const gateway = createToolGateway({ database: options.database, userId: options.userId, turnId: options.turnId,
    limits: { maxCalls: state.limits.maxCalls, maxMutations: state.limits.maxMutations }, restore: state.gateway,
    durable: { lease: () => lease, context: state.context } });
  const save = async () => {
    state = parse(state);
    const next = await saveTurnCheckpoint(options.database, options.userId, lease, document(state)); lease = next.lease;
  };
  const finish = async (stopReason: TurnResult['stopReason'], text = ''): Promise<DurableTurnResult> => {
    state.gateway = gateway.snapshot(); state.phase = 'done';
    state.result = { text, receipts: state.gateway.receipts, failures: state.failures, rounds: state.rounds, stopReason };
    state = parse(state);
    await finishTurn(options.database, options.userId, lease, document(state));
    return { status: 'finished', result: state.result! };
  };
  while (true) {
    if (state.phase === 'tools') {
      const assistant = [...state.messages].reverse().find(message => message.role === 'assistant');
      if (!assistant || assistant.role !== 'assistant') invalid();
      while (state.nextToolIndex < assistant.toolCalls.length) {
        if (state.executed >= state.limits.maxToolCalls) return finish('call_limit');
        const call = assistant.toolCalls[state.nextToolIndex]; if (!call) invalid();
        const result = await gateway.invoke(call);
        if (result.status !== 'ok') state.failures.push({ tool: call.name, status: result.status,
          error: typeof result.content['error'] === 'string' ? result.content['error'] : result.status });
        state.messages.push({ role: 'tool', callId: call.id, name: call.name, content: JSON.stringify(result.content) });
        state.executed++; state.nextToolIndex++; state.gateway = gateway.snapshot(); await save();
      }
      state.phase = 'ready'; await save();
    }
    if (state.rounds >= state.limits.maxRounds) return finish('round_limit');
    // Reserve an attempt BEFORE HTTP. Interrupted attempts still consume the local round bound.
    state.rounds++; state.phase = 'awaiting'; await save();
    lease = (await renewTurnLease(options.database, options.userId, lease, options.leaseMs ?? 120_000)).lease;
    let response: AiTurnResponse;
    try { response = await options.provider.generateTurn({ system: state.system, messages: structuredClone(state.messages), tools: gateway.definitions() }); }
    // Исчерпанный предел — не отказ поставщика: обращения не было, и говорить
    // человеку «ИИ недоступен» значит отправить его ждать того, что не сломано.
    catch (error) { return finish(error instanceof BudgetExhaustedError ? 'budget_exhausted' : 'provider_error'); }
    let safe: AiTurnResponse;
    try { safe = document({ text: response.text, toolCalls: response.toolCalls }) as unknown as AiTurnResponse; }
    catch { return invalid(); }
    state.messages.push({ role: 'assistant', content: safe.text, toolCalls: safe.toolCalls }); state.nextToolIndex = 0;
    state.phase = Array.isArray(safe.toolCalls) && safe.toolCalls.length === 0 ? 'ready' : 'tools';
    state = parse(state);
    if (state.phase === 'ready') return finish('answered', safe.text);
    // Must persist and revalidate the lease AFTER provider await, BEFORE any tool effects.
    await save();
  }
}
