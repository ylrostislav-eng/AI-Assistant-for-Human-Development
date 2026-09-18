import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { runMigrations } from '../../src/shared/db/migrate.ts';
import { resetSchema } from '../helpers/reset-schema.ts';
import { openDurableTurn, resumeDurableTurn, parseDurableCheckpoint, type DurableLimits } from '../../src/modules/ai/durable-turn.ts';
import { claimTurn, readTurn } from '../../src/modules/ai/turn-store.ts';
import { executeEnvelope } from '../../src/modules/sync/routes.ts';
import type { AiProvider, AiTurnRequest, AiTurnResponse, ToolCall } from '../../src/modules/ai/provider.ts';
import { createToolGateway } from '../../src/modules/ai/gateway.ts';
import type { GatewayState } from '../../src/modules/ai/gateway-state.ts';

let owner: Database; let runtime: Database;
beforeAll(async () => {
  const config = loadConfig(); owner = createPool(config.database); await resetSchema(owner); await runMigrations(owner);
  const url = new URL(config.database.connectionString); url.username = 'app_runtime'; url.password = '';
  runtime = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 4 });
});
afterAll(async () => { await runtime?.end(); if (owner) { await resetSchema(owner); await owner.end(); } });
const caught = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
const response = (toolCalls: readonly ToolCall[] = [], text = ''): AiTurnResponse => ({ text, toolCalls });
const create = (id = 'create-a'): ToolCall => ({ id, name: 'create_quest', arguments: {
  title: 'Synthetic quest', success_rule: 'duration', unit: 'seconds', duration_seconds: 2700, amount: null,
} });
const read: ToolCall = { id: 'read-a', name: 'get_today_quests', arguments: {} };
const complete: ToolCall = { id: 'complete-a', name: 'complete_quest', arguments: {
  quest_ref: 'q1', variant: null, actual_duration_seconds: 2700, actual_amount: null,
} };
function provider(responses: readonly AiTurnResponse[]) {
  const requests: AiTurnRequest[] = [];
  const value: AiProvider = { name: 'synthetic', async generateTurn(request) {
    requests.push(structuredClone(request)); const next = responses[requests.length - 1];
    if (!next) throw new Error('Synthetic outage'); return next;
  } };
  return { value, requests };
}
async function opened(limits?: Partial<DurableLimits>) {
  const userId = randomUUID(); const turnId = randomUUID();
  await owner.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [userId, 'dev', userId]);
  await owner.query("INSERT INTO user_profiles (user_id, timezone, day_boundary_minutes) VALUES ($1, 'Europe/Moscow', 240)", [userId]);
  const state = await openDurableTurn({ database: runtime, userId, turnId, source: { channel: 'telegram', scope: 'synthetic', requestId: turnId },
    message: 'Synthetic input', now: new Date('2026-09-18T01:00:00.000Z'), ...(limits ? { limits } : {}), maxAttempts: 5 }).catch(() => null);
  expect(state).not.toBeNull(); return { userId, turnId };
}
async function expire(userId: string, turnId: string) {
  await owner.query("UPDATE ai_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1 AND id = $2", [userId, turnId]);
}
// Process-crash injection lives only in the test adapter. Domain code has no test hook.
function interceptQueries(intercept: (sql: string, args?: unknown[]) => Promise<void> | void): Database {
  return new Proxy(runtime, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, key) {
        if (key === 'query') return async (sql: unknown, args?: unknown[]) => {
          if (typeof sql === 'string') await intercept(sql, args);
          return connection.query(sql as string, args);
        };
        const member = Reflect.get(connection, key); return typeof member === 'function' ? member.bind(connection) : member;
      } });
    };
    const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
  } });
}
function crashOn(predicate: (checkpoint: Record<string, unknown>) => boolean): Database {
  let armed = true;
  return interceptQueries((sql, args) => {
    if (armed && sql.includes('UPDATE ai_turns SET checkpoint = $3::jsonb') && typeof args?.[2] === 'string'
      && predicate(JSON.parse(args[2]) as Record<string, unknown>)) { armed = false; throw new Error('Synthetic process crash'); }
  });
}
async function templates(userId: string) { return (await owner.query('SELECT count(*) FROM quest_templates WHERE user_id = $1', [userId])).rows[0]?.count; }
async function makeQuest(userId: string) {
  const envelope = (kind: string, payload: Record<string, unknown>) => ({ schema_version: 1, command_id: randomUUID(), device_id: randomUUID(),
    kind, aggregate_id: null, expected_version: null, client_created_at: new Date().toISOString(), depends_on_command_id: null, payload });
  const template = await executeEnvelope(runtime, userId, envelope('create_quest_template', { title: 'Existing synthetic quest',
    normal_spec: { success_rule: 'duration', unit: 'seconds', duration_seconds: 2700 } }));
  const occurrence = await executeEnvelope(runtime, userId, envelope('materialize_occurrence', {
    template_id: template.result?.['template_id'], recurrence_key: '2026-09-18', timezone: 'Europe/Moscow',
  }));
  expect(occurrence.status).toBe('committed'); return occurrence.result?.['occurrence_id'] as string;
}
describe('durable AI turn core', () => {
  it('provider cannot mutate stored transcript through its request object', async () => {
    const identity = await opened();
    const model: AiProvider = { name: 'synthetic', async generateTurn(request) {
      (request.messages as unknown[]).pop(); return response([], 'Done');
    } };
    expect(await caught(resumeDurableTurn({ database: runtime, ...identity, provider: model }))).toMatchObject({ status: 'finished' });
    const stored = await readTurn(runtime, identity.userId, identity.turnId);
    expect((stored?.checkpoint['messages'] as Array<{ role: string }>)[0]?.role).toBe('user');
  });
  it('restored reverse reference map keeps q2 after q1 leaves the read list', async () => {
    const identity = await opened(); const first = await makeQuest(identity.userId); await makeQuest(identity.userId);
    await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'awaiting' && state['rounds'] === 2), ...identity, provider: provider([response([read])]).value }));
    const stored = await readTurn(runtime, identity.userId, identity.turnId);
    expect(Object.keys((stored?.checkpoint['gateway'] as unknown as GatewayState).refs)).toEqual(['q1', 'q2']);
    expect((await executeEnvelope(runtime, identity.userId, { schema_version: 1, command_id: randomUUID(), device_id: randomUUID(), kind: 'complete_quest',
      aggregate_id: first, expected_version: 1, client_created_at: new Date().toISOString(), depends_on_command_id: null, payload: { actual_duration_seconds: 2700 } })).status).toBe('committed');
    const gateway = createToolGateway({ database: runtime, userId: identity.userId, turnId: identity.turnId,
      restore: stored?.checkpoint['gateway'] as unknown as GatewayState });
    const result = await gateway.invoke({ ...read, id: 'read-b' });
    const quests = result.content['quests'] as Array<{ ref: string }>;
    expect(quests).toHaveLength(1); expect(quests[0]?.ref).toBe('q2');
  });
  it('source replay preserves original frozen context despite new clock and profile', async () => {
    const identity = await opened(); const first = await readTurn(runtime, identity.userId, identity.turnId);
    await owner.query("UPDATE user_profiles SET timezone = 'UTC', day_boundary_minutes = 0 WHERE user_id = $1", [identity.userId]);
    const replay = await openDurableTurn({ database: runtime, ...identity, source: { channel: 'telegram', scope: 'synthetic', requestId: identity.turnId },
      message: 'Synthetic input', now: new Date('2026-10-01T00:00:00.000Z'), maxAttempts: 5 });
    expect(replay).toEqual(first);
  });
  it('finishes and terminal replay uses no provider or tools', async () => {
    const identity = await opened(); const model = provider([response([create()]), response([], 'Done')]);
    const first = await resumeDurableTurn({ database: runtime, ...identity, provider: model.value });
    expect(first.status).toBe('finished'); if (first.status !== 'finished') return;
    expect(first.result.receipts).toHaveLength(1); expect(first.result.text).toBe('Done');
    expect(await resumeDurableTurn({ database: runtime, ...identity, provider: model.value })).toEqual(first);
    expect(model.requests).toHaveLength(2); expect(await templates(identity.userId)).toBe('1');
  });
  it('persists assistant response before executing any proposed command', async () => {
    const identity = await opened(); const model = provider([response([create()])]);
    const error = await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'tools'), ...identity, provider: model.value }));
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('Synthetic process crash');
    expect(await templates(identity.userId)).toBe('0');
  });
  it('commit then crash restores same intent and frozen date without resampling proposal', async () => {
    const identity = await opened(); const firstModel = provider([response([create()])]);
    const error = await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'tools' && state['nextToolIndex'] === 1), ...identity, provider: firstModel.value }));
    expect((error as Error).message).toBe('Synthetic process crash'); expect(await templates(identity.userId)).toBe('1');
    await expire(identity.userId, identity.turnId);
    await owner.query("UPDATE user_profiles SET timezone = 'America/New_York', day_boundary_minutes = 300 WHERE user_id = $1", [identity.userId]);
    const nextModel = provider([response([], 'Resumed')]);
    const result = await resumeDurableTurn({ database: runtime, ...identity, provider: nextModel.value });
    expect(result.status).toBe('finished'); if (result.status !== 'finished') return;
    expect(result.result.receipts).toHaveLength(1); expect(nextModel.requests).toHaveLength(1);
    expect(nextModel.requests[0]?.messages.some(message => message.role === 'assistant' && message.toolCalls[0]?.id === 'create-a')).toBe(true);
    expect(await templates(identity.userId)).toBe('1');
    const occurrence = (await owner.query('SELECT recurrence_key, timezone_snapshot FROM quest_occurrences WHERE user_id = $1', [identity.userId])).rows[0];
    expect(occurrence).toEqual({ recurrence_key: '2026-09-18', timezone_snapshot: 'Europe/Moscow' });
  });
  it('active claim returns busy without provider calls or commands', async () => {
    const identity = await opened(); expect(await claimTurn(runtime, identity.userId, identity.turnId, 60_000)).not.toBeNull();
    const model = provider([response([create()])]);
    expect(await resumeDurableTurn({ database: runtime, ...identity, provider: model.value })).toEqual({ status: 'busy' });
    expect(model.requests).toHaveLength(0); expect(await templates(identity.userId)).toBe('0');
  });
  it('takeover during provider await blocks stale response before tools', async () => {
    const identity = await opened(); const model: AiProvider = { name: 'synthetic', async generateTurn() {
      await expire(identity.userId, identity.turnId); expect(await claimTurn(runtime, identity.userId, identity.turnId, 60_000)).not.toBeNull();
      return response([create()]);
    } };
    expect(await caught(resumeDurableTurn({ database: runtime, ...identity, provider: model }))).toMatchObject({ code: 'lost_lease' });
    expect(await templates(identity.userId)).toBe('0');
  });
  it('gateway mutation counters survive restart between tools', async () => {
    const identity = await opened({ maxMutations: 1 }); const model = provider([response([create('a')])]);
    expect((await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'awaiting' && state['rounds'] === 2), ...identity, provider: model.value })) as Error).message).toBe('Synthetic process crash');
    await expire(identity.userId, identity.turnId);
    const result = await caught(resumeDurableTurn({ database: runtime, ...identity, provider: provider([response([create('b')]), response([], 'Done')]).value }));
    expect(await templates(identity.userId)).toBe('1'); expect(result).toMatchObject({ status: 'finished', result: { failures: [{ error: 'mutation_budget_exhausted' }] } });
  });
  it('persisted read refs remain stale after restart on completable active object', async () => {
    const identity = await opened(); const occurrenceId = await makeQuest(identity.userId);
    const model = provider([response([read])]);
    expect((await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'awaiting' && state['rounds'] === 2), ...identity, provider: model.value })) as Error).message).toBe('Synthetic process crash');
    expect((await readTurn(runtime, identity.userId, identity.turnId))?.checkpoint['gateway']).toBeDefined();
    await executeEnvelope(runtime, identity.userId, { schema_version: 1, command_id: randomUUID(), device_id: randomUUID(), kind: 'start_quest',
      aggregate_id: occurrenceId, expected_version: 1, client_created_at: new Date().toISOString(), depends_on_command_id: null, payload: {} });
    await expire(identity.userId, identity.turnId);
    const result = await resumeDurableTurn({ database: runtime, ...identity, provider: provider([response([complete]), response([], 'Done')]).value });
    expect(result.status).toBe('finished'); if (result.status !== 'finished') return;
    expect(result.result.failures.some(f => f.error === 'version_conflict')).toBe(true);
    expect((await owner.query('SELECT count(*) FROM xp_ledger WHERE user_id = $1', [identity.userId])).rows[0]?.count).toBe('0');
  });
  it('provider outage returns saved receipts with empty draft', async () => {
    const identity = await opened(); const model = provider([response([create()], 'Unconfirmed draft')]);
    const result = await resumeDurableTurn({ database: runtime, ...identity, provider: model.value });
    expect(result.status).toBe('finished'); if (result.status !== 'finished') return;
    expect(result.result.stopReason).toBe('provider_error'); expect(result.result.text).toBe(''); expect(result.result.receipts).toHaveLength(1);
  });
  it('saved rounds bound interrupted provider attempts before another HTTP call', async () => {
    const identity = await opened({ maxRounds: 1 });
    await owner.query("UPDATE ai_turns SET checkpoint = jsonb_set(jsonb_set(checkpoint, '{phase}', '\"awaiting\"'), '{rounds}', '1') WHERE user_id = $1 AND id = $2", [identity.userId, identity.turnId]);
    const model = provider([response([create()])]); const result = await caught(resumeDurableTurn({ database: runtime, ...identity, provider: model.value }));
    expect(model.requests).toHaveLength(0); expect(result).toMatchObject({ status: 'finished', result: { stopReason: 'round_limit', rounds: 1 } });
  });
  it('renews live lease before each provider attempt', async () => {
    const identity = await opened(); let calls = 0; let remaining = 0;
    const model: AiProvider = { name: 'synthetic', async generateTurn() {
      calls++;
      if (calls === 1) {
        await owner.query("UPDATE ai_turns SET lease_expires_at = clock_timestamp() + interval '5 seconds' WHERE user_id = $1 AND id = $2", [identity.userId, identity.turnId]);
        return response([read]);
      }
      remaining = Number((await owner.query('SELECT EXTRACT(EPOCH FROM lease_expires_at - clock_timestamp()) AS seconds FROM ai_turns WHERE user_id = $1 AND id = $2', [identity.userId, identity.turnId])).rows[0]?.seconds);
      return response([], 'Done');
    } };
    const result = await resumeDurableTurn({ database: runtime, ...identity, provider: model });
    expect(remaining).toBeGreaterThan(100); expect(result.status).toBe('finished');
  });
  it('provider attempt is reserved durably before provider can observe it', async () => {
    const identity = await opened(); let observed = 0;
    const model: AiProvider = { name: 'synthetic', async generateTurn() {
      observed = Number((await readTurn(runtime, identity.userId, identity.turnId))?.checkpoint['rounds']);
      return response([], 'Done');
    } };
    const result = await caught(resumeDurableTurn({ database: runtime, ...identity, provider: model }));
    expect(observed).toBe(1); expect(result).toMatchObject({ status: 'finished' });
  });
  it('durable completion forwards fence when takeover happens inside CommandBus', async () => {
    const identity = await opened(); await makeQuest(identity.userId); let armed = true;
    const database = interceptQueries(async sql => {
      if (armed && sql.includes('INSERT INTO user_change_counters')) {
        armed = false; await expire(identity.userId, identity.turnId);
        expect(await claimTurn(runtime, identity.userId, identity.turnId, 60_000)).not.toBeNull();
      }
    });
    const result = await caught(resumeDurableTurn({ database, ...identity, provider: provider([response([read]), response([complete])]).value }));
    expect((await owner.query('SELECT count(*) FROM xp_ledger WHERE user_id = $1', [identity.userId])).rows[0]?.count).toBe('0');
    expect(result).toMatchObject({ code: 'lost_turn_lease' });
  });
  it('global tool limit stops before another domain effect', async () => {
    const identity = await opened({ maxToolCalls: 1 }); const model = provider([response([create('a'), create('b')])]);
    const result = await caught(resumeDurableTurn({ database: runtime, ...identity, provider: model.value }));
    expect(await templates(identity.userId)).toBe('1'); expect(result).toMatchObject({ status: 'finished', result: { stopReason: 'call_limit', text: '' } });
    expect(model.requests).toHaveLength(1);
  });
  it('gateway read call counter survives restart', async () => {
    const identity = await opened({ maxCalls: 1, maxMutations: 1 });
    const model = provider([response([read])]);
    expect((await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'awaiting' && state['rounds'] === 2), ...identity, provider: model.value })) as Error).message).toBe('Synthetic process crash');
    await expire(identity.userId, identity.turnId);
    const result = await resumeDurableTurn({ database: runtime, ...identity, provider: provider([response([{ ...read, id: 'read-b' }]), response([], 'Done')]).value });
    expect(result.status).toBe('finished'); if (result.status !== 'finished') return;
    expect(result.result.failures.some(f => f.error === 'call_budget_exhausted')).toBe(true);
  });
  it('successful completion and stored read results survive commit crash with one reward', async () => {
    const identity = await opened(); await makeQuest(identity.userId);
    const model = provider([response([read]), response([complete])]);
    const error = await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'tools' && state['executed'] === 2), ...identity, provider: model.value }));
    expect((error as Error).message).toBe('Synthetic process crash'); await expire(identity.userId, identity.turnId);
    const next = provider([response([], 'Done')]); const result = await resumeDurableTurn({ database: runtime, ...identity, provider: next.value });
    expect(result.status).toBe('finished'); if (result.status !== 'finished') return;
    expect(result.result.receipts).toHaveLength(1);
    expect(next.requests[0]?.messages.some(message => message.role === 'tool' && message.name === 'get_today_quests' && message.content.includes('q1'))).toBe(true);
    expect((await owner.query('SELECT count(*) FROM xp_ledger WHERE user_id = $1', [identity.userId])).rows[0]?.count).toBe('1');
  });
  it('duplicate provider call IDs fail before tool effects', async () => {
    const identity = await opened(); const result = await caught(resumeDurableTurn({ database: runtime, ...identity, provider: provider([response([create(), create()]), response([], 'Done')]).value }));
    expect((result as Error).name).toBe('DurableTurnError'); expect(await templates(identity.userId)).toBe('0');
  });
  it('unsupported versions and closed checkpoint fields fail before provider', async () => {
    for (const changed of ['version', 'field']) {
      const identity = await opened();
      if (changed === 'version') await owner.query("UPDATE ai_turns SET checkpoint_version = 'unknown-future' WHERE user_id = $1 AND id = $2", [identity.userId, identity.turnId]);
      else await owner.query("UPDATE ai_turns SET checkpoint = checkpoint || '{\"PRIVATE_EXTRA\":\"PRIVATE_VALUE\"}'::jsonb WHERE user_id = $1 AND id = $2", [identity.userId, identity.turnId]);
      const model = provider([response([], 'Done')]); const result = await caught(resumeDurableTurn({ database: runtime, ...identity, provider: model.value }));
      expect((result as Error).name).toBe('DurableTurnError'); expect(String(result)).not.toContain('PRIVATE_VALUE'); expect(model.requests).toHaveLength(0);
    }
  });
  it('cursor cannot skip saved but unexecuted tool proposal', async () => {
    const identity = await opened();
    await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'tools' && state['nextToolIndex'] === 1), ...identity, provider: provider([response([create()])]).value }));
    await owner.query("UPDATE ai_turns SET checkpoint = jsonb_set(checkpoint, '{nextToolIndex}', '1') WHERE user_id = $1 AND id = $2", [identity.userId, identity.turnId]);
    await expire(identity.userId, identity.turnId);
    const model = provider([response([], 'Done')]);
    let parsed: unknown;
    try { parsed = parseDurableCheckpoint((await readTurn(runtime, identity.userId, identity.turnId))?.checkpoint); } catch (error) { parsed = error; }
    expect((parsed as Error).name).toBe('DurableTurnError');
    expect((await caught(resumeDurableTurn({ database: runtime, ...identity, provider: model.value })) as Error).name).toBe('DurableTurnError');
    expect(model.requests).toHaveLength(0);
  });
  it('transcript tool results retain call ID and name correlation', async () => {
    for (const field of ['callId', 'name']) {
      const identity = await opened();
      await caught(resumeDurableTurn({ database: crashOn(state => state['phase'] === 'awaiting' && state['rounds'] === 2), ...identity, provider: provider([response([read])]).value }));
      await owner.query('UPDATE ai_turns SET checkpoint = jsonb_set(checkpoint, $1::text[], $2::jsonb) WHERE user_id = $3 AND id = $4',
        [['messages', '2', field], JSON.stringify('changed'), identity.userId, identity.turnId]);
      await expire(identity.userId, identity.turnId);
      expect((await caught(resumeDurableTurn({ database: runtime, ...identity, provider: provider([response([], 'Done')]).value })) as Error).name).toBe('DurableTurnError');
    }
  });
  it('malformed provider response fails before commands', async () => {
    const identity = await opened(); const model = provider([{ text: 123, toolCalls: [create()] } as unknown as AiTurnResponse]);
    expect((await caught(resumeDurableTurn({ database: runtime, ...identity, provider: model.value })) as Error).name).toBe('DurableTurnError');
    expect(await templates(identity.userId)).toBe('0');
  });
});
