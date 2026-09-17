import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  deliverPendingMessages,
  reapStuckSends,
  type TelegramTransport,
  type TransportResult,
} from '../../src/modules/telegram/delivery.ts';
import { loadConfig } from '../../src/config.ts';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../src/shared/db/migrate.ts';
import { createPool, type Database } from '../../src/shared/db/pool.ts';
import { resetSchema } from '../helpers/reset-schema.ts';

/**
 * Отправка сообщений в Telegram (T-02b, часть 2; docs/01, раздел 6, пункт 6).
 *
 * Telegram не даёт нашей гарантии «ровно один раз»: таймаут запроса может
 * означать уже доставленное сообщение. Поэтому исход «неизвестно» — отдельное
 * состояние, а не разновидность неудачи, и вслепую он не повторяется.
 *
 * Транспорт здесь синтетический: проверяется наша логика исходов, а не связь с
 * Telegram. **Живая проверка с настоящим ботом обязательна отдельно** — этот
 * набор её не заменяет.
 */

const USER = '55445544-5544-4554-8554-554455445544';

let ownerDb: Database;
let workerDb: Database;

beforeAll(async () => {
  const config = loadConfig();
  ownerDb = createPool(config.database);

  await resetSchema(ownerDb);
  await runMigrations(ownerDb, DEFAULT_MIGRATIONS_DIR);
  await ownerDb.query('INSERT INTO users (id, auth_issuer, auth_subject) VALUES ($1, $2, $3)', [
    USER,
    'dev',
    'delivery',
  ]);

  const url = new URL(config.database.connectionString);
  url.username = 'app_worker';
  url.password = '';
  workerDb = createPool({ ...config.database, connectionString: url.toString(), maxConnections: 4 });
});

afterAll(async () => {
  await workerDb.end();
  await resetSchema(ownerDb);
  await ownerDb.end();
});

let nextChat = 700000;

async function queue(body = 'текст ответа'): Promise<{ id: string; chatId: string }> {
  nextChat += 1;
  const chatId = String(nextChat);
  const inserted = await ownerDb.query<{ id: string }>(
    `INSERT INTO telegram_messages (user_id, chat_id, kind, body, dedupe_key)
     VALUES ($1, $2, 'start', $3, $4) RETURNING id`,
    [USER, chatId, body, `проверка:${chatId}`],
  );
  return { id: inserted.rows[0]?.id as string, chatId };
}

interface MessageRow {
  readonly state: string;
  readonly attempts: number;
  readonly telegram_message_id: string | null;
  readonly last_error_code: string | null;
  readonly next_attempt_at: Date | null;
}

async function read(id: string): Promise<MessageRow> {
  const rows = await ownerDb.query<MessageRow>(
    `SELECT state, attempts, telegram_message_id, last_error_code, next_attempt_at
       FROM telegram_messages WHERE id = $1`,
    [id],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error('Сообщение не найдено');
  }
  return row;
}

/** Транспорт с заранее заданным исходом и записью того, что он видел. */
function transportReturning(
  result: TransportResult,
  onCall?: (chatId: string) => Promise<void>,
): TelegramTransport & { calls: number } {
  const transport = {
    calls: 0,
    async sendMessage(chatId: string): Promise<TransportResult> {
      transport.calls += 1;
      if (onCall !== undefined) {
        await onCall(chatId);
      }
      return result;
    },
    async answerCallbackQuery(): Promise<TransportResult> {
      transport.calls += 1;
      return result;
    },
  };
  return transport;
}

describe('успешная отправка', () => {
  it('подтверждённое сообщение помечается отправленным с идентификатором', async () => {
    const message = await queue();
    const transport = transportReturning({ outcome: 'sent', messageId: 4242 });

    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    const row = await read(message.id);
    expect(row.state).toBe('sent');
    expect(row.telegram_message_id).toBe('4242');
  });

  it('отправленное не берётся повторно', async () => {
    const message = await queue();
    const transport = transportReturning({ outcome: 'sent', messageId: 1 });
    await deliverPendingMessages(workerDb, transport, { limit: 5 });
    const before = transport.calls;

    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    expect(transport.calls).toBe(before);
    expect((await read(message.id)).state).toBe('sent');
  });
});

