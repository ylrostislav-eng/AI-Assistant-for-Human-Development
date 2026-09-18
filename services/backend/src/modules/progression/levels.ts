import { progressionRules } from './engine.ts';

/**
 * Уровни по накопленному Lifetime XP (docs/03, раздел 7).
 *
 * Кривая намеренно медленная: сотый уровень при абсолютном дневном пределе
 * требует около пяти лет непрерывного максимума. Это не «здоровая норма», а
 * математическая нижняя граница — уровень должен значить время жизни, а не
 * удачную неделю.
 *
 * Порог ищется целочисленным перебором, а не обращением многочлена в дробных
 * числах: спецификация запрещает это прямо. На больших уровнях обратная
 * функция в плавающей точке промахивается на единицу, и человек видит то
 * уровень, то предыдущий, в зависимости от того, как легло округление.
 */

const RULES = progressionRules().levels.lifetime;

const LINEAR = BigInt(RULES.linear_mxp);
const QUADRATIC = BigInt(RULES.quadratic_mxp);
const CUBIC = BigInt(RULES.cubic_mxp);

/** Сколько milli-XP нужно накопить, чтобы получить уровень целиком. */
export function lifetimeThresholdMxp(level: number): bigint {
  if (!Number.isInteger(level) || level < 0) {
    throw new Error(`Уровень должен быть целым неотрицательным, получено: ${level}`);
  }
  const l = BigInt(level);
  return LINEAR * l + QUADRATIC * l * l + CUBIC * l * l * l;
}

/**
 * Уровень по накопленному.
 *
 * Верхняя граница поиска находится удвоением: потолка у уровня нет, сто — лишь
 * символическая отметка, и зашитый предел однажды упёрся бы в человека.
 */
export function lifetimeLevel(totalMxp: bigint): number {
  if (totalMxp <= 0n) {
    // Компенсирующие записи могут увести сумму вниз. Отрицательного уровня в
    // правилах нет, и придумывать его здесь нельзя.
    return 0;
  }

  let high = 1;
  while (lifetimeThresholdMxp(high) <= totalMxp) {
    high *= 2;
  }

  // Деление целочисленное. Первая версия делила как есть, и при сумме ниже
  // первого порога граница не удваивалась ни разу: уровень выходил дробным,
  // 0.5. Проверка границы с обеих сторон это и поймала.
  let low = Math.floor(high / 2);
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lifetimeThresholdMxp(middle) <= totalMxp) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

export interface LevelProgress {
  readonly level: number;
  /** Сколько milli-XP набрано внутри текущего уровня. */
  readonly intoMxp: bigint;
  /** Сколько milli-XP занимает текущий уровень целиком. */
  readonly spanMxp: bigint;
}

export function lifetimeProgress(totalMxp: bigint): LevelProgress {
  const level = lifetimeLevel(totalMxp);
  const current = lifetimeThresholdMxp(level);
  const next = lifetimeThresholdMxp(level + 1);
  const into = totalMxp > current ? totalMxp - current : 0n;
  return { level, intoMxp: into, spanMxp: next - current };
}
