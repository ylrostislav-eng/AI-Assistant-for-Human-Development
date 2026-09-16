import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { ensureUserDay } from '../../src/modules/scheduling/user-days.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки материализации пользовательского дня на реальной схеме.
 */

const USER_A = '41414141-4141-4141-8141-414141414141';
const MOSCOW = 'Europe/Moscow';
const BERLIN = 'Europe/Berlin';

let ownerDb: Database;
let runtimeDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  await ownerDb.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    USER_A,
    'dev',
    'days-a',
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

describe('материализация дня', () => {
  it('создаёт день с границами из календарной математики', async () => {
    const day = await ensureUserDay(runtimeDb, USER_A, new Date('2026-09-16T01:00:00+03:00'), {
      zone: MOSCOW,
      boundaryMinutes: 240,
    });

    // Час ночи относится к предыдущему дню при границе 04:00.
    expect(day.localDate).toBe('2026-09-15');
    expect(day.startsAt.toISOString()).toBe('2026-09-15T01:00:00.000Z');
    expect(day.endsAt.toISOString()).toBe('2026-09-16T01:00:00.000Z');
  });

  it('повторный вызов возвращает тот же день, а не создаёт второй', async () => {
    const first = await ensureUserDay(runtimeDb, USER_A, new Date('2026-09-20T10:00:00+03:00'), {
      zone: MOSCOW,
      boundaryMinutes: 240,
    });
    const second = await ensureUserDay(runtimeDb, USER_A, new Date('2026-09-20T22:00:00+03:00'), {
      zone: MOSCOW,
      boundaryMinutes: 240,
    });

    expect(second.id).toBe(first.id);
    const rows = await ownerDb.query('SELECT id FROM user_days WHERE local_date = $1::date', [
      '2026-09-20',
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it('смена границы не переписывает уже открытый день', async () => {
    const original = await ensureUserDay(runtimeDb, USER_A, new Date('2026-09-25T12:00:00+03:00'), {
      zone: MOSCOW,
      boundaryMinutes: 240,
    });

    const afterChange = await ensureUserDay(
      runtimeDb,
      USER_A,
      new Date('2026-09-25T12:00:00+03:00'),
      { zone: MOSCOW, boundaryMinutes: 360 },
    );

    // Пересчёт закрытой истории превратил бы вчерашнее выполнение в пропуск
    // задним числом (docs/04, раздел 2).
    expect(afterChange.boundaryMinutes).toBe(240);
    expect(afterChange.startsAt.getTime()).toBe(original.startsAt.getTime());
  });

  it('сутки перехода на летнее время сохраняются длиной 23 часа', async () => {
    const day = await ensureUserDay(runtimeDb, USER_A, new Date('2026-03-29T12:00:00+02:00'), {
      zone: BERLIN,
      boundaryMinutes: 0,
    });

    const lengthHours = (day.endsAt.getTime() - day.startsAt.getTime()) / 3_600_000;
    expect(day.localDate).toBe('2026-03-29');
    expect(lengthHours).toBe(23);
  });

  it('день принадлежит своему пользователю и не виден другому', async () => {
    const day = await ensureUserDay(runtimeDb, USER_A, new Date('2026-10-01T12:00:00+03:00'), {
      zone: MOSCOW,
      boundaryMinutes: 240,
    });

    const other = '42424242-4242-4242-8242-424242424242';
    await ownerDb.query(
      'INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [other, 'dev', 'days-b'],
    );

    const visible = await ensureUserDay(runtimeDb, other, new Date('2026-10-01T12:00:00+03:00'), {
      zone: MOSCOW,
      boundaryMinutes: 240,
    });

    // Одна и та же дата у разных пользователей — разные строки.
    expect(visible.id).not.toBe(day.id);
  });
});
