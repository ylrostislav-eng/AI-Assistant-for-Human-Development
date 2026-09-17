import { randomUUID } from 'node:crypto';

import { derivedCommandId } from '../../shared/commands/derived-id.ts';
import type { Database, TransactionClient } from '../../shared/db/pool.ts';
import { withTransaction } from '../../shared/db/pool.ts';
import { userDayAt } from '../../shared/time/user-day.ts';
import { executeEnvelope } from '../sync/routes.ts';
import { parseNewQuest } from './new-quest.ts';

/**
 * Разбор принятых обновлений Telegram (T-02b, docs/14, разделы 2 и 4).
 *
 * Разбор отделён от приёма намеренно: внешний вызов внутри приёма упёрся бы в
 * таймаут Telegram и задержал бы подтверждение, из-за которого он перестаёт
 * повторять доставку.
 *
 * Ответ не отправляется здесь, а кладётся в очередь исходящих. Таймаут запроса
 * к Telegram может означать уже доставленное сообщение: без записи о намерении
 * неизвестный исход не отличить от неотправленного, и повтор рассылает одно и
 * то же (docs/01, раздел 6, пункт 6).
 */

/** Сколько обновлений разбирать за проход. */
const DEFAULT_LIMIT = 20;

/**
 * Сколько сырое тело живёт после обработки. Это личная переписка: она нужна на
 * разбор поломки и дальше хранится без причины (docs/14, раздел 4).
 */
const PAYLOAD_RETENTION_HOURS = 24;

/**
 * Сколько живёт кнопка. Сутки: список заданий за это время всё равно
 * устаревает, а вечный ключ незачем держать.
 */
const ACTION_TOKEN_HOURS = 24;

/**
 * Непрозрачный ключ кнопки. В `callback_data` помещается 64 байта, и класть
 * туда состояние нельзя — клиент подменит его чем угодно. Дефисы исключены:
 * ключ не должен выглядеть разбираемым, чтобы никто не начал его парсить.
 */
function createActionToken(): string {
  return randomUUID().replaceAll('-', '');
}

export interface ProcessOptions {
  /** Кто допущен к пилоту. Пустой список означает «никого». */
  readonly allowedUserIds: readonly string[];
  readonly limit?: number;
}

export interface ProcessResult {
  readonly processed: number;
  readonly replies: number;
}

interface PendingUpdate {
  readonly id: string;
  readonly update_id: string;
  readonly kind: string | null;
  readonly sender_telegram_id: string | null;
  readonly payload: Record<string, unknown>;
}

interface InlineButton {
  readonly text: string;
  readonly callback_data: string;
}

interface Reply {
  readonly kind: string;
  readonly body: string;
  readonly replyMarkup?: { inline_keyboard: InlineButton[][] };
}

/** Текст сообщения, если он есть; у нажатия кнопки его нет. */
function messageText(payload: Record<string, unknown>): string | null {
  const message = payload['message'] ?? payload['edited_message'];
  const text = (message as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : null;
}

/** Чат, в который отвечаем. Берётся из того же раздела, что и отправитель. */
function chatId(payload: Record<string, unknown>): string | null {
  for (const field of ['message', 'edited_message', 'callback_query']) {
    const section = payload[field];
    if (typeof section !== 'object' || section === null) {
      continue;
    }
    const chat = (section as { chat?: { id?: unknown } }).chat;
    if (typeof chat?.id === 'number' && Number.isSafeInteger(chat.id)) {
      return String(chat.id);
    }
    const from = (section as { from?: { id?: unknown } }).from;
    if (typeof from?.id === 'number' && Number.isSafeInteger(from.id)) {
      // У нажатия кнопки чат лежит в сообщении, а если его нет — отвечаем
      // отправителю напрямую.
      return String(from.id);
    }
  }
  return null;
}

/**
 * Сегодняшние задания по серверному состоянию.
 *
 * Именно по состоянию, а не разбором прежних сообщений бота (docs/14, раздел 2):
 * сообщение устаревает в тот момент, когда то же задание завершают в другом
 * месте, и пересказ переписки показал бы человеку прошлое.
 */
async function composeToday(client: TransactionClient, userId: string): Promise<Reply> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
  const quests = await client.query<{
    id: string;
    version: string;
    template_snapshot: { title?: string };
  }>(
    `SELECT id, version, template_snapshot FROM quest_occurrences
      WHERE execution_status IN ('planned', 'active', 'partial')
      ORDER BY created_at
      LIMIT 20`,
  );

  if (quests.rowCount === 0) {
    return {
      kind: 'today',
      body: 'Сегодня заданий нет. Их пока некому создать: планирование появится дальше.',
    };
  }

  const buttons: InlineButton[][] = [];
  const titles: string[] = [];

  for (const quest of quests.rows) {
    const title = quest.template_snapshot.title ?? 'без названия';
    titles.push(`• ${title}`);

    // Ключ выдаётся вместе с версией, снятой прямо сейчас, и со стабильным
    // идентификатором команды. Версия делает нажатие по устаревшему списку
    // честным конфликтом, а идентификатор — повторное нажатие безвредным.
    const token = createActionToken();
    await client.query(
      `INSERT INTO telegram_action_tokens
         (token, user_id, occurrence_id, action, expected_version, command_id, expires_at)
       VALUES ($1, $2, $3, 'complete_quest', $4, gen_random_uuid(),
               now() + make_interval(hours => $5))`,
      [token, userId, quest.id, Number(quest.version), ACTION_TOKEN_HOURS],
    );
    buttons.push([{ text: `Сделал: ${title}`.slice(0, 64), callback_data: token }]);
  }

  return {
    kind: 'today',
    body: [`Сегодня заданий: ${quests.rowCount}`, ...titles].join('\n'),
    replyMarkup: { inline_keyboard: buttons },
  };
}

