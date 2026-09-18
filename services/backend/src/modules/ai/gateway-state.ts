import type { CommandReceiptSummary } from './gateway.ts';
import { createValidator } from '../../shared/schema/validator.ts';
import { jsonDocument, type JsonObject } from './turn-store.ts';
export interface GatewayState {
  readonly refs: Readonly<Record<string, { readonly occurrenceId: string; readonly title: string; readonly version: number }>>;
  readonly receipts: readonly CommandReceiptSummary[];
  readonly calls: number;
  readonly mutations: number;
}
export const receiptSchema = {
  type: 'object', additionalProperties: false, required: ['tool', 'status'], properties: {
    tool: { type: 'string', maxLength: 128 }, status: { enum: ['committed', 'already_applied'] },
    title: { type: 'string', maxLength: 500 }, occurrenceId: { type: 'string', format: 'uuid' },
    executionStatus: { type: 'string', maxLength: 32 }, committedSeq: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
  },
};
export const gatewayStateSchema = {
  type: 'object', additionalProperties: false, required: ['refs', 'receipts', 'calls', 'mutations'], properties: {
    calls: { type: 'integer', minimum: 0, maximum: 64 }, mutations: { type: 'integer', minimum: 0, maximum: 64 },
    receipts: { type: 'array', maxItems: 64, items: receiptSchema },
    refs: { type: 'object', maxProperties: 1280, propertyNames: { pattern: '^q[1-9][0-9]{0,3}$' }, additionalProperties: {
      type: 'object', additionalProperties: false, required: ['occurrenceId', 'title', 'version'], properties: {
        occurrenceId: { type: 'string', format: 'uuid' }, title: { type: 'string', maxLength: 500 },
        version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    } },
  },
};
const valid = createValidator().compile(gatewayStateSchema);
export class GatewayStateError extends Error { constructor() { super('Invalid AI gateway state'); this.name = 'GatewayStateError'; } }
export function parseGatewayState(value: unknown): GatewayState {
  try {
    const state = JSON.parse(jsonDocument(value as JsonObject, 524_288)) as GatewayState;
    if (!valid(state) || state.mutations > state.calls || state.receipts.length > state.mutations) throw new GatewayStateError();
    const refs = Object.keys(state.refs);
    if (refs.some((_, index) => !Object.hasOwn(state.refs, `q${index + 1}`))
      || new Set(Object.values(state.refs).map(ref => ref.occurrenceId)).size !== refs.length) throw new GatewayStateError();
    return state;
  } catch { throw new GatewayStateError(); }
}
