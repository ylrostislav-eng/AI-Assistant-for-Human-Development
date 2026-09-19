import type { AttemptAccounting, AttemptTicket, AiTurnResponse } from './provider.ts';
import { withTenantTransaction } from '../../shared/db/tenant.ts';
import { withTransaction, type Database } from '../../shared/db/pool.ts';

/**
 * Бюджет обращений к поставщику (T-04b-3c).
 *
 * Считать после ответа поздно: деньги уже потрачены, и предел превращается в
 * отчёт о перерасходе. Поэтому расход **резервируется оценкой до** обращения и
 * уточняется по факту.
 *
 * Учитывается попытка, а не ход. Ход с перебором запасных моделей стоит
 * столько, сколько было попыток, и считать его одной значит недосчитать ровно
 * в тот день, когда основная модель лежит и перебор работает постоянно
 * (17 сентября вся линия Claude отвечала отказом, handoff 3.19).
 *
 * Пробовали иначе: сначала списание делалось после ответа, по `usage` из тела
 * (черновик в ветке claude/ai-turns-wip). Отброшено по двум причинам сразу.
 * Первая — два одновременных хода видят один и тот же свободный остаток и оба
 * проходят. Вторая — `usage` приходит не всегда, а на отказах почти никогда,
 * и «нет счётчиков» превращалось в «бесплатно».
 */

/** Предел исчерпан: обращаться к модели нельзя. */
export class BudgetExhaustedError extends Error {
  constructor() {
    super('Предел обращений к модели за сутки исчерпан');
    this.name = 'BudgetExhaustedError';
  }
}

export interface BudgetLimits {
  /** Сколько токенов разрешено израсходовать за скользящие сутки. */
  readonly windowTokens: number;
  /**
   * Во сколько оценивается попытка до ответа. Она же остаётся списанием, если
   * поставщик не сказал расход: цена неведения выше нуля, а не равна ему.
   */
  readonly estimateTokens: number;
  /**
   * Сколько резерв считается незакрытым. После этого его закрывает сверка:
   * процесс мог умереть между запросом и уточнением.
   */
  readonly reservationMs: number;
}

/**
 * Значения по умолчанию.
 *
 * Оценка намеренно щедра: занизить её значит пропустить за предел больше
 * обращений, чем разрешено, и узнать об этом по счёту. Завышенная оценка
 * стоит лишь того, что несколько последних обращений в сутках не состоятся —
 * а ручной путь при этом работает.
 */
export const DEFAULT_BUDGET: BudgetLimits = {
  windowTokens: 400_000,
  estimateTokens: 8_000,
  reservationMs: 120_000,
};

export interface AttemptIdentity {
  readonly userId: string;
  readonly turnId: string;
}

/** Окно предела. Скользящие сутки, а не календарные: иначе предел обнуляется в полночь и им пользуются рывком. */
const WINDOW = "interval '24 hours'";

const SPENT = `SELECT COALESCE(SUM(charged_tokens), 0)::text AS total
                 FROM ai_provider_attempts
                WHERE user_id = $1 AND reserved_at > now() - ${WINDOW}`;

/** Сколько ещё можно потратить. Для отчётов и подсказок, а не для решения «пускать ли». */
export async function remainingBudget(
  db: Database,
  userId: string,
  limits: BudgetLimits,
): Promise<number> {
  const rows = await withTenantTransaction(db, userId, (client) =>
    client.query<{ total: string }>(SPENT, [userId]),
  );
  return Math.max(0, limits.windowTokens - Number(rows.rows[0]?.total ?? '0'));
}

/**
 * Учёт попыток для одного хода.
 *
 * Отдаётся транспорту как зависимость, а не вызывается им по имени: транспорт
 * не должен знать ни про базу, ни про то, чей это ход.
 */
