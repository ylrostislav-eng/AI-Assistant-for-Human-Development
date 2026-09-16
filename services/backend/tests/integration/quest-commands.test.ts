import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Сквозная проверка основного цикла через маршрут команд:
 * цель → шаблон задания → экземпляр → выполнение.
 *
 * Проверяется не «команды выполняются», а что нельзя получить вторую награду:
 * повторное завершение и завершение по устаревшей версии должны отклоняться.
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
    payload: { subject: 'квесты' },
  });
  accessToken = login.json().access_token;
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

async function send(
  kind: string,
  payload: Record<string, unknown>,
  target: { id: string; version: number } | null = null,
) {
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

/**
 * Переход выполнения. Версия обязательна: изменяющая команда называет
 * состояние, от которого клиент отталкивался.
 */
async function transition(
  kind: string,
  occurrence: { id: string; version: number },
  payload: Record<string, unknown> = {},
) {
  return send(kind, { ...payload }, occurrence);
}

async function createOccurrence(key: string): Promise<{ id: string; version: number }> {
  const template = await send('create_quest_template', {
    title: 'Английский 30 минут',
    normal_spec: { duration_seconds: 1800, unit: 'seconds', success_rule: 'duration' },
    minimum_spec: { duration_seconds: 300, unit: 'seconds', success_rule: 'duration' },
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

describe('основной цикл', () => {
  it('задание создаётся, запускается и завершается', async () => {
    const occurrence = await createOccurrence('цикл-1');

    const started = await transition('start_quest', occurrence);
    expect(started.statusCode).toBe(200);
    expect(started.json().result.execution_status).toBe('active');

    const completed = await transition('complete_quest', {
      id: occurrence.id,
      version: Number(started.json().result.version),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().result).toMatchObject({
      execution_status: 'completed',
      variant: 'normal',
    });
  });

  it('завершение минимальным объёмом сохраняет вариант', async () => {
    const occurrence = await createOccurrence('цикл-минимум');

    const completed = await transition('complete_quest', occurrence, { variant: 'minimum' });

    // Вариант важен для награды: минимум не равен полному выполнению.
    expect(completed.json().result.variant).toBe('minimum');
  });

  it('экземпляр хранит снимок правил шаблона', async () => {
    const occurrence = await createOccurrence('снимок');

    const stored = await ownerDb.query<{ template_snapshot: Record<string, unknown> }>(
      'SELECT template_snapshot FROM quest_occurrences WHERE id = $1',
      [occurrence.id],
    );

    // Поздняя правка шаблона не должна менять уже прожитое прошлое.
    expect(stored.rows[0]?.template_snapshot).toMatchObject({ title: 'Английский 30 минут' });
  });
});

describe('вторая награда невозможна', () => {
  it('повторное завершение отклоняется', async () => {
    const occurrence = await createOccurrence('повтор-завершения');
    const first = await transition('complete_quest', occurrence);

    // Версия берётся свежая, а не устаревшая: иначе сработала бы оптимистичная
    // блокировка и проверка ничего не сказала бы об автомате состояний.
    // Команда другая, идентификатор другой — идемпотентность шины здесь тоже
    // не спасает. Отклонить обязан автомат.
    const again = await transition('complete_quest', {
      id: occurrence.id,
      version: Number(first.json().result.version),
    });

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'invalid_transition' });
  });

  it('отменённое задание нельзя завершить', async () => {
    const occurrence = await createOccurrence('отменённое');
    const cancelled = await transition('cancel_quest', occurrence);

    const completed = await transition('complete_quest', {
      id: occurrence.id,
      version: Number(cancelled.json().result.version),
    });

    expect(completed.statusCode).toBe(409);
  });

  it('устаревшая версия отклоняется', async () => {
    const occurrence = await createOccurrence('версия');
    await transition('start_quest', occurrence);

    // Клиент решал по экрану, снятому до запуска задания.
    const stale = await transition('complete_quest', occurrence);

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'version_conflict' });
  });

  it('версия растёт с каждым переходом', async () => {
    const occurrence = await createOccurrence('версии-растут');

    const started = await transition('start_quest', occurrence);
    const completed = await transition('complete_quest', {
      id: occurrence.id,
      version: Number(started.json().result.version),
    });

    expect(Number(started.json().result.version)).toBe(occurrence.version + 1);
    expect(Number(completed.json().result.version)).toBe(occurrence.version + 2);
  });
});

describe('границы', () => {
  it('чужой экземпляр не находится', async () => {
    const occurrence = await createOccurrence('чужой');

    const otherLogin = await app.inject({
      method: 'POST',
      url: '/auth/dev-login',
      payload: { subject: 'посторонний' },
    });
    const otherToken = otherLogin.json().access_token;

    const response = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: {
        schema_version: 1,
        command_id: randomUUID(),
        device_id: randomUUID(),
        kind: 'complete_quest',
        aggregate_id: occurrence.id,
        expected_version: occurrence.version,
        client_created_at: '2026-09-16T12:00:00Z',
        depends_on_command_id: null,
        payload: {},
      },
    });

    // Политика изоляции не показывает чужую строку, поэтому она просто не
    // существует для этого пользователя.
    expect(response.statusCode).toBe(404);
  });

  it('неизвестный вариант завершения отклоняется', async () => {
    const occurrence = await createOccurrence('плохой-вариант');

    const response = await transition('complete_quest', occurrence, { variant: 'почти' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_payload' });
  });

  it('повтор ключа у одного шаблона отклоняется базой', async () => {
    const template = await send('create_quest_template', {
      title: 'Бег',
      normal_spec: { amount: 5, unit: 'km', success_rule: 'amount' },
    });
    const templateId = template.json().result.template_id;

    const first = await send('materialize_occurrence', {
      template_id: templateId,
      recurrence_key: 'день-1',
      timezone: 'Europe/Moscow',
    });
    expect(first.statusCode).toBe(200);

    const duplicate = await send('materialize_occurrence', {
      template_id: templateId,
      recurrence_key: 'день-1',
      timezone: 'Europe/Moscow',
    });

    // Два экземпляра на один день дали бы две награды за одну задачу.
    // 409, а не 500: запрос корректен, конфликт с уже существующей строкой.
    // Первая версия этой проверки закрепляла 500 — то есть фиксировала
    // неудобное поведение вместо того, чтобы его исправить.
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'already_exists' });
  });
});
