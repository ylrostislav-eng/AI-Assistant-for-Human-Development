import { afterEach, describe, expect, it, vi } from 'vitest';

import { logError } from '../../src/shared/logging/logger.ts';

/**
 * Проверки записи ошибок по аудиту `docs/15-backend-review.md` (R7).
 *
 * `console.error(error)` печатает объект целиком: у ошибки PostgreSQL это
 * `detail` с значением нарушившей строки, у сетевой — адрес и порт, у ошибки
 * внешнего провайдера — URL с токеном. Лог уезжает в сторонний сборщик, и
 * персональный текст оседает там навсегда.
 *
 * Контрольная строка «МАЯК-» вставляется в сообщение, в `detail` и в
 * посторонние поля: проверяется, что ни одно из них не попало в вывод.
 */

const SENTINEL = 'МАЯК-7f3a91';

afterEach(() => {
  vi.restoreAllMocks();
});

function capture(run: () => void): string {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  run();
  return lines.join('\n');
}

describe('R7: запись ошибок', () => {
  it('не выводит текст ошибки', () => {
    const error = new Error(`сбой запроса: ${SENTINEL}`);

    const output = capture(() => logError('db_query_failed', error));

    expect(output).not.toContain(SENTINEL);
  });

  it('не выводит посторонние поля ошибки', () => {
    const error = Object.assign(new Error('нарушение ограничения'), {
      code: '23505',
      detail: `Key (title)=(${SENTINEL}) already exists.`,
      table: 'goals',
      где: SENTINEL,
    });

    const output = capture(() => logError('db_query_failed', error));

    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain('goals');
    // Код нарушения безопасен и нужен для разбора.
    expect(output).toContain('23505');
  });

  it('вид собственной ошибки не теряется', () => {
    // `class ConfigError extends Error {}` не задаёт `name`, и в логе
    // оказывалось безликое «Error». Живой запуск на Railway это и показал:
    // сервис не стартовал, а по логу нельзя было понять, дело в настройке или
    // в базе — при том что текст ошибки намеренно не выводится.
    class ConfigError extends Error {}

    const record = JSON.parse(capture(() => logError('api_start_failed', new ConfigError('нет')))) as
      Record<string, unknown>;

    expect(record['error_name']).toBe('ConfigError');
  });

  it('пишет вид ошибки и отпечаток', () => {
    const error = Object.assign(new Error(`сбой: ${SENTINEL}`), { name: 'DatabaseError' });

    const record = JSON.parse(capture(() => logError('db_query_failed', error))) as Record<
      string,
      unknown
    >;

    expect(record['event']).toBe('db_query_failed');
    expect(record['error_name']).toBe('DatabaseError');
    // Отпечаток позволяет узнать ту же ошибку в потоке логов, не раскрывая её
    // содержания: без него одинаковые строки не отличить от разных.
    expect(typeof record['fingerprint']).toBe('string');
  });

  it('отпечаток одинаков у одной ошибки и разный у разных', () => {
    const first = JSON.parse(capture(() => logError('e', new Error('одно и то же')))) as {
      fingerprint: string;
    };
    const same = JSON.parse(capture(() => logError('e', new Error('одно и то же')))) as {
      fingerprint: string;
    };
    const other = JSON.parse(capture(() => logError('e', new Error('другое')))) as {
      fingerprint: string;
    };

    expect(same.fingerprint).toBe(first.fingerprint);
    expect(other.fingerprint).not.toBe(first.fingerprint);
  });

  it('пропускает только разрешённые поля контекста', () => {
    const record = JSON.parse(
      capture(() =>
        logError('request_failed', new Error('сбой'), {
          request_id: 'req-1',
          route: 'POST /commands',
          подсказка: SENTINEL,
        }),
      ),
    ) as Record<string, unknown>;

    expect(record['request_id']).toBe('req-1');
    expect(record['route']).toBe('POST /commands');
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
    // Отброшенное поле видно счётчиком: молчаливая потеря контекста хуже, чем
    // известная.
    expect(record['dropped_meta']).toBe(1);
  });

  it('обрезает слишком длинное значение контекста', () => {
    const record = JSON.parse(
      capture(() => logError('request_failed', new Error('сбой'), { route: 'x'.repeat(500) })),
    ) as Record<string, string>;

    expect((record['route'] as string).length).toBeLessThanOrEqual(64);
  });
});
