import { describe, expect, it } from 'vitest';

import {
  lifetimeLevel,
  lifetimeProgress,
  lifetimeThresholdMxp,
} from '../../src/modules/progression/levels.ts';

/**
 * Уровни по накопленному XP.
 *
 * Контрольные значения — таблица из `docs/03-progression-engine.md`, раздел 7.
 * Она написана до реализации и здесь не пересчитывалась.
 *
 * Порог ищется целочисленным перебором, а не обращением многочлена в дробных
 * числах: спецификация запрещает это прямо, и не зря — на больших уровнях
 * обратная функция в плавающей точке промахивается на единицу, и человек
 * видит то уровень, то предыдущий, в зависимости от того, как легло
 * округление.
 */

const XP = 1000n;

describe('пороги уровней из спецификации', () => {
  it.each([
    [1, 28_250n],
    [5, 331_250n],
    [10, 1_250n * XP],
    [20, 5_600n * XP],
    [40, 29_600n * XP],
    [60, 84_000n * XP],
    [100, 332_000n * XP],
  ])('уровень %i требует %s milli-XP', (level, expected) => {
    expect(lifetimeThresholdMxp(level)).toBe(expected);
  });

  it('нулевой уровень достаётся даром', () => {
    expect(lifetimeThresholdMxp(0)).toBe(0n);
    expect(lifetimeLevel(0n)).toBe(0);
  });
});

describe('уровень по накопленному', () => {
  it('ровно на пороге уровень уже получен', () => {
    expect(lifetimeLevel(28_250n)).toBe(1);
    expect(lifetimeLevel(1_250n * XP)).toBe(10);
  });

  it('на милли-XP меньше порога уровень прежний', () => {
    // Граница проверяется с обеих сторон: односторонняя проверка пропускает
    // ошибку на единицу, а именно она здесь и вероятна.
    expect(lifetimeLevel(28_249n)).toBe(0);
    expect(lifetimeLevel(1_250n * XP - 1n)).toBe(9);
  });

  it('уровень не ограничен сотней', () => {
    // Сто — символическая отметка, а не потолок: упереться в него человек не
    // должен (docs/03, раздел 7).
    expect(lifetimeLevel(332_000n * XP)).toBe(100);
    expect(lifetimeLevel(10_000_000n * XP)).toBeGreaterThan(100);
  });

  it('отрицательного накопления не бывает', () => {
    // Компенсирующие записи могут увести сумму вниз, но не ниже нуля: иначе
    // уровень стал бы отрицательным, а этого в правилах нет.
    expect(lifetimeLevel(-5n)).toBe(0);
  });
});

describe('продвижение внутри уровня', () => {
  it('на пороге — начало уровня', () => {
    const progress = lifetimeProgress(28_250n);
    expect(progress.level).toBe(1);
    expect(progress.intoMxp).toBe(0n);
    expect(progress.spanMxp).toBe(lifetimeThresholdMxp(2) - lifetimeThresholdMxp(1));
  });

  it('середина уровня считается от порога, а не от нуля', () => {
    // Иначе продвижение на сороковом уровне выглядело бы как 99 процентов
    // вечно, и полоска перестала бы что-либо значить.
    const first = lifetimeThresholdMxp(40);
    const second = lifetimeThresholdMxp(41);
    const progress = lifetimeProgress(first + (second - first) / 2n);
    expect(progress.level).toBe(40);
    expect(progress.intoMxp * 2n).toBeLessThanOrEqual(progress.spanMxp + 1n);
  });

  it('следующий порог всегда дальше текущего', () => {
    for (const level of [0, 1, 5, 20, 99]) {
      expect(lifetimeThresholdMxp(level + 1)).toBeGreaterThan(lifetimeThresholdMxp(level));
    }
  });
});
