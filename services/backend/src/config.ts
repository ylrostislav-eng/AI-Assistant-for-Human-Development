/**
 * Конфигурация читается только из переменных окружения: секреты в git не попадают
 * (AGENTS.md). Отсутствие обязательного значения — ошибка запуска, а не тихий
 * fallback на локальную БД: тихий fallback прячет неверную конфигурацию до
 * момента, когда приложение уже работает с чужими данными.
 */

export interface DatabaseConfig {
  readonly connectionString: string;
  readonly maxConnections: number;
  readonly connectionTimeoutMillis: number;
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

export interface AppConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly server: ServerConfig;
  readonly database: DatabaseConfig;
}

export class ConfigError extends Error {}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`Не задана обязательная переменная окружения ${name}`);
  }
  return value;
}

function readInteger(name: string, env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Переменная ${name} должна быть целым положительным числом, получено: ${raw}`);
  }
  return parsed;
}

function readEnvironment(env: NodeJS.ProcessEnv): AppConfig['environment'] {
  const raw = env['NODE_ENV'] ?? 'development';
  if (raw === 'development' || raw === 'test' || raw === 'production') {
    return raw;
  }
  throw new ConfigError(`NODE_ENV должен быть development, test или production, получено: ${raw}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    environment: readEnvironment(env),
    server: {
      host: env['HOST'] ?? '127.0.0.1',
      port: readInteger('PORT', env, 3000),
    },
    database: {
      connectionString: requireEnv('DATABASE_URL', env),
      maxConnections: readInteger('DATABASE_POOL_MAX', env, 10),
      connectionTimeoutMillis: readInteger('DATABASE_CONNECT_TIMEOUT_MS', env, 5000),
    },
  };
}
