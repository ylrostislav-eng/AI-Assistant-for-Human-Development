import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Пачка команд за один запрос (T-06, docs/06, раздел 3).
 *
 * Клиент, накопивший действия без сети, отправляет их одним запросом. Главное
 * свойство — **независимые квитанции**: одна негодная команда в пачке не
 * отменяет остальные. Иначе человек, у которого одно задание успели завершить с
 * другого устройства, теряет и все остальные отметки за день, причём молча.
 *
 * Второе свойство — тот же контракт, что у одиночной команды. Отдельный
 * разбор для пачки разошёлся бы с одиночным путём незаметно, и часть проверок
 * действовала бы только на одном из них.
 */

let ownerDb: Database;
let runtimeDb: Database;
let app: FastifyInstance;
let token: string;

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

  token = (
    await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { subject: 'пачка' } })
  ).json().access_token;
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

interface EnvelopeOptions {
  readonly commandId?: string;
  readonly aggregateId?: string | null;
  readonly expectedVersion?: number | null;
}

function envelope(
  kind: string,
  payload: Record<string, unknown>,
  options: EnvelopeOptions = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    command_id: options.commandId ?? randomUUID(),
    device_id: randomUUID(),
    kind,
    aggregate_id: options.aggregateId ?? null,
    expected_version: options.expectedVersion ?? null,
    client_created_at: '2026-09-17T09:00:00Z',
    depends_on_command_id: null,
    payload,
  };
}

function goal(title: string): Record<string, unknown> {
  return envelope('create_goal', { title, start_date: '2026-09-01' });
}

async function push(commands: readonly Record<string, unknown>[], accessToken = token) {
  return app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { commands },
  });
}

interface Receipt {
  readonly command_id: string;
  readonly status: string;
  readonly error?: string;
  readonly committed_seq?: string;
  readonly result?: Record<string, unknown>;
}

async function countGoals(title: string): Promise<number> {
  const rows = await ownerDb.query('SELECT id FROM goals WHERE title = $1', [title]);
  return rows.rowCount ?? 0;
}

describe('пачка команд', () => {
  it('без токена не принимается', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sync/push',
      payload: { commands: [goal('Без токена')] },
    });

    expect(response.statusCode).toBe(401);
  });

  it('выполняет команды по порядку и возвращает квитанцию на каждую', async () => {
    const response = await push([goal('Пачка 1'), goal('Пачка 2'), goal('Пачка 3')]);

    expect(response.statusCode).toBe(200);
    const receipts = (response.json() as { receipts: Receipt[] }).receipts;
    expect(receipts).toHaveLength(3);
    expect(receipts.every((receipt) => receipt.status === 'committed')).toBe(true);

    // Номера идут подряд: пачка не расходует номера впустую и не оставляет дыр.
    const numbers = receipts.map((receipt) => Number(receipt.committed_seq));
    expect(numbers[1]).toBe((numbers[0] as number) + 1);
    expect(numbers[2]).toBe((numbers[0] as number) + 2);
  });

  it('негодная команда не отменяет остальные', async () => {
    const broken = envelope('create_goal', { title: '', start_date: '2026-09-01' });

    const response = await push([goal('До негодной'), broken, goal('После негодной')]);

    expect(response.statusCode).toBe(200);
    const receipts = (response.json() as { receipts: Receipt[] }).receipts;
    expect(receipts.map((receipt) => receipt.status)).toEqual([
      'committed',
      'rejected',
      'committed',
    ]);
    // Соседи по пачке обязаны примениться: иначе человек, у которого одно
    // действие устарело, теряет все отметки за день разом.
    expect(await countGoals('До негодной')).toBe(1);
    expect(await countGoals('После негодной')).toBe(1);
  });

  it('квитанция отказа называет причину', async () => {
    const unknown = envelope('несуществующая_команда', {});

    const receipts = (await push([unknown])).json() as { receipts: Receipt[] };

    expect(receipts.receipts[0]).toMatchObject({
      status: 'rejected',
      error: 'unknown_command_kind',
    });
  });

  it('конфликт состояния отмечается отдельно от негодного запроса', async () => {
    const template = (await push([
      envelope('create_quest_template', {
        title: 'Для конфликта',
        normal_spec: { duration_seconds: 1800, unit: 'seconds', success_rule: 'duration' },
      }),
    ])).json() as { receipts: Receipt[] };
    const templateId = template.receipts[0]?.result?.['template_id'] as string;

    const occurrence = (await push([
      envelope('materialize_occurrence', {
        template_id: templateId,
        recurrence_key: 'конфликт',
        timezone: 'Europe/Moscow',
      }),
    ])).json() as { receipts: Receipt[] };
    const occurrenceId = occurrence.receipts[0]?.result?.['occurrence_id'] as string;
    const version = Number(occurrence.receipts[0]?.result?.['version']);

    // Обе команды называют одну и ту же версию: вторая решает по состоянию,
    // которого уже нет.
    const response = await push([
      envelope('start_quest', {}, { aggregateId: occurrenceId, expectedVersion: version }),
      envelope('complete_quest', {}, { aggregateId: occurrenceId, expectedVersion: version }),
    ]);

    const receipts = (response.json() as { receipts: Receipt[] }).receipts;
    expect(receipts[0]?.status).toBe('committed');
    expect(receipts[1]).toMatchObject({ status: 'conflict', error: 'version_conflict' });
  });

  it('повтор той же команды внутри пачки не даёт второго эффекта', async () => {
    const commandId = randomUUID();
    const once = goal('Повтор в пачке');
    const twice = { ...once, command_id: commandId };

    const response = await push([{ ...twice }, { ...twice }]);

    const receipts = (response.json() as { receipts: Receipt[] }).receipts;
    expect(receipts[0]?.status).toBe('committed');
    expect(receipts[1]?.status).toBe('already_applied');
    expect(await countGoals('Повтор в пачке')).toBe(1);
  });

  it('пустая пачка отклоняется', async () => {
    expect((await push([])).statusCode).toBe(400);
  });

  it('слишком большая пачка отклоняется целиком', async () => {
    const many = Array.from({ length: 51 }, (_, index) => goal(`Много ${index}`));

    const response = await push(many);

    // Отказ до выполнения, а не после половины: частично применённая пачка
    // оставляет клиента в состоянии, которого он не ожидает.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'batch_too_large' });
    expect(await countGoals('Много 0')).toBe(0);
  });

  it('лишнее поле в теле запроса отклоняется', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${token}` },
      payload: { commands: [goal('Лишнее поле')], hurry: true },
    });

    expect(response.statusCode).toBe(400);
  });

  it('пачка и одиночная команда разбираются одинаково', async () => {
    // Один и тот же нарушенный контракт должен отвергаться обоими путями:
    // отдельный разбор для пачки разошёлся бы с одиночным незаметно.
    const withVersion = envelope('create_goal', { title: 'С версией', start_date: '2026-09-01' }, {
      expectedVersion: 0,
    });

    const single = await app.inject({
      method: 'POST',
      url: '/commands',
      headers: { authorization: `Bearer ${token}` },
      payload: withVersion,
    });
    const batched = (await push([withVersion])).json() as { receipts: Receipt[] };

    expect(single.statusCode).toBe(400);
    expect(single.json()).toMatchObject({ error: 'version_required' });
    expect(batched.receipts[0]).toMatchObject({ status: 'rejected', error: 'version_required' });
  });
});
