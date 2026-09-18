import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { runMigrations } from '../../src/shared/db/migrate.ts';
import { resetSchema } from '../helpers/reset-schema.ts';
import { executeCommand, type CommandRequest } from '../../src/shared/commands/bus.ts';
import { openTurn, claimTurn, renewTurnLease } from '../../src/modules/ai/turn-store.ts';
import { executeEnvelope } from '../../src/modules/sync/routes.ts';
import type { CommandEnvelope } from '../../src/shared/commands/envelope.ts';

let owner: Database;
let runtime: Database;
beforeAll(async () => {
  const config = loadConfig(); owner = createPool(config.database);
  await resetSchema(owner); await runMigrations(owner);
  const url = new URL(config.database.connectionString); url.username = 'app_runtime'; url.password = '';
  runtime = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 3 });
});
afterAll(async () => { await runtime?.end(); if (owner) { await resetSchema(owner); await owner.end(); } });
const caught = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);
const handler = async () => ({ result: { done: true }, changes: [] });
async function started() {
  const userId = randomUUID(); const id = randomUUID();
  await owner.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [userId, 'dev', userId]);
  await openTurn(runtime, userId, { id, source: { channel: 'telegram', scope: 'synthetic-bot', requestId: id },
    input: {}, initialCheckpoint: {}, versions: { prompt: 'p1', policy: 'e1', checkpoint: 'c1' }, maxAttempts: 3 });
  const claimed = await claimTurn(runtime, userId, id, 60_000); expect(claimed).not.toBeNull();
  const command: CommandRequest = { userId, commandId: randomUUID(), kind: 'synthetic_fenced_command', schemaVersion: 1,
    targetId: null, expectedVersion: null, dependsOnCommandId: null, payload: {} };
  return { userId, id, lease: claimed!.lease, command };
}
async function expire(userId: string, id: string) {
  await owner.query("UPDATE ai_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1 AND id = $2", [userId, id]);
}
async function noEffects(id: string) {
  for (const table of ['command_receipts', 'sync_change_batches', 'user_change_counters']) {
    expect((await owner.query(`SELECT count(*) FROM ${table} WHERE user_id = $1`, [id])).rows[0]?.count).toBe('0');
  }
}
describe('CommandBus turn fencing', () => {
  it('missing turn and malformed lease fail without database parser errors', async () => {
    const { userId, lease, command } = await started();
    for (const bad of [{ ...lease, id: randomUUID() }, { ...lease, token: 'PRIVATE_INVALID_TOKEN' },
      { ...lease, revision: '9223372036854775808' }]) {
      const error = await caught(executeCommand(runtime, command, handler, bad));
      expect(error).toMatchObject({ code: 'lost_turn_lease' }); expect(String(error)).not.toContain('PRIVATE_INVALID');
    }
    await noEffects(userId);
  });
  it('expired lease rejects before effects and rolls back sequence', async () => {
    const { userId, id, lease, command } = await started(); await expire(userId, id); let called = false;
    const error = await caught(executeCommand(runtime, command, async () => { called = true; return handler(); }, lease));
    expect(error).toMatchObject({ code: 'lost_turn_lease' }); expect(called).toBe(false); await noEffects(userId);
  });
  it('wrong token rejects independently of revision and status', async () => {
    const { userId, lease, command } = await started();
    expect(await caught(executeCommand(runtime, command, handler, { ...lease, token: randomUUID() }))).toMatchObject({ code: 'lost_turn_lease' });
    await noEffects(userId);
  });
  it('old revision rejects independently of token and status', async () => {
    const { userId, lease, command } = await started(); await renewTurnLease(runtime, userId, lease, 60_000);
    expect(await caught(executeCommand(runtime, command, handler, lease))).toMatchObject({ code: 'lost_turn_lease' });
    await noEffects(userId);
  });
  it('foreign tenant cannot fence with another users turn', async () => {
    const foreign = await started(); const own = await started();
    expect(await caught(executeCommand(runtime, own.command, handler, foreign.lease))).toMatchObject({ code: 'lost_turn_lease' });
    await noEffects(own.userId);
  });
  it('takeover fences previous owner and replays committed command once', async () => {
    const { userId, id, lease, command } = await started(); let calls = 0;
    const run = async () => { calls++; return handler(); };
    const first = await executeCommand(runtime, command, run, lease);
    await expire(userId, id); const next = await claimTurn(runtime, userId, id, 60_000); expect(next).not.toBeNull();
    expect(await caught(executeCommand(runtime, command, run, lease))).toMatchObject({ code: 'lost_turn_lease' });
    expect(await executeCommand(runtime, command, run, next!.lease)).toEqual({ ...first, duplicate: true }); expect(calls).toBe(1);
    expect((await owner.query('SELECT seq FROM user_change_counters WHERE user_id = $1', [userId])).rows[0]?.seq).toBe('1');
  });
  it('expiry while waiting for user lock is checked after contention', async () => {
    const { userId, id, lease, command } = await started();
    const blocker = await owner.connect(); await blocker.query('BEGIN');
    await blocker.query('INSERT INTO user_change_counters (user_id, seq) VALUES ($1, 0)', [userId]); let called = false;
    const pending = caught(executeCommand(runtime, command, async () => { called = true; return handler(); }, lease));
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await owner.query("SELECT 1 FROM pg_stat_activity WHERE usename = 'app_runtime' AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO user_change_counters%'");
        if (rows.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true); await expire(userId, id);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(await pending).toMatchObject({ code: 'lost_turn_lease' }); expect(called).toBe(false); await noEffects(userId);
  });
  it('turn row stays locked through handler and receipt commit', async () => {
    const { userId, id, lease, command } = await started(); let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = executeCommand(runtime, command, async () => { enter(); await gate; return handler(); }, lease); await entered;
    const probe = await owner.connect(); await probe.query('BEGIN');
    try {
      expect(await caught(probe.query('SELECT id FROM ai_turns WHERE user_id = $1 AND id = $2 FOR UPDATE NOWAIT', [userId, id]))).toMatchObject({ code: '55P03' });
    } finally { await probe.query('ROLLBACK'); probe.release(); release(); }
    expect((await pending).duplicate).toBe(false);
  });
  it('expiry while waiting for turn lock is checked after contention', async () => {
    const { userId, id, lease, command } = await started();
    const blocker = await owner.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM ai_turns WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, id]);
    const pending = caught(executeCommand(runtime, command, handler, lease));
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await owner.query("SELECT 1 FROM pg_stat_activity WHERE usename = 'app_runtime' AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM ai_turns%FOR UPDATE%'");
        if (rows.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await blocker.query("UPDATE ai_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1 AND id = $2", [userId, id]);
    } finally { await blocker.query('COMMIT'); blocker.release(); }
    expect(await pending).toMatchObject({ code: 'lost_turn_lease' }); await noEffects(userId);
  });
  it('handler failure rolls back all effects and releases turn lock', async () => {
    const { userId, lease, command } = await started();
    const error = await caught(executeCommand(runtime, command, async () => { throw new Error('synthetic failure'); }, lease));
    expect(error).toBeInstanceOf(Error); await noEffects(userId);
    expect((await executeCommand(runtime, command, handler, lease)).duplicate).toBe(false);
  });
  it('envelope fencing blocks stale XP and valid replay awards once', async () => {
    const { userId, id, lease } = await started();
    await owner.query("INSERT INTO user_profiles (user_id, timezone, day_boundary_minutes) VALUES ($1, 'Europe/Moscow', 240)", [userId]);
    const envelope = (kind: string, payload: Record<string, unknown>, target?: string): CommandEnvelope => ({
      schema_version: 1, command_id: randomUUID(), device_id: randomUUID(), kind, aggregate_id: target ?? null,
      expected_version: target ? 1 : null, client_created_at: new Date().toISOString(), depends_on_command_id: null, payload,
    });
    const template = await executeEnvelope(runtime, userId, envelope('create_quest_template', {
      title: 'Synthetic quest', normal_spec: { success_rule: 'duration', unit: 'seconds', duration_seconds: 2700 },
    }));
    const occurrence = await executeEnvelope(runtime, userId, envelope('materialize_occurrence', {
      template_id: template.result?.['template_id'], recurrence_key: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }), timezone: 'Europe/Moscow',
    }));
    expect(occurrence.status).toBe('committed');
    const completion = envelope('complete_quest', { actual_duration_seconds: 2700 }, occurrence.result?.['occurrence_id'] as string);
    const before = (await owner.query('SELECT seq FROM user_change_counters WHERE user_id = $1', [userId])).rows[0]?.seq;
    await expire(userId, id);
    expect(await caught(executeEnvelope(runtime, userId, completion, lease))).toMatchObject({ code: 'lost_turn_lease' });
    expect((await owner.query('SELECT count(*) FROM xp_ledger WHERE user_id = $1', [userId])).rows[0]?.count).toBe('0');
    expect((await owner.query('SELECT seq FROM user_change_counters WHERE user_id = $1', [userId])).rows[0]?.seq).toBe(before);
    const next = await claimTurn(runtime, userId, id, 60_000); expect(next).not.toBeNull();
    expect((await executeEnvelope(runtime, userId, completion, next!.lease)).status).toBe('committed');
    expect((await executeEnvelope(runtime, userId, completion, next!.lease)).status).toBe('already_applied');
    expect((await owner.query('SELECT count(*) FROM xp_ledger WHERE user_id = $1', [userId])).rows[0]?.count).toBe('1');
  });
});
