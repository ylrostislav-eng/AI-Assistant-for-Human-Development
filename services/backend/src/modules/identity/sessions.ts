import { createHash, randomBytes } from 'node:crypto';

import { withTransaction, type Database, type TransactionClient } from '../../shared/db/pool.ts';

/**
 * Хранилище сессий: выпуск, ротация и отзыв refresh-токенов.
 *
 * Правила и сроки — docs/09, раздел 2. Прототип и найденные на нём ошибки
 * описаны в docs/security-prototype-session-rotation.md; здесь та же логика на
 * реальной схеме, через роль времени выполнения и политики RLS.
 *
 * Проверка Apple identity token сюда не входит: она требует ключей Apple и
 * остаётся незакрытой частью P1-02. Пользователь здесь считается уже
 * определённым.
 */

export const REFRESH_TTL_DAYS = 30;
export const ACCESS_TTL_MINUTES = 15;

export interface IssuedSession {
  readonly refreshToken: string;
  /**
   * Короткоживущий токен для обычных запросов. Живёт 15 минут, поэтому
   * украденный access устаревает сам; долгоживущий refresh предъявляется
   * только при обновлении и отзывается целой семьёй.
   */
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly familyId: string;
  readonly expiresAt: Date;
}

export interface AuthenticatedSession {
  readonly userId: string;
  readonly sessionId: string;
}

export class UnknownTokenError extends Error {}
export class ExpiredTokenError extends Error {}
export class RevokedFamilyError extends Error {}
export class TokenReuseError extends Error {}

/**
 * Токен — 32 случайных байта, поэтому хранится SHA-256, а не bcrypt/argon2.
 * Медленный хеш защищает от перебора коротких паролей; перебирать здесь нечего,
 * а замедление легло бы на каждое обновление сессии.
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

function accessExpiry(now: Date): Date {
  return new Date(now.getTime() + ACCESS_TTL_MINUTES * 60 * 1000);
}

/** Контекст пользователя для политик изоляции. */
async function setUser(client: TransactionClient, userId: string): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
}

/**
 * Контекст предъявленного токена. Открывает ровно ту строку, хеш которой задан,
 * и действует до конца транзакции.
 */
async function setRefreshHash(client: TransactionClient, hash: string): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.refresh_hash', hash]);
}

