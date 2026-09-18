import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { DAILY_CAP_MXP, ROLLING_CAP_MXP, RULE_VERSION } from '../../src/modules/progression/engine.ts';
import { executeEnvelope } from '../../src/modules/sync/routes.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { withTenantTransaction } from '../../src/shared/db/tenant.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Журнал начислений на живой базе (P3-01).
 *
 * Это тот слой, ради которого писалось правило «награда начисляется один раз на
 * одно фактическое выполнение». Проверяется не арифметика — она отдельно, на
 * контрольных примерах спецификации, — а то, чего по коду не видно: что повтор
 * команды не даёт второй награды, что дневной предел не обходится, что журнал
 * нельзя править и что чужие начисления не видны.
 */

let ownerDb: Database;
let runtimeDb: Database;

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await ownerDb.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    userId,
    'dev',
    `xp-${userId}`,
  ]);
  await ownerDb.query(
    `INSERT INTO user_profiles (user_id, timezone, day_boundary_minutes)
     VALUES ($1, 'Europe/Moscow', 240)`,
    [userId],
  );
  return userId;
}

function envelope(kind: string, payload: Record<string, unknown>, target?: { id: string; version: number }) {
  return {
    schema_version: 1,
    command_id: randomUUID(),
    device_id: randomUUID(),
    kind,
    aggregate_id: target?.id ?? null,
    expected_version: target?.version ?? null,
    client_created_at: new Date().toISOString(),
    depends_on_command_id: null,
    payload,
  };
}

/** Задание с экземпляром на сегодня. Возвращает идентификатор экземпляра. */
async function makeQuest(userId: string, title = 'Английский'): Promise<string> {
  const template = await executeEnvelope(
    runtimeDb,
    userId,
    envelope('create_quest_template', {
      title,
      normal_spec: { success_rule: 'duration', unit: 'seconds', duration_seconds: 2700 },
    }),
  );
  const occurrence = await executeEnvelope(
    runtimeDb,
    userId,
    envelope('materialize_occurrence', {
      template_id: template.result?.['template_id'],
      recurrence_key: `2026-09-18-${randomUUID().slice(0, 8)}`,
      timezone: 'Europe/Moscow',
    }),
  );
  return occurrence.result?.['occurrence_id'] as string;
}

async function ledger(userId: string): Promise<
  { amount_mxp: string; rule_version: string; counted_seconds: number }[]
> {
  const rows = await ownerDb.query<{ amount_mxp: string; rule_version: string; counted_seconds: number }>(
    'SELECT amount_mxp, rule_version, counted_seconds FROM xp_ledger WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  return rows.rows;
}

async function totalMxp(userId: string): Promise<bigint> {
  const rows = await ownerDb.query<{ total: string | null }>(
    'SELECT SUM(amount_mxp)::text AS total FROM xp_ledger WHERE user_id = $1',
    [userId],
  );
  return BigInt(rows.rows[0]?.total ?? '0');
}

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);
  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const url = new URL(config.database.connectionString);
  url.username = 'app_runtime';
  url.password = '';
  runtimeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 4 });
});

