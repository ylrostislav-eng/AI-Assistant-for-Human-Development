/**
 * Автомат выполнения задания (docs/02, раздел 8).
 *
 * Две оси состояния разделены намеренно: перенос меняет размещение и не
 * трогает выполнение, иначе перенесённая задача выглядела бы пропущенной.
 *
 * Переходы перечислены явно, а не выводятся из «разрешено всё, кроме». Список
 * запретов молчаливо разрешает новое состояние, добавленное позже, и ошибка
 * обнаруживается на данных.
 */

export type ExecutionStatus =
  | 'planned'
  | 'active'
  | 'partial'
  | 'completed'
  | 'missed'
  | 'excused'
  | 'cancelled';

export type QuestCommand =
  | 'start_quest'
  | 'complete_quest'
  | 'record_partial'
  | 'close_user_day'
  | 'explain_missed'
  | 'reconcile_late_completion'
  | 'cancel_quest'
  | 'undo_completion';

export type CompletionVariant = 'normal' | 'minimum';

interface Transition {
  readonly command: QuestCommand;
  readonly from: readonly ExecutionStatus[];
  readonly to: ExecutionStatus;
}

const TRANSITIONS: readonly Transition[] = [
  { command: 'start_quest', from: ['planned'], to: 'active' },
  { command: 'complete_quest', from: ['planned', 'active', 'partial'], to: 'completed' },
  { command: 'record_partial', from: ['planned', 'active', 'partial'], to: 'partial' },
  { command: 'close_user_day', from: ['planned', 'active'], to: 'missed' },
  { command: 'close_user_day', from: ['partial'], to: 'partial' },
  { command: 'explain_missed', from: ['missed'], to: 'excused' },
  // Позднее выполнение: действие было, синхронизация запоздала.
  { command: 'reconcile_late_completion', from: ['missed'], to: 'completed' },
  { command: 'cancel_quest', from: ['planned', 'active', 'partial'], to: 'cancelled' },
  // Отмена выполнения — отдельная команда с компенсирующими записями,
  // а не обычный переход назад.
  { command: 'undo_completion', from: ['completed'], to: 'planned' },
];

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ExecutionStatus,
    readonly command: QuestCommand,
  ) {
    super(`Команда ${command} недопустима в состоянии ${from}`);
  }
}

export function nextStatus(from: ExecutionStatus, command: QuestCommand): ExecutionStatus {
  const transition = TRANSITIONS.find(
    (candidate) => candidate.command === command && candidate.from.includes(from),
  );
  if (transition === undefined) {
    throw new InvalidTransitionError(from, command);
  }
  return transition.to;
}

export function canApply(from: ExecutionStatus, command: QuestCommand): boolean {
  return TRANSITIONS.some(
    (candidate) => candidate.command === command && candidate.from.includes(from),
  );
}

export function isCompletionVariant(value: unknown): value is CompletionVariant {
  return value === 'normal' || value === 'minimum';
}

/** Состояния, в которых задание ещё живо и его размещение можно менять. */
export function isLivePlacement(status: ExecutionStatus): boolean {
  return status === 'planned' || status === 'active' || status === 'partial';
}