export async function issueSession(
  db: Database,
  userId: string,
  deviceId: string | null,
  now: Date = new Date(),
): Promise<IssuedSession> {
  const refreshToken = createToken();
  const accessToken = createToken();

  return withTransaction(db, async (client) => {
    await setUser(client, userId);
    const result = await client.query<{
      family_id: string;
      expires_at: Date;
      access_expires_at: Date;
    }>(
      `INSERT INTO sessions
         (user_id, device_id, family_id, refresh_hash, issued_at, expires_at,
          access_hash, access_expires_at)
       VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7)
       RETURNING family_id, expires_at, access_expires_at`,
      [
        userId,
        deviceId,
        hashToken(refreshToken),
        now,
        refreshExpiry(now),
        hashToken(accessToken),
        accessExpiry(now),
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Сессия не создана');
    }
    return {
      refreshToken,
      accessToken,
      accessExpiresAt: row.access_expires_at,
      familyId: row.family_id,
      expiresAt: row.expires_at,
    };
  });
}

/**
 * Проверка access-токена для обычных запросов.
 *
 * Отзыв действует немедленно: токен непрозрачный и проверяется по базе, а не
 * подписью. Подписанный токен пришлось бы считать действительным до истечения
 * срока либо вести отдельный список отозванных — для личного приложения это
 * лишняя сущность, а задержка отзыва здесь недопустима.
 */
export async function authenticateAccessToken(
  db: Database,
  presentedToken: string,
  now: Date = new Date(),
): Promise<AuthenticatedSession | null> {
  const hash = hashToken(presentedToken);

  return withTransaction(db, async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['app.access_hash', hash]);

    const found = await client.query<{
      id: string;
      user_id: string;
      access_expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, access_expires_at, revoked_at
         FROM sessions WHERE access_hash = $1`,
      [hash],
    );

    const session = found.rows[0];
    if (session === undefined) {
      return null;
    }
    if (session.revoked_at !== null) {
      return null;
    }
    if (session.access_expires_at.getTime() <= now.getTime()) {
      return null;
    }

    return { userId: session.user_id, sessionId: session.id };
  });
}

async function revokeFamilyWithin(
  client: TransactionClient,
  familyId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE sessions SET revoked_at = $1, revoke_reason = $2
      WHERE family_id = $3 AND revoked_at IS NULL`,
    [now, reason, familyId],
  );
}

export async function revokeFamily(
  db: Database,
  userId: string,
  familyId: string,
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  await withTransaction(db, async (client) => {
    await setUser(client, userId);
    await revokeFamilyWithin(client, familyId, reason, now);
  });
}

type RotationOutcome =
  | { readonly kind: 'rotated'; readonly session: IssuedSession }
  | { readonly kind: 'reuse' };

/**
 * Ротация: предъявленный токен гасится, в той же семье выдаётся новый.
 *
 * Строка берётся `FOR UPDATE`: без блокировки два одновременных обновления с
 * одним токеном выдали бы два действующих, и украденный остался бы рабочим.
 *
 * Повторное предъявление уже использованного токена означает, что он есть у
 * двоих. Отличить владельца от похитителя нельзя, поэтому отзывается вся семья.
 */
export async function rotateSession(
  db: Database,
  presentedToken: string,
  now: Date = new Date(),
): Promise<IssuedSession> {
  const hash = hashToken(presentedToken);

  const outcome = await withTransaction<RotationOutcome>(db, async (client) => {
    // Шаг 1: найти владельца токена. Контекст пользователя ещё неизвестен,
    // поэтому строку открывает политика по предъявленному хешу.
    //
    // Блокировки здесь намеренно нет: PostgreSQL применяет к SELECT ... FOR
    // UPDATE ещё и политики изменения, а они требуют app.user_id, которого на
    // этом шаге нет, — запрос возвращал бы пустой результат и вход был бы
    // невозможен. Это выяснилось на первом прогоне проверок.
    await setRefreshHash(client, hash);

    const owner = await client.query<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE refresh_hash = $1',
      [hash],
    );

    const userId = owner.rows[0]?.user_id;
    if (userId === undefined) {
      throw new UnknownTokenError('Неизвестный refresh-токен');
    }

    // Шаг 2: пользователь известен, дальше действуют обычные политики владельца.
    await setUser(client, userId);

    // Блокировка берётся до любых изменений, поэтому два одновременных
    // обновления одним токеном по-прежнему сериализуются.
    const found = await client.query<{
      id: string;
      user_id: string;
      device_id: string | null;
      family_id: string;
      expires_at: Date;
      rotated_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, device_id, family_id, expires_at, rotated_at, revoked_at
         FROM sessions WHERE refresh_hash = $1 FOR UPDATE`,
      [hash],
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
      // Возврат, а не throw: исключение откатило бы транзакцию вместе с
      // отзывом, и защита сообщала бы о срабатывании, не сработав. Эта ошибка
      // была допущена на прототипе и найдена проверкой.
      return { kind: 'reuse' };
    }
    if (session.expires_at.getTime() <= now.getTime()) {
      throw new ExpiredTokenError('Срок действия refresh-токена истёк');
    }

    const nextRefresh = createToken();
    const nextAccess = createToken();
    // Прежний access гасится вместе с refresh: иначе после обновления сессии
    // старый токен продолжал бы отвечать до конца своих 15 минут.
    await client.query(
      'UPDATE sessions SET rotated_at = $1, access_hash = NULL, access_expires_at = NULL WHERE id = $2',
      [now, session.id],
    );
    const inserted = await client.query<{ expires_at: Date; access_expires_at: Date }>(
      `INSERT INTO sessions
         (user_id, device_id, family_id, refresh_hash, issued_at, expires_at,
          access_hash, access_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING expires_at, access_expires_at`,
      [
        session.user_id,
        session.device_id,
        session.family_id,
        hashToken(nextRefresh),
        now,
        refreshExpiry(now),
        hashToken(nextAccess),
        accessExpiry(now),
      ],
    );

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('Новая сессия не создана');
    }
    return {
      kind: 'rotated',
      session: {
        refreshToken: nextRefresh,
        accessToken: nextAccess,
        accessExpiresAt: row.access_expires_at,
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
