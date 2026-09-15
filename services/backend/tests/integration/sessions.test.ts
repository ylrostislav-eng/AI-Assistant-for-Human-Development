import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import {
  ExpiredTokenError,
  issueSession,
  REFRESH_TTL_DAYS,
  revokeFamily,
  RevokedFamilyError,
  rotateSession,
  TokenReuseError,
  UnknownTokenError,
} from '../../src/modules/identity/sessions.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, withTransaction, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Проверки хранилища сессий на реальной схеме и **через роль времени
 * выполнения**: именно под ней действуют политики RLS. Под владельцем таблиц
 * проверка чтения сессии до аутентификации прошла бы вхолостую — там политика
 * по хешу вообще не понадобилась бы.
 */

const RUNTIME_ROLE = 'app_runtime';

const USER_A = '12121212-1212-4121-8121-121212121212';
const USER_B = '13131313-1313-4131-8131-131313131313';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const LATER = new Date('2026-09-16T12:00:00.000Z');
const AFTER_EXPIRY = new Date(NOW.getTime() + (REFRESH_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);

let ownerDb: Database;
let runtimeDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  const applied = await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  expect(applied.applied).toContain('006_session_lookup.sql');

  await ownerDb.query(
    'INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3), ($4, $5, $6)',
    [USER_A, 'apple', 'session-a', USER_B, 'apple', 'session-b'],
  );

  const url = new URL(config.database.connectionString);
  url.username = RUNTIME_ROLE;
  url.password = '';
  runtimeDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 3 });
});

afterAll(async () => {
  await runtimeDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

describe('чтение сессии до аутентификации', () => {
  it('без контекста токена строка не видна', async () => {
    await issueSession(runtimeDb, USER_A, null, NOW);

    const result = await runtimeDb.query('SELECT id FROM sessions');

    // Запрет по умолчанию сохраняется: политика по хешу ничего не открывает
    // тому, кто хеша не предъявил.
    expect(result.rowCount).toBe(0);
  });

  it('по неверному хешу не видно ничего', async () => {
    await issueSession(runtimeDb, USER_A, null, NOW);

    // Контекст задаётся транзакционно: значение на уровне сеанса осталось бы
    // на соединении пула и открывало бы строку следующему запросу.
    const rows = await withTransaction(runtimeDb, async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.refresh_hash', 'подобранный']);
      return client.query('SELECT id FROM sessions');
    });

    expect(rows.rowCount).toBe(0);
  });
});

describe('выпуск и ротация', () => {
  it('сервер хранит хеш, а не токен', async () => {
    const session = await issueSession(runtimeDb, USER_A, null, NOW);

    const stored = await ownerDb.query<{ refresh_hash: string }>(
      'SELECT refresh_hash FROM sessions WHERE family_id = $1',
      [session.familyId],
    );

    expect(stored.rows[0]?.refresh_hash).not.toBe(session.refreshToken);
    expect(stored.rows[0]?.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ротация выдаёт новый токен и гасит предъявленный', async () => {
    const first = await issueSession(runtimeDb, USER_A, null, NOW);
    const second = await rotateSession(runtimeDb, first.refreshToken, LATER);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.familyId).toBe(first.familyId);
    await expect(rotateSession(runtimeDb, second.refreshToken, LATER)).resolves.toBeDefined();
  });

  it('неизвестный токен отклоняется', async () => {
    await expect(rotateSession(runtimeDb, 'выдуманный', LATER)).rejects.toBeInstanceOf(
      UnknownTokenError,
    );
  });

  it('истёкший токен отклоняется', async () => {
    const session = await issueSession(runtimeDb, USER_A, null, NOW);

    await expect(rotateSession(runtimeDb, session.refreshToken, AFTER_EXPIRY)).rejects.toBeInstanceOf(
      ExpiredTokenError,
    );
  });
});

describe('обнаружение кражи', () => {
  it('повторное использование отзывает семью вместе с действующим токеном', async () => {
    const first = await issueSession(runtimeDb, USER_A, null, NOW);
    const second = await rotateSession(runtimeDb, first.refreshToken, LATER);

    await expect(rotateSession(runtimeDb, first.refreshToken, LATER)).rejects.toBeInstanceOf(
      TokenReuseError,
    );

    // Проверка отзыва обязательна: первая версия на прототипе возвращала эту
    // же ошибку, но отзыв откатывался вместе с транзакцией.
    await expect(rotateSession(runtimeDb, second.refreshToken, LATER)).rejects.toBeInstanceOf(
      RevokedFamilyError,
    );

    const revoked = await ownerDb.query<{ revoke_reason: string }>(
      'SELECT DISTINCT revoke_reason FROM sessions WHERE family_id = $1 AND revoked_at IS NOT NULL',
      [first.familyId],
    );
    expect(revoked.rows).toEqual([{ revoke_reason: 'token_reuse' }]);
  });

  it('кража в одной семье не трогает другие устройства', async () => {
    const stolen = await issueSession(runtimeDb, USER_A, null, NOW);
    const other = await issueSession(runtimeDb, USER_A, null, NOW);
    await rotateSession(runtimeDb, stolen.refreshToken, LATER);
    await expect(rotateSession(runtimeDb, stolen.refreshToken, LATER)).rejects.toBeInstanceOf(
      TokenReuseError,
    );

    await expect(rotateSession(runtimeDb, other.refreshToken, LATER)).resolves.toBeDefined();
  });

  it('сессии другого пользователя не задеты', async () => {
    const mine = await issueSession(runtimeDb, USER_A, null, NOW);
    const theirs = await issueSession(runtimeDb, USER_B, null, NOW);
    await rotateSession(runtimeDb, mine.refreshToken, LATER);
    await expect(rotateSession(runtimeDb, mine.refreshToken, LATER)).rejects.toBeInstanceOf(
      TokenReuseError,
    );

    await expect(rotateSession(runtimeDb, theirs.refreshToken, LATER)).resolves.toBeDefined();
  });
});

describe('отзыв', () => {
  it('после отзыва семьи токен не работает', async () => {
    const session = await issueSession(runtimeDb, USER_A, null, NOW);
    await revokeFamily(runtimeDb, USER_A, session.familyId, 'logout', LATER);

    await expect(rotateSession(runtimeDb, session.refreshToken, LATER)).rejects.toBeInstanceOf(
      RevokedFamilyError,
    );
  });

  it('чужой пользователь не может отозвать сессию', async () => {
    const session = await issueSession(runtimeDb, USER_A, null, NOW);

    // Политика владельца не даёт увидеть чужие строки, поэтому UPDATE не
    // находит цели и ничего не меняет.
    await revokeFamily(runtimeDb, USER_B, session.familyId, 'атака', LATER);

    await expect(rotateSession(runtimeDb, session.refreshToken, LATER)).resolves.toBeDefined();
  });
});

describe('гонка', () => {
  it('одним токеном нельзя получить два действующих', async () => {
    const session = await issueSession(runtimeDb, USER_A, null, NOW);

    const results = await Promise.allSettled([
      rotateSession(runtimeDb, session.refreshToken, LATER),
      rotateSession(runtimeDb, session.refreshToken, LATER),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
