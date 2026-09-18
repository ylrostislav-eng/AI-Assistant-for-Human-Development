import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { runMigrations } from '../../src/shared/db/migrate.ts';
import { resetSchema } from '../helpers/reset-schema.ts';
import {
  openTurn, readTurn, claimTurn, saveTurnCheckpoint, finishTurn, renewTurnLease,
  type OpenTurnInput, type TurnLease,
} from '../../src/modules/ai/turn-store.ts';

let owner: Database;
let runtime: Database;
let worker: Database;
const versions = { prompt: 'coach-1', policy: 'egress-1', checkpoint: 'turn-checkpoint-1' };
const checkpoint = {
  messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'call-a', name: 'complete_quest', arguments: { quest_ref: 'q1' } }] }],
  refs: { q1: { occurrenceId: '11111111-1111-4111-8111-111111111111', version: '2' } },
  results: [], nextToolIndex: 0, rounds: 1, executed: 0,
  clock: '2026-09-18T00:01:00.000Z',
};
async function user(): Promise<string> {
  const id = randomUUID();
  await owner.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [id, 'dev', id]);
  return id;
}
function input(extra: Partial<OpenTurnInput> = {}): OpenTurnInput {
  return { id: randomUUID(), source: { channel: 'telegram', scope: 'synthetic-bot', requestId: randomUUID() },
    input: { text: 'Синтетическое сообщение', locale: 'ru' }, versions, initialCheckpoint: checkpoint, maxAttempts: 2, ...extra };
}
async function started() {
  const userId = await user(); const args = input();
  await openTurn(runtime, userId, args);
  const claimed = await claimTurn(runtime, userId, args.id, 60_000);
  expect(claimed).not.toBeNull();
  return { userId, args, claimed: claimed! };
}
async function expire(userId: string, id: string) {
  await owner.query("UPDATE ai_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1 AND id = $2", [userId, id]);
}
const caught = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

beforeAll(async () => {
  const config = loadConfig(); owner = createPool(config.database);
  await resetSchema(owner); await runMigrations(owner);
  const role = (name: string) => { const url = new URL(config.database.connectionString); url.username = name; url.password = '';
    return createPool({ ...config.database, connectionString: url.toString(), maxConnections: 3 }); };
  runtime = role('app_runtime'); worker = role('app_worker');
});
afterAll(async () => { await runtime?.end(); await worker?.end(); if (owner) { await resetSchema(owner); await owner.end(); } });