/**
 * Ответ на обновление.
 *
 * Незнакомый текст получает понятный ответ, а не молчание: человек, которому не
 * ответили, пишет снова и снова и считает, что сломалось.
 */
async function composeReply(
  db: Database,
  client: TransactionClient,
  update: PendingUpdate,
  userId: string | null,
): Promise<Reply | null> {
  if (userId === null) {
    // Чужому отправителю отвечаем, но аккаунт ему не заводим.
    return {
      kind: 'not_allowed',
      body: 'Это личная система развития, и доступ к ней закрыт. Если бот нужен вам — напишите владельцу.',
    };
  }

  const text = messageText(update.payload)?.trim() ?? '';

  if (text.startsWith('/start')) {
    return {
      kind: 'start',
      body: [
        'Система развития на связи.',
        '',
        'Что умею сейчас:',
        '/new Английский 30м — создать задание на сегодня',
        '/today — показать задания с кнопками',
        '',
        'Награды, уровни и планирование появятся дальше — обещать их сейчас было бы нечестно.',
      ].join('\n'),
    };
  }

  if (text.startsWith('/today')) {
    return composeToday(client, userId);
  }

  if (text.startsWith('/new')) {
    return createQuestFromLine(db, client, update, userId, text);
  }

  if (text === '') {
    // Прочее без текста: ответить не на то хуже, чем промолчать. Нажатия
    // кнопок сюда не попадают — они разбираются отдельно, до этого места.
    return null;
  }

  return {
    kind: 'unknown_command',
    body: 'Пока понимаю /new и /today. Свободный разбор появится вместе с ИИ.',
  };
}

/**
 * Идентификатор команды, выведенный из обновления.
 *
 * Обязателен именно детерминированный: команда выполняется своей транзакцией, и
 * если внешняя (та, что помечает обновление разобранным) упадёт после неё,
 * обновление разберётся второй раз. Со случайным идентификатором это создало бы
 * второе задание; с выведенным шина узнаёт повтор и вернёт прежнюю квитанцию.
 *
 * Вывод общий с ходом ИИ: две копии одного правила разъехались бы незаметно, а
 * повод у них один и тот же — внешний источник, который повторяет доставку.
 */
function commandIdFor(updateId: string, step: string): string {
  return derivedCommandId('telegram', updateId, step);
}

/**
 * Создание задания одной строкой.
 *
 * Обе команды идут через тот же `executeEnvelope`, что и Mini App: отдельного
 * пути для бота быть не должно, иначе проверки контракта начнут действовать
 * только на одном из них.
 *
 * Ключ повторения — локальная дата пользовательского дня, а не дата сервера:
 * человек в Москве, создающий задание в час ночи, имеет в виду сегодняшний
 * день по своей границе, а не по UTC.
 */
