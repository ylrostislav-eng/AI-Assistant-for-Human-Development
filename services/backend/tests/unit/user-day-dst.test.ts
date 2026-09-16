import { describe, expect, it } from 'vitest';

import {
  instantFromWallTime,
  userDayAt,
  userDayLengthMinutes,
  wallTimeAt,
} from '../../src/shared/time/user-day.ts';

/**
 * Разрывы и наложения локального времени — проверки по аудиту
 * `docs/15-backend-review.md` (R4).
 *
 * Прежний набор проверял разрыв в одной точке — ровно в начале часа. Смещение
 * вычислялось с потерей секунд, поэтому двоичный поиск границы сходился только
 * там, где секунды пробы случайно оказывались нулевыми: из 12 проб шага в пять
 * минут ошибались 8. Поэтому здесь проверяется **каждая минута** разрыва и
 * наложения.
 *
 * Ожидаемые значения взяты из правил переходов и сверены с базой часовых поясов
 * отдельным запуском Intl, не через проверяемый код:
 * Нью-Йорк 8 марта 2026 01:59 → 03:00; Берлин 29 марта 01:59 → 03:00;
 * Нью-Йорк 1 ноября 05:00Z и 06:00Z — оба 01:00 местного;
 * Лорд-Хау 4 октября 01:59 → 02:30 (переход на полчаса).
 */

const NEW_YORK = 'America/New_York';
const BERLIN = 'Europe/Berlin';
const LORD_HOWE = 'Australia/Lord_Howe';
const KATHMANDU = 'Asia/Kathmandu';
const EUCLA = 'Australia/Eucla';

interface GapCase {
  readonly zone: string;
  readonly date: { year: number; month: number; day: number };
  readonly hour: number;
  /** Минуты разрыва: этого локального времени не существует. */
  readonly minutes: readonly number[];
  /** Первое допустимое мгновение после разрыва. */
  readonly firstValid: string;
}

const GAPS: readonly GapCase[] = [
  {
    zone: NEW_YORK,
    date: { year: 2026, month: 3, day: 8 },
    hour: 2,
    minutes: Array.from({ length: 60 }, (_, index) => index),
    firstValid: '2026-03-08T07:00:00.000Z',
  },
  {
    zone: BERLIN,
    date: { year: 2026, month: 3, day: 29 },
    hour: 2,
    minutes: Array.from({ length: 60 }, (_, index) => index),
    firstValid: '2026-03-29T01:00:00.000Z',
  },
  {
    zone: LORD_HOWE,
    date: { year: 2026, month: 10, day: 4 },
    hour: 2,
    // Переход на полчаса: не существует только первая половина часа.
    minutes: Array.from({ length: 30 }, (_, index) => index),
    firstValid: '2026-10-03T15:30:00.000Z',
  },
];

describe('R4: весенний разрыв', () => {
  for (const gap of GAPS) {
    it(`${gap.zone}: каждая минута разрыва даёт первое допустимое мгновение`, () => {
      const wrong: string[] = [];
      for (const minute of gap.minutes) {
        const resolved = instantFromWallTime({ ...gap.date, hour: gap.hour, minute }, gap.zone);
        if (resolved.toISOString() !== gap.firstValid) {
          wrong.push(`${gap.hour}:${String(minute).padStart(2, '0')} → ${resolved.toISOString()}`);
        }
      }

      // Список неверных минут, а не первая упавшая: по одной точке не видно,
      // ошибка это в политике или в поиске границы.
      expect(wrong).toEqual([]);
    });
  }
});

interface FoldCase {
  readonly zone: string;
  readonly date: { year: number; month: number; day: number };
  readonly hour: number;
  readonly minutes: readonly number[];
  /** Смещение раннего вхождения в минутах от UTC. */
  readonly earlyOffsetMinutes: number;
}

const FOLDS: readonly FoldCase[] = [
  {
    zone: NEW_YORK,
    date: { year: 2026, month: 11, day: 1 },
    hour: 1,
    minutes: Array.from({ length: 60 }, (_, index) => index),
    earlyOffsetMinutes: -240,
  },
  {
    zone: LORD_HOWE,
    date: { year: 2026, month: 4, day: 5 },
    hour: 1,
    minutes: Array.from({ length: 30 }, (_, index) => 30 + index),
    earlyOffsetMinutes: 11 * 60,
  },
];

