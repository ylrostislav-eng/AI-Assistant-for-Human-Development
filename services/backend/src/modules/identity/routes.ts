import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { AppConfig, TelegramConfig } from '../../config.ts';
import { withTransaction, type Database } from '../../shared/db/pool.ts';
import { logError } from '../../shared/logging/logger.ts';
import {
  ExpiredTokenError,
  issueSession,
  revokeFamily,
  RevokedFamilyError,
  rotateSession,
  TokenReuseError,
  UnknownTokenError,
  type IssuedSession,
} from './sessions.ts';
import { InitDataError, verifyInitData } from './telegram.ts';

/**
 * Маршруты входа. Проверка Apple identity token не реализована — она требует
 * ключей Apple; вместо неё в разработке доступен вход по синтетической
 * личности (docs/09, раздел 2), запрещённый в production.
 */

interface DevLoginBody {
  readonly subject?: string;
}

interface RefreshBody {
  readonly refresh_token?: string;
}

interface LogoutBody {
  readonly family_id?: string;
}

interface TelegramLoginBody {
  readonly init_data?: string;
  readonly installation_id?: string;
}

/**
 * Тело запроса входа закрыто: лишнее поле означает, что клиент рассчитывает на
 * поведение, которого нет.
 */
const telegramLoginSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['init_data'],
  properties: {
    init_data: { type: 'string', minLength: 1, maxLength: 8192 },
    installation_id: { type: 'string', format: 'uuid' },
  },
} as const;

/**
 * Разбор отказов проверки подписи.
 *
 * 400 — клиент собрал запрос неправильно и может это исправить. 401 — личность
 * не подтверждена: подделка, просроченное доказательство, чужой человек. Почему
 * именно не подтверждена, знает клиент (он собирал запрос), а подбирающему
 * различие не даёт ничего нового: все эти случаи для него одинаково «не
 * прошло».
 */
const MALFORMED_CODES = new Set([
  'initdata_too_large',
  'initdata_malformed',
  'initdata_duplicate_key',
  'initdata_hash_missing',
  'initdata_no_user',
  'initdata_user_id_unsafe',
]);

/**
 * Идентификатор синтетического пользователя выводится из subject детерминированно.
 *
 * Иначе каждый вход разработчика создавал бы нового пользователя: искать
 * существующего по subject нельзя — политика изоляции показывает только
 * собственную строку, а чтобы её увидеть, идентификатор уже нужен.
 */
