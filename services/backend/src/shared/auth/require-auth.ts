import type { FastifyInstance } from 'fastify';

import { authenticateAccessToken } from '../../modules/identity/sessions.ts';
import type { Database } from '../db/pool.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Пользователь, подтверждённый access-токеном. */
    userId?: string;
  }
}

/**
 * Доступ закрыт по умолчанию.
 *
 * Проверка вешается на приложение целиком, а исключения перечисляются явно.
 * Обратная схема — навешивать проверку на каждый маршрут — ошибается молча:
 * забытый маршрут остаётся открытым, и при чтении его кода это не видно.
 * Здесь забытый маршрут, наоборот, перестаёт работать, и ошибка обнаруживается
 * сразу.
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/health',
  '/health/ready',
  // Вход по определению выполняется без access-токена.
  '/auth/dev-login',
  '/auth/telegram',
  // Обновление предъявляет refresh-токен в теле запроса, а не access.
  '/auth/refresh',
];

export function registerAuth(app: FastifyInstance, database: Database): void {
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_PATHS.includes(request.routeOptions.url ?? request.url)) {
      return;
    }

    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const session = await authenticateAccessToken(database, header.slice('Bearer '.length));
    if (session === null) {
      // Причина не уточняется: различие «нет такого токена» и «токен истёк»
      // помогает подбирающему и ничего не даёт владельцу.
      return reply.code(401).send({ error: 'unauthorized' });
    }

    request.userId = session.userId;
  });
}
