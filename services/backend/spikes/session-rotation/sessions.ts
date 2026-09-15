import { createHash, randomBytes } from 'node:crypto';

import { withTransaction, type Database, type TransactionClient } from '../../src/shared/db/pool.ts';

/**
 * Прототип P0-04: выпуск, ротация и отзыв refresh-токенов.
 *
 * Это spike, а не модуль identity: проверка Apple identity token относится к
 * P1-02, здесь пользователь задаётся синтетическим идентификатором. Проверяется
 * то, что ломается чаще всего и тише всего — ротация и обнаружение повторного
 * использования украденного токена (docs/09, раздел 2).
 *
 * Сроки взяты оттуда же: access 15 минут, refresh 30 дней с ротацией.
 */

export const ACCESS_TTL_MINUTES = 15;
export const REFRESH_TTL_DAYS = 30;

export interface IssuedSession {
  readonly refreshToken: string;
  readonly familyId: string;
  readonly expiresAt: Date;
}

export class UnknownTokenError extends Error {}
export class ExpiredTokenError extends Error {}
export class RevokedFamilyError extends Error {}
export class TokenReuseError extends Error {}

/**
 * Токен — 32 случайных байта, поэтому хранится SHA-256, а не bcrypt/argon2.
 * Медленный хеш защищает от перебора коротких паролей; здесь перебирать нечего,
 * а замедление каждой ротации обошлось бы в задержку на каждом запросе.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function createToken(): string {
  return randomBytes(32).toString('base64url');
}

function refreshExpiry(now: Date): Date {
  return new Date(now.getTime() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export async function createSchema(db: Database): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS spike_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      device_id TEXT NOT NULL,
      family_id UUID NOT NULL,
      refresh_hash TEXT NOT NULL UNIQUE,
      issued_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      rotated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      revoke_reason TEXT
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS spike_sessions_family ON spike_sessions (family_id)');
}

export async function dropSchema(db: Database): Promise<void> {
  await db.query('DROP TABLE IF EXISTS spike_sessions');
}

export async function issueSession(
  db: Database,
  userId: string,
  deviceId: string,
  now: Date = new Date(),
): Promise<IssuedSession> {
  const token = createToken();
  const result = await db.query<{ family_id: string; expires_at: Date }>(
    `INSERT INTO spike_sessions (user_id, device_id, family_id, refresh_hash, issued_at, expires_at)
     VALUES ($1, $2, gen_random_uuid(), $3, $4, $5)
     RETURNING family_id, expires_at`,
    [userId, deviceId, hashToken(token), now, refreshExpiry(now)],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Сессия не создана');
  }
  return { refreshToken: token, familyId: row.family_id, expiresAt: row.expires_at };
}

async function revokeFamilyWithin(
  client: TransactionClient,
  familyId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE spike_sessions
        SET revoked_at = $1, revoke_reason = $2
      WHERE family_id = $3 AND revoked_at IS NULL`,
    [now, reason, familyId],
  );
}

export async function revokeFamily(
  db: Database,
  familyId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await withTransaction(db, async (client) => {
    await revokeFamilyWithin(client, familyId, reason, now);
  });
}

/**
 * Ротация: предъявленный токен гасится и выдаётся новый в той же семье.
 *
 * Строка берётся с `FOR UPDATE` в одной транзакции: без блокировки два
 * одновременных обновления с одним токеном выдали бы два действующих токена,
 * и украденный остался бы рабочим.
 *
 * Повторное предъявление уже использованного токена означает, что он у двух
 * сторон сразу: настоящий владелец и тот, кто его скопировал. Отличить их
 * нельзя, поэтому отзывается вся семья — это делает кражу заметной и
 * ограничивает её по времени.
 */
type RotationOutcome =
  | { readonly kind: 'rotated'; readonly session: IssuedSession }
  | { readonly kind: 'reuse' };

export async function rotateSession(
  db: Database,
  presentedToken: string,
  now: Date = new Date(),
): Promise<IssuedSession> {
  const outcome = await withTransaction<RotationOutcome>(db, async (client) => {
    const found = await client.query<{
      id: string;
      user_id: string;
      device_id: string;
      family_id: string;
      expires_at: Date;
      rotated_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, device_id, family_id, expires_at, rotated_at, revoked_at
         FROM spike_sessions
        WHERE refresh_hash = $1
        FOR UPDATE`,
      [hashToken(presentedToken)],
    );

    const session = found.rows[0];
    if (session === undefined) {
      throw new UnknownTokenError('Неизвестный refresh-токен');
    }
    if (session.revoked_at !== null) {
      throw new RevokedFamilyError('Сессия отозвана');
    }
    if (session.rotated_at !== null) {
      await revokeFamilyWithin(client, session.family_id, 'token_reuse', now);
      // Именно возврат, а не throw: исключение откатило бы транзакцию вместе с
      // только что выполненным отзывом. В первой версии проверка бросала
      // TokenReuseError отсюда, и снаружи всё выглядело правильно — ошибка
      // возвращалась, — но семья оставалась действующей, то есть украденный
      // токен продолжал работать. Нашлось тестом «отзывает всю семью».
      return { kind: 'reuse' };
    }
    if (session.expires_at.getTime() <= now.getTime()) {
      throw new ExpiredTokenError('Срок действия refresh-токена истёк');
    }

    const nextToken = createToken();
    await client.query('UPDATE spike_sessions SET rotated_at = $1 WHERE id = $2', [
      now,
      session.id,
    ]);
    const inserted = await client.query<{ expires_at: Date }>(
      `INSERT INTO spike_sessions (user_id, device_id, family_id, refresh_hash, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING expires_at`,
      [
        session.user_id,
        session.device_id,
        session.family_id,
        hashToken(nextToken),
        now,
        refreshExpiry(now),
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('Новая сессия не создана');
    }
    return {
      kind: 'rotated',
      session: {
        refreshToken: nextToken,
        familyId: session.family_id,
        expiresAt: row.expires_at,
      },
    };
  });

  if (outcome.kind === 'reuse') {
    throw new TokenReuseError('Повторное использование токена: семья сессий отозвана');
  }
  return outcome.session;
}
