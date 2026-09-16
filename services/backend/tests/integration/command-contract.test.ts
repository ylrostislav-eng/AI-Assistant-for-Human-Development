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
  readonly dependsOnCommandId?: string | null;
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
      depends_on_command_id: overrides.dependsOnCommandId ?? null,
      payload,
    },
  });
}

async function createOccurrence(
  key: string,
  templatePayload: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const template = await send('create_quest_template', {
    title: 'Задание для контракта',
    normal_spec: { duration_seconds: 1800, unit: 'seconds', success_rule: 'duration' },
    ...templatePayload,
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

describe('R6: закрытые схемы нагрузки', () => {
  it('лишнее поле в нагрузке отклоняется, а не теряется молча', async () => {
    const occurrence = await createOccurrence('r6-лишнее-поле');

    // Клиент присылает фактический объём при завершении. Пока Activity не
    // реализована, сервер не может его сохранить; молчаливый приём означал бы,
    // что человек считает объём записанным, а восстановить его через неделю
    // будет неоткуда.
    const response = await send('complete_quest', {
      occurrence_id: occurrence.id,
      actual_duration_seconds: 1800,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_payload' });
  });

  it('неверный тип поля отклоняется', async () => {
    const template = await send('create_quest_template', {
      title: 'Тип поля',
      normal_spec: { duration_seconds: '1800', unit: 'seconds', success_rule: 'duration' },
    });

    // Приведение типов отключено намеренно: строка "1800" не число, и принимать
    // её значило бы считать закрытую схему выполненной там, где она не сработала.
    expect(template.statusCode).toBe(400);
  });

  it('спецификация без меры отклоняется', async () => {
    const template = await send('create_quest_template', {
      title: 'Без меры',
      normal_spec: { unit: 'seconds', success_rule: 'duration' },
    });

    // success_rule говорит «считаем по длительности», а длительности нет:
    // раньше normal_spec проверялся только как объект, и правило было пустым.
    expect(template.statusCode).toBe(400);
  });

  it('минимум больше нормы отклоняется', async () => {
    const template = await send('create_quest_template', {
      title: 'Минимум больше нормы',
      normal_spec: { duration_seconds: 600, unit: 'seconds', success_rule: 'duration' },
      minimum_spec: { duration_seconds: 1800, unit: 'seconds', success_rule: 'duration' },
    });

    expect(template.statusCode).toBe(400);
  });

  it('завершение минимумом без спецификации минимума отклоняется', async () => {
    const occurrence = await createOccurrence('r6-минимум-без-спецификации');

    // Шаблон минимума не описывает. Приняв variant=minimum, сервер выдал бы
    // меньшую награду за объём, о котором ничего не известно.
    const response = await send('complete_quest', {
      occurrence_id: occurrence.id,
      variant: 'minimum',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_payload' });
  });

  it('завершение минимумом по принятой спецификации проходит', async () => {
    const occurrence = await createOccurrence('r6-минимум-по-спецификации', {
      minimum_spec: { duration_seconds: 300, unit: 'seconds', success_rule: 'duration' },
    });

    const response = await send('complete_quest', {
      occurrence_id: occurrence.id,
      variant: 'minimum',
    });

    // Отрицательный контроль к предыдущей проверке: запрет не должен ломать
    // законный минимум.
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({ variant: 'minimum' });
  });
});

describe('заявленная зависимость не игнорируется', () => {
  it('команда с depends_on_command_id отклоняется', async () => {
    const occurrence = await createOccurrence('зависимость');

    // Порядок между командами не реализован. Выполнить команду молча значит
    // нарушить порядок, который клиент считает гарантированным.
    const response = await send(
      'start_quest',
      { occurrence_id: occurrence.id },
      { dependsOnCommandId: randomUUID() },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'unsupported_dependency' });
  });
});
