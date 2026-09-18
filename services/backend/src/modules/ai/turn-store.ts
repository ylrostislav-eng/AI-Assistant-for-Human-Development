import { createHash } from 'node:crypto';
import type { Database, TransactionClient } from '../../shared/db/pool.ts';
import { withTenantTransaction } from '../../shared/db/tenant.ts';

/** Internal server storage. No bot wiring or command execution in this slice. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }
export interface TurnVersions {
  readonly prompt: string;
  readonly policy: string;
  readonly checkpoint: string;
}
export interface OpenTurnInput {
  readonly id: string;
  readonly source: { readonly channel: 'telegram' | 'miniapp'; readonly scope: string; readonly requestId: string };
  readonly input: JsonObject;
  readonly versions: TurnVersions;
  readonly initialCheckpoint: JsonObject;
  readonly maxAttempts: number;
}
export interface StoredTurn {
  readonly id: string;
  readonly revision: string;
  readonly status: 'pending' | 'running' | 'finished';
  readonly checkpoint: JsonObject;
  readonly versions: TurnVersions;
  readonly attempts: number;
  readonly maxAttempts: number;
}
export interface TurnLease { readonly id: string; readonly token: string; readonly revision: string }
export interface ClaimedTurn { readonly turn: StoredTurn; readonly lease: TurnLease }
export class TurnStoreError extends Error {
  constructor(readonly code: 'invalid_input' | 'identity_conflict' | 'lost_lease') {
    super(`AI turn storage: ${code}`); this.name = 'TurnStoreError';
  }
}
interface Row {
  id: string; revision: string; status: StoredTurn['status']; checkpoint: JsonObject;
  prompt_version: string; policy_version: string; checkpoint_version: string;
  attempts: number; max_attempts: number; lease_token: string | null;
  channel: string; source_scope: string; source_request_id: string; input_hash: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): never { throw new TurnStoreError('invalid_input'); }
function uuid(value: string): void { if (!UUID.test(value)) invalid(); }
function text(value: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) invalid();
}
function positive(value: number, max: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) invalid();
}
function jsonText(value: string): string {
  if (value.includes('\0')) invalid();
  // PostgreSQL JSONB rejects lone UTF-16 surrogates; reject before SQL so the
  // driver cannot retain private input inside a parser exception.
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  return value;
}
/** Canonical JSON rejects lossy serialization (undefined, non-finite numbers,
 * class instances), deep/cyclic trees and oversized input. Private data is
 * never included in a validation exception. Outer document is always an object.
 * This is storage validation, not the orchestrator schema or egress policy. */
export function jsonDocument(value: JsonObject, maxBytes: number): string {
  let nodes = 0;
  function canonical(v: unknown, depth: number): JsonValue {
    if (depth > 32 || ++nodes > 20_000) invalid();
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') return jsonText(v);
    if (typeof v === 'number') { if (!Number.isFinite(v)) invalid(); return v; }
    if (Array.isArray(v)) {
      if (v.length > 20_000 || Object.getPrototypeOf(v) !== Array.prototype
        || Object.getOwnPropertySymbols(v).length !== 0 || Object.getOwnPropertyNames(v).length !== v.length + 1) invalid();
      return Array.from({ length: v.length }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(v, String(index));
        if (!item || !('value' in item) || !item.enumerable) invalid();
        return canonical(item.value, depth + 1);
      });
    }
    if (typeof v !== 'object' || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) invalid();
    if (Object.getOwnPropertySymbols(v).length !== 0) invalid();
    return Object.fromEntries(Object.getOwnPropertyNames(v).sort().map((key) => {
      jsonText(key);
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
      return [key, canonical(descriptor.value, depth + 1)];
    }));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const encoded = JSON.stringify(canonical(value, 0));
  if (Buffer.byteLength(encoded) > maxBytes) invalid();
  return encoded;
}
function view(row: Row): StoredTurn {
  return { id: row.id, revision: row.revision, status: row.status, checkpoint: row.checkpoint,
    versions: { prompt: row.prompt_version, policy: row.policy_version, checkpoint: row.checkpoint_version },
    attempts: row.attempts, maxAttempts: row.max_attempts };
}
function held(row: Row): ClaimedTurn {
  if (row.lease_token === null) throw new TurnStoreError('lost_lease');
  return { turn: view(row), lease: { id: row.id, token: row.lease_token, revision: row.revision } };
}
function validateLease(lease: TurnLease): void {
  uuid(lease.id); uuid(lease.token);
  if (!/^[1-9][0-9]{0,18}$/.test(lease.revision) || BigInt(lease.revision) > 9223372036854775807n) invalid();
}

/** Replay returns stored state, never the caller's fresh initial checkpoint.
 * A reused source/turn identity with changed semantic input fails closed. */
