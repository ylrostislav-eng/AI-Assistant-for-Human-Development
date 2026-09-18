import { createHash } from 'node:crypto';

import {
  computeAward,
  evidenceBasisPoints,
  DAILY_CAP_MXP,
  ROLLING_CAP_MXP,
  RULE_VERSION,
} from './engine.ts';
import type { TransactionClient } from '../../shared/db/pool.ts';
import { userDayAt } from '../../shared/time/user-day.ts';

/**
 * Начисление за записанный факт (docs/03, разделы 4 и 5).
 *
 * Награду считает только этот код и только по правилам из
 * `packages/rules/progression`. Ни модель, ни текст бота не начисляют ничего:
 * LLM не знает о выданном XP до квитанции (AGENTS.md, docs/05).
 *
 * Начисление идёт той же транзакцией, что и сам факт. Отдельная транзакция
 * оставила бы окно, в котором задание уже выполнено, а награды ещё нет, и
 * падение в этом окне не восстановил бы никто: факт есть, начисления нет, и
 * отличить это от «начислено ноль» нечем.
 *
 * Коэффициенты Phase 3: сложность, качество и новизна равны единице —
 * рубрик нет, и повышающий множитель нельзя получить одной фразой «это S»
 * (docs/03, раздел 4). Постоянство тоже единица: оно считается по закрытым
 * дням, а закрытия дня ещё нет. Работает доказательство: самоотчёт, таймер или
 * устройство различаются по источнику факта.
 */

const NEUTRAL_BP = 10_000;

export interface AwardRequest {
  readonly userId: string;
  readonly activityId: string;
  readonly activityRootId: string;
  readonly templateId: string;
  readonly durationSeconds: number | null;
  readonly source: string;
  readonly now: Date;
}

export interface AwardOutcome {
  readonly amountMxp: bigint;
  readonly ruleVersion: string;
  readonly bucketKey: string;
}

async function sumOf(
  client: TransactionClient,
  column: 'amount_mxp' | 'counted_seconds',
  where: string,
  params: readonly unknown[],
): Promise<bigint> {
  const rows = await client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(${column}), 0)::text AS total FROM xp_ledger WHERE ${where}`,
    [...params],
  );
  return BigInt(rows.rows[0]?.total ?? '0');
}

/**
 * Отпечаток входных данных расчёта.
 *
 * Нужен не для идемпотентности — её держит ограничение уникальности по записи
 * факта, — а чтобы потом было видно, что повтор считал то же самое. Без него
 * расхождение в сумме не отличить от изменения входных данных.
 */
function inputHash(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 32);
}

export async function awardForActivity(
  client: TransactionClient,
  request: AwardRequest,
): Promise<AwardOutcome> {
  const profile = await client.query<{ timezone: string; day_boundary_minutes: number }>(
    'SELECT timezone, day_boundary_minutes FROM user_profiles WHERE user_id = $1',
    [request.userId],
  );
  const settings = profile.rows[0];
  if (settings === undefined) {
    throw new Error('У пользователя нет профиля');
  }
  // День пользователя, а не дата сервера: смена часового пояса не должна
  // удваивать дневной предел (docs/03, раздел 4).
  const bucketKey = userDayAt(request.now, settings.timezone, settings.day_boundary_minutes)
    .localDate;

  // Счётчики полос берутся без вклада этого же корня: завершение после
  // частичной записи уточняет одно действие, а не добавляет второе.
  const familySecondsBefore = await sumOf(
    client,
    'counted_seconds',
    'user_id = $1 AND bucket_key = $2 AND family_key = $3 AND activity_root_id <> $4',
    [request.userId, bucketKey, request.templateId, request.activityRootId],
  );
  const globalSecondsBefore = await sumOf(
    client,
    'counted_seconds',
    'user_id = $1 AND bucket_key = $2 AND activity_root_id <> $3',
    [request.userId, bucketKey, request.activityRootId],
  );

  const seconds = request.durationSeconds ?? 0;
  const computed = computeAward({
    seconds,
    familySecondsBefore: Number(familySecondsBefore),
    globalSecondsBefore: Number(globalSecondsBefore),
    difficultyBp: NEUTRAL_BP,
    qualityBp: NEUTRAL_BP,
    evidenceBp: evidenceBasisPoints(request.source),
    consistencyBp: NEUTRAL_BP,
    noveltyBp: NEUTRAL_BP,
  });

  // Пределы считаются без вклада корня по той же причине, и оба применяются
  // сразу: дневной привязан к дню человека, скользящий — к часам, и смена
  // границы дня не должна открывать второй лимит.
  const dayOther = await sumOf(
    client,
    'amount_mxp',
    'user_id = $1 AND bucket_key = $2 AND activity_root_id <> $3',
    [request.userId, bucketKey, request.activityRootId],
  );
  const rollingOther = await sumOf(
    client,
    'amount_mxp',
    "user_id = $1 AND credited_at > $2::timestamptz - interval '24 hours' AND activity_root_id <> $3",
    [request.userId, request.now.toISOString(), request.activityRootId],
  );

  const headroom = (cap: bigint, used: bigint): bigint => (cap > used ? cap - used : 0n);
  const allowed = [
    computed.amountMxp,
    headroom(DAILY_CAP_MXP, dayOther),
    headroom(ROLLING_CAP_MXP, rollingOther),
  ].reduce((least, value) => (value < least ? value : least));

  // Дельта к уже начисленному по этому корню: журнал дописывается, а не
  // правится (docs/03, раздел 5).
  const already = await sumOf(client, 'amount_mxp', 'user_id = $1 AND activity_root_id = $2', [
    request.userId,
    request.activityRootId,
  ]);
  const alreadySeconds = await sumOf(
    client,
    'counted_seconds',
    'user_id = $1 AND activity_root_id = $2',
    [request.userId, request.activityRootId],
  );

  const amountMxp = allowed - already;
  // Счётчик не уходит назад: уменьшающие исправления в этой редакции расчёта не
  // поддержаны, и их влияние на полосы описано как несделанное.
  const countedDelta = BigInt(seconds) > alreadySeconds ? BigInt(seconds) - alreadySeconds : 0n;

  await client.query(
    `INSERT INTO xp_ledger
       (user_id, activity_id, activity_root_id, bucket_key, family_key,
        amount_mxp, counted_seconds, rule_version, input_hash, credited_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      request.userId,
      request.activityId,
      request.activityRootId,
      bucketKey,
      request.templateId,
      amountMxp.toString(),
      Number(countedDelta),
      RULE_VERSION,
      inputHash({
        seconds,
        source: request.source,
        familySecondsBefore: familySecondsBefore.toString(),
        globalSecondsBefore: globalSecondsBefore.toString(),
        rule: RULE_VERSION,
      }),
      request.now.toISOString(),
    ],
  );

  return { amountMxp, ruleVersion: RULE_VERSION, bucketKey };
}
