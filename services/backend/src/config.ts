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
  /**
   * Вход по синтетической личности без Apple. Разрешён только вне production и
   * только по явному флагу (docs/09, раздел 2): иначе он превращается в
   * постоянный обход аутентификации, о котором все забывают.
   */
  readonly devAuthEnabled: boolean;
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

function readDevAuth(env: NodeJS.ProcessEnv, environment: AppConfig['environment']): boolean {
  const enabled = env['DEV_AUTH_ENABLED'] === 'true';
  if (enabled && environment === 'production') {
    // Отказ на запуске, а не тихое игнорирование: включённый обход в
    // production — это ошибка развёртывания, и она должна быть заметна сразу.
    throw new ConfigError('DEV_AUTH_ENABLED не может быть включён в production');
  }
  return enabled;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = readEnvironment(env);
  return {
    environment,
    devAuthEnabled: readDevAuth(env, environment),
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
