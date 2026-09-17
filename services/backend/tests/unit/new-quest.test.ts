import { describe, expect, it } from 'vitest';

import { parseNewQuest } from '../../src/modules/telegram/new-quest.ts';

/**
 * Разбор строки `/new` (T-02d).
 *
 * Формат намеренно однострочный: диалог в несколько шагов требует хранить
 * состояние разговора, а это отдельная машинка со своими ошибками. Для первого
 * способа создать задание честнее без неё.
 *
 * Мера — последнее слово строки. Всё до неё — название, как человек его
 * написал: угадывать за него нельзя.
 */

describe('мера времени', () => {
  const cases: readonly [string, number][] = [
    ['/new Английский 30м', 1800],
    ['/new Английский 30мин', 1800],
    ['/new Английский 1ч', 3600],
    ['/new Английский 1ч30м', 5400],
    ['/new Английский 45m', 2700],
    ['/new Английский 2h', 7200],
  ];

  for (const [line, seconds] of cases) {
    it(line, () => {
      const parsed = parseNewQuest(line);

      expect(parsed).toMatchObject({
        ok: true,
        title: 'Английский',
        spec: { success_rule: 'duration', unit: 'seconds', duration_seconds: seconds },
      });
    });
  }
});

describe('мера объёма', () => {
  it('километры', () => {
    const parsed = parseNewQuest('/new Бег 5км');

    expect(parsed).toMatchObject({
      ok: true,
      title: 'Бег',
      spec: { success_rule: 'amount', unit: 'км', amount: 5 },
    });
  });

  it('дробное значение', () => {
    expect(parseNewQuest('/new Бег 7.5км')).toMatchObject({
      ok: true,
      spec: { amount: 7.5, unit: 'км' },
    });
  });

  it('единица на латинице', () => {
    expect(parseNewQuest('/new Чтение 20pages')).toMatchObject({
      ok: true,
      spec: { success_rule: 'amount', unit: 'pages', amount: 20 },
    });
  });
});

describe('название', () => {
  it('сохраняется целиком, как написал человек', () => {
    const parsed = parseNewQuest('/new Английский по 30 минут каждый день 30м');

    // Обрезать или переписывать название нельзя: это его слова, и он будет
    // искать их глазами в списке.
    expect(parsed).toMatchObject({ ok: true, title: 'Английский по 30 минут каждый день' });
  });

  it('лишние пробелы не ломают разбор', () => {
    expect(parseNewQuest('/new   Бег    5км  ')).toMatchObject({ ok: true, title: 'Бег' });
  });
});

describe('отказы', () => {
  it('без названия и меры', () => {
    const parsed = parseNewQuest('/new');

    expect(parsed.ok).toBe(false);
    // Отказ обязан показать пример: «неверный формат» без образца ничему не
    // учит.
    expect(parsed.ok === false && parsed.hint).toContain('/new');
  });

  it('только название без меры', () => {
    expect(parseNewQuest('/new Английский').ok).toBe(false);
  });

  it('мера без числа', () => {
    expect(parseNewQuest('/new Английский минут').ok).toBe(false);
  });

  it('нулевая мера', () => {
    // Задание на ноль минут выполнено с самого начала.
    expect(parseNewQuest('/new Английский 0м').ok).toBe(false);
  });

  it('неправдоподобно большая мера', () => {
    // Сутки в задании — почти наверняка опечатка, а не намерение.
    expect(parseNewQuest('/new Английский 100ч').ok).toBe(false);
  });

  it('слишком длинное название', () => {
    expect(parseNewQuest(`/new ${'а'.repeat(300)} 30м`).ok).toBe(false);
  });
});