export function databaseAccounting(
  db: Database,
  identity: AttemptIdentity,
  limits: BudgetLimits,
): AttemptAccounting {
  return {
    async reserve(attempt): Promise<AttemptTicket> {
      const id = await withTenantTransaction(db, identity.userId, async (client) => {
        // Блокировка на человека, а не `FOR UPDATE`: блокировать здесь нечего,
        // считается сумма, а между «посчитал» и «записал» помещается второй
        // ход. Агрегат с `FOR UPDATE` PostgreSQL не принимает вовсе — это уже
        // проверено ошибкой «FOR UPDATE is not allowed with aggregate
        // functions». Тот же приём у счётчика пользовательских дней
        // (modules/scheduling/user-days).
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `ai_budget:${identity.userId}`,
        ]);

        const spent = await client.query<{ total: string }>(SPENT, [identity.userId]);
        if (Number(spent.rows[0]?.total ?? '0') + limits.estimateTokens > limits.windowTokens) {
          throw new BudgetExhaustedError();
        }

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ai_provider_attempts
             (user_id, turn_id, provider, model, state, reserved_tokens, charged_tokens, expires_at)
           VALUES ($1, $2, $3, $4, 'reserved', $5, $5, now() + make_interval(secs => $6))
           RETURNING id`,
          [
            identity.userId,
            identity.turnId,
            attempt.provider,
            attempt.model,
            limits.estimateTokens,
            limits.reservationMs / 1000,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new Error('Резерв обращения не записан');
        }
        return row.id;
      });

      return {
        async settle(usage): Promise<void> {
          await settleAttempt(db, identity.userId, id, usage, limits);
        },
      };
    },
  };
}

/**
 * Уточнение попытки по факту.
 *
 * Известный расход заменяет оценку — в обе стороны: попытка могла оказаться и
 * дешевле, и дороже, и держать оценку значит врать о потраченном.
 *
 * Нулевой расход известным не считается. Ответ с `usage: {0, 0}` — это не
 * подарок, а сломанный счётчик, и принимать его как факт значит открыть тот же
 * способ не платить, что и отсутствие `usage` вовсе.
 *
 * Закрывается только незакрытый резерв. Если его успела закрыть сверка, оценка
 * остаётся: переписывать закрытое задним числом — это способ вернуть себе
 * бюджет, опоздав.
 */
async function settleAttempt(
  db: Database,
  userId: string,
  id: string,
  usage: AiTurnResponse['usage'] | null,
  limits: BudgetLimits,
): Promise<void> {
  const total =
    usage === undefined || usage === null ? 0 : usage.inputTokens + usage.outputTokens;
  const known = total > 0;

  await withTenantTransaction(db, userId, (client) =>
    client.query(
      `UPDATE ai_provider_attempts
          SET state = 'settled', settled_at = now(),
              charged_tokens = $3, usage_known = $4,
              input_tokens = $5, output_tokens = $6
        WHERE user_id = $1 AND id = $2 AND state = 'reserved'`,
      [
        userId,
        id,
        known ? total : limits.estimateTokens,
        known,
        known ? (usage?.inputTokens ?? null) : null,
        known ? (usage?.outputTokens ?? null) : null,
      ],
    ),
  );
}

/**
 * Сверка брошенных резервов.
 *
 * Закрывает просроченные попытки **по оценке**, а не освобождает бюджет:
 * процесс мог умереть уже после отправки запроса, и считать такую попытку
 * бесплатной значит открыть способ не платить — достаточно падать вовремя.
 *
 * Идёт по всем людям узкой функцией SECURITY DEFINER: у исполнителя намеренно
 * нет сквозной политики на доменные таблицы (тот же приём, что у закрытия дня).
 */
export async function reconcileExpiredAttempts(db: Database, maxRows = 200): Promise<number> {
  return withTransaction(db, async (client) => {
    const rows = await client.query<{ ai_settle_expired_attempts: number }>(
      'SELECT ai_settle_expired_attempts($1)',
      [maxRows],
    );
    return rows.rows[0]?.ai_settle_expired_attempts ?? 0;
  });
}
