import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  InitDataError,
  verifyInitData,
  type TelegramAuthConfig,
} from '../../src/modules/identity/telegram.ts';

/**
 * Проверка подписи Telegram initData (T-01, docs/14, раздел 3).
 *
 * Контрольные случаи выбраны заранее по официальной спецификации и docs/14:
 * подделка, изменённое поле, чужой бот, просроченное и будущее время, дубли
 * ключей, отсутствие пользователя, пользователь вне allowlist. Подпись здесь —
 * единственное доказательство личности: `initDataUnsafe` и username личность
 * не подтверждают.
 */

const BOT_TOKEN = '7654321:AAH-синтетический-токен-для-проверок';
const OTHER_BOT_TOKEN = '1234567:AAH-другой-бот';
const NOW = new Date('2026-09-16T12:00:00Z');

const CONFIG: TelegramAuthConfig = {
  botToken: BOT_TOKEN,
  allowedUserIds: ['42'],
  maxAgeSeconds: 300,
  futureSkewSeconds: 30,
};

/** Сборка подписанной строки ровно по спецификации Telegram. */
function signInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN,
): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key] as string}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.append(key, value);
  }
  params.append('hash', hash);
  return params.toString();
}

function fields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(Math.floor(NOW.getTime() / 1000) - 10),
    query_id: 'AAH-запрос',
    user: JSON.stringify({ id: 42, first_name: 'Ростислав', username: 'rostislav' }),
    ...overrides,
  };
}

function expectRejection(raw: string, code: string, config: TelegramAuthConfig = CONFIG): void {
  try {
    verifyInitData(raw, config, NOW);
  } catch (error) {
    expect(error).toBeInstanceOf(InitDataError);
    expect((error as InitDataError).code).toBe(code);
    return;
  }
  throw new Error(`Ожидался отказ ${code}, но проверка прошла`);
}

describe('подпись initData', () => {
  it('подлинная строка принимается', () => {
    const verified = verifyInitData(signInitData(fields()), CONFIG, NOW);

    expect(verified.telegramUserId).toBe('42');
  });

  it('подделанная подпись отклоняется', () => {
    const raw = signInitData(fields()).replace(/hash=[0-9a-f]+$/, `hash=${'0'.repeat(64)}`);

    expectRejection(raw, 'initdata_forged');
  });

  it('изменённое после подписи поле отклоняется', () => {
    // Подмена идентификатора — прямой путь к чужому аккаунту. Подпись
    // остаётся прежней, меняется только содержимое.
    const signed = new URLSearchParams(signInitData(fields()));
    signed.set('user', JSON.stringify({ id: 99, first_name: 'Подменённый' }));

    expectRejection(signed.toString(), 'initdata_forged');
  });

  it('строка, подписанная другим ботом, отклоняется', () => {
    const raw = signInitData(fields(), OTHER_BOT_TOKEN);

    expectRejection(raw, 'initdata_forged');
  });

  it('строка без подписи отклоняется', () => {
    const params = new URLSearchParams(fields());

    expectRejection(params.toString(), 'initdata_hash_missing');
  });
});

describe('время подписи', () => {
  it('просроченная строка отклоняется', () => {
    const stale = String(Math.floor(NOW.getTime() / 1000) - 301);

    // Подпись не делает украденную строку безопасной: ограничение срока —
    // единственное, что сужает окно кражи (docs/14, раздел 3).
    expectRejection(signInitData(fields({ auth_date: stale })), 'initdata_expired');
  });

  it('строка из будущего отклоняется', () => {
    const ahead = String(Math.floor(NOW.getTime() / 1000) + 31);

    expectRejection(signInitData(fields({ auth_date: ahead })), 'initdata_from_future');
  });

  it('малое расхождение часов допускается', () => {
    // Отрицательный контроль: часы клиента и сервера расходятся всегда.
    const ahead = String(Math.floor(NOW.getTime() / 1000) + 20);

    expect(verifyInitData(signInitData(fields({ auth_date: ahead })), CONFIG, NOW)).toBeDefined();
  });

  it('нечисловое время отклоняется', () => {
    expectRejection(signInitData(fields({ auth_date: 'вчера' })), 'initdata_malformed');
  });
});

describe('содержимое', () => {
  it('дубль ключа отклоняется', () => {
    // Два значения одного ключа позволяют подписать одно, а прочитать другое.
    const raw = `${signInitData(fields())}&user=${encodeURIComponent('{"id":99}')}`;

    expectRejection(raw, 'initdata_duplicate_key');
  });

  it('строка без пользователя отклоняется', () => {
    const withoutUser = fields();
    delete withoutUser['user'];

    expectRejection(signInitData(withoutUser), 'initdata_no_user');
  });

  it('идентификатор вне безопасного диапазона отклоняется', () => {
    // Молча потерять точность значит однажды привязать двух людей к одному
    // аккаунту.
    const raw = signInitData(fields({ user: '{"id":90071992547409911,"first_name":"Слишком"}' }));

    expectRejection(raw, 'initdata_user_id_unsafe');
  });

  it('слишком длинная строка отклоняется до разбора', () => {
    const raw = signInitData(fields({ query_id: 'x'.repeat(9000) }));

    expectRejection(raw, 'initdata_too_large');
  });

  it('пользователь вне allowlist отклоняется', () => {
    const raw = signInitData(fields({ user: JSON.stringify({ id: 777, first_name: 'Чужой' }) }));

    // Личный пилот принимает только владельца (docs/14, раздел 2).
    expectRejection(raw, 'user_not_allowed');
  });

  it('пустой allowlist никого не пускает', () => {
    // Закрыто по умолчанию: пустой список означает «никого», а не «всех».
    expectRejection(signInitData(fields()), 'user_not_allowed', {
      ...CONFIG,
      allowedUserIds: [],
    });
  });
});

describe('отпечаток доказательства', () => {
  it('одинаков при перестановке ключей', () => {
    const raw = signInitData(fields());
    const params = [...new URLSearchParams(raw).entries()].reverse();
    const reordered = new URLSearchParams(params).toString();

    // Иначе повтор с переставленными ключами выглядел бы новым входом
    // (docs/14, раздел 3).
    expect(verifyInitData(reordered, CONFIG, NOW).proofDigest).toBe(
      verifyInitData(raw, CONFIG, NOW).proofDigest,
    );
  });

  it('различается у разных строк', () => {
    const first = verifyInitData(signInitData(fields()), CONFIG, NOW);
    const second = verifyInitData(
      signInitData(fields({ query_id: 'AAH-другой-запрос' })),
      CONFIG,
      NOW,
    );

    expect(second.proofDigest).not.toBe(first.proofDigest);
  });
});
