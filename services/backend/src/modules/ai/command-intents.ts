import { createHash } from 'node:crypto';
import type { Database, TransactionClient } from '../../shared/db/pool.ts';
import { commandEnvelopeSchema, type CommandEnvelope } from '../../shared/commands/envelope.ts';
import { buildEnvelopeCommand, executeEnvelope, type CommandOutcomeReport } from '../sync/routes.ts';
import { jsonDocument, type JsonObject, type TurnLease } from './turn-store.ts';
import { withTenantTransaction } from '../../shared/db/tenant.ts';
import { createValidator } from '../../shared/schema/validator.ts';
import { userDayAt } from '../../shared/time/user-day.ts';
import { derivedCommandId } from '../../shared/commands/derived-id.ts';
import { lockTurnFence, semanticHash, SEMANTIC_HASH_VERSION } from '../../shared/commands/bus.ts';

export interface IntentSnapshot {
  readonly clock: string;
  readonly localDate: string;
  readonly timezone: string;
  readonly dayBoundaryMinutes: number;
  readonly refs: Readonly<Record<string, { readonly occurrenceId: string; readonly version: number; readonly title: string }>>;
}
export interface IntentInput {
  readonly callId: string;
  readonly envelope: CommandEnvelope;
  readonly snapshot: IntentSnapshot;
  readonly questRef: string | null;
}
export interface PreparedIntent extends IntentInput { readonly step: string; readonly hash: string }
export class CommandIntentError extends Error {
  constructor(readonly code: 'invalid_intent' | 'intent_conflict' | 'intent_not_ready') {
    super(`AI command intent: ${code}`); this.name = 'CommandIntentError';
  }
}
const validator = createValidator();
const validEnvelope = validator.compile(commandEnvelopeSchema);
const validInput = validator.compile({
  type: 'object', additionalProperties: false, required: ['callId', 'envelope', 'snapshot', 'questRef'],
  properties: {
    callId: { type: 'string', minLength: 1, maxLength: 128 }, envelope: { type: 'object' },
    questRef: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^q[1-9][0-9]{0,3}$' }] },
    snapshot: { type: 'object', additionalProperties: false,
      required: ['clock', 'localDate', 'timezone', 'dayBoundaryMinutes', 'refs'], properties: {
        clock: { type: 'string', format: 'date-time' }, localDate: { type: 'string', format: 'date' },
        timezone: { type: 'string', minLength: 1, maxLength: 128 }, dayBoundaryMinutes: { type: 'integer', minimum: 0, maximum: 1439 },
        refs: { type: 'object', maxProperties: 20, propertyNames: { pattern: '^q[1-9][0-9]{0,3}$' }, additionalProperties: {
          type: 'object', additionalProperties: false, required: ['occurrenceId', 'version', 'title'], properties: {
            occurrenceId: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            title: { type: 'string', maxLength: 500 },
          },
        } },
      },
    },
  },
});
interface IntentRow { step: string; intent_hash: string; command_hash: string; command_id: string; hash_version: number; document: IntentInput }
const invalid = (): never => { throw new CommandIntentError('invalid_intent'); };
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function validated(userId: string, turnId: string, input: IntentInput, allowOccurrence = false) {
  try {
    // Copy before awaiting SQL: mutation by the caller cannot change the prepared document.
    const encoded = jsonDocument(input as unknown as JsonObject, 256 * 1024);
    const copy = JSON.parse(encoded) as IntentInput;
    if (!validInput(copy) || !validEnvelope(copy.envelope) || !copy.callId.trim()) invalid();
    const suffix = copy.envelope.kind === 'create_quest_template' ? 'template'
      : copy.envelope.kind === 'complete_quest' ? 'complete'
      : allowOccurrence && copy.envelope.kind === 'materialize_occurrence' ? 'occurrence' : invalid();
    const step = `${copy.callId}:${suffix}`;
    if (copy.envelope.command_id !== derivedCommandId('ai', turnId, step)
      || copy.envelope.device_id !== derivedCommandId('ai', turnId, 'device')) invalid();
    const snap = copy.snapshot;
    if (new Date(snap.clock).toISOString() !== snap.clock || copy.envelope.client_created_at !== snap.clock
      || userDayAt(new Date(snap.clock), snap.timezone, snap.dayBoundaryMinutes).localDate !== snap.localDate) invalid();
    const { command } = buildEnvelopeCommand(userId, copy.envelope);
    if (suffix === 'complete') {
      const ref = copy.questRef === null ? undefined : snap.refs[copy.questRef];
      if (!ref || ref.occurrenceId !== command.targetId || ref.version !== command.expectedVersion) invalid();
    } else if (copy.questRef !== null) invalid();
    if (suffix === 'occurrence' && (copy.envelope.payload['recurrence_key'] !== snap.localDate
      || copy.envelope.payload['timezone'] !== snap.timezone)) invalid();
    return { copy, encoded, step, hash: digest(encoded), commandHash: semanticHash(command) };
  } catch { return invalid(); }
}
function unpack(userId: string, turnId: string, row: IntentRow): PreparedIntent {
  const value = validated(userId, turnId, row.document, true);
  if (value.hash !== row.intent_hash || value.commandHash !== row.command_hash || value.step !== row.step
    || value.copy.envelope.command_id !== row.command_id || row.hash_version !== SEMANTIC_HASH_VERSION) invalid();
  return { ...value.copy, step: value.step, hash: value.hash };
}
async function load(client: TransactionClient, userId: string, turnId: string, step: string): Promise<PreparedIntent | null> {
  const row = (await client.query<IntentRow>('SELECT * FROM ai_command_intents WHERE user_id = $1 AND turn_id = $2 AND step = $3', [userId, turnId, step])).rows[0];
  return row ? unpack(userId, turnId, row) : null;
}
async function persist(client: TransactionClient, userId: string, lease: TurnLease, input: IntentInput, allowOccurrence = false): Promise<PreparedIntent> {
  const value = validated(userId, lease.id, input, allowOccurrence);
  try {
    await client.query(`INSERT INTO ai_command_intents
      (user_id, turn_id, step, command_id, intent_hash, command_hash, hash_version, document, call_id, phase)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) ON CONFLICT (user_id, turn_id, step) DO NOTHING`,
    [userId, lease.id, value.step, value.copy.envelope.command_id, value.hash, value.commandHash, SEMANTIC_HASH_VERSION,
      value.encoded, value.copy.callId, value.step.slice(value.copy.callId.length + 1)]);
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === 'ai_tool_call_identity') throw new CommandIntentError('intent_conflict');
    throw error;
  }
  const stored = await load(client, userId, lease.id, value.step);
  if (!stored || stored.hash !== value.hash) throw new CommandIntentError('intent_conflict');
  return stored;
}
export async function prepareCommandIntent(db: Database, userId: string, lease: TurnLease, input: IntentInput): Promise<PreparedIntent> {
  const copy = validated(userId, lease.id, input).copy;
  return withTenantTransaction(db, userId, async client => {
    await lockTurnFence(client, userId, lease);
    return persist(client, userId, lease, copy);
  });
}
export async function readCommandIntent(db: Database, userId: string, turnId: string, step: string): Promise<PreparedIntent | null> {
  return withTenantTransaction(db, userId, client => load(client, userId, turnId, step));
}
function committedTemplateId(receipt: { result: Record<string, unknown> } | undefined): string {
  if (!receipt || typeof receipt.result['template_id'] !== 'string') throw new CommandIntentError('intent_not_ready');
  return receipt.result['template_id'];
}
export async function prepareQuestOccurrenceIntent(db: Database, userId: string, lease: TurnLease, callId: string): Promise<PreparedIntent> {
  if (typeof callId !== 'string' || !callId.trim() || callId.length > 128 || callId.includes('\0')) invalid();
  return withTenantTransaction(db, userId, async client => {
    await lockTurnFence(client, userId, lease);
    const template = await load(client, userId, lease.id, `${callId}:template`);
    if (!template) throw new CommandIntentError('intent_not_ready');
    const command = buildEnvelopeCommand(userId, template.envelope).command;
    const receipt = (await client.query<{ result: Record<string, unknown> }>(`SELECT result FROM command_receipts
      WHERE user_id = $1 AND command_id = $2 AND kind = 'create_quest_template' AND payload_hash = $3 AND hash_version = $4`,
    [userId, template.envelope.command_id, semanticHash(command), SEMANTIC_HASH_VERSION])).rows[0];
    const templateId = committedTemplateId(receipt);
    const next: IntentInput = { callId, snapshot: template.snapshot, questRef: null, envelope: {
      ...template.envelope, kind: 'materialize_occurrence', command_id: derivedCommandId('ai', lease.id, `${callId}:occurrence`),
      payload: { template_id: templateId, recurrence_key: template.snapshot.localDate, timezone: template.snapshot.timezone },
    } };
    return persist(client, userId, lease, next, true);
  });
}
export async function executePreparedIntent(db: Database, userId: string, lease: TurnLease, step: string): Promise<CommandOutcomeReport> {
  const stored = await readCommandIntent(db, userId, lease.id, step);
  if (!stored) throw new CommandIntentError('intent_not_ready');
  return executeEnvelope(db, userId, stored.envelope, { ...lease, intent: { step: stored.step, hash: stored.hash } });
}
