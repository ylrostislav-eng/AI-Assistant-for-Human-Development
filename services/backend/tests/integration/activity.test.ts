import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Факт выполнения — остаток P1-06 по аудиту `docs/15-backend-review.md` (R6).
 *
 * До этой задачи завершение меняло только статус. «Сделал» без объёма и времени
 * ничем не отличается от «нажал кнопку»: через неделю восстановить, сколько
 * было на самом деле, неоткуда, а награда считалась бы по запланированному
 * объёму, то есть по намерению, а не по факту.
 *
 * Главное правило набора: неизвестный объём остаётся неизвестным. Подстановка
 * запланированного значения — не «разумное умолчание», а выдумка, которую
 * потом не отличить от измерения.
 */

let ownerDb: Database;
let runtimeDb: Database;
let app: FastifyInstance;
let accessToken: string;

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const url = new URL(base.database.connectionString);
  url.username = 'app_runtime';
  url.password = '';
  runtimeDb = createPool({ ...base.database, connectionString: url.toString(), maxConnections: 4 });

  const config: AppConfig = { ...base, devAuthEnabled: true };
  app = createApp({ config, database: runtimeDb });

  const login = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { subject: 'факт-выполнения' },
  });
  accessToken = login.json().access_token;
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

interface Target {
  readonly id: string;
  readonly version: number;
}

async function send(kind: string, payload: Record<string, unknown>, target: Target | null = null) {
  return app.inject({
    method: 'POST',
    url: '/commands',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      schema_version: 1,
      command_id: randomUUID(),
      device_id: randomUUID(),
      kind,
      aggregate_id: target?.id ?? null,
      expected_version: target?.version ?? null,
      client_created_at: '2026-09-16T12:00:00Z',
      depends_on_command_id: null,
      payload,
    },
  });
}

const DURATION_SPEC = {
  normal: { duration_seconds: 1800, unit: 'seconds', success_rule: 'duration' },
  minimum: { duration_seconds: 300, unit: 'seconds', success_rule: 'duration' },
};
const AMOUNT_SPEC = {
  normal: { amount: 5, unit: 'km', success_rule: 'amount' },
  minimum: { amount: 1, unit: 'km', success_rule: 'amount' },
};

async function createOccurrence(
  key: string,
  spec: { normal: Record<string, unknown>; minimum?: Record<string, unknown> } = DURATION_SPEC,
): Promise<Target> {
  const template = await send('create_quest_template', {
    title: `Задание ${key}`,
    normal_spec: spec.normal,
    ...(spec.minimum === undefined ? {} : { minimum_spec: spec.minimum }),
  });
  expect(template.statusCode).toBe(200);

  const occurrence = await send('materialize_occurrence', {
    template_id: template.json().result.template_id,
    recurrence_key: key,
    timezone: 'Europe/Moscow',
  });
  expect(occurrence.statusCode).toBe(200);

  return {
    id: occurrence.json().result.occurrence_id,
    version: Number(occurrence.json().result.version),
  };
}

interface ActivityRow {
  readonly id: string;
  readonly root_activity_id: string;
  readonly replaces_id: string | null;
  readonly occurred_start: Date | null;
  readonly occurred_end: Date | null;
  readonly duration_seconds: number | null;
  readonly amount: string | null;
  readonly unit: string | null;
  readonly measurement: string;
  readonly source: string;
  readonly variant: string;
  readonly state: string;
}

async function activities(occurrenceId: string): Promise<ActivityRow[]> {
  const rows = await ownerDb.query<ActivityRow>(
    `SELECT id, root_activity_id, replaces_id, occurred_start, occurred_end, duration_seconds,
            amount, unit, measurement, source, variant, state
       FROM activity_records WHERE occurrence_id = $1 ORDER BY recorded_at, id`,
    [occurrenceId],
  );
  return rows.rows;
}

