import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { ensureUserDay } from '../../src/modules/scheduling/user-days.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Смена границы дня — проверки по аудиту `docs/15-backend-review.md` (R5).
 *
 * Прежние проверки смотрели только на снимок уже созданного дня, поэтому
 * пересечение интервалов не замечалось: `ON CONFLICT (user_id, local_date)`
 * ловит совпадение даты, а не наложение отрезков. Одно мгновение оказывалось
 * сразу в двух днях, и будущие корзины наград удвоились бы на нём.
 *
 * Зона UTC выбрана намеренно: переход на летнее время здесь ни при чём, и
 * пересечение видно в чистом виде.
 */

const USER = '43434343-4343-4343-8343-434343434343';
const UTC = 'UTC';

let ownerDb: Database;
let runtimeDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  await ownerDb.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    USER,
    'dev',
    'boundary',
  ]);

  const url = new URL(config.database.connectionString);
  url.username = 'app_runtime';
  url.password = '';
  runtimeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 3 });
});

afterAll(async () => {
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

interface Interval {
  readonly id: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
}

async function intervals(): Promise<Interval[]> {
  const rows = await ownerDb.query<Interval>(
    'SELECT id, starts_at, ends_at FROM user_days WHERE user_id = $1 ORDER BY starts_at',
    [USER],
  );
  return rows.rows;
}

/** Пары дней, у которых отрезки накладываются. Пустой список — требование. */
function overlaps(days: readonly Interval[]): string[] {
  const found: string[] = [];
  for (let index = 1; index < days.length; index += 1) {
    const previous = days[index - 1] as Interval;
    const current = days[index] as Interval;
    if (current.starts_at.getTime() < previous.ends_at.getTime()) {
      found.push(
        `${previous.starts_at.toISOString()}–${previous.ends_at.toISOString()} и ` +
          `${current.starts_at.toISOString()}–${current.ends_at.toISOString()}`,
      );
    }
  }
  return found;
}

function gaps(days: readonly Interval[]): string[] {
  const found: string[] = [];
  for (let index = 1; index < days.length; index += 1) {
    const previous = days[index - 1] as Interval;
    const current = days[index] as Interval;
    if (current.starts_at.getTime() > previous.ends_at.getTime()) {
      found.push(`${previous.ends_at.toISOString()} → ${current.starts_at.toISOString()}`);
    }
  }
  return found;
}

describe('R5: смена границы дня', () => {
  it('мгновение не попадает в два дня после переноса границы назад', async () => {
    const instant = new Date('2026-09-16T01:00:00Z');

    const withLateBoundary = await ensureUserDay(runtimeDb, USER, instant, {
      zone: UTC,
      boundaryMinutes: 240,
    });
    // Человек передвинул границу на полночь. Мгновение уже принадлежит
    // открытому дню; второй день на него завёл бы вторую корзину наград.
    const withEarlyBoundary = await ensureUserDay(runtimeDb, USER, instant, {
      zone: UTC,
      boundaryMinutes: 0,
    });

    expect(withEarlyBoundary.id).toBe(withLateBoundary.id);
    expect(overlaps(await intervals())).toEqual([]);
  });

  it('переходный день начинается там, где кончился предыдущий', async () => {
    const before = await ensureUserDay(runtimeDb, USER, new Date('2026-10-10T12:00:00Z'), {
      zone: UTC,
      boundaryMinutes: 240,
    });

    // Первое мгновение после конца прежнего дня, уже с новой границей.
    const after = await ensureUserDay(runtimeDb, USER, before.endsAt, {
      zone: UTC,
      boundaryMinutes: 0,
    });

    expect(after.id).not.toBe(before.id);
    expect(after.startsAt.getTime()).toBe(before.endsAt.getTime());
  });

  it('перенос границы вперёд не оставляет щели', async () => {
    const before = await ensureUserDay(runtimeDb, USER, new Date('2026-11-10T12:00:00Z'), {
      zone: UTC,
      boundaryMinutes: 0,
    });

    // Граница уехала с полуночи на 04:00: без правила переходного дня четыре
    // часа не принадлежали бы ни одному дню, и выполненное в них не попало бы
    // никуда.
    const after = await ensureUserDay(runtimeDb, USER, new Date('2026-11-11T05:00:00Z'), {
      zone: UTC,
      boundaryMinutes: 240,
    });

    expect(after.startsAt.getTime()).toBe(before.endsAt.getTime());
  });

  it('дни идут встык при границе, меняющейся туда и обратно', async () => {
    const boundaries = [240, 0, 360, 120, 0];
    let cursor = new Date('2026-12-01T09:00:00Z');
    const chain: Interval[] = [];

    for (const boundary of boundaries) {
      const day = await ensureUserDay(runtimeDb, USER, cursor, {
        zone: UTC,
        boundaryMinutes: boundary,
      });
      chain.push({ id: day.id, starts_at: day.startsAt, ends_at: day.endsAt });
      // Следующее мгновение — сразу за концом текущего дня.
      cursor = new Date(day.endsAt.getTime());
    }

    // Проверяется собственная цепочка, а не все дни пользователя: между
    // отрезками, созданными другими проверками, щель законна, и первая версия
    // этой проверки падала при перемешивании порядка именно из-за них.
    expect(overlaps(chain)).toEqual([]);
    expect(gaps(chain)).toEqual([]);

    // Пересечений не должно быть и во всей таблице — это общее требование,
    // не зависящее от порядка проверок.
    expect(overlaps(await intervals())).toEqual([]);
  });

  it('база не принимает пересекающиеся дни', async () => {
    const day = await ensureUserDay(runtimeDb, USER, new Date('2027-02-10T12:00:00Z'), {
      zone: UTC,
      boundaryMinutes: 0,
    });

    // Прикладная проверка может быть обойдена будущим кодом; интервалы должна
    // защищать и сама база.
    await expect(
      ownerDb.query(
        `INSERT INTO user_days
           (user_id, local_date, zone_snapshot, boundary_snapshot, starts_at, ends_at)
         VALUES ($1, '2027-02-11'::date, 'UTC', 0, $2, $3)`,
        [USER, new Date(day.startsAt.getTime() + 3_600_000), day.endsAt],
      ),
    ).rejects.toThrow();
  });

  it('одновременные вызовы создают один день, а не два', async () => {
    const instant = new Date('2027-04-12T12:00:00Z');

    const results = await Promise.all([
      ensureUserDay(runtimeDb, USER, instant, { zone: UTC, boundaryMinutes: 0 }),
      ensureUserDay(runtimeDb, USER, instant, { zone: UTC, boundaryMinutes: 0 }),
      ensureUserDay(runtimeDb, USER, instant, { zone: UTC, boundaryMinutes: 0 }),
    ]);

    // Без блокировки на пользователя все три не находят содержащего дня и
    // пытаются вставить свой.
    expect(new Set(results.map((day) => day.id)).size).toBe(1);
  });

  it('длинный перерыв не достраивает цепочку пустых днями', async () => {
    const before = await ensureUserDay(runtimeDb, USER, new Date('2027-05-01T12:00:00Z'), {
      zone: UTC,
      boundaryMinutes: 0,
    });
    const after = await ensureUserDay(runtimeDb, USER, new Date('2027-05-20T12:00:00Z'), {
      zone: UTC,
      boundaryMinutes: 0,
    });

    // Неделя без приложения не должна порождать неделю пустых дней: цепочка
    // честно прерывается, а не притягивает новый день к прошлому.
    expect(after.startsAt.toISOString()).toBe('2027-05-20T00:00:00.000Z');
    expect(after.startsAt.getTime()).toBeGreaterThan(before.endsAt.getTime());
  });

  it('снимки существующего дня не переписываются новой границей', async () => {
    const original = await ensureUserDay(runtimeDb, USER, new Date('2027-03-05T12:00:00Z'), {
      zone: UTC,
      boundaryMinutes: 240,
    });

    const again = await ensureUserDay(runtimeDb, USER, new Date('2027-03-05T12:00:00Z'), {
      zone: UTC,
      boundaryMinutes: 0,
    });

    // Отрицательный контроль к правилу переходного дня: прошлое не
    // пересчитывается, иначе вчерашнее выполнение стало бы пропуском.
    expect(again.id).toBe(original.id);
    expect(again.boundaryMinutes).toBe(240);
    expect(again.startsAt.getTime()).toBe(original.startsAt.getTime());
  });
});
