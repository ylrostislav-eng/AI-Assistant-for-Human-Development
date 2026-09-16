import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { withTenantTransaction } from '../../src/shared/db/tenant.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки маршрута команд: граница доверия и проверка конверта по контракту.
 */

const RUNTIME_ROLE = 'app_runtime';

let ownerDb: Database;
let runtimeDb: Database;
let app: FastifyInstance;
let config: AppConfig;

beforeAll(async () => {
  const base = loadConfig();
  ownerDb = createPool(base.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);

  const url = new URL(base.database.connectionString);
  url.username = RUNTIME_ROLE;
  url.password = '';
  runtimeDb = createPool({ ...base.database, connectionString: url.toString(), maxConnections: 4 });

  config = { ...base, devAuthEnabled: true };
  app = createApp({ config, database: runtimeDb });
});

afterAll(async () => {
  await app.close();
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

async function login(subject: string): Promise<{ userId: string; accessToken: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { subject },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { userId: body.user_id, accessToken: body.access_token };
}

function envelope(kind: string, payload: Record<string, unknown>, commandId = randomUUID()) {
  return {
    schema_version: 1,
    command_id: commandId,
    device_id: randomUUID(),
    kind,
    aggregate_id: null,
    expected_version: null,
    client_created_at: '2026-09-16T10:00:00Z',
    depends_on_command_id: null,
    payload,
  };
}

const GOAL_PAYLOAD = { title: 'Английский', start_date: '2026-09-01' };

async function send(accessToken: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/commands',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: body as Record<string, unknown>,
  });
}

describe('доступ к маршруту команд', () => {
  it('без токена отвечает 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/commands',
      payload: envelope('create_goal', GOAL_PAYLOAD),
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('проверка конверта по контракту', () => {
  it('принимает корректный конверт', async () => {
    const session = await login('конверт-ок');

    const response = await send(session.accessToken, envelope('create_goal', GOAL_PAYLOAD));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ duplicate: false });
    expect(response.json().result.goal_id).toBeTruthy();
  });

  it('отклоняет постороннее поле в конверте', async () => {
    const session = await login('конверт-лишнее');

    // Схема закрыта: неизвестное поле означает, что клиент и сервер понимают
    // команду по-разному.
    const response = await send(session.accessToken, {
      ...envelope('create_goal', GOAL_PAYLOAD),
      user_id: 'подставленный',
    });

    expect(response.statusCode).toBe(400);
  });

  it('отклоняет конверт без обязательного поля', async () => {
    const session = await login('конверт-без-поля');
    const { command_id: _omitted, ...withoutId } = envelope('create_goal', GOAL_PAYLOAD);

    const response = await send(session.accessToken, withoutId);

    expect(response.statusCode).toBe(400);
  });

  it('отклоняет command_id не в формате uuid', async () => {
    const session = await login('конверт-не-uuid');

    const response = await send(session.accessToken, {
      ...envelope('create_goal', GOAL_PAYLOAD),
      command_id: 'не-uuid',
    });

    // Без проверки формата ajv пропустил бы любую строку, и идемпотентность
    // держалась бы на честном слове клиента.
    expect(response.statusCode).toBe(400);
  });

  it('отклоняет неизвестный вид команды', async () => {
    const session = await login('неизвестная-команда');

    const response = await send(session.accessToken, envelope('стереть_всё', {}));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'unknown_command_kind' });
  });

  it('отклоняет негодную нагрузку', async () => {
    const session = await login('плохая-нагрузка');

    const response = await send(
      session.accessToken,
      envelope('create_goal', { title: 'Без даты' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_payload' });
  });
});

describe('граница доверия', () => {
  it('цель создаётся тому пользователю, чей токен предъявлен', async () => {
    const first = await login('владелец-цели');
    const second = await login('посторонний');

    const response = await send(first.accessToken, envelope('create_goal', GOAL_PAYLOAD));
    const goalId = response.json().result.goal_id;

    const seenByOwner = await withTenantTransaction(runtimeDb, first.userId, async (client) => {
      return client.query('SELECT id FROM goals WHERE id = $1', [goalId]);
    });
    const seenByOther = await withTenantTransaction(runtimeDb, second.userId, async (client) => {
      return client.query('SELECT id FROM goals WHERE id = $1', [goalId]);
    });

    expect(seenByOwner.rowCount).toBe(1);
    expect(seenByOther.rowCount).toBe(0);
  });
});

describe('идемпотентность через маршрут', () => {
  it('повтор конверта возвращает прежнюю квитанцию и не создаёт вторую цель', async () => {
    const session = await login('повтор-через-маршрут');
    const body = envelope('create_goal', { title: 'Единственная', start_date: '2026-09-01' });

    const first = await send(session.accessToken, body);
    const second = await send(session.accessToken, body);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      duplicate: true,
      committed_seq: first.json().committed_seq,
    });
    expect(second.json().result).toEqual(first.json().result);

    const goals = await withTenantTransaction(runtimeDb, session.userId, async (client) => {
      return client.query('SELECT id FROM goals WHERE title = $1', ['Единственная']);
    });
    expect(goals.rowCount).toBe(1);
  });

  it('тот же command_id с другой нагрузкой даёт 409', async () => {
    const session = await login('конфликт-нагрузки');
    const commandId = randomUUID();

    await send(session.accessToken, envelope('create_goal', GOAL_PAYLOAD, commandId));
    const conflict = await send(
      session.accessToken,
      envelope('create_goal', { title: 'Другая', start_date: '2026-09-01' }, commandId),
    );

    // Запрос корректен сам по себе, конфликтует он с зафиксированным
    // состоянием, поэтому 409, а не 400.
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'command_id_reused' });
  });

  it('тот же command_id у другого пользователя выполняется', async () => {
    const first = await login('пользователь-один');
    const second = await login('пользователь-два');
    const commandId = randomUUID();

    await send(first.accessToken, envelope('create_goal', GOAL_PAYLOAD, commandId));
    const other = await send(second.accessToken, envelope('create_goal', GOAL_PAYLOAD, commandId));

    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ duplicate: false });
  });
});