describe('факт выполнения записывается', () => {
  it('завершение с измеренной длительностью сохраняет факт', async () => {
    const occurrence = await createOccurrence('факт-длительность');

    const response = await send(
      'complete_quest',
      {
        actual_duration_seconds: 2100,
        occurred_start: '2026-09-16T08:00:00Z',
        occurred_end: '2026-09-16T08:35:00Z',
        source: 'timer',
      },
      occurrence,
    );

    expect(response.statusCode).toBe(200);
    const [fact] = await activities(occurrence.id);
    expect(fact).toMatchObject({
      duration_seconds: 2100,
      unit: 'seconds',
      measurement: 'measured',
      source: 'timer',
      variant: 'normal',
      state: 'accepted',
    });
    // Корнем первого факта является он сам: к нему потом привязываются
    // исправления и подтверждения.
    expect(fact?.root_activity_id).toBe(fact?.id);
  });

  it('завершение с измеренным объёмом сохраняет факт в единицах спецификации', async () => {
    const occurrence = await createOccurrence('факт-объём', AMOUNT_SPEC);

    await send('complete_quest', { actual_amount: 6.2 }, occurrence);

    const [fact] = await activities(occurrence.id);
    expect(Number(fact?.amount)).toBe(6.2);
    expect(fact?.unit).toBe('km');
    expect(fact?.measurement).toBe('measured');
  });

  it('завершение без измерения не выдумывает запланированный объём', async () => {
    const occurrence = await createOccurrence('факт-неизвестен');

    const response = await send('complete_quest', {}, occurrence);

    expect(response.statusCode).toBe(200);
    const [fact] = await activities(occurrence.id);
    // Ровно это и есть главный запрет: 1800 секунд из спецификации — план, а
    // не факт. Подставив его, мы бы навсегда потеряли разницу между «отметил» и
    // «измерил».
    expect(fact?.measurement).toBe('unknown');
    expect(fact?.duration_seconds).toBeNull();
    expect(fact?.amount).toBeNull();
  });

  it('длительность выводится из отрезка времени, если он измерен', async () => {
    const occurrence = await createOccurrence('факт-из-отрезка');

    await send(
      'complete_quest',
      { occurred_start: '2026-09-16T08:00:00Z', occurred_end: '2026-09-16T08:40:00Z' },
      occurrence,
    );

    const [fact] = await activities(occurrence.id);
    // Это не выдумка: отрезок измерен, длительность — его следствие.
    expect(fact?.duration_seconds).toBe(2400);
    expect(fact?.measurement).toBe('measured');
  });
});

describe('факт согласован со спецификацией', () => {
  it('измерение не в той мере отклоняется', async () => {
    const occurrence = await createOccurrence('мера', AMOUNT_SPEC);

    // Спецификация меряет километры, прислана длительность: такой факт нечем
    // сравнить с критерием успеха.
    const response = await send('complete_quest', { actual_duration_seconds: 1800 }, occurrence);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_payload' });
  });

  it('объём ниже нормы не проходит как полное выполнение', async () => {
    const occurrence = await createOccurrence('ниже-нормы');

    const response = await send('complete_quest', { actual_duration_seconds: 600 }, occurrence);

    // 10 минут из 30 — не полное выполнение. Принять значило бы выдать полную
    // награду за треть работы.
    expect(response.statusCode).toBe(400);
  });

  it('минимум ниже своей спецификации не проходит', async () => {
    const occurrence = await createOccurrence('ниже-минимума');

    const response = await send(
      'complete_quest',
      { variant: 'minimum', actual_duration_seconds: 120 },
      occurrence,
    );

    expect(response.statusCode).toBe(400);
  });

  it('объём между минимумом и нормой проходит как минимум', async () => {
    const occurrence = await createOccurrence('годный-минимум');

    const response = await send(
      'complete_quest',
      { variant: 'minimum', actual_duration_seconds: 600 },
      occurrence,
    );

    // Отрицательный контроль: запреты не должны ломать законный минимум.
    expect(response.statusCode).toBe(200);
    const [fact] = await activities(occurrence.id);
    expect(fact).toMatchObject({ variant: 'minimum', duration_seconds: 600 });
  });

  it('полный объём под видом минимума отклоняется', async () => {
    const occurrence = await createOccurrence('минимум-с-нормой');

    const response = await send(
      'complete_quest',
      { variant: 'minimum', actual_duration_seconds: 2000 },
      occurrence,
    );

    // Норма выполнена: молча засчитать меньшую награду значит обокрасть
    // человека, молча повысить вариант — подменить его решение.
    expect(response.statusCode).toBe(400);
  });

  it('частичное выполнение без объёма отклоняется', async () => {
    const occurrence = await createOccurrence('частичное-без-объёма');

    const response = await send('record_partial', {}, occurrence);

    // Частичное выполнение без объёма не отличить от невыполнения.
    expect(response.statusCode).toBe(400);
  });

  it('частичное выполнение сохраняет измеренный объём', async () => {
    const occurrence = await createOccurrence('частичное-с-объёмом');

    const response = await send('record_partial', { actual_duration_seconds: 420 }, occurrence);

    expect(response.statusCode).toBe(200);
    const [fact] = await activities(occurrence.id);
    expect(fact).toMatchObject({ variant: 'partial', duration_seconds: 420 });
  });
});

