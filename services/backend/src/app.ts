import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.ts';
import { registerIdentityRoutes } from './modules/identity/routes.ts';
import { registerSyncReadRoutes } from './modules/sync/reads.ts';
import { registerCommandRoutes } from './modules/sync/routes.ts';
import { registerAuth } from './shared/auth/require-auth.ts';
import { checkConnection, type Database } from './shared/db/pool.ts';
import { logError } from './shared/logging/logger.ts';
import { createValidator } from './shared/schema/validator.ts';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly database: Database;
}

/**
 * Единственный источник путей API. Проверка контрактов сверяет этот список с
 * `packages/contracts/openapi.yaml` в обе стороны: описанный, но не
 * реализованный маршрут и реализованный, но не описанный одинаково означают
 * расхождение контракта с сервером, а замечают такое обычно потребители.
 */
export const API_ROUTES = [
  { method: 'get', path: '/health' },
  { method: 'get', path: '/health/ready' },
  { method: 'post', path: '/auth/dev-login' },
  { method: 'post', path: '/auth/telegram' },
  { method: 'post', path: '/auth/refresh' },
  { method: 'post', path: '/auth/logout' },
  { method: 'get', path: '/me' },
  { method: 'post', path: '/commands' },
  { method: 'get', path: '/bootstrap' },
  { method: 'get', path: '/sync/pull' },
] as const;

/**
 * Фабрика приложения без побочных эффектов запуска: тесты поднимают тот же
 * экземпляр через inject, поэтому проверяется реальный роутинг, а не копия
 * обработчика.
 */
export function createApp(deps: AppDependencies): FastifyInstance {
  // Логирование выключено целиком: структурированные редактированные логи
  // добавляются отдельной задачей (docs/01, раздел 2), а до неё вывод сырых
  // запросов рискует записать персональный текст.
  const app = Fastify({ logger: false });

  // Встроенный валидатор Fastify настроен на draft-07 и молча проигнорировал бы
  // часть ключевых слов схем 2020-12; подключается валидатор нужного диалекта.
  // Тот же экземпляр настроек используется для схем нагрузки — разойдись в них
  // один флаг, и закрытость схемы перестала бы что-либо значить.
  const validator = createValidator();
  app.setValidatorCompiler(({ schema }) => validator.compile(schema as object));

  // Необработанная ошибка не должна пересказывать клиенту внутренности: по
  // умолчанию Fastify возвращает текст исключения, и живая проверка показала
  // в ответе имя колонки базы данных. Это разведка схемы бесплатно.
  app.setErrorHandler((error: unknown, request, reply) => {
    const failure = error as { statusCode?: number; code?: string };
    // Ошибки валидации самого Fastify сообщают о запросе клиента, а не о
    // сервере, и их скрывать не нужно.
    const status = failure.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: failure.code ?? 'bad_request' });
    }
    // Ошибка записывается выжимкой: печать объекта целиком выводила бы detail
    // PostgreSQL со значением строки и адрес базы (R7 в docs/15-backend-review.md).
    logError('request_failed', error, {
      request_id: request.id,
      route: `${request.method} ${request.url}`,
      status,
    });
    // Идентификатор запроса возвращается клиенту: без него человек не может
    // сослаться на свой случай, а с текстом ошибки уехали бы внутренности.
    return reply.code(500).send({ error: 'internal_error', request_id: request.id });
  });

  // Доступ закрыт по умолчанию: проверка вешается раньше маршрутов, публичные
  // пути перечислены явно в PUBLIC_PATHS.
  registerAuth(app, deps.database);
  registerIdentityRoutes(app, deps.config, deps.database);
  registerCommandRoutes(app, deps.database);
  registerSyncReadRoutes(app, deps.database);

  // Liveness: процесс жив и отвечает. Намеренно не трогает БД — иначе рестарт
  // приложения зависит от доступности базы и перезапуск лечит не то.
  app.get(API_ROUTES[0].path, () => {
    return {
      status: 'ok' as const,
      environment: deps.config.environment,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  });

  // Readiness: приложение готово обслуживать запросы, то есть БД отвечает.
  // При недоступной БД возвращается 503, а не 200 с текстом об ошибке:
  // балансировщик читает код, а не тело.
  app.get(API_ROUTES[1].path, async (_request, reply) => {
    try {
      await checkConnection(deps.database);
      return { status: 'ready' as const, database: 'up' as const };
    } catch {
      // Причина ошибки не попадает в ответ: строка подключения и параметры
      // сервера не предназначены для внешнего клиента.
      return reply.code(503).send({ status: 'not_ready', database: 'down' });
    }
  });

  return app;
}
