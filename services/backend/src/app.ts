import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.ts';
import { checkConnection, type Database } from './shared/db/pool.ts';

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
