import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Детерминированный расчёт награды (docs/03, раздел 4).
 *
 * Числа берутся из `packages/rules/progression`, а не из кода: это канонический
 * источник баланса (AGENTS.md), и вторая копия значений разошлась бы с ним
 * незаметно. Менять баланс правкой кода нельзя — тогда прошлые начисления
 * нечем объяснить.
 *
 * Арифметика целочисленная, в milli-XP и на BigInt. Двоичная плавающая точка
 * здесь запрещена не из педантизма: 0.1 + 0.2 ≠ 0.3, а это баланс, который
 * человек зарабатывает месяцами, и расхождение накапливается молча.
 *
 * Модель наград — не утверждение о пользе занятий. Полосы убывающей отдачи
 * ограничивают игровые начисления, а не рекомендуют заниматься четыре часа.
 */

// От src/modules/progression до корня репозитория пять уровней.
const RULES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/rules/progression/progression-v0.1.json',
);

interface Band {
  readonly end_minutes: number | null;
  readonly multiplier: number;
}

interface ProgressionRules {
  readonly version: string;
  readonly milli_xp_per_xp: number;
  readonly levels: {
    readonly lifetime: {
      readonly linear_mxp: number;
      readonly quadratic_mxp: number;
      readonly cubic_mxp: number;
    };
  };
  readonly reward: {
    readonly base_xp_per_minute: number;
    readonly consistency: {
      readonly step: number;
      readonly days_per_step: number;
      readonly max_steps: number;
      readonly window_eligible_days: number;
    };
    readonly family_bands: readonly Band[];
    readonly global_bands: readonly Band[];
    readonly daily_cap_xp: number;
    readonly rolling_24h_cap_xp: number;
    readonly evidence: Record<string, number>;
  };
}

const RULES = JSON.parse(readFileSync(RULES_PATH, 'utf8')) as ProgressionRules;

export function progressionRules(): ProgressionRules {
  return RULES;
}

export const RULE_VERSION = RULES.version;

/** Доля в базисных пунктах: 10000 — единица. Целое, чтобы не было дробей. */
const BASIS = 10_000n;

function toBasisPoints(multiplier: number): bigint {
  const scaled = Math.round(multiplier * 10_000);
  if (!Number.isSafeInteger(scaled) || scaled < 0) {
    throw new Error(`Недопустимый коэффициент в правилах: ${multiplier}`);
  }
  return BigInt(scaled);
}

interface Boundary {
  /** Конец полосы в секундах от начала дня; `null` — без конца. */
  readonly endSeconds: number | null;
  readonly bp: bigint;
}

function toBoundaries(bands: readonly Band[]): Boundary[] {
  return bands.map((band) => ({
    endSeconds: band.end_minutes === null ? null : band.end_minutes * 60,
    bp: toBasisPoints(band.multiplier),
  }));
}

const FAMILY = toBoundaries(RULES.reward.family_bands);
const GLOBAL = toBoundaries(RULES.reward.global_bands);

/** Базовая ставка в milli-XP за минуту: 0.5 XP — это 500. */
const RATE_MXP_PER_MINUTE = BigInt(
  Math.round(RULES.reward.base_xp_per_minute * RULES.milli_xp_per_xp),
);

export const DAILY_CAP_MXP = BigInt(RULES.reward.daily_cap_xp * RULES.milli_xp_per_xp);
export const ROLLING_CAP_MXP = BigInt(RULES.reward.rolling_24h_cap_xp * RULES.milli_xp_per_xp);

/** Множитель доказательства. Выбирается максимум, а не произведение (docs/03). */
export function evidenceBasisPoints(source: string | null): number {
  const table = RULES.reward.evidence;
  const value = Object.prototype.hasOwnProperty.call(table, source ?? 'self')
    ? table[source ?? 'self']
    : table['self'];
  return Math.round((value ?? 1) * 10_000);
}

function bandAt(boundaries: readonly Boundary[], seconds: number): Boundary {
  const found = boundaries.find(
    (band) => band.endSeconds === null || seconds < band.endSeconds,
  );
  if (found === undefined) {
    throw new Error('Полосы не покрывают всю ось времени');
  }
  return found;
}

function nextBoundary(boundaries: readonly Boundary[], seconds: number): number | null {
  return bandAt(boundaries, seconds).endSeconds;
}

