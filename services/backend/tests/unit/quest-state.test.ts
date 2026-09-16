import { describe, expect, it } from 'vitest';

import {
  canApply,
  InvalidTransitionError,
  isLivePlacement,
  nextStatus,
  type ExecutionStatus,
  type QuestCommand,
} from '../../src/modules/quests/state.ts';

/**
 * Проверки автомата выполнения. Таблица переходов взята из docs/02, раздел 8,
 * и записана здесь независимо от реализации: она перечисляет, что документ
 * разрешает, а не что делает код.
 */

const ALLOWED: readonly (readonly [ExecutionStatus, QuestCommand, ExecutionStatus])[] = [
  ['planned', 'start_quest', 'active'],
  ['planned', 'complete_quest', 'completed'],
  ['active', 'complete_quest', 'completed'],
  ['partial', 'complete_quest', 'completed'],
  ['planned', 'record_partial', 'partial'],
  ['active', 'record_partial', 'partial'],
  ['planned', 'close_user_day', 'missed'],
  ['active', 'close_user_day', 'missed'],
  ['partial', 'close_user_day', 'partial'],
  ['missed', 'explain_missed', 'excused'],
  ['missed', 'reconcile_late_completion', 'completed'],
  ['planned', 'cancel_quest', 'cancelled'],
  ['active', 'cancel_quest', 'cancelled'],
  ['partial', 'cancel_quest', 'cancelled'],
  ['completed', 'undo_completion', 'planned'],
];

const FORBIDDEN: readonly (readonly [ExecutionStatus, QuestCommand])[] = [
  // Повторное завершение — самый опасный случай: вторая награда за одно дело.
  ['completed', 'complete_quest'],
  ['completed', 'start_quest'],
  ['cancelled', 'start_quest'],
  ['cancelled', 'complete_quest'],
  ['excused', 'complete_quest'],
  ['missed', 'complete_quest'],
  ['missed', 'start_quest'],
  ['planned', 'explain_missed'],
  ['completed', 'close_user_day'],
];

describe('разрешённые переходы', () => {
  it.each(ALLOWED)('%s + %s → %s', (from, command, expected) => {
    expect(nextStatus(from, command)).toBe(expected);
    expect(canApply(from, command)).toBe(true);
  });
});

describe('запрещённые переходы', () => {
  it.each(FORBIDDEN)('%s + %s отклоняется', (from, command) => {
    expect(() => nextStatus(from, command)).toThrow(InvalidTransitionError);
    expect(canApply(from, command)).toBe(false);
  });
});

describe('живое размещение', () => {
  it('перенести можно только незавершённое задание', () => {
    expect(isLivePlacement('planned')).toBe(true);
    expect(isLivePlacement('active')).toBe(true);
    expect(isLivePlacement('partial')).toBe(true);

    // Перенос завершённого или отменённого задания переписал бы историю.
    expect(isLivePlacement('completed')).toBe(false);
    expect(isLivePlacement('missed')).toBe(false);
    expect(isLivePlacement('cancelled')).toBe(false);
    expect(isLivePlacement('excused')).toBe(false);
  });
});

describe('позднее выполнение', () => {
  it('пропущенное задание можно закрыть фактическим выполнением', () => {
    // Синхронизация могла запоздать; действие при этом было (docs/02, раздел 8).
    expect(nextStatus('missed', 'reconcile_late_completion')).toBe('completed');
  });

  it('но обычной командой завершения — нельзя', () => {
    // Иначе пропуск закрывался бы задним числом без пометки о позднем
    // выполнении, и история дня становилась бы недостоверной.
    expect(canApply('missed', 'complete_quest')).toBe(false);
  });
});