async function createQuestFromLine(
  db: Database,
  client: TransactionClient,
  update: PendingUpdate,
  userId: string,
  line: string,
): Promise<Reply> {
  const parsed = parseNewQuest(line);
  if (!parsed.ok) {
    return { kind: 'new_usage', body: parsed.hint };
  }

  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
  const profile = await client.query<{ timezone: string; day_boundary_minutes: number }>(
    'SELECT timezone, day_boundary_minutes FROM user_profiles WHERE user_id = $1',
    [userId],
  );
  const settings = profile.rows[0];
  if (settings === undefined) {
    throw new Error('У пользователя нет профиля');
  }
  const day = userDayAt(new Date(), settings.timezone, settings.day_boundary_minutes);

  const envelope = (kind: string, step: string, payload: Record<string, unknown>) => ({
    schema_version: 1,
    command_id: commandIdFor(update.update_id, step),
    device_id: commandIdFor(update.update_id, 'device'),
    kind,
    aggregate_id: null,
    expected_version: null,
    client_created_at: new Date().toISOString(),
    depends_on_command_id: null,
    payload,
  });

  const template = await executeEnvelope(
    db,
    userId,
    envelope('create_quest_template', 'template', {
      title: parsed.title,
      normal_spec: parsed.spec,
    }),
  );
  const templateId = template.result?.['template_id'];
  if (typeof templateId !== 'string') {
    return {
      kind: 'new_failed',
      body: 'Не получилось создать задание. Попробуйте ещё раз или напишите иначе.',
    };
  }

  const occurrence = await executeEnvelope(
    db,
    userId,
    envelope('materialize_occurrence', 'occurrence', {
      template_id: templateId,
      recurrence_key: day.localDate,
      timezone: settings.timezone,
    }),
  );
  if (occurrence.result === undefined) {
    return {
      kind: 'new_failed',
      body: 'Задание создано, но не попало в сегодняшний день. Отправьте /today и посмотрите.',
    };
  }

  return {
    kind: 'new_created',
    body: `Записал: ${parsed.title}. Отправьте /today, чтобы увидеть список с кнопками.`,
  };
}

/** Ответ, одинаковый для просроченного и несуществующего ключа. */
const EXPIRED_BUTTON: Reply = {
  kind: 'expired_button',
  body: 'Эта кнопка больше не действует. Отправьте /today, чтобы обновить список.',
};

/**
 * Нажатие кнопки.
 *
 * Ключ непрозрачен, и всё, что он значит, лежит на сервере. Владелец
 * проверяется отдельно: политика изоляции и так не покажет чужую строку, но
 * полагаться на одно только это значит зависеть от того, что контекст
 * пользователя установлен верно.
 *
 * Несуществующий ключ получает тот же ответ, что и просроченный: различие
 * подсказало бы подбирающему, какие ключи существуют.
 */
async function handleButtonPress(
  db: Database,
  client: TransactionClient,
  update: PendingUpdate,
  userId: string | null,
): Promise<Reply | null> {
  const callback = update.payload['callback_query'] as { data?: unknown } | undefined;
  const data = callback?.data;
  if (userId === null || typeof data !== 'string') {
    return EXPIRED_BUTTON;
  }

  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
  const found = await client.query<{
    occurrence_id: string;
    action: string;
    expected_version: string;
    command_id: string;
  }>(
    `SELECT occurrence_id, action, expected_version, command_id
       FROM telegram_action_tokens
      WHERE token = $1 AND user_id = $2 AND expires_at > now()`,
    [data, userId],
  );

  const token = found.rows[0];
  if (token === undefined) {
    return EXPIRED_BUTTON;
  }

  // Команда идёт тем же путём, что у Mini App: отдельного протокола для бота
  // быть не должно (docs/14, раздел 4). Идентификатор команды взят из ключа и
  // не меняется, поэтому повторное нажатие возвращает прежнюю квитанцию, а не
  // даёт второй эффект.
  const outcome = await executeEnvelope(db, userId, {
    schema_version: 1,
    command_id: token.command_id,
    device_id: token.command_id,
    kind: token.action,
    aggregate_id: token.occurrence_id,
    expected_version: Number(token.expected_version),
    client_created_at: new Date().toISOString(),
    depends_on_command_id: null,
    payload: {},
  });

  await client.query(
    `UPDATE telegram_action_tokens SET consumed_at = COALESCE(consumed_at, now())
      WHERE token = $1`,
    [data],
  );

  if (outcome.status === 'committed' || outcome.status === 'already_applied') {
    return { kind: 'button_done', body: 'Записал. Отправьте /today, чтобы увидеть остальное.' };
  }

  if (outcome.error === 'version_conflict' || outcome.error === 'invalid_transition') {
    // Задание изменилось в другом месте. Менять состояние нельзя: человек
    // нажимал по экрану, которого уже нет.
    return {
      kind: 'stale_button',
      body: 'Задание изменилось с момента показа. Отправьте /today, чтобы увидеть, как есть сейчас.',
    };
  }

  return {
    kind: 'button_failed',
    body: 'Не получилось записать. Отправьте /today и попробуйте ещё раз.',
  };
}

