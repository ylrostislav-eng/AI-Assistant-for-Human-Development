import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { API_ROUTES, createApp } from '../../src/app.ts';
import type { AppConfig } from '../../src/config.ts';
import type { Database } from '../../src/shared/db/pool.ts';

/**
 * Сверка контракта с сервером в обе стороны.
 *
 * Расхождение контракта и реализации не проявляется у того, кто его допустил:
 * сервер продолжает работать, а ломается клиент, написанный по описанию.
 * Поэтому проверка отдельно ловит описанный, но не реализованный маршрут и
 * реализованный, но не описанный.
 */

const CONTRACTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts',
);

interface OpenApiDocument {
  readonly openapi: string;
  readonly paths: Record<string, Record<string, { operationId?: string }>>;
}

async function loadOpenApi(): Promise<OpenApiDocument> {
  const raw = await readFile(path.join(CONTRACTS_DIR, 'openapi.yaml'), 'utf8');
  return parse(raw) as OpenApiDocument;
}

const config: AppConfig = {
  environment: 'test',
  devAuthEnabled: false,
  server: { host: '127.0.0.1', port: 0 },
  database: { connectionString: 'postgres://unused', maxConnections: 1, connectionTimeoutMillis: 1000 },
};

const unusedDatabase = { query: () => Promise.reject(new Error('не используется')) } as unknown as Database;

describe('openapi.yaml', () => {
  it('является документом OpenAPI 3.1', async () => {
    const document = await loadOpenApi();

    expect(document.openapi).toMatch(/^3\.1\./);
  });

  it('описывает ровно те маршруты, которые регистрирует приложение', async () => {
    const document = await loadOpenApi();

    const documented = Object.entries(document.paths)
      .flatMap(([route, methods]) => Object.keys(methods).map((method) => `${method} ${route}`))
      .sort();
    const implemented = API_ROUTES.map((route) => `${route.method} ${route.path}`).sort();

    expect(documented).toEqual(implemented);
  });

  it('каждый описанный маршрут действительно отвечает', async () => {
    const document = await loadOpenApi();
    const app = createApp({ config, database: unusedDatabase });

    try {
      for (const [route, methods] of Object.entries(document.paths)) {
        for (const method of Object.keys(methods)) {
          // Наличие в списке путей не доказывает регистрацию маршрута:
          // сверяется сам экземпляр приложения.
          expect(app.hasRoute({ method: method.toUpperCase() as 'GET', url: route })).toBe(true);
        }
      }
    } finally {
      await app.close();
    }
  });

  it('у каждой операции есть operationId', async () => {
    const document = await loadOpenApi();

    for (const [route, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.operationId, `${method} ${route}`).toBeTruthy();
      }
    }
  });
});