describe('порядок записи и запроса', () => {
  it('в момент запроса сообщение уже помечено отправляемым', async () => {
    const message = await queue();
    let stateDuringCall: string | null = null;

    const transport = transportReturning({ outcome: 'sent', messageId: 7 }, async () => {
      stateDuringCall = (await read(message.id)).state;
    });

    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    // Пометка после запроса теряет факт попытки при падении процесса, и
    // сообщение уходит второй раз. Поэтому «отправляем» записывается до
    // обращения к Telegram и фиксируется отдельной транзакцией.
    expect(stateDuringCall).toBe('sending');
  });

  it('попытка засчитывается даже при неизвестном исходе', async () => {
    const message = await queue();
    const transport = transportReturning({ outcome: 'unknown', code: 'timeout' });

    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    expect((await read(message.id)).attempts).toBe(1);
  });
});

describe('неизвестный исход', () => {
  it('таймаут не считается неудачей', async () => {
    const message = await queue();
    const transport = transportReturning({ outcome: 'unknown', code: 'timeout' });

    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    // Сообщение могло быть доставлено: пометить его неудачей значит однажды
    // отправить второе такое же.
    expect((await read(message.id)).state).toBe('unknown');
  });

  it('неизвестный исход не повторяется вслепую', async () => {
    await queue();
    const transport = transportReturning({ outcome: 'unknown', code: 'timeout' });
    await deliverPendingMessages(workerDb, transport, { limit: 5 });
    const before = transport.calls;

    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    expect(transport.calls).toBe(before);
  });
});

describe('отказы Telegram', () => {
  it('429 возвращает сообщение в очередь с отсрочкой', async () => {
    const message = await queue();
    const transport = transportReturning({
      outcome: 'rejected',
      code: 'too_many_requests',
      retryable: true,
      retryAfterSeconds: 30,
    });

    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    const row = await read(message.id);
    expect(row.state).toBe('pending');
    // Отсрочку назначает Telegram, и игнорировать её значит получить запрет
    // подольше.
    expect(row.next_attempt_at).not.toBeNull();
    expect((row.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('до истечения отсрочки сообщение не берётся', async () => {
    await queue();
    const rejecting = transportReturning({
      outcome: 'rejected',
      code: 'too_many_requests',
      retryable: true,
      retryAfterSeconds: 30,
    });
    await deliverPendingMessages(workerDb, rejecting, { limit: 5 });

    const second = transportReturning({ outcome: 'sent', messageId: 9 });
    await deliverPendingMessages(workerDb, second, { limit: 5 });

    expect(second.calls).toBe(0);
  });

  it('заблокированный бот перестаёт слать, а не копит попытки', async () => {
    const message = await queue();
    const transport = transportReturning({
      outcome: 'rejected',
      code: 'bot_blocked',
      retryable: false,
    });

    await deliverPendingMessages(workerDb, transport, { limit: 5 });
    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    const row = await read(message.id);
    // Человек закрыл бота: повторы ничего не изменят и только жгут лимиты.
    expect(row.state).toBe('failed');
    expect(row.last_error_code).toBe('bot_blocked');
    expect(transport.calls).toBe(1);
  });

  it('исчерпанные попытки уходят в отказ', async () => {
    const message = await queue();
    await ownerDb.query('UPDATE telegram_messages SET max_attempts = 2 WHERE id = $1', [
      message.id,
    ]);
    const transport = transportReturning({
      outcome: 'rejected',
      code: 'too_many_requests',
      retryable: true,
      retryAfterSeconds: 0,
    });

    await deliverPendingMessages(workerDb, transport, { limit: 5 });
    await deliverPendingMessages(workerDb, transport, { limit: 5 });
    await deliverPendingMessages(workerDb, transport, { limit: 5 });

    const row = await read(message.id);
    // Бесконечные повторы скрывают поломку: попытки кончаются, сообщение
    // остаётся видимым для разбора.
    expect(row.state).toBe('failed');
    expect(transport.calls).toBe(2);
  });
});

describe('оборванная отправка', () => {
  it('зависшее «отправляем» становится неизвестным, а не очередным', async () => {
    const message = await queue();
    await ownerDb.query(
      `UPDATE telegram_messages
          SET state = 'sending', sending_since = now() - interval '10 minutes'
        WHERE id = $1`,
      [message.id],
    );

    const reaped = await reapStuckSends(workerDb);

    // Процесс умер после запроса: доставка не подтверждена и не опровергнута.
    // Вернуть такое в очередь значит отправить второй раз.
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect((await read(message.id)).state).toBe('unknown');
  });

  it('свежее «отправляем» не трогается', async () => {
    const message = await queue();
    await ownerDb.query(
      `UPDATE telegram_messages SET state = 'sending', sending_since = now() WHERE id = $1`,
      [message.id],
    );

    await reapStuckSends(workerDb);

    // Отрицательный контроль: идущая прямо сейчас отправка не должна
    // объявляться оборванной.
    expect((await read(message.id)).state).toBe('sending');
  });
});
