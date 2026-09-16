import { describe, expect, it } from 'vitest';

import {
  InvalidBoundaryError,
  instantFromWallTime,
  nextBoundaryAfter,
  userDayAt,
  userDayLengthMinutes,
  wallTimeAt,
} from '../../src/shared/time/user-day.ts';

/**
 * Проверки пользовательского дня.
 *
 * Контрольные случаи выбраны заранее по docs/04, раздел 2, а не подогнаны под
 * реализацию: сутки перехода на летнее время, граница внутри разрыва,
 * повторяющееся локальное время, пояс с некруглым смещением.
 */

const BERLIN = 'Europe/Berlin';
const MOSCOW = 'Europe/Moscow';
const KATHMANDU = 'Asia/Kathmandu';

// Переходы 2026 года в Берлине: 29 марта часы идут 02:00 → 03:00,
// 25 октября 03:00 → 02:00.
const SPRING_FORWARD = '2026-03-29';
const FALL_BACK = '2026-10-25';

describe('граница дня', () => {
  it('час ночи относится к предыдущему дню при границе 04:00', () => {
    const day = userDayAt(new Date('2026-09-16T00:30:00+03:00'), MOSCOW, 240);

    expect(day.localDate).toBe('2026-09-15');
  });

  it('мгновение ровно на границе принадлежит новому дню', () => {
    const boundary = new Date('2026-09-16T04:00:00+03:00');
    const day = userDayAt(boundary, MOSCOW, 240);

    // Интервал полуоткрытый: иначе мгновение попало бы в оба дня.
    expect(day.localDate).toBe('2026-09-16');
    expect(day.startsAt.getTime()).toBe(boundary.getTime());
  });

  it('мгновение на миллисекунду раньше границы принадлежит прошлому дню', () => {
    const day = userDayAt(new Date('2026-09-16T03:59:59.999+03:00'), MOSCOW, 240);

    expect(day.localDate).toBe('2026-09-15');
  });

  it('обычные сутки длятся 1440 минут', () => {
    const day = userDayAt(new Date('2026-09-16T12:00:00+03:00'), MOSCOW, 240);

    expect(userDayLengthMinutes(day)).toBe(1440);
  });

  it('граница вне диапазона отклоняется', () => {
    expect(() => userDayAt(new Date(), MOSCOW, 1440)).toThrow(InvalidBoundaryError);
    expect(() => userDayAt(new Date(), MOSCOW, -1)).toThrow(InvalidBoundaryError);
  });
});

describe('переход на летнее время', () => {
  it('сутки весеннего перехода короче на час', () => {
    const day = userDayAt(new Date(`${SPRING_FORWARD}T12:00:00+02:00`), BERLIN, 0);

    expect(day.localDate).toBe(SPRING_FORWARD);
    // Прибавление 86400 секунд дало бы 1440 и увело бы конец дня на час вперёд.
    expect(userDayLengthMinutes(day)).toBe(1380);
  });

  it('сутки осеннего перехода длиннее на час', () => {
    const day = userDayAt(new Date(`${FALL_BACK}T12:00:00+01:00`), BERLIN, 0);

    expect(day.localDate).toBe(FALL_BACK);
    expect(userDayLengthMinutes(day)).toBe(1500);
  });

  it('дни идут встык без пропусков и наложений через переход', () => {
    const before = userDayAt(new Date('2026-03-28T12:00:00+01:00'), BERLIN, 240);
    const during = userDayAt(before.endsAt, BERLIN, 240);
    const after = userDayAt(during.endsAt, BERLIN, 240);

    // Конец одного дня — ровно начало следующего. Пропуск означал бы, что
    // действие не относится ни к какому дню, наложение — что к двум сразу.
    expect(during.startsAt.getTime()).toBe(before.endsAt.getTime());
    expect(after.startsAt.getTime()).toBe(during.endsAt.getTime());
    expect(during.localDate).toBe(SPRING_FORWARD);
  });

  it('граница внутри весеннего разрыва сдвигается к первому существующему времени', () => {
    // 02:30 29 марта в Берлине не существует: часы идут 02:00 → 03:00.
    const day = userDayAt(new Date(`${SPRING_FORWARD}T12:00:00+02:00`), BERLIN, 150);

    const wall = wallTimeAt(day.startsAt, BERLIN);
    expect(wall.hour).toBe(3);
    expect(wall.minute).toBe(0);
  });

  it('повторяющееся локальное время разрешается в раннее вхождение', () => {
    // 02:30 25 октября в Берлине наступает дважды: в CEST и затем в CET.
    const resolved = instantFromWallTime(
      { year: 2026, month: 10, day: 25, hour: 2, minute: 30 },
      BERLIN,
    );

    // Раннее вхождение — ещё летнее время, смещение +02:00.
    expect(resolved.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('конец дня строго позже начала в сутки перехода', () => {
    for (const date of [SPRING_FORWARD, FALL_BACK]) {
      const day = userDayAt(new Date(`${date}T12:00:00Z`), BERLIN, 150);
      expect(day.endsAt.getTime()).toBeGreaterThan(day.startsAt.getTime());
    }
  });
});

describe('пояса с некруглым смещением', () => {
  it('Катманду со смещением 5:45 обрабатывается верно', () => {
    const day = userDayAt(new Date('2026-09-16T00:00:00Z'), KATHMANDU, 240);

    // 00:00 UTC — это 05:45 по Катманду, то есть уже после границы 04:00.
    expect(day.localDate).toBe('2026-09-16');
    expect(userDayLengthMinutes(day)).toBe(1440);
  });
});

describe('следующая граница', () => {
  it('совпадает с концом текущего дня', () => {
    const instant = new Date('2026-09-16T12:00:00+03:00');
    const day = userDayAt(instant, MOSCOW, 240);

    expect(nextBoundaryAfter(instant, MOSCOW, 240).getTime()).toBe(day.endsAt.getTime());
  });

  it('следующая граница всегда позже мгновения', () => {
    for (const hour of [0, 3, 4, 5, 12, 23]) {
      const instant = new Date(`2026-09-16T${String(hour).padStart(2, '0')}:00:00+03:00`);
      expect(nextBoundaryAfter(instant, MOSCOW, 240).getTime()).toBeGreaterThan(instant.getTime());
    }
  });
});