export interface AwardInput {
  /** Длительность отрезка в секундах. */
  readonly seconds: number;
  /** Сколько секунд этой же семьи уже засчитано за день, включая неоплаченные. */
  readonly familySecondsBefore: number;
  /** Сколько секунд всех развивающих занятий уже засчитано за день. */
  readonly globalSecondsBefore: number;
  readonly difficultyBp: number;
  readonly qualityBp: number;
  readonly evidenceBp: number;
  readonly consistencyBp: number;
  readonly noveltyBp: number;
}

export interface AwardResult {
  readonly amountMxp: bigint;
  /**
   * Сколько секунд ушло в счётчики. Это вся длительность, включая участок с
   * нулевой ставкой: иначе бесплатные минуты не двигали бы полосу, и после них
   * ставка возвращалась бы к полной.
   */
  readonly countedSeconds: number;
}

/**
 * Награда за один отрезок.
 *
 * Отрезок режется на пересечениях границ обеих полос — семьи и общей за день, —
 * и каждая часть считается своей ставкой. Округление одно, после суммирования:
 * округлять каждую секунду значило бы, что сто записей по минуте выгоднее или
 * невыгоднее одной записи на сто минут, и человек начал бы подстраиваться под
 * арифметику вместо дела.
 */
export function computeAward(input: AwardInput): AwardResult {
  if (!Number.isInteger(input.seconds) || input.seconds < 0) {
    throw new Error(`Длительность должна быть целым числом секунд, получено: ${input.seconds}`);
  }

  let familyAt = input.familySecondsBefore;
  let globalAt = input.globalSecondsBefore;
  let remaining = input.seconds;
  // Сумма произведений «секунды × коэффициент семьи × коэффициент дня».
  let weighted = 0n;

  while (remaining > 0) {
    const familyBand = bandAt(FAMILY, familyAt);
    const globalBand = bandAt(GLOBAL, globalAt);

    const familyEnd = nextBoundary(FAMILY, familyAt);
    const globalEnd = nextBoundary(GLOBAL, globalAt);
    const untilFamily = familyEnd === null ? remaining : familyEnd - familyAt;
    const untilGlobal = globalEnd === null ? remaining : globalEnd - globalAt;
    const chunk = Math.min(remaining, untilFamily, untilGlobal);

    weighted += BigInt(chunk) * familyBand.bp * globalBand.bp;
    familyAt += chunk;
    globalAt += chunk;
    remaining -= chunk;
  }

  const multipliers =
    BigInt(input.difficultyBp) *
    BigInt(input.qualityBp) *
    BigInt(input.evidenceBp) *
    BigInt(input.consistencyBp) *
    BigInt(input.noveltyBp);

  // Знаменатель: 60 секунд в минуте, две полосы и пять коэффициентов — каждый
  // в базисных пунктах. Деление одно, в самом конце, и всегда вниз.
  const denominator = 60n * BASIS * BASIS * BASIS ** 5n;
  const amountMxp = (weighted * RATE_MXP_PER_MINUTE * multipliers) / denominator;

  return { amountMxp, countedSeconds: input.seconds };
}

/** Сколько последних закрытых пригодных дней смотрит постоянство. */
export const CONSISTENCY_WINDOW_DAYS = RULES.reward.consistency.window_eligible_days;

/**
 * Множитель постоянства: `1 + 0.02 × min(4, floor(успешные_дни / 3))`.
 *
 * Считается по закрытым предыдущим дням, а не по текущему: сегодняшнее
 * выполнение не должно поднимать множитель самому себе.
 *
 * Потолок в четыре ступени намеренно низкий — восемь процентов сверху. Это
 * поощрение за регулярность, а не рычаг, ради которого стоит заниматься больным
 * или без сна: система прямо отказывается наказывать за отдых (AGENTS.md), и
 * симметрично не должна делать перерыв дорогим.
 */
export function consistencyBasisPoints(successDays: number): number {
  if (!Number.isInteger(successDays) || successDays < 0) {
    throw new Error(`Число успешных дней должно быть целым неотрицательным: ${successDays}`);
  }
  const rules = RULES.reward.consistency;
  const steps = Math.min(rules.max_steps, Math.floor(successDays / rules.days_per_step));
  return Math.round((1 + rules.step * steps) * 10_000);
}
