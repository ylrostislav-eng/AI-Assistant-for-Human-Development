import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import {
  createSchema,
  dropSchema,
  ExpiredTokenError,
  issueSession,
  REFRESH_TTL_DAYS,
  revokeFamily,
  RevokedFamilyError,
  rotateSession,
  TokenReuseError,
  UnknownTokenError,
} from './sessions.ts';

const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';
const DEVICE = 'iphone-прототип';

/**
 * Время передаётся параметром, а не берётся системное: иначе проверка срока
 * действия потребовала бы ждать 30 дней или подменять системные часы.
 */
const NOW = new Date('2026-09-15T12:00:00.000Z');
const LATER = new Date('2026-09-16T12:00:00.000Z');
const AFTER_EXPIRY = new Date(NOW.getTime() + (REFRESH_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);

let db: Database;

beforeAll(async () => {
  db = createPool(loadConfig().database);
  await dropSchema(db);
  await createSchema(db);
});

afterAll(async () => {
  await dropSchema(db);
  await db.end();
});

afterEach(async () => {
  await db.query('DELETE FROM spike_sessions');
});

describe('выпуск сессии', () => {
  it('не хранит сам токен, только его хеш', async () => {
    const session = await issueSession(db, USER, DEVICE, NOW);

    const stored = await db.query<{ refresh_hash: string }>(
      'SELECT refresh_hash FROM spike_sessions',
    );
    const hash = stored.rows[0]?.refresh_hash ?? '';

    // Утечка базы не должна давать рабочие токены.
    expect(hash).not.toBe(session.refreshToken);
    expect(hash).not.toContain(session.refreshToken);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('задаёт срок действия refresh в 30 дней', async () => {
    const session = await issueSession(db, USER, DEVICE, NOW);
    const days = (session.expiresAt.getTime() - NOW.getTime()) / (24 * 60 * 60 * 1000);

    expect(days).toBe(REFRESH_TTL_DAYS);
  });
});

describe('ротация', () => {
  it('выдаёт новый токен и гасит предъявленный', async () => {
    const first = await issueSession(db, USER, DEVICE, NOW);
    const second = await rotateSession(db, first.refreshToken, LATER);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.familyId).toBe(first.familyId);

    // Новый токен работает.
    await expect(rotateSession(db, second.refreshToken, LATER)).resolves.toBeDefined();
  });

  it('отклоняет неизвестный токен', async () => {
    await expect(rotateSession(db, 'выдуманный-токен', NOW)).rejects.toBeInstanceOf(
      UnknownTokenError,
    );
  });

  it('отклоняет токен с истёкшим сроком', async () => {
    const session = await issueSession(db, USER, DEVICE, NOW);

    await expect(rotateSession(db, session.refreshToken, AFTER_EXPIRY)).rejects.toBeInstanceOf(
      ExpiredTokenError,
    );
  });

  it('токен одного пользователя не даёт доступа к сессии другого', async () => {
    const mine = await issueSession(db, USER, DEVICE, NOW);
    await issueSession(db, OTHER_USER, DEVICE, NOW);

    const rotated = await rotateSession(db, mine.refreshToken, LATER);
    const rows = await db.query<{ user_id: string }>(
      'SELECT user_id FROM spike_sessions WHERE family_id = $1',
      [rotated.familyId],
    );

    expect(rows.rows.every((row) => row.user_id === USER)).toBe(true);
  });
});

describe('обнаружение повторного использования', () => {
  it('отзывает всю семью, включая действующий токен настоящего владельца', async () => {
    const first = await issueSession(db, USER, DEVICE, NOW);
    const second = await rotateSession(db, first.refreshToken, LATER);

    // Похититель предъявляет перехваченный старый токен.
    await expect(rotateSession(db, first.refreshToken, LATER)).rejects.toBeInstanceOf(
      TokenReuseError,
    );

    // Настоящий владелец тоже теряет доступ: отличить его от похитителя нельзя,
    // и оставить семью рабочей означало бы оставить рабочим украденный токен.
    await expect(rotateSession(db, second.refreshToken, LATER)).rejects.toBeInstanceOf(
      RevokedFamilyError,
    );

    const revoked = await db.query<{ revoke_reason: string }>(
      'SELECT DISTINCT revoke_reason FROM spike_sessions WHERE revoked_at IS NOT NULL',
    );
    expect(revoked.rows).toEqual([{ revoke_reason: 'token_reuse' }]);
  });

  it('не задевает сессии других семей', async () => {
    const compromised = await issueSession(db, USER, DEVICE, NOW);
    const otherDevice = await issueSession(db, USER, 'ipad-прототип', NOW);
    await rotateSession(db, compromised.refreshToken, LATER);
    await expect(rotateSession(db, compromised.refreshToken, LATER)).rejects.toBeInstanceOf(
      TokenReuseError,
    );

    // Кража на одном устройстве не должна выбрасывать пользователя со всех.
    await expect(rotateSession(db, otherDevice.refreshToken, LATER)).resolves.toBeDefined();
  });
});

describe('отзыв', () => {
  it('после отзыва семьи токен не работает', async () => {
    const session = await issueSession(db, USER, DEVICE, NOW);
    await revokeFamily(db, session.familyId, 'logout', LATER);

    await expect(rotateSession(db, session.refreshToken, LATER)).rejects.toBeInstanceOf(
      RevokedFamilyError,
    );
  });
});

describe('гонка двух одновременных обновлений', () => {
  it('одним токеном нельзя получить два действующих', async () => {
    const session = await issueSession(db, USER, DEVICE, NOW);

    const results = await Promise.allSettled([
      rotateSession(db, session.refreshToken, LATER),
      rotateSession(db, session.refreshToken, LATER),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    // Главный инвариант: два действующих токена из одного не рождаются.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Вторая попытка неотличима от кражи, поэтому семья отзывается. Это
    // известная плата за строгое обнаружение: повтор запроса клиентом при
    // обрыве сети приведёт к разлогиниванию. Окно допуска для повторов —
    // открытый вопрос для P1-02, здесь оно намеренно не вводится, чтобы
    // поведение было явным.
    const reason = await db.query<{ revoke_reason: string | null }>(
      'SELECT DISTINCT revoke_reason FROM spike_sessions',
    );
    expect(reason.rows).toEqual([{ revoke_reason: 'token_reuse' }]);
  });
});