describe('durable turn storage', () => {
  it('replay preserves checkpoint and canonical input identity', async () => {
    const id = await user(); const args = input();
    const first = await openTurn(runtime, id, args);
    const again = await openTurn(worker, id, { ...args, input: { locale: 'ru', text: 'Синтетическое сообщение' }, initialCheckpoint: { changed: true } }).catch(() => null);
    expect(again).toEqual(first); expect(again?.checkpoint).toEqual(checkpoint);
    const count = await owner.query('SELECT count(*) FROM ai_turns WHERE user_id = $1', [id]);
    expect(count.rows[0]?.count).toBe('1');
  });
  it('concurrent source deliveries share one stored turn', async () => {
    const id = await user(); const args = input();
    const results = await Promise.all([openTurn(runtime, id, args), openTurn(worker, id, args)]);
    expect(results[0]).toEqual(results[1]);
    expect((await owner.query('SELECT count(*) FROM ai_turns WHERE user_id = $1', [id])).rows[0]?.count).toBe('1');
  });
  it('rejects changed input, versions, source and source reuse with different turn ID', async () => {
    const id = await user(); const args = input(); await openTurn(runtime, id, args);
    for (const changed of [
      { ...args, input: { text: 'OTHER_PRIVATE_TEXT' } },
      { ...args, versions: { ...versions, policy: 'egress-2' } },
      { ...args, versions: { ...versions, prompt: 'coach-2' } },
      { ...args, versions: { ...versions, checkpoint: 'turn-checkpoint-2' } },
      { ...args, source: { ...args.source, scope: 'other-bot' } },
      { ...args, source: { ...args.source, channel: 'miniapp' as const } },
      { ...args, id: randomUUID() }, { ...args, maxAttempts: 3 },
    ]) {
      const error = await caught(openTurn(runtime, id, changed));
      expect(error).toMatchObject({ code: 'identity_conflict' });
      expect(String(error)).not.toContain('OTHER_PRIVATE_TEXT');
    }
  });
  it('source identity includes channel and scope', async () => {
    const id = await user(); const args = input(); await openTurn(runtime, id, args);
    expect((await openTurn(runtime, id, { ...args, id: randomUUID(), source: { ...args.source, channel: 'miniapp' } })).status).toBe('pending');
    expect((await openTurn(runtime, id, { ...args, id: randomUUID(), source: { ...args.source, scope: 'another-bot' } })).status).toBe('pending');
  });
  it('concurrent executors obtain only one lease', async () => {
    const id = await user(); const args = input(); await openTurn(runtime, id, args);
    const results = await Promise.all([claimTurn(runtime, id, args.id, 60_000), claimTurn(worker, id, args.id, 60_000)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readTurn(runtime, id, args.id))?.attempts).toBe(1);
  });
  it('checkpoint survives a fresh connection and retains refs, intents and receipts', async () => {
    const { userId, args, claimed } = await started();
    const state = { ...checkpoint, results: [{ callId: 'call-a', receipt: { status: 'committed', title: 'Тест' } }], nextToolIndex: 1, executed: 1 };
    const updated = await saveTurnCheckpoint(runtime, userId, claimed.lease, state);
    const base = loadConfig(); const url = new URL(base.database.connectionString); url.username = 'app_runtime'; url.password = '';
    const fresh = createPool({ ...base.database, connectionString: url.toString() });
    try { expect(await readTurn(fresh, userId, args.id)).toEqual(updated.turn); }
    finally { await fresh.end(); }
    expect(updated.turn.checkpoint).toEqual(state); expect(updated.turn.revision).not.toBe(claimed.turn.revision);
  });
  it.each(['save', 'finish', 'renew'] as const)('old lease cannot %s after another executor takes over', async (operation) => {
    const { userId, args, claimed } = await started(); await expire(userId, args.id);
    const newer = await claimTurn(worker, userId, args.id, 60_000); expect(newer).not.toBeNull();
    // Use the NEW revision deliberately: only the ownership token can reject this.
    const stale: TurnLease = { ...claimed.lease, revision: newer!.lease.revision };
    const result = await caught(operation === 'save' ? saveTurnCheckpoint(runtime, userId, stale, { bad: true })
      : operation === 'finish' ? finishTurn(runtime, userId, stale, { bad: true }) : renewTurnLease(runtime, userId, stale, 60_000));
    expect(result).toMatchObject({ code: 'lost_lease' });
    expect(await readTurn(runtime, userId, args.id)).toEqual(newer!.turn);
  });
  it('expired lease cannot save even without takeover', async () => {
    const { userId, args, claimed } = await started(); await expire(userId, args.id);
    expect(await caught(saveTurnCheckpoint(runtime, userId, claimed.lease, { bad: true }))).toMatchObject({ code: 'lost_lease' });
    expect((await readTurn(runtime, userId, args.id))?.checkpoint).toEqual(checkpoint);
  });
  it('lease expiry is checked after waiting for a row lock', async () => {
    const { userId, args, claimed } = await started();
    const locker = await owner.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM ai_turns WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, args.id]);
      pending = caught(saveTurnCheckpoint(runtime, userId, claimed.lease, { bad: true }));
      let waiting = false;
      for (let i = 0; i < 100; i += 1) {
        const found = await owner.query("SELECT pid FROM pg_stat_activity WHERE usename = 'app_runtime' AND wait_event_type = 'Lock' AND query LIKE '%ai_turns%'");
        if (found.rowCount) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      await locker.query("UPDATE ai_turns SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1 AND id = $2", [userId, args.id]);
      await locker.query('COMMIT');
      expect(await pending).toMatchObject({ code: 'lost_lease' });
      expect((await readTurn(runtime, userId, args.id))?.checkpoint).toEqual(checkpoint);
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending; }
  });
  it('same holder stale revision cannot overwrite a newer checkpoint', async () => {
    const { userId, args, claimed } = await started();
    const saved = await saveTurnCheckpoint(runtime, userId, claimed.lease, { marker: 'new' });
    expect(await caught(saveTurnCheckpoint(runtime, userId, claimed.lease, { marker: 'old' }))).toMatchObject({ code: 'lost_lease' });
    expect(await readTurn(runtime, userId, args.id)).toEqual(saved.turn);
  });
  it('renew advances revision and completed result is terminal', async () => {
    const { userId, args, claimed } = await started();
    const renewed = await renewTurnLease(runtime, userId, claimed.lease, 120_000);
    expect(renewed.lease.revision).not.toBe(claimed.lease.revision);
    const finished = await finishTurn(runtime, userId, renewed.lease, { result: { receipts: ['synthetic'], stopReason: 'answered' } });
    expect(finished.status).toBe('finished');
    expect(await claimTurn(worker, userId, args.id, 60_000)).toBeNull();
    expect(await caught(saveTurnCheckpoint(runtime, userId, { ...renewed.lease, revision: finished.revision }, { bad: true }))).toMatchObject({ code: 'lost_lease' });
    expect(await openTurn(runtime, userId, args)).toEqual(finished);
  });
  it('expired attempts cannot exceed the persisted attempt cap', async () => {
    const { userId, args } = await started(); await expire(userId, args.id);
    expect(await claimTurn(worker, userId, args.id, 60_000)).not.toBeNull(); await expire(userId, args.id);
    expect(await caught(claimTurn(runtime, userId, args.id, 60_000))).toBeNull();
    expect((await readTurn(runtime, userId, args.id))?.attempts).toBe(2);
  });
  it('tenant isolation applies to runtime and worker, with no-context denial', async () => {
    const { userId, args, claimed } = await started(); const other = await user();
    for (const db of [runtime, worker]) {
      expect(await readTurn(db, other, args.id)).toBeNull();
      expect(await claimTurn(db, other, args.id, 60_000)).toBeNull();
      expect(await caught(saveTurnCheckpoint(db, other, claimed.lease, { bad: true }))).toMatchObject({ code: 'lost_lease' });
      expect((await db.query('SELECT id FROM ai_turns')).rows).toEqual([]);
    }
    // Same external identity and UUID can belong independently to another tenant.
    expect((await openTurn(worker, other, args)).status).toBe('pending');
    expect((await readTurn(runtime, userId, args.id))?.status).toBe('running');
  });
  it('invalid or oversized JSON and limits fail before storage writes', async () => {
    const id = await user(); const args = input();
    const cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
    for (const initialCheckpoint of [null, [], { secret: 'x'.repeat(530_000) }, { bad: Infinity }, { bad: undefined }, cycle, { bad: new Date() }]) {
      expect(await caught(openTurn(runtime, id, { ...args, initialCheckpoint: initialCheckpoint as never }))).toMatchObject({ code: 'invalid_input' });
    }
    for (const maxAttempts of [0, 11, 0.5]) expect(await caught(openTurn(runtime, id, { ...args, maxAttempts }))).toMatchObject({ code: 'invalid_input' });
    await openTurn(runtime, id, args);
    for (const ms of [0, 600_001, 0.5]) expect(await caught(claimTurn(runtime, id, args.id, ms))).toMatchObject({ code: 'invalid_input' });
    expect((await readTurn(runtime, id, args.id))?.status).toBe('pending');
  });
  it.each(['NUL', 'high surrogate', 'low surrogate', 'accessor'])('JSONB-invalid text and accessors fail safely: %s', async (kind) => {
    const id = await user(); const args = input();
    const bad = kind === 'accessor'
      ? Object.defineProperty({}, 'note', { enumerable: true, get() { throw new Error('PRIVATE_SENTINEL'); } })
      : { note: 'PRIVATE_SENTINEL' + (kind === 'NUL' ? '\0' : kind === 'high surrogate' ? '\ud800' : '\udfff') };
    const error = await caught(openTurn(runtime, id, { ...args, initialCheckpoint: bad }));
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(String(error)).not.toContain('PRIVATE_SENTINEL');
  });
  it('valid surrogate pairs are preserved', async () => {
    const id = await user();
    expect((await openTurn(runtime, id, input({ initialCheckpoint: { note: 'Задание 🧠' } }))).checkpoint).toEqual({ note: 'Задание 🧠' });
  });
  it.each(['accessor', 'sparse', 'extra property'])('array serialization cannot silently drop data or run code: %s', async (kind) => {
    const array: unknown[] = [];
    if (kind === 'accessor') Object.defineProperty(array, '0', { enumerable: true, get() { throw new Error('PRIVATE_SENTINEL'); } });
    else if (kind === 'sparse') array.length = 1;
    else Object.defineProperty(array, 'note', { enumerable: true, value: 'PRIVATE_SENTINEL' });
    const id = await user();
    const error = await caught(openTurn(runtime, id, input({ initialCheckpoint: { array } as never })));
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(String(error)).not.toContain('PRIVATE_SENTINEL');
  });
  it('deleting the account deletes its checkpoint', async () => {
    const { userId, args } = await started();
    expect(await caught(owner.query('DELETE FROM users WHERE id = $1', [userId]))).toMatchObject({ rowCount: 1 });
    expect(await readTurn(runtime, userId, args.id)).toBeNull();
  });
});
