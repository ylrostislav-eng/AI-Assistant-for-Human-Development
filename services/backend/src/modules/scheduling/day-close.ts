import { executeEnvelope } from '../sync/routes.ts';
import { derivedCommandId } from '../../shared/commands/derived-id.ts';
import type { Database } from '../../shared/db/pool.ts';
import { withTransaction } from '../../shared/db/pool.ts';
import { userDayAt } from '../../shared/time/user-day.ts';

/**
 * Закрытие прошедших пользовательских дней (docs/04).
 *
 * Без него день не кончается: несделанное вчера остаётся «запланированным»
 * навсегда, пропуск не отличается от «ещё успею», и постоянству не с чего
 * считаться.
 *
 * День считается прошедшим по **границе дня самого человека**, а не по
 * полуночи сервера. Человек, работающий за полночь, не должен получить пропуск
 * посреди дела, и тот же проход не должен закрывать день раньше времени
 * жителю другого пояса.
 *
 * Состояние закрытия нигде не хранится, и это осознанно: день прошёл, если его
 * локальная дата меньше сегодняшней. Отдельная отметка «закрыт» потребовала бы
 * следить, чтобы её никто не проспал и не поставил дважды, а так проход
 * самовосстанавливается — после недели простоя он закроет всю неделю.
 */

/** Сколько заданий закрывать за проход. Остальные достанутся следующему. */
const DEFAULT_LIMIT = 200;

export interface CloseOptions {
  readonly now?: () => Date;
  readonly limit?: number;
}

export interface CloseResult {
  /** Сколько заданий переведено в пропущенные. */
  readonly closed: number;
  /**
   * Сколько пропущено из-за расхождения версии. Человек успел что-то сделать
   * между чтением и командой — его действие выигрывает, а строка достанется
   * следующему проходу.
   */
  readonly skipped: number;
}

interface StaleRow {
  readonly user_id: string;
  readonly occurrence_id: string;
  readonly version: string;
  readonly recurrence_key: string;
}

export async function closeElapsedDays(
  db: Database,
  options: CloseOptions = {},
): Promise<CloseResult> {
  const now = options.now ?? ((): Date => new Date());
  const limit = options.limit ?? DEFAULT_LIMIT;

  // Кандидаты берутся узкой функцией SECURITY DEFINER: у исполнителя намеренно
  // нет сквозной политики на доменные таблицы, и это и есть изоляция для
  // фоновой работы. Функция только возвращает строки — решение «день прошёл»
  // принимается здесь, календарной арифметикой, которая живёт в одном месте и
  // проверена по каждой минуте перехода на летнее время.
  const stale = await withTransaction(db, async (client) => {
    const rows = await client.query<StaleRow & { timezone: string; day_boundary_minutes: number }>(
      'SELECT * FROM scheduling_day_close_candidates($1)',
      [limit],
    );
    return rows.rows;
  });

  let closed = 0;
  let skipped = 0;

  for (const row of stale) {
    const today = userDayAt(now(), row.timezone, row.day_boundary_minutes).localDate;
    if (row.recurrence_key >= today) {
      // День ещё идёт. Закрыть его сейчас значило бы записать пропуск
      // человеку, у которого впереди полдня.
      continue;
    }

    // Та же шина, что у кнопки и Mini App. Отдельный путь для фонового
    // исполнителя означал бы, что часть проверок действует только на одном из
    // них — ровно то, что запрещено для бота (docs/14, раздел 4).
    const outcome = await executeEnvelope(db, row.user_id, {
      schema_version: 1,
      // Выведен из дня и задания: повторный проход после сбоя вернёт прежнюю
      // квитанцию, а не закроет день второй раз.
      command_id: derivedCommandId('day-close', row.occurrence_id, row.recurrence_key),
      device_id: derivedCommandId('day-close', 'device', row.user_id),
      kind: 'close_user_day',
      aggregate_id: row.occurrence_id,
      // Версия прочитана только что. Если человек успел что-то сделать, это
      // честный конфликт, и его действие выигрывает.
      expected_version: Number(row.version),
      client_created_at: now().toISOString(),
      depends_on_command_id: null,
      payload: {},
    });

    if (outcome.status === 'committed' || outcome.status === 'already_applied') {
      closed += 1;
    } else {
      skipped += 1;
    }
  }

  return { closed, skipped };
}
