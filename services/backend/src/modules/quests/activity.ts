import type { TransactionClient } from '../../shared/db/pool.ts';
import { InvalidCommandPayloadError } from '../goals/commands.ts';

/**
 * Факт выполнения.
 *
 * Завершение, хранящее только статус, не отличается от нажатия кнопки: через
 * неделю восстановить, сколько было на самом деле, неоткуда, а награда
 * считалась бы по запланированному объёму — по намерению, а не по факту
 * (остаток P1-06, R6 в docs/15-backend-review.md).
 *
 * Главное правило: неизвестный объём остаётся неизвестным. Подстановка
 * запланированного значения — не разумное умолчание, а выдумка, которую потом
 * не отличить от измерения.
 */

export type Measure = 'duration' | 'amount';
export type ActivityVariant = 'normal' | 'minimum' | 'partial';

export interface EffortSpec {
  readonly success_rule: Measure;
  readonly unit: string;
  readonly duration_seconds?: number;
  readonly amount?: number;
}

export interface ActivityFact {
  readonly occurredStart: Date | null;
  readonly occurredEnd: Date | null;
  readonly durationSeconds: number | null;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly measurement: 'measured' | 'unknown';
  readonly source: string;
}

/** Значение, которое сравнивается с критерием успеха, в мере спецификации. */
function targetOf(spec: EffortSpec | null | undefined): number | null {
  if (spec === null || spec === undefined) {
    return null;
  }
  const value = spec.success_rule === 'duration' ? spec.duration_seconds : spec.amount;
  return typeof value === 'number' ? value : null;
}

function parseInstant(payload: Record<string, unknown>, key: string): Date | null {
  const value = payload[key];
  if (value === undefined) {
    return null;
  }
  // Форму строки уже проверила закрытая схема нагрузки; здесь остаётся
  // убедиться, что дата разбирается.
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidCommandPayloadError(`${key} не разбирается как момент времени`);
  }
  return parsed;
}

/**
 * Разбор присланного факта в мере спецификации.
 *
 * Мера одна: у спецификации с правилом `duration` критерий — длительность, с
 * правилом `amount` — объём. Присланное в другой мере сравнить с критерием
 * нечем, поэтому оно отклоняется, а не игнорируется: молча отброшенное
 * измерение человек считает записанным.
 */
export function parseActivityFact(
  payload: Record<string, unknown>,
  normalSpec: EffortSpec,
): ActivityFact {
  const occurredStart = parseInstant(payload, 'occurred_start');
  const occurredEnd = parseInstant(payload, 'occurred_end');
  if (occurredStart !== null && occurredEnd !== null && occurredEnd < occurredStart) {
    throw new InvalidCommandPayloadError('occurred_end раньше occurred_start');
  }

  const sentDuration = payload['actual_duration_seconds'];
  const sentAmount = payload['actual_amount'];
  const measure = normalSpec.success_rule;

  if (measure === 'duration' && sentAmount !== undefined) {
    throw new InvalidCommandPayloadError('Задание меряется длительностью, а прислан объём');
  }
  if (measure === 'amount' && sentDuration !== undefined) {
    throw new InvalidCommandPayloadError('Задание меряется объёмом, а прислана длительность');
  }

  // Длительность из измеренного отрезка — не выдумка, а его следствие: отрезок
  // измерен, значит измерена и длительность.
  const derivedDuration =
    occurredStart !== null && occurredEnd !== null
      ? Math.round((occurredEnd.getTime() - occurredStart.getTime()) / 1000)
      : null;

  const criterion =
    measure === 'duration'
      ? typeof sentDuration === 'number'
        ? sentDuration
        : derivedDuration
      : typeof sentAmount === 'number'
        ? sentAmount
        : null;

  const source = typeof payload['source'] === 'string' ? payload['source'] : 'self';

  if (criterion === null) {
    // Ни объёма, ни длительности. Отрезок времени, если он есть, сохраняется:
    // он сам по себе факт, но критерий по нему не проверить.
    return {
      occurredStart,
      occurredEnd,
      durationSeconds: null,
      amount: null,
      unit: null,
      measurement: 'unknown',
      source,
    };
  }

  return {
    occurredStart,
    occurredEnd,
    durationSeconds: measure === 'duration' ? criterion : null,
    amount: measure === 'amount' ? criterion : null,
    unit: normalSpec.unit,
    measurement: 'measured',
    source,
  };
}

/** Измеренное значение в мере спецификации; null, если объём неизвестен. */
export function criterionValue(fact: ActivityFact, measure: Measure): number | null {
  return measure === 'duration' ? fact.durationSeconds : fact.amount;
}

/**
 * Согласование факта с вариантом выполнения.
 *
 * Молча повысить или понизить вариант нельзя: понижение обкрадывает человека,
 * повышение подменяет его решение. Поэтому противоречие — отказ с объяснением,
 * а не тихая правка.
 */
