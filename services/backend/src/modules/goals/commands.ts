import type { CommandContext, CommandOutcome } from '../../shared/commands/bus.ts';

/**
 * Команда создания цели. Первая настоящая команда шины: на ней проверяется
 * «один эффект на одну команду». Остальные команды целей появляются в P1-05.
 */

export interface CreateGoalPayload {
  readonly goal_id?: string;
  readonly title: string;
  readonly start_date: string;
  readonly why?: string;
  readonly target_date?: string;
}

export class InvalidCommandPayloadError extends Error {}

export function parseCreateGoalPayload(payload: Record<string, unknown>): CreateGoalPayload {
  const title = payload['title'];
  const startDate = payload['start_date'];

  if (typeof title !== 'string' || title.trim() === '') {
    throw new InvalidCommandPayloadError('title обязателен');
  }
  if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    // Дата цели — календарная, а не мгновение: у неё нет часового пояса, и
    // приводить её к timestamp нельзя (docs/02, раздел 1).
    throw new InvalidCommandPayloadError('start_date должен быть датой вида ГГГГ-ММ-ДД');
  }

  const goalId = payload['goal_id'];
  const why = payload['why'];
  const targetDate = payload['target_date'];

  return {
    ...(typeof goalId === 'string' ? { goal_id: goalId } : {}),
    title,
    start_date: startDate,
    ...(typeof why === 'string' ? { why } : {}),
    ...(typeof targetDate === 'string' ? { target_date: targetDate } : {}),
  };
}

export function createGoalHandler(payload: CreateGoalPayload) {
  return async (context: CommandContext): Promise<CommandOutcome> => {
    const inserted = await context.client.query<{ id: string; version: string }>(
      `INSERT INTO goals (id, user_id, title, why, start_date, target_date)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5::date, $6::date)
       RETURNING id, version`,
      [
        payload.goal_id ?? null,
        context.userId,
        payload.title,
        payload.why ?? null,
        payload.start_date,
        payload.target_date ?? null,
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('Цель не создана');
    }

    return {
      result: { goal_id: row.id, version: row.version },
      changes: [{ entity: 'goal', id: row.id, operation: 'created', version: row.version }],
      // В событие кладутся ссылки, а не содержание цели: полный текст в
      // очереди заданий не нужен и не должен там оседать (docs/01, раздел 6).
      events: [{ kind: 'goal_created', payload: { goal_id: row.id } }],
    };
  };
}