export async function openTurn(db: Database, userId: string, args: OpenTurnInput): Promise<StoredTurn> {
  uuid(userId); uuid(args.id); text(args.source.scope, 256); text(args.source.requestId, 256);
  if (!['telegram', 'miniapp'].includes(args.source.channel)) invalid();
  for (const version of [args.versions.prompt, args.versions.policy, args.versions.checkpoint]) text(version, 128);
  positive(args.maxAttempts, 10);
  const inputHash = createHash('sha256').update(jsonDocument(args.input, 262_144)).digest('hex');
  const checkpoint = jsonDocument(args.initialCheckpoint, 524_288);
  return withTenantTransaction(db, userId, async (client) => {
    const inserted = await client.query<Row>(
      `INSERT INTO ai_turns (user_id, id, channel, source_scope, source_request_id, input_hash,
        prompt_version, policy_version, checkpoint_version, checkpoint, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT DO NOTHING RETURNING *`,
      [userId, args.id, args.source.channel, args.source.scope, args.source.requestId, inputHash,
        args.versions.prompt, args.versions.policy, args.versions.checkpoint, checkpoint, args.maxAttempts]);
    if (inserted.rows[0]) return view(inserted.rows[0]);
    const rows = await client.query<Row>(
      `SELECT * FROM ai_turns WHERE user_id = $1 AND
       (id = $2 OR (channel = $3 AND source_scope = $4 AND source_request_id = $5))`,
      [userId, args.id, args.source.channel, args.source.scope, args.source.requestId]);
    const row = rows.rows[0];
    if (rows.rows.length !== 1 || !row || row.id !== args.id || row.channel !== args.source.channel
      || row.source_scope !== args.source.scope || row.source_request_id !== args.source.requestId
      || row.input_hash !== inputHash || row.prompt_version !== args.versions.prompt
      || row.policy_version !== args.versions.policy || row.checkpoint_version !== args.versions.checkpoint
      || row.max_attempts !== args.maxAttempts) throw new TurnStoreError('identity_conflict');
    return view(row);
  });
}
export async function readTurn(db: Database, userId: string, id: string): Promise<StoredTurn | null> {
  uuid(userId); uuid(id);
  return withTenantTransaction(db, userId, async (client) => {
    const row = (await client.query<Row>('SELECT * FROM ai_turns WHERE user_id = $1 AND id = $2', [userId, id])).rows[0];
    return row ? view(row) : null;
  });
}
/** Atomic claim; PostgreSQL clock, not worker clock, determines expiry. */
export async function claimTurn(db: Database, userId: string, id: string, leaseMs: number): Promise<ClaimedTurn | null> {
  uuid(userId); uuid(id); positive(leaseMs, 600_000);
  return withTenantTransaction(db, userId, async (client) => {
    const row = (await client.query<Row>(
      `UPDATE ai_turns SET status = 'running', lease_token = gen_random_uuid(),
       lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
       attempts = attempts + 1, revision = revision + 1, updated_at = clock_timestamp()
       WHERE user_id = $1 AND id = $2 AND status IN ('pending', 'running')
       AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
       AND attempts < max_attempts RETURNING *`, [userId, id, leaseMs])).rows[0];
    return row ? held(row) : null;
  });
}
/** All write operations use the SAME ownership + revision + live lease guard.
 * This fences storage writes only. Durable callers must also pass the trusted
 * CommandBus turn fence and validate persisted intents before resuming tools. */
async function writeHeld(db: Database, userId: string, lease: TurnLease,
  run: (client: TransactionClient) => Promise<Row | undefined>): Promise<Row> {
  uuid(userId); validateLease(lease);
  return withTenantTransaction(db, userId, async (client) => {
    // Lock first so expiry is checked after any contention, not before waiting.
    const row = (await client.query<Row>(
      `SELECT * FROM ai_turns WHERE user_id = $1 AND id = $2 FOR UPDATE`, [userId, lease.id])).rows[0];
    if (!row) throw new TurnStoreError('lost_lease');
    const valid = await client.query(
      `SELECT id FROM ai_turns WHERE user_id = $1 AND id = $2 AND status = 'running'
       AND lease_token = $3 AND revision = $4 AND lease_expires_at > clock_timestamp()`,
      [userId, lease.id, lease.token, lease.revision]);
    if (valid.rowCount !== 1) throw new TurnStoreError('lost_lease');
    const result = await run(client);
    if (!result) throw new TurnStoreError('lost_lease');
    return result;
  });
}
export async function saveTurnCheckpoint(db: Database, userId: string, lease: TurnLease, checkpoint: JsonObject): Promise<ClaimedTurn> {
  const encoded = jsonDocument(checkpoint, 524_288);
  const row = await writeHeld(db, userId, lease, async (client) => (await client.query<Row>(
    `UPDATE ai_turns SET checkpoint = $3::jsonb, revision = revision + 1, updated_at = clock_timestamp()
     WHERE user_id = $1 AND id = $2 RETURNING *`, [userId, lease.id, encoded])).rows[0]);
  return held(row);
}
export async function finishTurn(db: Database, userId: string, lease: TurnLease, finalCheckpoint: JsonObject): Promise<StoredTurn> {
  const encoded = jsonDocument(finalCheckpoint, 524_288);
  return view(await writeHeld(db, userId, lease, async (client) => (await client.query<Row>(
    `UPDATE ai_turns SET checkpoint = $3::jsonb, status = 'finished', lease_token = NULL,
     lease_expires_at = NULL, revision = revision + 1, updated_at = clock_timestamp()
     WHERE user_id = $1 AND id = $2 RETURNING *`, [userId, lease.id, encoded])).rows[0]));
}
export async function renewTurnLease(db: Database, userId: string, lease: TurnLease, leaseMs: number): Promise<ClaimedTurn> {
  positive(leaseMs, 600_000);
  return held(await writeHeld(db, userId, lease, async (client) => (await client.query<Row>(
    `UPDATE ai_turns SET lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
     revision = revision + 1, updated_at = clock_timestamp()
     WHERE user_id = $1 AND id = $2 RETURNING *`, [userId, lease.id, leaseMs])).rows[0]));
}