function devUserId(subject: string): string {
  const digest = createHash('sha256').update(`dev:${subject}`, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Версия 4 и вариант RFC: значение должно быть корректным UUID, иначе его
  // отвергнет тип колонки.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Повторно предъявленное доказательство входа. */
class ProofReusedError extends Error {}

function sessionResponse(session: IssuedSession): Record<string, unknown> {
  return {
    access_token: session.accessToken,
    access_expires_at: session.accessExpiresAt.toISOString(),
    refresh_token: session.refreshToken,
    refresh_expires_at: session.expiresAt.toISOString(),
    family_id: session.familyId,
  };
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  config: AppConfig,
  database: Database,
): void {
  app.post('/auth/dev-login', async (request, reply) => {
    if (!config.devAuthEnabled) {
      // 404, а не 403: отключённый маршрут не должен подтверждать своё
      // существование.
      return reply.code(404).send({ error: 'not_found' });
    }

    const body = (request.body ?? {}) as DevLoginBody;
    const subject = body.subject ?? 'dev';
    const userId = devUserId(subject);

    await withTransaction(database, async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
      await client.query(
        `INSERT INTO users (id, auth_issuer, auth_subject)
         VALUES ($1, 'dev', $2)
         ON CONFLICT (auth_issuer, auth_subject) DO NOTHING`,
        [userId, subject],
      );
    });

    const session = await issueSession(database, userId, null);
    return reply.code(201).send({ user_id: userId, ...sessionResponse(session) });
  });

  app.post(
    '/auth/telegram',
    { schema: { body: telegramLoginSchema } },
    async (request, reply) => {
      const telegram: TelegramConfig = config.telegram;
      if (telegram.botToken === null) {
        // 404, а не 503: ненастроенный маршрут не должен подтверждать своё
        // существование, как и отключённый вход разработчика.
        return reply.code(404).send({ error: 'not_found' });
      }

      const body = request.body as TelegramLoginBody;
      const initData = body.init_data ?? '';

      let verified;
      try {
        verified = verifyInitData(initData, {
          botToken: telegram.botToken,
          allowedUserIds: telegram.allowedUserIds,
          maxAgeSeconds: telegram.maxAgeSeconds,
          futureSkewSeconds: telegram.futureSkewSeconds,
        });
      } catch (error) {
        if (error instanceof InitDataError) {
          // Сама строка не логируется ни при каком исходе: это действующее
          // предъявительское доказательство (docs/14, раздел 3).
          const status = MALFORMED_CODES.has(error.code) ? 400 : 401;
          return reply.code(status).send({ error: error.code });
        }
        throw error;
      }

      let userId: string;
      try {
        userId = await withTransaction(database, async (client) => {
          // Обмен доказательства на сессию: отпечаток расходуется первым, и
          // повтор не дойдёт до создания второй семьи сессий.
          const consumed = await client.query(
            `INSERT INTO telegram_login_proofs (digest, expires_at)
             VALUES ($1, $2) ON CONFLICT (digest) DO NOTHING`,
            [
              verified.proofDigest,
              new Date(verified.authDate.getTime() + telegram.maxAgeSeconds * 1000),
            ],
          );
          if (consumed.rowCount !== 1) {
            throw new ProofReusedError('Это доказательство уже обменено на сессию');
          }

          // Узкая функция с правами владельца: до входа политика изоляции не
          // показывает строку пользователя, потому что идентификатор ещё не
          // установлен. Общего обхода политики при этом не появляется.
          const resolved = await client.query<{ identity_resolve_telegram: string }>(
            'SELECT identity_resolve_telegram($1)',
            [verified.telegramUserId],
          );
          const found = resolved.rows[0]?.identity_resolve_telegram;
          if (found === undefined) {
            throw new Error('Личность Telegram не сопоставлена пользователю');
          }
          return found;
        });
      } catch (error) {
        if (error instanceof ProofReusedError) {
          return reply.code(401).send({ error: 'initdata_already_used' });
        }
        if ((error as { code?: string }).code === '28000') {
          return reply.code(403).send({ error: 'account_unavailable' });
        }
        logError('telegram_login_failed', error, {
          request_id: request.id,
          route: 'POST /auth/telegram',
        });
        return reply.code(503).send({ error: 'service_unavailable', request_id: request.id });
      }

      // Telegram остаётся внешним поставщиком личности: доказательство не
      // пересылается с каждым запросом, дальше работает собственная сессия.
      const session = await issueSession(database, userId, body.installation_id ?? null);
      return reply.code(201).send({ user_id: userId, ...sessionResponse(session) });
    },
  );

  app.post('/auth/refresh', async (request, reply) => {
    const body = (request.body ?? {}) as RefreshBody;
    if (typeof body.refresh_token !== 'string') {
      return reply.code(400).send({ error: 'refresh_token_required' });
    }

    try {
      const session = await rotateSession(database, body.refresh_token);
      return reply.send(sessionResponse(session));
    } catch (error) {
      if (error instanceof TokenReuseError) {
        // Отдельный код: клиент обязан отличить «нужно войти заново» от
        // обычного отказа, потому что семья сессий отозвана целиком.
        return reply.code(401).send({ error: 'token_reuse_detected' });
      }
      // Истёкший и отозванный токен не различаются в ответе намеренно.
      if (
        error instanceof UnknownTokenError ||
        error instanceof ExpiredTokenError ||
        error instanceof RevokedFamilyError
      ) {
        return reply.code(401).send({ error: 'invalid_refresh_token' });
      }
      // Всё остальное — сбой инфраструктуры, а не приговор сессии. Прежний
      // общий catch отвечал 401 и при недоступной базе; для клиента это
      // означает «сессия недействительна», и он стирает локальный журнал с
      // несинхронизированными записями из-за временного сбоя
      // (R7 в docs/15-backend-review.md).
      logError('session_refresh_failed', error, {
        request_id: request.id,
        route: 'POST /auth/refresh',
      });
      return reply.code(503).send({ error: 'service_unavailable', request_id: request.id });
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = (request.body ?? {}) as LogoutBody;
    const userId = request.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (typeof body.family_id !== 'string') {
      return reply.code(400).send({ error: 'family_id_required' });
    }

    // Политика изоляции не даст отозвать чужую семью, поэтому отдельная
    // проверка владельца здесь не нужна.
    await revokeFamily(database, userId, body.family_id, 'logout');
    return reply.code(204).send();
  });

  app.get('/me', async (request, reply) => {
    const userId = request.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.send({ user_id: userId });
  });
}