describe('R4: осеннее наложение', () => {
  for (const fold of FOLDS) {
    it(`${fold.zone}: каждая минута повтора разрешается в раннее вхождение`, () => {
      const wrong: string[] = [];
      for (const minute of fold.minutes) {
        const wall = { ...fold.date, hour: fold.hour, minute };
        const resolved = instantFromWallTime(wall, fold.zone);
        const expected = new Date(
          Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) -
            fold.earlyOffsetMinutes * 60_000,
        );
        if (resolved.getTime() !== expected.getTime()) {
          wrong.push(
            `${fold.hour}:${String(minute).padStart(2, '0')} → ${resolved.toISOString()}, ожидалось ${expected.toISOString()}`,
          );
        }
      }

      expect(wrong).toEqual([]);
    });
  }
});

describe('R4: обычное и дробное смещение', () => {
  const cases: readonly { zone: string; wall: string; instant: string }[] = [
    { zone: KATHMANDU, wall: '2026-06-15T03:30', instant: '2026-06-14T21:45:00.000Z' },
    { zone: EUCLA, wall: '2026-06-15T06:30', instant: '2026-06-14T21:45:00.000Z' },
    { zone: NEW_YORK, wall: '2026-06-15T12:00', instant: '2026-06-15T16:00:00.000Z' },
    { zone: BERLIN, wall: '2026-01-15T12:00', instant: '2026-01-15T11:00:00.000Z' },
  ];

  for (const probe of cases) {
    it(`${probe.zone}: ${probe.wall}`, () => {
      const [date, time] = probe.wall.split('T') as [string, string];
      const [year, month, day] = date.split('-').map(Number) as [number, number, number];
      const [hour, minute] = time.split(':').map(Number) as [number, number];

      expect(instantFromWallTime({ year, month, day, hour, minute }, probe.zone).toISOString()).toBe(
        probe.instant,
      );
    });
  }
});

describe('R4: обратное преобразование', () => {
  it('существующее локальное время восстанавливается без изменений', () => {
    const zones = [NEW_YORK, BERLIN, KATHMANDU, EUCLA, LORD_HOWE];
    const wrong: string[] = [];

    for (const zone of zones) {
      // Шаг в 37 минут выбран нарочно: кратный час скрыл бы ошибку, зависящую
      // от минут и секунд пробы.
      for (let minutes = 0; minutes < 1440; minutes += 37) {
        const wall = {
          year: 2026,
          month: 6,
          day: 15,
          hour: Math.floor(minutes / 60),
          minute: minutes % 60,
        };
        const back = wallTimeAt(instantFromWallTime(wall, zone), zone);
        if (
          back.year !== wall.year ||
          back.month !== wall.month ||
          back.day !== wall.day ||
          back.hour !== wall.hour ||
          back.minute !== wall.minute
        ) {
          wrong.push(`${zone} ${wall.hour}:${wall.minute} → ${back.hour}:${back.minute}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe('R4: дни встык при любой границе', () => {
  const transitions: readonly { zone: string; day: string; expectedMinutes: number }[] = [
    { zone: BERLIN, day: '2026-03-29', expectedMinutes: 1380 },
    { zone: BERLIN, day: '2026-10-25', expectedMinutes: 1500 },
    { zone: LORD_HOWE, day: '2026-10-04', expectedMinutes: 1410 },
    { zone: LORD_HOWE, day: '2026-04-05', expectedMinutes: 1470 },
  ];

  for (const transition of transitions) {
    it(`${transition.zone} ${transition.day}: нет ни щели, ни наложения`, () => {
      const broken: string[] = [];

      for (let boundary = 0; boundary < 1440; boundary += 1) {
        // Полдень заведомо существует в любом поясе, поэтому день перехода
        // выбирается по нему, а не по границе, которая может попасть в разрыв.
        const noon = instantFromWallTime(
          {
            ...splitDate(transition.day),
            hour: 12,
            minute: 0,
          },
          transition.zone,
        );
        const day = userDayAt(noon, transition.zone, boundary);
        const next = userDayAt(day.endsAt, transition.zone, boundary);

        if (next.startsAt.getTime() !== day.endsAt.getTime()) {
          broken.push(`граница ${boundary}: щель или наложение на стыке дней`);
        }
        if (day.endsAt.getTime() <= day.startsAt.getTime()) {
          broken.push(`граница ${boundary}: день не длится`);
        }
      }

      expect(broken).toEqual([]);
    });

    it(`${transition.zone} ${transition.day}: сутки перехода длятся ${transition.expectedMinutes} минут`, () => {
      // Граница в полночь: обычный случай, при котором длина суток перехода
      // видна целиком.
      const noon = instantFromWallTime(
        { ...splitDate(transition.day), hour: 12, minute: 0 },
        transition.zone,
      );
      const day = userDayAt(noon, transition.zone, 0);

      expect(userDayLengthMinutes(day)).toBe(transition.expectedMinutes);
    });
  }
});

function splitDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}
