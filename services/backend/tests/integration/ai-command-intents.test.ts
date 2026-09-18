import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { runMigrations, DEFAULT_MIGRATIONS_DIR } from '../../src/shared/db/migrate.ts';
import { withTenantTransaction } from '../../src/shared/db/tenant.ts';
import { resetSchema } from '../helpers/reset-schema.ts';
import { derivedCommandId } from '../../src/shared/commands/derived-id.ts';
import { openTurn, claimTurn, type TurnLease } from '../../src/modules/ai/turn-store.ts';
import { executeEnvelope } from '../../src/modules/sync/routes.ts';
import { buildEnvelopeCommand } from '../../src/modules/sync/routes.ts';
import { semanticHash } from '../../src/shared/commands/bus.ts';
import { prepareCommandIntent, readCommandIntent, prepareQuestOccurrenceIntent, executePreparedIntent,
  type IntentInput, type PreparedIntent } from '../../src/modules/ai/command-intents.ts';

let owner: Database; let runtime: Database; let worker: Database;
let upgraded: { id: string; userId: string; lease: TurnLease };
beforeAll(async () => {
  const config = loadConfig(); owner = createPool(config.database); await resetSchema(owner);
  const directory = await mkdtemp(path.join(tmpdir(), 'intent-upgrade-'));
  try {
    for (const name of await readdir(DEFAULT_MIGRATIONS_DIR)) {
      if (name.endsWith('.sql') && name < '021') await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, name), path.join(directory, name));
    }
    await runMigrations(owner, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const url = new URL(config.database.connectionString); url.username = 'app_runtime'; url.password = '';
  runtime = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 3 });
  url.username = 'app_worker'; worker = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 3 });
  upgraded = await started();
  expect((await runMigrations(owner)).applied).toEqual(['021_ai_command_intents.sql']);
});
afterAll(async () => { await runtime?.end(); await worker?.end(); if (owner) { await resetSchema(owner); await owner.end(); } });
const caught = (promise: Promise<unknown>) => promise.catch((e: unknown) => e);
async function started() {
  const userId = randomUUID(); const id = randomUUID();
  await owner.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [userId, 'dev', userId]);
  await owner.query("INSERT INTO user_profiles (user_id, timezone, day_boundary_minutes) VALUES ($1, 'Europe/Moscow', 240)", [userId]);
  await openTurn(runtime, userId, { id, source: { channel: 'telegram', scope: 'synthetic', requestId: id }, input: {},
    initialCheckpoint: {}, versions: { prompt: 'p1', policy: 'e1', checkpoint: 'c1' }, maxAttempts: 3 });
  const claimed = await claimTurn(runtime, userId, id, 60_000); expect(claimed).not.toBeNull();
  return { userId, id, lease: claimed!.lease };
}
function input(lease: TurnLease, callId = 'create-a'): IntentInput {
  return { callId, questRef: null, snapshot: { clock: '2026-09-18T01:00:00.000Z', localDate: '2026-09-18',
    timezone: 'Europe/Moscow', dayBoundaryMinutes: 240, refs: {} }, envelope: {
    schema_version: 1, command_id: derivedCommandId('ai', lease.id, `${callId}:template`),
    device_id: derivedCommandId('ai', lease.id, 'device'), kind: 'create_quest_template', aggregate_id: null,
    expected_version: null, client_created_at: '2026-09-18T01:00:00.000Z', depends_on_command_id: null,
    payload: { title: 'Synthetic quest', normal_spec: { success_rule: 'duration', unit: 'seconds', duration_seconds: 2700 } },
  } };
}
async function prepare(userId: string, lease: TurnLease, value = input(lease)) {
  const intent = await prepareCommandIntent(runtime, userId, lease, value).catch(() => null);
  expect(intent).not.toBeNull(); return intent!;
}
async function takeover(userId: string, id: string) {
  await owner.query("UPDATE ai_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1 AND id = $2", [userId, id]);
  const next = await claimTurn(runtime, userId, id, 60_000); expect(next).not.toBeNull(); return next!.lease;
}
async function quest(userId: string, lease: TurnLease) {
  const template = await prepare(userId, lease); await executePreparedIntent(runtime, userId, lease, template.step);
  const occurrence = await prepareQuestOccurrenceIntent(runtime, userId, lease, template.callId);
  const result = await executePreparedIntent(runtime, userId, lease, occurrence.step);
  expect(result.status).toBe('committed'); return { template, occurrence, occurrenceId: result.result?.['occurrence_id'] as string };
}
function completion(lease: TurnLease, template: PreparedIntent, occurrenceId: string): IntentInput {
  const callId = 'complete-a';
  return { callId, questRef: 'q1', snapshot: { ...template.snapshot, refs: { q1: { occurrenceId, version: 1, title: 'Synthetic quest' } } },
    envelope: { ...template.envelope, kind: 'complete_quest', command_id: derivedCommandId('ai', lease.id, `${callId}:complete`),
      aggregate_id: occurrenceId, expected_version: 1, payload: { actual_duration_seconds: 2700 } } };
}
describe('prepared AI command intents', () => {
  it('upgrades existing claimed turn without changing its checkpoint lease or revision', async () => {
    const row = (await owner.query('SELECT lease_token, revision, checkpoint FROM ai_turns WHERE user_id = $1 AND id = $2', [upgraded.userId, upgraded.id])).rows[0];
    expect(row).toEqual({ lease_token: upgraded.lease.token, revision: upgraded.lease.revision, checkpoint: {} });
    expect((await runMigrations(owner)).applied).toEqual([]);
  });
  it('prepares without effect and canonical replay preserves exact input', async () => {
    const { userId, lease } = await started(); const original = input(lease); const first = await prepare(userId, lease, original);
    const again = await prepare(userId, lease, { ...original, envelope: { ...original.envelope, payload: { normal_spec: original.envelope.payload['normal_spec'], title: 'Synthetic quest' } } });
    expect(again).toEqual(first);
    expect(await readCommandIntent(runtime, userId, lease.id, first.step)).toEqual(first);
    expect((await owner.query('SELECT count(*) FROM quest_templates WHERE user_id = $1', [userId])).rows[0]?.count).toBe('0');
  });
  it('changed payload same step conflicts before any command receipt exists', async () => {
    const { userId, lease } = await started(); const original = input(lease); await prepare(userId, lease, original);
    expect(await caught(prepareCommandIntent(runtime, userId, lease, { ...original, envelope: { ...original.envelope,
      payload: { ...original.envelope.payload, title: 'OTHER_PRIVATE_TEXT' } } }))).toMatchObject({ code: 'intent_conflict' });
  });
  it('changed valid snapshot same step conflicts even with unchanged command semantics', async () => {
    const { userId, lease } = await started(); const original = input(lease); await prepare(userId, lease, original);
    const error = await caught(prepareCommandIntent(runtime, userId, lease, { ...original,
      snapshot: { ...original.snapshot, refs: { q1: { occurrenceId: randomUUID(), version: 1, title: 'OTHER_PRIVATE_TEXT' } } } }));
    expect(error).toMatchObject({ code: 'intent_conflict' }); expect(String(error)).not.toContain('OTHER_PRIVATE_TEXT');
  });
  it('closed validation rejects unsafe kind payload identity date and snapshot refs', async () => {
    const { userId, lease } = await started(); const original = input(lease);
    const variants = [
      { ...original, envelope: { ...original.envelope, kind: 'add_xp' } },
      { ...original, envelope: { ...original.envelope, kind: 'create_goal', payload: { title: 'Synthetic goal', start_date: '2026-09-18' } } },
      { ...original, envelope: { ...original.envelope, privateExtra: 'PRIVATE_TEXT' } },
      { ...original, envelope: { ...original.envelope, payload: { ...original.envelope.payload, xp: 500 } } },
      { ...original, envelope: { ...original.envelope, command_id: randomUUID() } },
      { ...original, envelope: { ...original.envelope, device_id: randomUUID() } },
      { ...original, snapshot: { ...original.snapshot, localDate: '2026-09-19' } },
      { ...original, snapshot: { ...original.snapshot, refs: { q1: { occurrenceId: randomUUID(), version: 0, title: 'Synthetic' } } } },
      { ...original, envelope: { ...original.envelope, client_created_at: '2026-09-18T02:00:00.000Z' } },
      { ...original, privateExtra: 'PRIVATE_TEXT' },
    ];
    for (const value of variants) expect(await caught(prepareCommandIntent(runtime, userId, lease, value))).toMatchObject({ code: 'invalid_intent' });
  });
  it('concurrent preparation persists one immutable intent', async () => {
    const { userId, lease } = await started(); const original = input(lease);
    const values = await Promise.all([prepareCommandIntent(runtime, userId, lease, original), prepareCommandIntent(worker, userId, lease, original)]);
    expect(values[0]).toEqual(values[1]);
    expect((await owner.query('SELECT count(*) FROM ai_command_intents WHERE user_id = $1', [userId])).rows[0]?.count).toBe('1');
  });
  it('both app roles cannot update or delete intents and RLS hides foreign rows', async () => {
    const own = await started(); const other = await started(); const intent = await prepare(own.userId, own.lease);
    for (const db of [runtime, worker]) {
      expect((await db.query('SELECT * FROM ai_command_intents')).rows).toEqual([]);
      expect((await withTenantTransaction(db, other.userId, client => client.query('SELECT * FROM ai_command_intents'))).rows).toEqual([]);
      expect(await readCommandIntent(db, other.userId, own.id, intent.step)).toBeNull();
      for (const sql of ['UPDATE ai_command_intents SET intent_hash = intent_hash WHERE user_id = $1', 'DELETE FROM ai_command_intents WHERE user_id = $1']) {
        expect(await caught(withTenantTransaction(db, own.userId, client => client.query(sql, [own.userId])))).toMatchObject({ code: '42501' });
      }
    }
  });
  it('transaction rejects changed command before first receipt with live lease', async () => {
    const { userId, lease } = await started(); const intent = await prepare(userId, lease);
    const error = await caught(executeEnvelope(runtime, userId, { ...intent.envelope, payload: { ...intent.envelope.payload, title: 'Changed title' } },
      { ...lease, intent: { step: intent.step, hash: intent.hash } }));
    expect(error).toMatchObject({ code: 'intent_mismatch' });
    expect((await owner.query('SELECT count(*) FROM command_receipts WHERE user_id = $1', [userId])).rows[0]?.count).toBe('0');
    expect((await owner.query('SELECT count(*) FROM quest_templates WHERE user_id = $1', [userId])).rows[0]?.count).toBe('0');
    expect((await owner.query('SELECT count(*) FROM user_change_counters WHERE user_id = $1', [userId])).rows[0]?.count).toBe('0');
  });
  it('transaction rejects missing intent wrong digest and command ID independently', async () => {
    const { userId, lease } = await started(); const intent = await prepare(userId, lease);
    for (const context of [{ step: 'missing', hash: intent.hash }, { step: intent.step, hash: '0'.repeat(64) }]) {
      expect(await caught(executeEnvelope(runtime, userId, intent.envelope, { ...lease, intent: context }))).toMatchObject({ code: 'intent_mismatch' });
    }
    expect(await caught(executeEnvelope(runtime, userId, { ...intent.envelope, command_id: randomUUID() },
      { ...lease, intent: { step: intent.step, hash: intent.hash } }))).toMatchObject({ code: 'intent_mismatch' });
  });
  it('transaction compares kind and expected version to persisted semantics', async () => {
    const { userId, lease } = await started(); const made = await quest(userId, lease);
    const intent = await prepare(userId, lease, completion(lease, made.template, made.occurrenceId));
    for (const envelope of [{ ...intent.envelope, kind: 'start_quest', payload: {} }, { ...intent.envelope, expected_version: 2 }]) {
      expect(await caught(executeEnvelope(runtime, userId, envelope, { ...lease, intent: { step: intent.step, hash: intent.hash } }))).toMatchObject({ code: 'intent_mismatch' });
    }
  });
  it('intent check occurs after user lock waiting in the effect transaction', async () => {
    const { userId, lease } = await started(); const intent = await prepare(userId, lease);
    const blocker = await owner.connect(); await blocker.query('BEGIN');
    await blocker.query('INSERT INTO user_change_counters (user_id, seq) VALUES ($1, 0)', [userId]);
    const pending = caught(executePreparedIntent(runtime, userId, lease, intent.step));
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await owner.query("SELECT 1 FROM pg_stat_activity WHERE usename = 'app_runtime' AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO user_change_counters%'");
        if (rows.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // Simulate privileged corruption after the executor has loaded its snapshot.
      await owner.query('UPDATE ai_command_intents SET intent_hash = $1 WHERE user_id = $2 AND turn_id = $3 AND step = $4', ['0'.repeat(64), userId, lease.id, intent.step]);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(await pending).toMatchObject({ code: 'intent_mismatch' });
    expect((await owner.query('SELECT count(*) FROM command_receipts WHERE user_id = $1', [userId])).rows[0]?.count).toBe('0');
  });
  it('completion must match both identity and version of its selected snapshot ref', async () => {
    const { userId, lease } = await started(); const made = await quest(userId, lease); const original = completion(lease, made.template, made.occurrenceId);
    for (const value of [{ ...original, questRef: 'q2' }, { ...original, envelope: { ...original.envelope, aggregate_id: randomUUID() } },
      { ...original, envelope: { ...original.envelope, expected_version: 2 } }]) {
      expect(await caught(prepareCommandIntent(runtime, userId, lease, value))).toMatchObject({ code: 'invalid_intent' });
    }
  });
  it('same model call ID cannot become another primary command', async () => {
    const { userId, lease } = await started(); const made = await quest(userId, lease);
    const value = completion(lease, made.template, made.occurrenceId); const callId = made.template.callId;
    expect(await caught(prepareCommandIntent(runtime, userId, lease, { ...value, callId,
      envelope: { ...value.envelope, command_id: derivedCommandId('ai', lease.id, `${callId}:complete`) } }))).toMatchObject({ code: 'intent_conflict' });
  });
  it('occurrence preparation requires the template commit', async () => {
    const { userId, lease } = await started(); const template = await prepare(userId, lease);
    expect(await caught(prepareQuestOccurrenceIntent(runtime, userId, lease, template.callId))).toMatchObject({ code: 'intent_not_ready' });
  });
  it('occurrence receipt must match template kind independently of hash', async () => {
    const { userId, lease } = await started(); const intent = await prepare(userId, lease);
    const goal = { ...intent.envelope, kind: 'create_goal', payload: { title: 'Synthetic goal', start_date: '2026-09-18' } };
    expect((await executeEnvelope(runtime, userId, goal)).status).toBe('committed');
    await owner.query('UPDATE command_receipts SET payload_hash = $1, result = $2::jsonb WHERE user_id = $3 AND command_id = $4',
      [semanticHash(buildEnvelopeCommand(userId, intent.envelope).command), JSON.stringify({ template_id: randomUUID() }), userId, intent.envelope.command_id]);
    expect(await caught(prepareQuestOccurrenceIntent(runtime, userId, lease, intent.callId))).toMatchObject({ code: 'intent_not_ready' });
  });
  it('occurrence receipt must match prepared template semantic hash', async () => {
    const { userId, lease } = await started(); const intent = await prepare(userId, lease);
    expect((await executeEnvelope(runtime, userId, { ...intent.envelope, payload: { ...intent.envelope.payload, title: 'Another template' } })).status).toBe('committed');
    expect(await caught(prepareQuestOccurrenceIntent(runtime, userId, lease, intent.callId))).toMatchObject({ code: 'intent_not_ready' });
  });
  it('occurrence receipt must match semantic hash version', async () => {
    const { userId, lease } = await started(); const intent = await prepare(userId, lease);
    expect((await executePreparedIntent(runtime, userId, lease, intent.step)).status).toBe('committed');
    await owner.query('UPDATE command_receipts SET hash_version = 1 WHERE user_id = $1 AND command_id = $2', [userId, intent.envelope.command_id]);
    expect(await caught(prepareQuestOccurrenceIntent(runtime, userId, lease, intent.callId))).toMatchObject({ code: 'intent_not_ready' });
  });
  it('crash after template commit preserves clock day settings and both receipts', async () => {
    const { userId, id, lease } = await started(); const template = await prepare(userId, lease);
    const first = await executePreparedIntent(runtime, userId, lease, template.step); expect(first.status).toBe('committed');
    const next = await takeover(userId, id);
    await owner.query("UPDATE user_profiles SET timezone = 'America/New_York', day_boundary_minutes = 300 WHERE user_id = $1", [userId]);
    expect((await executePreparedIntent(runtime, userId, next, template.step)).status).toBe('already_applied');
    const occurrence = await prepareQuestOccurrenceIntent(runtime, userId, next, template.callId);
    expect(occurrence.snapshot).toEqual(template.snapshot);
    expect(occurrence.envelope.payload).toEqual({ template_id: first.result?.['template_id'], recurrence_key: '2026-09-18', timezone: 'Europe/Moscow' });
    expect(occurrence.envelope.client_created_at).toBe(template.snapshot.clock);
    const result = await executePreparedIntent(runtime, userId, next, occurrence.step); expect(result.status).toBe('committed');
    const last = await takeover(userId, id);
    expect(await readCommandIntent(runtime, userId, id, occurrence.step)).toEqual(occurrence);
    expect((await executePreparedIntent(runtime, userId, last, occurrence.step)).result).toEqual(result.result);
    expect((await owner.query('SELECT count(*) FROM quest_templates WHERE user_id = $1', [userId])).rows[0]?.count).toBe('1');
    expect((await owner.query('SELECT count(*) FROM quest_occurrences WHERE user_id = $1', [userId])).rows[0]?.count).toBe('1');
  });
  it('stale holder cannot prepare or execute after takeover', async () => {
    const { userId, id, lease } = await started(); const intent = await prepare(userId, lease); await takeover(userId, id);
    expect(await caught(prepareCommandIntent(runtime, userId, lease, input(lease, 'other')))).toMatchObject({ code: 'lost_turn_lease' });
    expect(await caught(executePreparedIntent(runtime, userId, lease, intent.step))).toMatchObject({ code: 'lost_turn_lease' });
  });
  it('stored snapshot version stays stale even when the object can complete', async () => {
    const { userId, lease } = await started(); const made = await quest(userId, lease);
    const intent = await prepare(userId, lease, completion(lease, made.template, made.occurrenceId));
    const start = { ...intent.envelope, kind: 'start_quest', command_id: randomUUID(), payload: {} };
    expect((await executeEnvelope(runtime, userId, start)).status).toBe('committed');
    expect((await executePreparedIntent(runtime, userId, lease, intent.step)).error).toBe('version_conflict');
    expect((await owner.query('SELECT count(*) FROM xp_ledger WHERE user_id = $1', [userId])).rows[0]?.count).toBe('0');
  });
  it('committed completion survives crash without a second XP award', async () => {
    const { userId, id, lease } = await started(); const made = await quest(userId, lease);
    const intent = await prepare(userId, lease, completion(lease, made.template, made.occurrenceId));
    const first = await executePreparedIntent(runtime, userId, lease, intent.step); expect(first.status).toBe('committed');
    const next = await takeover(userId, id);
    const replay = await executePreparedIntent(runtime, userId, next, intent.step);
    expect(replay.status).toBe('already_applied'); expect(replay.result).toEqual(first.result);
    expect((await owner.query('SELECT count(*) FROM xp_ledger WHERE user_id = $1', [userId])).rows[0]?.count).toBe('1');
  });
});