afterAll(async () => {
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

describe('начисление за выполнение', () => {
  it('записывает награду с версией правил', async () => {
    const userId = await createUser();
    const occurrence = await makeQuest(userId);

    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', { actual_duration_seconds: 2700 }, { id: occurrence, version: 1 }),
    );

    const rows = await ledger(userId);
    expect(rows).toHaveLength(1);
    // 45 минут по базовой ставке — 22.500 XP.
    expect(rows[0]?.amount_mxp).toBe('22500');
    // Версия в каждой строке: без неё нельзя объяснить, по каким правилам
    // начислено полгода назад.
    expect(rows[0]?.rule_version).toBe(RULE_VERSION);
    expect(rows[0]?.counted_seconds).toBe(2700);
  });

  it('повтор команды не даёт второй награды', async () => {
    const userId = await createUser();
    const occurrence = await makeQuest(userId);
    const command = envelope('complete_quest', { actual_duration_seconds: 2700 }, { id: occurrence, version: 1 });

    await executeEnvelope(runtimeDb, userId, command);
    await executeEnvelope(runtimeDb, userId, command);

    expect(await ledger(userId)).toHaveLength(1);
  });

  it('выполнение без измеренного времени не даёт времени в награду', async () => {
    const userId = await createUser();
    const occurrence = await makeQuest(userId);

    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', {}, { id: occurrence, version: 1 }),
    );

    const rows = await ledger(userId);
    // Строка есть: расчёт был, и его итог — ноль. Отсутствие строки означало бы
    // «ещё не считали», а это другое. Сказать «сделал» не значит отработать
    // выдуманный час (docs/05, раздел 5).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount_mxp).toBe('0');
  });

  it('второе задание того же дня считается с учётом первого', async () => {
    const userId = await createUser();
    const first = await makeQuest(userId, 'Первое');
    const second = await makeQuest(userId, 'Второе');

    // Час и ещё час: вторая семья своя, но общий дневной счётчик один.
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', { actual_duration_seconds: 3600 }, { id: first, version: 1 }),
    );
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', { actual_duration_seconds: 3600 }, { id: second, version: 1 }),
    );

    // Оба часа внутри первых 120 минут дня — полная ставка, по 30.000 каждый.
    expect(await totalMxp(userId)).toBe(60_000n);
  });

  it('завершение после частичной записи не складывает награду дважды', async () => {
    const userId = await createUser();
    const occurrence = await makeQuest(userId);

    // Пятнадцать минут из сорока пяти: это уточнение одного действия, а не
    // второе действие.
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('record_partial', { actual_duration_seconds: 900 }, { id: occurrence, version: 1 }),
    );
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', { actual_duration_seconds: 2700 }, { id: occurrence, version: 2 }),
    );

    // Итог — награда за сорок пять минут, а не за пятнадцать плюс сорок пять.
    // Иначе дробление записи приносило бы больше, чем честная одна.
    expect(await totalMxp(userId)).toBe(22_500n);
    expect(await ledger(userId)).toHaveLength(2);
  });

  it('день ограничен полосами, а не числом заданий', async () => {
    const userId = await createUser();
    // Восемь заданий по три часа. Каждое — своя семья, поэтому семейная полоса
    // им не мешает; ограничивает общая дневная.
    for (let i = 0; i < 8; i += 1) {
      const occurrence = await makeQuest(userId, `Задание ${i}`);
      await executeEnvelope(
        runtimeDb,
        userId,
        envelope('complete_quest', { actual_duration_seconds: 3 * 3600 }, { id: occurrence, version: 1 }),
      );
    }

    // Потолок от длительности: 120 минут по полной ставке плюс 120 по
    // половинной, дальше ноль. Это 90 XP, и никакое число заданий его не
    // поднимает — иначе дневной предел обходился бы дроблением на задания.
    expect(await totalMxp(userId)).toBeLessThanOrEqual(90_000n);
    expect(await totalMxp(userId)).toBeGreaterThan(0n);
  });

  it('дневной предел обрезает награду, когда он уже почти выбран', async () => {
    const userId = await createUser();
    const first = await makeQuest(userId, 'Первое');

    // Отметка без измеренного времени: строка журнала будет с нулём.
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', {}, { id: first, version: 1 }),
    );
    // Исправление факта создаёт вторую запись того же действия. Начисление по
    // исправлениям пока не сделано, поэтому строки журнала у неё нет — к ней и
    // привязывается ручная заправка дня.
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('correct_activity', { actual_duration_seconds: 2700 }, { id: first, version: 2 }),
    );

    // Предел в 180 XP длительностью не достигается: полосы отдают максимум 90.
    // Поэтому день добивается напрямую записью в журнал — так же, как его
    // однажды доберут routine, milestone и множители сложности.
    //
    // Момент начисления отодвинут за окно в 24 часа намеренно: иначе оба
    // предела обрезали бы одинаково, и проверка не сказала бы, который из них
    // работает. Первая версия этой проверки так и проходила при выключенном
    // дневном пределе — за него всё делал скользящий.
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
    const filled = await ownerDb.query(
      `INSERT INTO xp_ledger
         (user_id, activity_id, activity_root_id, bucket_key, family_key,
          amount_mxp, counted_seconds, rule_version, input_hash, credited_at)
       SELECT $1, a.id, a.root_activity_id, $2, 'прочее', $3, 0, 'ручная-заправка', 'ручная',
              now() - interval '30 hours'
         FROM activity_records a
        WHERE a.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM xp_ledger l WHERE l.activity_id = a.id)
        LIMIT 1`,
      [userId, day, (DAILY_CAP_MXP - 5_000n).toString()],
    );
    expect(filled.rowCount).toBe(1);

    const second = await makeQuest(userId, 'Второе');
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', { actual_duration_seconds: 2700 }, { id: second, version: 1 }),
    );

    // Насчитано было бы 22.500, а свободного лимита осталось 5.000: выдаётся
    // остаток, и день упирается ровно в предел.
    expect(await totalMxp(userId)).toBe(DAILY_CAP_MXP);
  });

  it('скользящее окно обрезает награду независимо от границы дня', async () => {
    const userId = await createUser();
    const first = await makeQuest(userId, 'Первое');
    await executeEnvelope(runtimeDb, userId, envelope('complete_quest', {}, { id: first, version: 1 }));
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('correct_activity', { actual_duration_seconds: 2700 }, { id: first, version: 2 }),
    );

    // Начислено только что, но отнесено ко вчерашнему дню. Дневной предел
    // сегодняшнего дня этого не видит, скользящее окно — видит. Без второго
    // предела смена границы дня открывала бы второй лимит подряд.
    await ownerDb.query(
      `INSERT INTO xp_ledger
         (user_id, activity_id, activity_root_id, bucket_key, family_key,
          amount_mxp, counted_seconds, rule_version, input_hash)
       SELECT $1, a.id, a.root_activity_id, 'вчерашний-день', 'прочее', $2, 0, 'ручная-заправка', 'ручная'
         FROM activity_records a
        WHERE a.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM xp_ledger l WHERE l.activity_id = a.id)
        LIMIT 1`,
      [userId, (ROLLING_CAP_MXP - 5_000n).toString()],
    );

    const second = await makeQuest(userId, 'Второе');
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', { actual_duration_seconds: 2700 }, { id: second, version: 1 }),
    );

    expect(await totalMxp(userId)).toBe(ROLLING_CAP_MXP);
  });
});

