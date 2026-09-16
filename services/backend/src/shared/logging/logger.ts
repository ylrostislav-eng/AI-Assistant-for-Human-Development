import { createHash } from 'node:crypto';

/**
 * Запись ошибок с разрешённым списком полей.
 *
 * `console.error(error)` печатает объект целиком. У ошибки PostgreSQL это
 * `detail` со значением нарушившей строки, у сетевой — адрес и порт, у ошибки
 * внешнего провайдера — URL с токеном. Логи уезжают в сторонний сборщик, и
 * персональный текст оседает там навсегда (R7 в docs/15-backend-review.md).
 *
 * Поэтому пишется не ошибка, а выжимка: вид, код и отпечаток. Отпечаток —
 * хеш от текста; он позволяет узнать ту же ошибку в потоке и посчитать
 * повторы, не раскрывая содержания. Без него одинаковые строки не отличить от
 * разных, и разбор сводится к угадыванию.
 *
 * Разрешённый список, а не список запрещённых: запрещать приходится по одному,
 * и следующее поле с персональными данными добавят раньше, чем вспомнят про
 * список.
 */

const ALLOWED_META = new Set([
  'request_id',
  'route',
  'method',
  'status',
  'user_id',
  'job_id',
  'job_kind',
  'attempt',
]);

/** Коды и имена ошибок безопасны, только если это действительно коды. */
const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_META_LENGTH = 64;

function fingerprint(error: unknown): string {
  const failure = error as { name?: unknown; message?: unknown };
  const name = typeof failure?.name === 'string' ? failure.name : 'Error';
  const message = typeof failure?.message === 'string' ? failure.message : '';
  return createHash('sha256').update(`${name}|${message}`, 'utf8').digest('hex').slice(0, 12);
}

function sanitizeMeta(value: unknown): string | number | boolean {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.slice(0, MAX_META_LENGTH);
  }
  // Объект в контексте — это чаще всего случайно переданная нагрузка запроса.
  return 'redacted';
}

export interface ErrorRecord {
  readonly level: 'error';
  readonly event: string;
  readonly error_name: string;
  readonly fingerprint: string;
  readonly error_code?: string;
  readonly dropped_meta?: number;
}

/**
 * Единственная точка вывода ошибок. Прямой `console.error` с объектом ошибки в
 * коде приложения считается дефектом: `logger: false` у Fastify выключает его
 * собственный вывод, но не консоль.
 */
export function logError(
  event: string,
  error: unknown,
  meta: Readonly<Record<string, unknown>> = {},
): void {
  const failure = error as { name?: unknown; code?: unknown };
  const name = typeof failure?.name === 'string' && CODE_PATTERN.test(failure.name)
    ? failure.name
    : 'Error';

  const record: Record<string, unknown> = {
    level: 'error',
    event,
    error_name: name,
    fingerprint: fingerprint(error),
  };

  const code = failure?.code;
  if (typeof code === 'string' && CODE_PATTERN.test(code)) {
    record['error_code'] = code;
  }

  let dropped = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (ALLOWED_META.has(key)) {
      record[key] = sanitizeMeta(value);
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    // Счётчик, а не имена: молчаливая потеря контекста хуже известной, но и
    // имена полей могут оказаться говорящими.
    record['dropped_meta'] = dropped;
  }

  console.error(JSON.stringify(record));
}
