import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка `initData` из Telegram Mini App (T-01, docs/14, раздел 3).
 *
 * Подпись — единственное доказательство личности. `initDataUnsafe`, username и
 * отображаемое имя личность не подтверждают: их подставляет клиент.
 *
 * Официальная спецификация:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Сама строка — краткоживущее предъявительское доказательство: подпись не
 * делает украденную строку безопасной. Поэтому её нельзя логировать, а срок
 * жизни ограничен минутами.
 */

export interface TelegramAuthConfig {
  readonly botToken: string;
  /** Личный пилот принимает только перечисленных (docs/14, раздел 2). */
  readonly allowedUserIds: readonly string[];
  readonly maxAgeSeconds: number;
  readonly futureSkewSeconds: number;
}

export interface VerifiedInitData {
  readonly telegramUserId: string;
  readonly authDate: Date;
  /**
   * Отпечаток проверенных полей в области видимости бота. Защита от повтора
   * строится на нём, а не на сырой строке: перестановка ключей и другая
   * кодировка того же содержания дают тот же отпечаток.
   */
  readonly proofDigest: string;
}

export class InitDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Предел размера. Проверяется до разбора: строка приходит от недоверенного
 * клиента, и разбирать мегабайт, чтобы затем его отвергнуть, незачем.
 */
const MAX_INIT_DATA_BYTES = 8192;

/**
 * Поля, не входящие в подписываемую строку. `hash` — сама подпись; `signature`
 * относится к отдельной проверке Ed25519 для третьих сторон, и смешивать два
 * протокола нельзя (docs/14, раздел 3).
 */
const UNSIGNED_FIELDS = new Set(['hash', 'signature']);

function parsePairs(raw: string): Map<string, string> {
  const params = new URLSearchParams(raw);
  const pairs = new Map<string, string>();
  for (const [key, value] of params) {
    if (pairs.has(key)) {
      // Два значения одного ключа позволяют подписать одно, а прочитать
      // другое: какое из них увидит проверка, зависит от порядка разбора.
      throw new InitDataError('initdata_duplicate_key', 'Повторяющийся ключ в initData');
    }
    pairs.set(key, value);
  }
  return pairs;
}

function dataCheckString(pairs: ReadonlyMap<string, string>): string {
  return [...pairs.entries()]
    .filter(([key]) => !UNSIGNED_FIELDS.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    // Разной длины буферы timingSafeEqual сравнивать отказывается, а сама
    // длина подписи и так известна из спецификации.
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

/** Идентификатор бота из токена: часть до двоеточия, сам токен не раскрывается. */
function botScope(botToken: string): string {
  return botToken.split(':')[0] ?? 'unknown';
}

function readTelegramUserId(pairs: ReadonlyMap<string, string>): string {
  const rawUser = pairs.get('user');
  if (rawUser === undefined) {
    // Запуск без подписанного пользователя (например, из inline-режима) для
    // входа не годится: подменять его на initDataUnsafe нельзя.
    throw new InitDataError('initdata_no_user', 'В initData нет подписанного пользователя');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    throw new InitDataError('initdata_malformed', 'Поле user не разбирается');
  }

  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new InitDataError('initdata_malformed', 'В поле user нет целочисленного id');
  }
  if (!Number.isSafeInteger(id)) {
    // Молча потерять точность значит однажды привязать двух людей к одному
    // аккаунту. Отказ заметен, потеря точности — нет.
    throw new InitDataError(
      'initdata_user_id_unsafe',
      'Идентификатор Telegram вне безопасного диапазона',
    );
  }
  return String(id);
}

export function verifyInitData(
  raw: string,
  config: TelegramAuthConfig,
  now: Date = new Date(),
): VerifiedInitData {
  if (Buffer.byteLength(raw, 'utf8') > MAX_INIT_DATA_BYTES) {
    throw new InitDataError('initdata_too_large', 'initData длиннее допустимого');
  }

  const pairs = parsePairs(raw);
  const presentedHash = pairs.get('hash');
  if (presentedHash === undefined || presentedHash === '') {
    throw new InitDataError('initdata_hash_missing', 'В initData нет подписи');
  }

  const checkString = dataCheckString(pairs);
  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');

  if (!constantTimeEquals(expected, presentedHash)) {
    // Одна причина отказа на подделку, изменённое поле и чужого бота: детали
    // подсказали бы, какая часть подошла.
    throw new InitDataError('initdata_forged', 'Подпись initData не совпадает');
  }

  const rawAuthDate = pairs.get('auth_date');
  const authSeconds = rawAuthDate === undefined ? Number.NaN : Number(rawAuthDate);
  if (!Number.isInteger(authSeconds)) {
    throw new InitDataError('initdata_malformed', 'auth_date не является целым числом секунд');
  }

  const ageSeconds = Math.floor(now.getTime() / 1000) - authSeconds;
  if (ageSeconds > config.maxAgeSeconds) {
    throw new InitDataError('initdata_expired', 'initData просрочена');
  }
  if (-ageSeconds > config.futureSkewSeconds) {
    // Время из будущего означает либо подкрученные часы, либо заготовленную
    // впрок строку; и то и другое — не вход.
    throw new InitDataError('initdata_from_future', 'auth_date из будущего');
  }

  const telegramUserId = readTelegramUserId(pairs);
  if (!config.allowedUserIds.includes(telegramUserId)) {
    // Пустой список означает «никого»: закрыто по умолчанию, как и остальной
    // доступ в проекте.
    throw new InitDataError('user_not_allowed', 'Пользователь не допущен к пилоту');
  }

  return {
    telegramUserId,
    authDate: new Date(authSeconds * 1000),
    // Разделитель не встречается в идентификаторе бота, поэтому склейка
    // однозначна: иначе разные пары давали бы один отпечаток.
    proofDigest: createHash('sha256')
      .update(`${botScope(config.botToken)}:\n${checkString}`, 'utf8')
      .digest('hex'),
  };
}
