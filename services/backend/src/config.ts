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

/**
 * Вход через Telegram. Без токена бота маршрут не существует: включать проверку
 * подписи «наполовину» нельзя, а отсутствующий токен — это не настройка по
 * умолчанию, а незавершённая настройка.
 */
export interface TelegramConfig {
  readonly botToken: string | null;
  /**
   * Секрет вебхука. Это **не** токен бота: Telegram присылает его заголовком
   * `X-Telegram-Bot-Api-Secret-Token`, и он подтверждает только происхождение
   * запроса. Без него маршрут не существует — включать приём наполовину
   * нельзя.
   */
  readonly webhookSecret: string | null;
  /**
   * Личный пилот принимает только перечисленных (docs/14, раздел 2). Пустой
   * список означает «никого»: доступ закрыт по умолчанию.
   */
  readonly allowedUserIds: readonly string[];
  readonly maxAgeSeconds: number;
  readonly futureSkewSeconds: number;
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
  readonly telegram: TelegramConfig;
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

/**
 * Список допущенных идентификаторов Telegram. Нечисловое значение — ошибка
 * запуска: пропустить его значит тихо сузить список и получить необъяснимый
 * отказ во входе.
 */
function readAllowedUserIds(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env['TELEGRAM_ALLOWED_USER_IDS'];
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  return raw.split(',').map((entry) => {
    const value = entry.trim();
    if (!/^[0-9]{1,20}$/.test(value)) {
      throw new ConfigError(
        `TELEGRAM_ALLOWED_USER_IDS содержит нечисловой идентификатор: ${value}`,
      );
    }
    return value;
  });
}

function readTelegram(env: NodeJS.ProcessEnv): TelegramConfig {
  const token = env['TELEGRAM_BOT_TOKEN'];
  const webhookSecret = env['TELEGRAM_WEBHOOK_SECRET'];
  return {
    botToken: token === undefined || token.trim() === '' ? null : token.trim(),
    webhookSecret:
      webhookSecret === undefined || webhookSecret.trim() === '' ? null : webhookSecret.trim(),
    allowedUserIds: readAllowedUserIds(env),
    // Срок жизни доказательства: подпись не делает украденную строку
    // безопасной, и окно кражи сужает только он (docs/14, раздел 3).
    maxAgeSeconds: readInteger('TELEGRAM_AUTH_MAX_AGE_SECONDS', env, 300),
    futureSkewSeconds: readInteger('TELEGRAM_AUTH_FUTURE_SKEW_SECONDS', env, 30),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = readEnvironment(env);
  return {
    environment,
    devAuthEnabled: readDevAuth(env, environment),
    telegram: readTelegram(env),
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