describe('один факт на задание', () => {
  it('завершение после частичного заменяет прежний факт, а не добавляет второй', async () => {
    const occurrence = await createOccurrence('частичное-и-завершение');

    const partial = await send('record_partial', { actual_duration_seconds: 420 }, occurrence);
    const completed = await send(
      'complete_quest',
      { actual_duration_seconds: 1900 },
      { id: occurrence.id, version: Number(partial.json().result.version) },
    );
    expect(completed.statusCode).toBe(200);

    const facts = await activities(occurrence.id);
    const accepted = facts.filter((fact) => fact.state === 'accepted');

    // Два принятых факта на одно задание — это две награды за одно действие.
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.duration_seconds).toBe(1900);
    // Прежний факт не стирается: история выполнения остаётся видимой.
    expect(facts).toHaveLength(2);
    expect(facts[0]?.state).toBe('superseded');
    // Оба относятся к одному корню: это один факт, уточнённый, а не два
    // разных действия.
    expect(facts[1]?.root_activity_id).toBe(facts[0]?.root_activity_id);
  });

  it('база не принимает второй принятый факт на задание', async () => {
    const occurrence = await createOccurrence('второй-факт');
    await send('complete_quest', { actual_duration_seconds: 1900 }, occurrence);
    const [fact] = await activities(occurrence.id);

    await expect(
      ownerDb.query(
        `INSERT INTO activity_records
           (user_id, occurrence_id, root_activity_id, measurement, source, variant)
         SELECT user_id, occurrence_id, root_activity_id, 'unknown', 'self', 'normal'
           FROM activity_records WHERE id = $1`,
        [fact?.id],
      ),
      // Имя ограничения проверяется намеренно: без него проверка прошла бы и
      // от любой другой ошибки — например, от отсутствующей таблицы.
    ).rejects.toThrow(/activity_records_one_accepted/);
  });

  it('база не принимает неизвестное измерение с объёмом', async () => {
    const occurrence = await createOccurrence('неизвестное-с-объёмом');

    // Прикладная проверка может быть обойдена будущим кодом; запрет выдумывать
    // объём должен держать и база.
    await expect(
      ownerDb.query(
        `INSERT INTO activity_records
           (user_id, occurrence_id, root_activity_id, measurement, source, variant,
            duration_seconds)
         VALUES ((SELECT user_id FROM quest_occurrences WHERE id = $1), $1,
                 gen_random_uuid(), 'unknown', 'self', 'normal', 1800)`,
        [occurrence.id],
      ),
    ).rejects.toThrow(/activity_records_unknown_has_no_value/);
  });
});

describe('исправление факта', () => {
  it('исправление заменяет факт, сохраняя корень и историю', async () => {
    const occurrence = await createOccurrence('исправление');
    const completed = await send('complete_quest', { actual_duration_seconds: 1900 }, occurrence);

    const corrected = await send(
      'correct_activity',
      { actual_duration_seconds: 2400, source: 'device' },
      { id: occurrence.id, version: Number(completed.json().result.version) },
    );

    expect(corrected.statusCode).toBe(200);
    const facts = await activities(occurrence.id);
    const accepted = facts.filter((fact) => fact.state === 'accepted');

    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ duration_seconds: 2400, source: 'device' });
    // Новый способ доказательства уточняет факт, а не создаёт второе действие
    // (docs/02, раздел 5).
    expect(accepted[0]?.root_activity_id).toBe(facts[0]?.root_activity_id);
    expect(accepted[0]?.replaces_id).toBe(facts[0]?.id);
  });

  it('исправлять нечего, если факта не было', async () => {
    const occurrence = await createOccurrence('исправление-без-факта');

    const response = await send('correct_activity', { actual_duration_seconds: 600 }, occurrence);

    expect(response.statusCode).toBe(404);
  });
});

describe('прежние завершения не выдаются за измеренные', () => {
  it('у задания, завершённого до появления фактов, фактов нет', async () => {
    const occurrence = await createOccurrence('старое-завершение');
    // Запись статуса в обход команды: так выглядят завершения, сделанные до
    // этой задачи.
    await ownerDb.query(
      `UPDATE quest_occurrences
          SET execution_status = 'completed', completion_variant = 'normal'
        WHERE id = $1`,
      [occurrence.id],
    );

    // Миграция не досочиняет им факты: иначе отметку задним числом не отличить
    // от измерения.
    expect(await activities(occurrence.id)).toHaveLength(0);
  });
});