/**
 * Один проход разбора.
 *
 * Обновления берутся `FOR UPDATE SKIP LOCKED`: второй проход не ждёт первого и
 * не разбирает то же самое. Пометка обработки и постановка ответа идут одной
 * транзакцией — иначе сбой между ними оставил бы ответ без пометки, и человек
 * получил бы его дважды.
 */
export async function processPendingUpdates(
  db: Database,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  return withTransaction(db, async (client) => {
    const pending = await client.query<PendingUpdate>(
      `SELECT id, update_id, kind, sender_telegram_id, payload
         FROM telegram_updates
        WHERE processed_at IS NULL
        ORDER BY received_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    let replies = 0;
    for (const update of pending.rows) {
      // Контекст пользователя сбрасывается перед каждым обновлением: иначе он
      // достаётся следующему от предыдущего, и однажды кто-то прочитает чужие
      // строки, потому что контекст просто не успели сменить.
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', '']);

      const sender = update.sender_telegram_id;
      let userId: string | null = null;

      if (sender !== null && options.allowedUserIds.includes(sender)) {
        const resolved = await client.query<{ identity_resolve_telegram: string }>(
          'SELECT identity_resolve_telegram($1)',
          [sender],
        );
        userId = resolved.rows[0]?.identity_resolve_telegram ?? null;
      }

      const target = chatId(update.payload);
      const isButton = update.kind === 'callback_query';
      const reply =
        sender === null || target === null
          ? null
          : isButton
            ? await handleButtonPress(db, client, update, userId)
            : await composeReply(db, client, update, userId);

      if (reply !== null && target !== null) {
        await client.query(
          `INSERT INTO telegram_messages
             (user_id, chat_id, kind, body, dedupe_key, reply_markup)
           VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            userId,
            target,
            reply.kind,
            reply.body,
            `update:${update.update_id}`,
            reply.replyMarkup === undefined ? null : JSON.stringify(reply.replyMarkup),
          ],
        );
        replies += 1;
      }

      // Подтверждение нажатия: без него кнопка «крутится» у человека на
      // экране. Оно ставится в ту же очередь и отдельной записью — это другой
      // метод Bot API, и его неудача не должна отменять сам ответ.
      const callbackId = (update.payload['callback_query'] as { id?: unknown } | undefined)?.id;
      if (isButton && typeof callbackId === 'string') {
        await client.query(
          `INSERT INTO telegram_messages
             (user_id, chat_id, kind, body, dedupe_key, method, callback_query_id)
           VALUES ($1::uuid, $2, 'callback_ack', '', $3, 'answerCallbackQuery', $4)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [userId, target ?? '0', `ack:${update.update_id}`, callbackId],
        );
      }

      await client.query('UPDATE telegram_updates SET processed_at = now() WHERE id = $1', [
        update.id,
      ]);
    }

    return { processed: pending.rowCount ?? 0, replies };
  });
}

/**
 * Стирание сырых тел обработанных обновлений по сроку.
 *
 * Стирается только тело: строка остаётся, потому что на ней держится
 * дедупликация. Без неё старое обновление, доставленное повторно, сработало бы
 * второй раз. Необработанные не трогаются ни при каком возрасте — стереть тело
 * до разбора значит потерять сообщение человека.
 */
export async function purgeProcessedPayloads(db: Database): Promise<number> {
  const result = await db.query(
    `UPDATE telegram_updates
        SET payload = '{}'::jsonb, payload_purged_at = now()
      WHERE processed_at IS NOT NULL
        AND payload_purged_at IS NULL
        AND processed_at < now() - make_interval(hours => $1)`,
    [PAYLOAD_RETENTION_HOURS],
  );
  return result.rowCount ?? 0;
}
