/**
 * Пользовательский день: локальная дата плюс конкретные мгновения начала и
 * конца (docs/04, раздел 2).
 *
 * Главное правило проекта: следующая граница строится по календарной дате, а не
 * прибавлением 86400 секунд. В сутки перехода на летнее время их 23 или 25, и
 * арифметика «плюс 24 часа» даёт либо пропущенный, либо удвоенный день — молча,
 * на одном дне в году.
 *
 * Интервалы полуоткрытые `[начало, конец)`: мгновение ровно на границе
 * принадлежит новому дню, иначе оно попало бы в оба.
 */

export interface UserDay {
  /** Локальная дата в виде ГГГГ-ММ-ДД. */
  readonly localDate: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(zone);
  if (cached !== undefined) {
    return cached;
  }
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(zone, created);
  return created;
}

/** Локальное время в указанном поясе для данного мгновения. */
export function wallTimeAt(instant: Date, zone: string): WallTime {
  const parts = formatter(zone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Не удалось получить ${type} для пояса ${zone}`);
    }
    // hourCycle h23 отдаёт 24 для полуночи в некоторых окружениях.
    return Number(part.value) % (type === 'hour' ? 24 : Number.MAX_SAFE_INTEGER);
  };

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

function wallAsUtcMillis(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** Смещение пояса в миллисекундах для конкретного мгновения. */
function offsetAt(instant: Date, zone: string): number {
  return wallAsUtcMillis(wallTimeAt(instant, zone)) - instant.getTime();
}

function sameWall(left: WallTime, right: WallTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

/**
 * Мгновение для заданного локального времени.
 *
 * Политика DST v0.1 (docs/04, раздел 2):
 * несуществующее локальное время (весенний разрыв) сдвигается к первому
 * допустимому мгновению после разрыва; повторяющееся локальное время (осеннее
 * возвращение) разрешается в раннее вхождение.
 */
export function instantFromWallTime(wall: WallTime, zone: string): Date {
  const asUtc = wallAsUtcMillis(wall);
  const dayMs = 86_400_000;

  // Смещения берутся по обе стороны от искомого времени, а не в нём самом.
  // Проба в самой точке возвращает смещение уже после перехода, и раннее
  // вхождение повторяющегося времени не находится вовсе — на этом первая
  // версия и ошиблась.
  const offsetBefore = offsetAt(new Date(asUtc - dayMs), zone);
  const offsetAfter = offsetAt(new Date(asUtc + dayMs), zone);

  const candidates = [...new Set([asUtc - offsetBefore, asUtc - offsetAfter])].sort(
    (left, right) => left - right,
  );
  const valid = candidates.filter((millis) => sameWall(wallTimeAt(new Date(millis), zone), wall));

  if (valid.length > 0) {
    // Раннее вхождение: при осеннем возвращении времени оно наступает дважды.
    return new Date(valid[0] as number);
  }

  // Времени не существует (весенний разрыв): нужен сам момент перехода, то
  // есть первое допустимое мгновение после него. Сдвинутый кандидат дал бы
  // время на час позже начала разрыва.
  const low = candidates[0] as number;
  const high = candidates[candidates.length - 1] as number;
  return new Date(findTransition(low, high, zone));
}

/**
 * Поиск мгновения, с которого действует смещение, наблюдаемое в конце
 * промежутка. Промежуток заведомо содержит переход, поэтому двоичный поиск
 * сходится за десятки шагов и не зависит от того, какой это переход.
 */
function findTransition(lowMillis: number, highMillis: number, zone: string): number {
  const target = offsetAt(new Date(highMillis), zone);
  let low = lowMillis;
  let high = highMillis;

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(new Date(middle), zone) === target) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

function formatLocalDate(wall: WallTime): string {
  const month = String(wall.month).padStart(2, '0');
  const day = String(wall.day).padStart(2, '0');
  return `${wall.year}-${month}-${day}`;
}

/** Календарное смещение даты на указанное число дней, без арифметики по времени. */
function shiftCalendarDate(wall: WallTime, days: number): WallTime {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

function boundaryFor(localDate: WallTime, zone: string, boundaryMinutes: number): Date {
  return instantFromWallTime(
    {
      year: localDate.year,
      month: localDate.month,
      day: localDate.day,
      hour: Math.floor(boundaryMinutes / 60),
      minute: boundaryMinutes % 60,
    },
    zone,
  );
}

export class InvalidBoundaryError extends Error {}

/**
 * Пользовательский день, которому принадлежит мгновение.
 *
 * Берётся последняя календарная граница не позже мгновения: при границе 04:00
 * час ночи относится ещё к предыдущему дню, как и ощущает это человек.
 */
export function userDayAt(instant: Date, zone: string, boundaryMinutes: number): UserDay {
  if (!Number.isInteger(boundaryMinutes) || boundaryMinutes < 0 || boundaryMinutes > 1439) {
    throw new InvalidBoundaryError('Граница дня задаётся минутами от 0 до 1439');
  }

  const wall = wallTimeAt(instant, zone);
  let dateOfDay = wall;
  let startsAt = boundaryFor(dateOfDay, zone, boundaryMinutes);

  if (instant.getTime() < startsAt.getTime()) {
    // Мгновение раньше сегодняшней границы — день ещё вчерашний.
    dateOfDay = shiftCalendarDate(wall, -1);
    startsAt = boundaryFor(dateOfDay, zone, boundaryMinutes);
  }

  // Конец — граница следующей календарной даты. Именно здесь сутки перехода
  // получаются длиной 23 или 25 часов.
  const endsAt = boundaryFor(shiftCalendarDate(dateOfDay, 1), zone, boundaryMinutes);

  return { localDate: formatLocalDate(dateOfDay), startsAt, endsAt };
}

/** Следующая граница пользовательского дня после указанного мгновения. */
export function nextBoundaryAfter(instant: Date, zone: string, boundaryMinutes: number): Date {
  return userDayAt(instant, zone, boundaryMinutes).endsAt;
}

/** Длительность пользовательского дня в минутах: 1440 в обычные сутки, 1380 или 1500 в сутки перехода. */
export function userDayLengthMinutes(day: UserDay): number {
  return (day.endsAt.getTime() - day.startsAt.getTime()) / 60_000;
}
