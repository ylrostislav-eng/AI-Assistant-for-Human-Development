import { it, expect } from 'vitest';
import { parseGatewayState, type GatewayState } from '../../src/modules/ai/gateway-state.ts';
const id = '11111111-1111-4111-8111-111111111111';
const state: GatewayState = { refs: { q1: { occurrenceId: id, title: 'Synthetic', version: 1 } }, calls: 2, mutations: 1,
  receipts: [{ tool: 'complete_quest', status: 'committed', occurrenceId: id, committedSeq: '1' }] };
const caught = (value: unknown) => { try { return parseGatewayState(value); } catch (error) { return error; } };
it('gateway state copies data instead of sharing mutable refs', () => {
  const copy = parseGatewayState(state); expect(copy).toEqual(state); expect(copy).not.toBe(state); expect(copy.refs['q1']).not.toBe(state.refs['q1']);
});
it('gateway rejects duplicated occurrence identity under different refs', () => {
  expect((caught({ ...state, refs: { ...state.refs, q2: state.refs['q1'] } }) as Error).name).toBe('GatewayStateError');
});
it('gateway rejects gaps in reference numbers', () => {
  expect((caught({ ...state, refs: { q2: state.refs['q1'] } }) as Error).name).toBe('GatewayStateError');
});
it('gateway rejects receipt and mutation counter inconsistencies', () => {
  for (const value of [{ ...state, mutations: 3 }, { ...state, mutations: 0 }]) expect((caught(value) as Error).name).toBe('GatewayStateError');
});
it('gateway rejects closed schema violations and unsafe versions without private values', () => {
  for (const value of [{ ...state, PRIVATE_EXTRA: 'PRIVATE_VALUE' }, { ...state, refs: { q1: { ...state.refs['q1'], version: Number.MAX_SAFE_INTEGER + 1 } } }]) {
    const error = caught(value) as Error; expect(error.name).toBe('GatewayStateError'); expect(String(error)).not.toContain('PRIVATE_VALUE');
  }
});
