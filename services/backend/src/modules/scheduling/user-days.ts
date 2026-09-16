import { withTenantTransaction } from '../../shared/db/tenant.ts';
import type { Database, TransactionClient } from '../../shared/db/pool.ts';
import { userDayAt, type UserDay } from '../../shared/time/user-day.ts';

/**
 * Материализация пользовательского дня.
 *
 * День хранит снимки пояса и границы на момент своего создания. Это не
 * дублирование профиля: изменение границы действует с ближайшего ещё не
 * открытого дня и не пересчитывает закрытую историю (docs/04, раздел 2).
 * Пересчёт прошлого превратил бы вчерашнее выполнение в пропуск задним числом.
 *
 * Дни образуют непрерывную цепочку без пересечений и щелей. Раньше каждый день
 * считался независимо от соседей: смена границы с 04:00 на 00:00 создавала
 * второй день, пересекающийся с первым на четыре часа, и одно мгновение
 * принадлежало сразу двум дням (R5 в docs/15-backend-review.md). Для будущих
 * корзин наград это двойной бюджет за одни и те же часы, а щель между днями —
 * часы, выполненное в которые не попадёт никуда.
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

/**
 * Насколько близко к предыдущему дню должно быть мгновение, чтобы новый день
 * пристыковывался к нему. Пропуск в неделю не должен порождать неделю пустых
 * дней: там цепочка честно прерывается.
 */
const CHAIN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Минимальная длина переходного дня. Огрызок в четыре часа получил бы
 * собственный дневной бюджет наград наравне с полными сутками, поэтому остаток
 * присоединяется к следующему дню, а не живёт отдельно.
 */
const MIN_DAY_MS = 12 * 60 * 60 * 1000;

interface DayRow {
  readonly id: string;
  readonly local_date: Date;
  readonly zone_snapshot: string;
  readonly boundary_snapshot: number;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly status: string;
}

const DAY_COLUMNS =
  'id, local_date, zone_snapshot, boundary_snapshot, starts_at, ends_at, status';

function toStored(row: DayRow): StoredUserDay {
  return {
    id: row.id,
    localDate: formatDate(row.local_date),
    zone: row.zone_snapshot,
    boundaryMinutes: row.boundary_snapshot,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
  };
}

/**
 * Дата из базы приходит как Date в местном поясе процесса; брать от неё
 * `toISOString` нельзя — сдвиг пояса меняет дату на сутки.
 */
function formatDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

async function findContaining(
  client: TransactionClient,
  instant: Date,
): Promise<DayRow | undefined> {
  const found = await client.query<DayRow>(
    `SELECT ${DAY_COLUMNS} FROM user_days WHERE starts_at <= $1 AND ends_at > $1`,
    [instant],
  );
  return found.rows[0];
}

export async function ensureUserDay(
  db: Database,
  userId: string,
  instant: Date,
  settings: DaySettings,
): Promise<StoredUserDay> {
  return withTenantTransaction(db, userId, async (client) => {
    // Блокировка на пользователя: два одновременных вызова иначе оба не найдут
    // содержащего дня и создадут два пересекающихся. Блокируется не строка
    // дня — его ещё нет.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `user_days:${userId}`,
    ]);

    // Мгновение уже принадлежит открытому дню — он и есть ответ, какими бы ни
    // были текущие настройки. Новая граница действует со следующего дня.
    const containing = await findContaining(client, instant);
    if (containing !== undefined) {
      return toStored(containing);
    }

    const candidate = userDayAt(instant, settings.zone, settings.boundaryMinutes);
    let startsAt = candidate.startsAt;
    let endsAt = candidate.endsAt;
    let localDate = candidate.localDate;

    const previous = await client.query<DayRow>(
      `SELECT ${DAY_COLUMNS} FROM user_days WHERE ends_at <= $1 ORDER BY ends_at DESC LIMIT 1`,
      [instant],
    );
    const previousRow = previous.rows[0];
    if (
      previousRow !== undefined &&
      instant.getTime() - previousRow.ends_at.getTime() < CHAIN_WINDOW_MS
    ) {
      // Стык с предыдущим днём. Он же закрывает оба направления смены границы:
      // при переносе назад новый день иначе залез бы на предыдущий, при
      // переносе вперёд между ними осталась бы щель.
      startsAt = previousRow.ends_at;
    }

    const following = await client.query<DayRow>(
      `SELECT ${DAY_COLUMNS} FROM user_days WHERE starts_at > $1 ORDER BY starts_at LIMIT 1`,
      [instant],
    );
    const followingRow = following.rows[0];

    if (followingRow !== undefined && followingRow.starts_at.getTime() < endsAt.getTime()) {
      endsAt = followingRow.starts_at;
    } else if (endsAt.getTime() - startsAt.getTime() < MIN_DAY_MS) {
      // Переходный огрызок присоединяется к следующему дню: отдельный день на
      // четыре часа получил бы полный дневной бюджет наград.
      const extended = userDayAt(endsAt, settings.zone, settings.boundaryMinutes).endsAt;
      endsAt =
        followingRow !== undefined && followingRow.starts_at.getTime() < extended.getTime()
          ? followingRow.starts_at
          : extended;
    }

    // Метка даты — ключ порядка и отображения; истина хранится в отрезке.
    // После смены границы дата старта может совпасть с уже занятой, и тогда
    // метка сдвигается вперёд: два дня с одной меткой не различить в истории.
    const taken = await client.query<{ local_date: Date }>(
      'SELECT local_date FROM user_days WHERE local_date >= $1::date ORDER BY local_date',
      [localDate],
    );
    const busy = new Set(taken.rows.map((row) => formatDate(row.local_date)));
    while (busy.has(localDate)) {
      localDate = shiftDate(localDate, 1);
    }

    const inserted = await client.query<DayRow>(
      `INSERT INTO user_days
         (user_id, local_date, zone_snapshot, boundary_snapshot, starts_at, ends_at)
       VALUES ($1, $2::date, $3, $4, $5, $6)
       RETURNING ${DAY_COLUMNS}`,
      [userId, localDate, settings.zone, settings.boundaryMinutes, startsAt, endsAt],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('Пользовательский день не создан');
    }
    return toStored(row);
  });
}
