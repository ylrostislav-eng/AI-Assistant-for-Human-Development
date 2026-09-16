import { withTenantTransaction } from '../../shared/db/tenant.ts';
import type { Database } from '../../shared/db/pool.ts';
import { userDayAt, type UserDay } from '../../shared/time/user-day.ts';

/**
 * Материализация пользовательского дня.
 *
 * День хранит снимки пояса и границы на момент своего создания. Это не
 * дублирование профиля: изменение границы действует с ближайшего ещё не
 * открытого дня и не пересчитывает закрытую историю (docs/04, раздел 2).
 * Пересчёт прошлого превратил бы вчерашнее выполнение в пропуск задним числом.
 */

export interface StoredUserDay extends UserDay {
  readonly id: string;
  readonly zone: string;
  readonly boundaryMinutes: number;
  readonly status: string;
}

export interface DaySettings {
  readonly zone: string;
  readonly boundaryMinutes: number;
}

export async function ensureUserDay(
  db: Database,
  userId: string,
  instant: Date,
  settings: DaySettings,
): Promise<StoredUserDay> {
  const day = userDayAt(instant, settings.zone, settings.boundaryMinutes);

  return withTenantTransaction(db, userId, async (client) => {
    // Существующий день не переписывается: его снимки остаются теми, при
    // которых он открывался.
    await client.query(
      `INSERT INTO user_days
         (user_id, local_date, zone_snapshot, boundary_snapshot, starts_at, ends_at)
       VALUES ($1, $2::date, $3, $4, $5, $6)
       ON CONFLICT (user_id, local_date) DO NOTHING`,
      [
        userId,
        day.localDate,
        settings.zone,
        settings.boundaryMinutes,
        day.startsAt,
        day.endsAt,
      ],
    );

    const stored = await client.query<{
      id: string;
      local_date: Date;
      zone_snapshot: string;
      boundary_snapshot: number;
      starts_at: Date;
      ends_at: Date;
      status: string;
    }>(
      `SELECT id, local_date, zone_snapshot, boundary_snapshot, starts_at, ends_at, status
         FROM user_days WHERE local_date = $1::date`,
      [day.localDate],
    );

    const row = stored.rows[0];
    if (row === undefined) {
      throw new Error('Пользовательский день не создан');
    }

    return {
      id: row.id,
      localDate: day.localDate,
      zone: row.zone_snapshot,
      boundaryMinutes: row.boundary_snapshot,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
    };
  });
}
