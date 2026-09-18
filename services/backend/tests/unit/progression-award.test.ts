import { describe, expect, it } from 'vitest';

import {
  computeAward,
  progressionRules,
  RULE_VERSION,
  type AwardInput,
} from '../../src/modules/progression/engine.ts';

/**
 * Расчёт награды.
 *
 * Контрольные значения взяты из таблицы примеров `docs/03-progression-engine.md`,
 * раздел 4. Она написана до реализации и здесь не пересчитывалась: замер,
 * сделанный после того, как увидены ответы, измеряет память, а не правильность
 * (AGENTS.md).
 *
 * XP хранится в целых milli-XP. Двоичная плавающая точка здесь запрещена: она
 * даёт 0.1 + 0.2 ≠ 0.3, а это баланс, который человек зарабатывает месяцами.
 */

const HOUR = 3600;
const MINUTE = 60;

function award(input: Partial<AwardInput> & Pick<AwardInput, 'seconds'>): bigint {
  return computeAward({
    familySecondsBefore: 0,
    globalSecondsBefore: 0,
    difficultyBp: 10000,
    qualityBp: 10000,
    evidenceBp: 10000,
    consistencyBp: 10000,
    noveltyBp: 10000,
    ...input,
  }).amountMxp;
}

describe('контрольные примеры из спецификации', () => {
  it('45 минут, сложность C, самоотчёт — 22.500 XP', () => {
    expect(award({ seconds: 45 * MINUTE })).toBe(22_500n);
  });

  it('минимум 15 минут вместо 45 — 7.500 XP', () => {
    // Штраф за неполное выполнение уже заложен в длительность: второй раз
    // наказывать за неё запрещено (docs/03, раздел 4).
    expect(award({ seconds: 15 * MINUTE })).toBe(7_500n);
  });

  it('45 минут, сложность B, таймер — 27.540 XP', () => {
    expect(award({ seconds: 45 * MINUTE, difficultyBp: 12000, evidenceBp: 10200 })).toBe(27_540n);
  });

  it('90 минут одной семьи — 37.500 XP', () => {
    // После шестидесятой минуты той же семьи минута стоит вдвое меньше.
    expect(award({ seconds: 90 * MINUTE })).toBe(37_500n);
  });

  it('180 минут одной семьи — 48.750 XP', () => {
    // Здесь работают обе полосы сразу: третий час режется и по семье, и по
    // общему дневному счётчику.
    expect(award({ seconds: 180 * MINUTE })).toBe(48_750n);
  });

  it('сто отрезков по минуте одной семьи — 40.000 XP', () => {
    // Дробление не должно быть выгоднее одного отрезка: счётчик накапливается
    // между записями, а округление идёт после суммирования.
    let total = 0n;
    let familySeconds = 0;
    let globalSeconds = 0;
    for (let i = 0; i < 100; i += 1) {
      total += award({ seconds: MINUTE, familySecondsBefore: familySeconds, globalSecondsBefore: globalSeconds });
      familySeconds += MINUTE;
      globalSeconds += MINUTE;
    }
    expect(total).toBe(40_000n);
  });
});

describe('полосы убывающей отдачи', () => {
  it('минуты сверх трёх часов одной семьи не стоят ничего', () => {
    expect(award({ seconds: 30 * MINUTE, familySecondsBefore: 180 * MINUTE, globalSecondsBefore: 180 * MINUTE })).toBe(0n);
  });

  it('минуты сверх четырёх часов за день не стоят ничего даже в новой семье', () => {
    // Иначе дневной предел обходится заведением нового задания.
    expect(award({ seconds: 30 * MINUTE, familySecondsBefore: 0, globalSecondsBefore: 240 * MINUTE })).toBe(0n);
  });

  it('отрезок, пересекающий границу полосы, режется по ней', () => {
    // 50 минут при 40 уже пройденных: двадцать минут до границы шестидесяти
    // по полной ставке, оставшиеся тридцать — по половинной.
    const split = award({ seconds: 50 * MINUTE, familySecondsBefore: 40 * MINUTE, globalSecondsBefore: 40 * MINUTE });
    expect(split).toBe(20n * 500n + 30n * 250n);
  });

  it('счётчик учитывает и неоплаченные минуты', () => {
    // «Счётчики учитывают суммарные допустимые минуты, включая участок с
    // нулевым XP» — иначе бесплатные минуты не двигали бы полосу, и после них
    // ставка возвращалась бы к полной.
    const result = computeAward({
      seconds: 30 * MINUTE,
      familySecondsBefore: 200 * MINUTE,
      globalSecondsBefore: 200 * MINUTE,
      difficultyBp: 10000,
      qualityBp: 10000,
      evidenceBp: 10000,
      consistencyBp: 10000,
      noveltyBp: 10000,
    });
    expect(result.amountMxp).toBe(0n);
    expect(result.countedSeconds).toBe(30 * MINUTE);
  });
});

describe('арифметика', () => {
  it('результат целый в milli-XP и округляется вниз', () => {
    // 1 секунда по базовой ставке — 8.333... milli-XP.
    expect(award({ seconds: 1 })).toBe(8n);
  });

  it('нулевая длительность не даёт награды', () => {
    expect(award({ seconds: 0 })).toBe(0n);
  });

  it('версия правил названа и совпадает с файлом правил', () => {
    // Версия пишется в каждую строку ledger: без неё нельзя объяснить, по каким
    // правилам начислено полгода назад.
    expect(RULE_VERSION).toBe(progressionRules().version);
    expect(RULE_VERSION).toMatch(/^progression-/);
  });

  it('час ровно по базовой ставке — 30.000 XP', () => {
    expect(award({ seconds: HOUR })).toBe(30_000n);
  });
});
