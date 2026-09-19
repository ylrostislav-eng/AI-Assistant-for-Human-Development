import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { closeElapsedDays } from '../../src/modules/scheduling/day-close.ts';
import { executeEnvelope } from '../../src/modules/sync/routes.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Закрытие прошедших дней (P4-01).
 *
 * Без него день не кончается: несделанное вчера остаётся «запланированным»
 * навсегда, пропуск не отличается от «ещё успею», и постоянству не с чего
 * считаться. Это вторая половина основного цикла.
 *
 * Закрытие идёт тем же контрактом команд, что кнопка и Mini App. Фоновому
 * исполнителю здесь нужна явная политика версии, а не исключение из правила:
 * он читает текущую версию непосредственно перед командой, и если человек
 * успел что-то сделать в последнюю секунду, его действие выигрывает, а
 * закрытие пропускает эту строку до следующего прохода.
 */

let ownerDb: Database;
let workerDb: Database;

const MOSCOW = 'Europe/Moscow';
/** Полдень 19 сентября по Москве: 18-е уже прошло, 19-е идёт. */
/**
 * Даты намеренно далеко от настоящего дня.
 *
 * Раньше здесь стояло 18–19 сентября 2026 года, и 19 сентября подставные часы
 * стали неотличимы от системных: отрицательный контроль «взять системные часы
 * вместо переданных» перестал ловиться, а проверка осталась зелёной. Дата
 * рядом с настоящей превращает проверку часов в проверку календаря.
 */
const NOW = new Date('2019-03-06T09:00:00Z');

async function createUser(timezone = MOSCOW, boundaryMinutes = 240): Promise<string> {
  const userId = randomUUID();
  await ownerDb.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    userId,
    'dev',
    `close-${userId}`,
  ]);
  await ownerDb.query(
    `INSERT INTO user_profiles (user_id, timezone, day_boundary_minutes) VALUES ($1, $2, $3)`,
    [userId, timezone, boundaryMinutes],
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

/** Задание на указанный локальный день. */
async function makeQuest(userId: string, localDate: string, title = 'Английский'): Promise<string> {
  const template = await executeEnvelope(
    workerDb,
    userId,
    envelope('create_quest_template', {
      title,
      normal_spec: { success_rule: 'duration', unit: 'seconds', duration_seconds: 1800 },
    }),
  );
  const occurrence = await executeEnvelope(
    workerDb,
    userId,
    envelope('materialize_occurrence', {
      template_id: template.result?.['template_id'],
      recurrence_key: localDate,
      timezone: MOSCOW,
    }),
  );
  return occurrence.result?.['occurrence_id'] as string;
}

async function statusOf(occurrenceId: string): Promise<{ status: string; version: string }> {
  const rows = await ownerDb.query<{ execution_status: string; version: string }>(
    'SELECT execution_status, version FROM quest_occurrences WHERE id = $1',
    [occurrenceId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error('Экземпляр не найден');
  }
  return { status: row.execution_status, version: row.version };
}

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);
  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const url = new URL(config.database.connectionString);
  url.username = 'app_worker';
  url.password = '';
  workerDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 4 });
});

afterAll(async () => {
  await workerDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

describe('закрытие прошедшего дня', () => {
  it('несделанное вчера становится пропущенным', async () => {
    const userId = await createUser();
    const quest = await makeQuest(userId, '2019-03-05');

    const result = await closeElapsedDays(workerDb, { now: () => NOW });

    expect(result.closed).toBeGreaterThanOrEqual(1);
    // «Запланировано» навсегда — это не факт, а отсутствие факта: пропуск
    // должен называться пропуском.
    expect((await statusOf(quest)).status).toBe('missed');
  });

  it('сегодняшнее не трогается', async () => {
    const userId = await createUser();
    const quest = await makeQuest(userId, '2019-03-06');

    await closeElapsedDays(workerDb, { now: () => NOW });

    // День ещё идёт: закрыть его сейчас значило бы записать пропуск человеку,
    // у которого впереди полдня.
    expect((await statusOf(quest)).status).toBe('planned');
  });

  it('частично выполненное не превращается в пропуск', async () => {
    const userId = await createUser();
    const quest = await makeQuest(userId, '2019-03-05');
    await executeEnvelope(
      workerDb,
      userId,
      envelope('record_partial', { actual_duration_seconds: 600 }, { id: quest, version: 1 }),
    );
    const before = await statusOf(quest);

    await closeElapsedDays(workerDb, { now: () => NOW });

    const after = await statusOf(quest);
    // Сделанное наполовину — не то же, что не сделанное вовсе. И версия не
    // должна расти на пустом месте: иначе каждый проход двигал бы её вечно.
    expect(after.status).toBe('partial');
    expect(after.version).toBe(before.version);
  });

  it('выполненное вчера остаётся выполненным', async () => {
    const userId = await createUser();
    const quest = await makeQuest(userId, '2019-03-05');
    await executeEnvelope(
      workerDb,
      userId,
      envelope('complete_quest', { actual_duration_seconds: 1800 }, { id: quest, version: 1 }),
    );

    await closeElapsedDays(workerDb, { now: () => NOW });

    expect((await statusOf(quest)).status).toBe('completed');
  });

  it('повторный проход ничего не меняет', async () => {
    const userId = await createUser();
    const quest = await makeQuest(userId, '2019-03-05');

    await closeElapsedDays(workerDb, { now: () => NOW });
    const after = await statusOf(quest);
    const second = await closeElapsedDays(workerDb, { now: () => NOW });

    expect(second.closed).toBe(0);
    expect(await statusOf(quest)).toEqual(after);
  });
});

describe('граница дня', () => {
  it('до наступления границы вчерашний день ещё не закрыт', async () => {
    // Граница в 04:00 по Москве. В 02:00 по Москве 19-го «вчера» ещё идёт:
    // человек, работающий за полночь, не должен получить пропуск посреди дела.
    const userId = await createUser(MOSCOW, 240);
    const quest = await makeQuest(userId, '2019-03-05');

    await closeElapsedDays(workerDb, { now: () => new Date('2019-03-05T23:00:00Z') });

    expect((await statusOf(quest)).status).toBe('planned');
  });

  it('часовой пояс человека решает, а не пояс сервера', async () => {
    // Во Владивостоке 19-е наступило на семь часов раньше московского.
    const early = await createUser('Asia/Vladivostok', 240);
    const late = await createUser('Europe/Lisbon', 240);
    const earlyQuest = await makeQuest(early, '2019-03-05', 'Владивосток');
    const lateQuest = await makeQuest(late, '2019-03-05', 'Лиссабон');

    // 18 сентября, 20:00 UTC: во Владивостоке уже 19-е после границы,
    // в Лиссабоне ещё 18-е.
    await closeElapsedDays(workerDb, { now: () => new Date('2019-03-05T20:00:00Z') });

    expect((await statusOf(earlyQuest)).status).toBe('missed');
    expect((await statusOf(lateQuest)).status).toBe('planned');
  });
});
