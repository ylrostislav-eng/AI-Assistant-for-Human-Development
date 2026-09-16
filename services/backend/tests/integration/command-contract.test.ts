import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки контракта команд по аудиту `docs/15-backend-review.md` (R1, R2, R6).
 *
 * Эти сценарии воспроизводят найденные дефекты и написаны до исправления:
 * прежние проверки их не ловили, потому что обращались к полям в payload, а не
 * к каноническим полям конверта.
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
    payload: { subject: 'контракт-команд' },
  });
  accessToken = login.json().access_token;
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

interface EnvelopeOverrides {
  readonly commandId?: string;
  readonly aggregateId?: string | null;
  readonly expectedVersion?: number | null;
}

async function send(
  kind: string,
  payload: Record<string, unknown>,
  overrides: EnvelopeOverrides = {},
) {
  return app.inject({
    method: 'POST',
    url: '/commands',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      schema_version: 1,
      command_id: overrides.commandId ?? randomUUID(),
      device_id: randomUUID(),
      kind,
      aggregate_id: overrides.aggregateId ?? null,
      expected_version: overrides.expectedVersion ?? null,
      client_created_at: '2026-09-16T12:00:00Z',
      depends_on_command_id: null,
      payload,
    },
  });
}

async function createOccurrence(key: string): Promise<{ id: string; version: number }> {
  const template = await send('create_quest_template', {
    title: 'Задание для контракта',
    normal_spec: { duration_seconds: 1800, unit: 'seconds', success_rule: 'duration' },
  });
  const occurrence = await send('materialize_occurrence', {
    template_id: template.json().result.template_id,
    recurrence_key: key,
    timezone: 'Europe/Moscow',
  });
  return {
    id: occurrence.json().result.occurrence_id,
    version: Number(occurrence.json().result.version),
  };
}

describe('R1: версия и цель берутся из конверта', () => {
  it('устаревшая версия в конверте отклоняется', async () => {
    const occurrence = await createOccurrence('r1-версия');
    await send('start_quest', { occurrence_id: occurrence.id });

    // Клиент собирает конверт по контракту: версия и цель — поля верхнего
    // уровня. Раньше обработчик читал их только из payload, и канонические
    // поля молча игнорировались.
    const stale = await send(
      'complete_quest',
      { occurrence_id: occurrence.id },
      { aggregateId: occurrence.id, expectedVersion: occurrence.version },
    );

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'version_conflict' });
  });

  it('актуальная версия в конверте принимается', async () => {
    const occurrence = await createOccurrence('r1-актуальная');

    const response = await send(
      'complete_quest',
      { occurrence_id: occurrence.id },
      { aggregateId: occurrence.id, expectedVersion: occurrence.version },
    );

    expect(response.statusCode).toBe(200);
  });

  it('противоречие между целью конверта и целью нагрузки отклоняется', async () => {
    const first = await createOccurrence('r1-цель-1');
    const second = await createOccurrence('r1-цель-2');

    // Два разных идентификатора в одном запросе: неизвестно, какой считать
    // настоящим, и молча выбирать один нельзя.
    const response = await send(
      'complete_quest',
      { occurrence_id: first.id },
      { aggregateId: second.id },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'target_mismatch' });
  });
});

describe('R2: повтор распознаётся вместе с видом команды', () => {
  it('тот же идентификатор с другим видом команды отклоняется', async () => {
    const occurrence = await createOccurrence('r2-вид');
    const commandId = randomUUID();

    const started = await send(
      'start_quest',
      { occurrence_id: occurrence.id },
      { commandId },
    );
    expect(started.statusCode).toBe(200);

    // Нагрузка та же, вид другой. Раньше хеш считался только по нагрузке, и
    // ответом приходила квитанция чужой операции: клиент считал завершённым
    // задание, которое всего лишь запущено.
    const wrongKind = await send(
      'complete_quest',
      { occurrence_id: occurrence.id },
      { commandId },
    );

    expect(wrongKind.statusCode).toBe(409);
    expect(wrongKind.json()).toMatchObject({ error: 'command_id_reused' });
  });

  it('тот же идентификатор с другой целью отклоняется', async () => {
    const first = await createOccurrence('r2-цель-1');
    const second = await createOccurrence('r2-цель-2');
    const commandId = randomUUID();

    await send('start_quest', { occurrence_id: first.id }, { commandId });
    const other = await send('start_quest', { occurrence_id: second.id }, { commandId });

    expect(other.statusCode).toBe(409);
  });

  it('честный повтор того же вида и нагрузки возвращает прежнюю квитанцию', async () => {
    const occurrence = await createOccurrence('r2-честный-повтор');
    const commandId = randomUUID();

    const first = await send('start_quest', { occurrence_id: occurrence.id }, { commandId });
    const repeat = await send('start_quest', { occurrence_id: occurrence.id }, { commandId });

    // Обычный повтор при обрыве сети обязан работать по-прежнему.
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({ duplicate: true });
    expect(repeat.json().result).toEqual(first.json().result);
  });
});

describe('R6: реестр команд читает только собственные ключи', () => {
  it('имя из прототипа объекта не считается командой', async () => {
    const response = await send('constructor', { occurrence_id: randomUUID() });

    // Реестр — обычный объект; поиск по нему без проверки собственных ключей
    // возвращает Object.prototype.constructor, и вместо отказа получается
    // внутренняя ошибка.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'unknown_command_kind' });
  });
});