describe('журнал', () => {
  it('нельзя править и нельзя удалять', async () => {
    const userId = await createUser();
    const occurrence = await makeQuest(userId);
    await executeEnvelope(
      runtimeDb,
      userId,
      envelope('complete_quest', { actual_duration_seconds: 2700 }, { id: occurrence, version: 1 }),
    );

    // Журнал, который можно править, перестаёт быть журналом. Запрет держится
    // правами базы, а не аккуратностью следующего автора.
    await expect(
      withTenantTransaction(runtimeDb, userId, async (client) =>
        client.query('UPDATE xp_ledger SET amount_mxp = 999999 WHERE user_id = $1', [userId]),
      ),
    ).rejects.toThrow();

    await expect(
      withTenantTransaction(runtimeDb, userId, async (client) =>
        client.query('DELETE FROM xp_ledger WHERE user_id = $1', [userId]),
      ),
    ).rejects.toThrow();

    expect(await totalMxp(userId)).toBe(22_500n);
  });

  it('чужие начисления не видны', async () => {
    const mine = await createUser();
    const theirs = await createUser();
    const occurrence = await makeQuest(theirs);
    await executeEnvelope(
      runtimeDb,
      theirs,
      envelope('complete_quest', { actual_duration_seconds: 2700 }, { id: occurrence, version: 1 }),
    );

    const visible = await withTenantTransaction(runtimeDb, mine, async (client) =>
      client.query('SELECT id FROM xp_ledger'),
    );
    expect(visible.rowCount).toBe(0);
  });
});