export function assertFactMatchesVariant(
  fact: ActivityFact,
  variant: ActivityVariant,
  normalSpec: EffortSpec,
  minimumSpec: EffortSpec | null,
): void {
  const measured = criterionValue(fact, normalSpec.success_rule);
  const normalTarget = targetOf(normalSpec);

  if (variant === 'partial') {
    if (measured === null) {
      throw new InvalidCommandPayloadError(
        'Частичное выполнение без объёма не отличить от невыполнения',
      );
    }
    if (measured <= 0) {
      throw new InvalidCommandPayloadError('Частичное выполнение требует объёма больше нуля');
    }
    if (normalTarget !== null && measured >= normalTarget) {
      throw new InvalidCommandPayloadError('Объём достигает нормы: это полное выполнение');
    }
    return;
  }

  const minimumTarget = targetOf(minimumSpec);
  // Наличие принятой спецификации минимума проверяется раньше объёма и
  // независимо от него: без неё «минимальное выполнение» ничем не ограничено,
  // и меньшая награда выдавалась бы за невыясненный объём
  // (R6 в docs/15-backend-review.md).
  if (variant === 'minimum' && minimumTarget === null) {
    throw new InvalidCommandPayloadError(
      'У задания нет принятой спецификации минимума: завершить минимумом нельзя',
    );
  }

  if (measured === null || normalTarget === null) {
    // Объём неизвестен — сравнивать не с чем. Отметка принимается как
    // неизмеренная и такой и останется.
    return;
  }

  if (variant === 'normal') {
    if (measured < normalTarget) {
      throw new InvalidCommandPayloadError(
        'Объём ниже нормы: это частичное выполнение или минимум',
      );
    }
    return;
  }

  if (minimumTarget === null || measured < minimumTarget) {
    throw new InvalidCommandPayloadError('Объём ниже принятого минимума');
  }
  if (measured >= normalTarget) {
    throw new InvalidCommandPayloadError('Норма выполнена: это полное выполнение, а не минимум');
  }
}

export interface StoredActivity {
  readonly id: string;
  readonly rootActivityId: string;
}

/**
 * Запись факта.
 *
 * Прежний принятый факт того же задания заменяется, а не дополняется: два
 * принятых факта — это две награды за одно действие. Корень при этом
 * сохраняется, поэтому уточнение остаётся тем же действием, а не становится
 * вторым (docs/02, раздел 5). Прежняя запись не стирается: история выполнения
 * должна быть видна.
 */
export async function recordActivity(
  client: TransactionClient,
  userId: string,
  occurrenceId: string,
  fact: ActivityFact,
  variant: ActivityVariant,
): Promise<StoredActivity> {
  const existing = await client.query<{ id: string; root_activity_id: string }>(
    `SELECT id, root_activity_id FROM activity_records
      WHERE occurrence_id = $1 AND state = 'accepted' FOR UPDATE`,
    [occurrenceId],
  );
  const prior = existing.rows[0];

  if (prior !== undefined) {
    await client.query(
      `UPDATE activity_records SET state = 'superseded', updated_at = now() WHERE id = $1`,
      [prior.id],
    );
  }

  // Идентификатор выдаётся в том же запросе, чтобы первый факт стал
  // собственным корнем: иначе потребовалась бы вторая запись сразу после
  // вставки, и между ними корень был бы пустым.
  const inserted = await client.query<{ id: string; root_activity_id: string }>(
    `WITH fresh AS (SELECT gen_random_uuid() AS id)
     INSERT INTO activity_records
       (id, user_id, occurrence_id, root_activity_id, replaces_id, occurred_start, occurred_end,
        duration_seconds, amount, unit, measurement, source, variant)
     SELECT fresh.id, $1, $2, COALESCE($3::uuid, fresh.id), $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12
       FROM fresh
     RETURNING id, root_activity_id`,
    [
      userId,
      occurrenceId,
      prior?.root_activity_id ?? null,
      prior?.id ?? null,
      fact.occurredStart,
      fact.occurredEnd,
      fact.durationSeconds,
      fact.amount,
      fact.unit,
      fact.measurement,
      fact.source,
      variant,
    ],
  );

  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('Факт выполнения не записан');
  }
  return { id: row.id, rootActivityId: row.root_activity_id };
}

/** Принятый факт задания; нужен для исправления. */
export async function findAcceptedActivity(
  client: TransactionClient,
  occurrenceId: string,
): Promise<{ id: string; variant: ActivityVariant } | undefined> {
  const found = await client.query<{ id: string; variant: ActivityVariant }>(
    `SELECT id, variant FROM activity_records WHERE occurrence_id = $1 AND state = 'accepted'`,
    [occurrenceId],
  );
  return found.rows[0];
}
