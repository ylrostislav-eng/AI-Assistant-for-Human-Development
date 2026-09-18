import { randomUUID } from 'node:crypto';

import { createToolGateway } from '../ai/gateway.ts';
import type { AiProvider } from '../ai/provider.ts';
import { runTurn, type TurnResult } from '../ai/turn.ts';
import { lifetimeProgress } from '../progression/levels.ts';
import { derivedCommandId } from '../../shared/commands/derived-id.ts';
import type { Database, TransactionClient } from '../../shared/db/pool.ts';
import { withTransaction } from '../../shared/db/pool.ts';
import { userDayAt } from '../../shared/time/user-day.ts';
import { executeEnvelope } from '../sync/routes.ts';
import { MAX_TITLE_LENGTH, parseNewQuest } from './new-quest.ts';

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

/**
 * Выдача ключа кнопки.
 *
 * Версия снимается в момент показа списка и в ключе не меняется: нажатие по
 * списку двухчасовой давности относится к состоянию, которого человек уже не
 * видел, и должно упереться в конфликт.
 */
async function issueActionToken(
  client: TransactionClient,
  userId: string,
  quest: { id: string; version: string },
  action: 'complete_quest' | 'cancel_quest',
): Promise<string> {
  const token = createActionToken();
  await client.query(
    `INSERT INTO telegram_action_tokens
       (token, user_id, occurrence_id, action, expected_version, command_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), now() + make_interval(hours => $6))`,
    [token, userId, quest.id, action, Number(quest.version), ACTION_TOKEN_HOURS],
  );
  return token;
}

export interface ProcessOptions {
  /** Кто допущен к пилоту. Пустой список означает «никого». */
  readonly allowedUserIds: readonly string[];
  readonly limit?: number;
  /**
   * Модель для свободного текста. `null` — её нет, и бот отвечает как раньше.
   *
   * Это рабочее состояние, а не поломка: команды и кнопки не зависят от
   * провайдера (ADR-011), а шлюз за два дня наблюдений падал дважды.
   */
  readonly ai?: AiProvider | null;
  /**
   * Часы. Нужны проверкам: «появится ли задание завтра» иначе не проверить
   * иначе как ожиданием суток, а непроверенное повторение — это задание,
   * которое однажды не придёт, и никто не заметит.
   */
  readonly now?: () => Date;
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
async function composeToday(
  db: Database,
  client: TransactionClient,
  update: PendingUpdate,
  userId: string,
  now: () => Date,
): Promise<Reply> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
  await materializeRecurring(db, client, update, userId, now);
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
    // Два ключа на задание: отметить выполнение и убрать. Оба выдаются с одной
    // и той же версией, снятой прямо сейчас, — значит любое из двух действий по
    // устаревшему списку станет честным конфликтом, а не тихой правкой того,
    // чего человек не видел.
    const done = await issueActionToken(client, userId, quest, 'complete_quest');
    const cancel = await issueActionToken(client, userId, quest, 'cancel_quest');
    buttons.push([
      { text: `Сделал: ${title}`.slice(0, 64), callback_data: done },
      // Подпись без названия: она стоит в одном ряду с ним, а место в ряду
      // ограничено. «Убрать», а не «Удалить»: строка остаётся, меняется
      // состояние, и обещать стирание было бы неправдой.
      { text: 'Убрать', callback_data: cancel },
    ]);
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
  options: ProcessOptions,
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
        '/new Английский 30м — задание на сегодня',
        '/every Английский 30м — то же, но каждый день',
        '/stop Английский — перестать повторять',
        '/rename Старое -> Новое — исправить название',
        '/me — уровень и накопленное',
        '/today — показать задания с кнопками',
        '',
        'Награды, уровни и планирование появятся дальше — обещать их сейчас было бы нечестно.',
      ].join('\n'),
    };
  }

  if (text.startsWith('/today')) {
    return composeToday(db, client, update, userId, options.now ?? ((): Date => new Date()));
  }

  if (text.startsWith('/me')) {
    return composeProgress(client, userId);
  }

  if (text.startsWith('/rename')) {
    return renameQuest(db, client, update, userId, text, options);
  }

  if (text.startsWith('/stop')) {
    return stopRecurrence(db, client, update, userId, text, options);
  }

  if (text.startsWith('/new') || text.startsWith('/every')) {
    return createQuestFromLine(db, client, update, userId, text, options);
  }

  if (text === '') {
    // Прочее без текста: ответить не на то хуже, чем промолчать. Нажатия
    // кнопок сюда не попадают — они разбираются отдельно, до этого места.
    return null;
  }

  if (options.ai === undefined || options.ai === null) {
    return {
      kind: 'unknown_command',
        body: 'Пока понимаю /new, /every, /stop, /rename, /me и /today. Свободный разбор появится вместе с ИИ.',
    };
  }

  return composeAiReply(db, update, userId, text, options.ai);
}

/**
 * Что сервер действительно записал, словами для человека.
 *
 * Строится из квитанций, а не из текста модели. Модель может написать «готово»,
 * ничего не сделав, и заметить это человек сможет только через неделю, когда
 * восстановить факт будет неоткуда (docs/05, раздел 3, пункт 8).
 */
function describeReceipt(receipt: { title?: string; executionStatus?: string }): string {
  const what = receipt.title ?? 'задание';
  return `• ${what} — ${receipt.executionStatus === 'completed' ? 'выполнено' : 'записано'}`;
}

function renderTurn(result: TurnResult): string {
  const parts: string[] = [];
  const text = result.text.trim();
  if (text !== '') {
    parts.push(text);
  }
  if (result.receipts.length > 0) {
    parts.push(['Записано:', ...result.receipts.map(describeReceipt)].join('\n'));
  }
  if (result.failures.length > 0) {
    // Отдельной строкой и без подробностей кодов: человеку нужно знать, что
    // сделано не всё, и куда посмотреть. «Готово» модели при этом остаётся
    // выше — переписывать её слова мы не можем, но рядом стоит правда сервера.
    parts.push(
      'Не получилось выполнить всё, о чём написано выше. Отправьте /today, чтобы увидеть, как есть сейчас.',
    );
  }
  if (result.stopReason !== 'answered') {
    parts.push('Ответ оборван на пределе шагов. Спросите короче или по одному делу.');
  }
  if (parts.length === 0) {
    parts.push('Не понял, что сделать. Попробуйте иначе или командой: /new Английский 30м');
  }
  return parts.join('\n\n');
}

/**
 * Ход модели по свободному тексту.
 *
 * Идентификатор хода выведен из обновления, а не случайный: из него шлюз
 * выводит идентификаторы команд, и повторный разбор обновления возвращает
 * прежние квитанции вместо второго задания.
 *
 * Отказ поставщика не должен выглядеть поломкой бота. За два дня наблюдений
 * шлюз падал дважды, так что это обычный режим: человеку говорится прямо, что
 * ИИ сейчас недоступен, и называется путь, который работает всегда.
 */
async function composeAiReply(
  db: Database,
  update: PendingUpdate,
  userId: string,
  text: string,
  provider: AiProvider,
): Promise<Reply> {
  const turnId = derivedCommandId('ai-turn', update.update_id);
  const gateway = createToolGateway({ database: db, userId, turnId });

  let result: TurnResult;
  try {
    result = await runTurn({ provider, gateway, turnId, message: text, source: 'telegram' });
  } catch {
    // Причина отказа не пересказывается человеку: в ней бывает и кусок
    // отправленного текста, и подробности чужой инфраструктуры.
    return {
      kind: 'ai_unavailable',
      body: [
        'ИИ сейчас недоступен — это со стороны поставщика, не с вашей.',
        '',
        'Работает как обычно: /new Английский 30м — записать задание, /today — список с кнопками.',
      ].join('\n'),
    };
  }

  return { kind: 'ai_reply', body: renderTurn(result) };
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
/**
 * Сегодняшний пользовательский день.
 *
 * Именно пользовательский, а не календарный по серверу: задание, созданное в
 * час ночи по Москве, относится к сегодняшнему дню человека, а не к следующему
 * по UTC.
 */
async function localDay(
  client: TransactionClient,
  userId: string,
  now: () => Date,
): Promise<{ localDate: string; timezone: string }> {
  const profile = await client.query<{ timezone: string; day_boundary_minutes: number }>(
    'SELECT timezone, day_boundary_minutes FROM user_profiles WHERE user_id = $1',
    [userId],
  );
  const settings = profile.rows[0];
  if (settings === undefined) {
    throw new Error('У пользователя нет профиля');
  }
  const day = userDayAt(now(), settings.timezone, settings.day_boundary_minutes);
  return { localDate: day.localDate, timezone: settings.timezone };
}

/**
 * Достройка экземпляров повторяющихся заданий на сегодня.
 *
 * Лениво, при показе списка, а не по расписанию. Отдельный планировщик пришлось
 * бы будить в границу дня каждого пользователя и следить, чтобы он не проспал и
 * не сработал дважды; а список, который человек не открыл, ему и не нужен.
 *
 * Повторный показ безопасен без всякой блокировки. Держит это **ограничение
 * уникальности** `quest_occurrences_key_unique` по (пользователь, шаблон,
 * ключ) — проверено прямо: со случайным идентификатором команды дубликаты всё
 * равно не появляются. Поэтому убранное или выполненное сегодня не
 * возвращается сегодня: строка на этот день уже есть, просто в другом
 * состоянии.
 *
 * Условие `NOT EXISTS` ниже — не защита, а способ не отправлять заведомо
 * обречённые команды: без него каждый показ списка порождал бы отказ на
 * ограничении, и нормальным ходом дел стала бы гонка за нарушение
 * уникальности.
 */
async function materializeRecurring(
  db: Database,
  client: TransactionClient,
  update: PendingUpdate,
  userId: string,
  now: () => Date,
): Promise<void> {
  const day = await localDay(client, userId, now);
  const templates = await client.query<{ id: string }>(
    `SELECT t.id FROM quest_templates t
      WHERE t.deleted_at IS NULL
        AND t.recurrence ->> 'kind' = 'daily'
        AND NOT EXISTS (
          SELECT 1 FROM quest_occurrences o
           WHERE o.template_id = t.id AND o.recurrence_key = $1
        )
      ORDER BY t.created_at
      LIMIT 20`,
    [day.localDate],
  );

  for (const template of templates.rows) {
    await executeEnvelope(
      db,
      userId,
      // Идентификатор выведен из шаблона и даты, а не из обновления: список за
      // день открывают много раз, и повтор обязан возвращать прежнюю квитанцию,
      // а не выясняться нарушением ограничения. От дубликатов защищает не это
      // (проверено: со случайным идентификатором их тоже нет) — здесь важна
      // стабильность квитанции и отсутствие мусорных отказов в журнале.
      {
        schema_version: 1,
        command_id: derivedCommandId('recurring', template.id, day.localDate),
        device_id: derivedCommandId('recurring', 'device', update.update_id),
        kind: 'materialize_occurrence',
        aggregate_id: null,
        expected_version: null,
        client_created_at: now().toISOString(),
        depends_on_command_id: null,
        payload: {
          template_id: template.id,
          recurrence_key: day.localDate,
          timezone: day.timezone,
        },
      },
    );
  }
}

/** Название для сверки: регистр и лишние пробелы человеку не важны. */
function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
}

interface TemplateRow {
  readonly id: string;
  readonly title: string;
  readonly version: string;
}

/**
 * Шаблоны человека: все или только повторяющиеся.
 *
 * Один источник на `/stop` и `/rename`. Два отдельных запроса разошлись бы в
 * мелочах — в учёте удалённых, в пределе выборки, — и одна команда начала бы
 * видеть то, чего не видит другая.
 */
async function ownTemplates(
  client: TransactionClient,
  onlyRepeating: boolean,
): Promise<TemplateRow[]> {
  const rows = await client.query<TemplateRow>(
    `SELECT id, title, version FROM quest_templates
      WHERE deleted_at IS NULL
        AND ($1 = false OR recurrence ->> 'kind' = 'daily')
      ORDER BY created_at LIMIT 50`,
    [onlyRepeating],
  );
  return rows.rows;
}

function matchByTitle(rows: readonly TemplateRow[], wanted: string): TemplateRow[] {
  return rows.filter((row) => normalizeTitle(row.title) === normalizeTitle(wanted));
}

/**
 * Накопленное и уровень.
 *
 * Числа читаются из журнала начислений, а не сочиняются здесь: показанное
 * должно сходиться с записанным, иначе сумма за неделю не совпадёт с суммой
 * дней, и доверять перестанут обоим.
 *
 * Ноль называется нулём. Все показатели начинаются с нуля (AGENTS.md), и
 * спрятать это за бодрой формулировкой значит начать отношения со вранья.
 */
async function composeProgress(client: TransactionClient, userId: string): Promise<Reply> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
  const rows = await client.query<{ total: string | null }>(
    'SELECT COALESCE(SUM(amount_mxp), 0)::text AS total FROM xp_ledger WHERE user_id = $1',
    [userId],
  );
  const total = BigInt(rows.rows[0]?.total ?? '0');
  const progress = lifetimeProgress(total);
  const left = progress.spanMxp - progress.intoMxp;

  return {
    kind: 'me',
    body: [
      `Уровень ${progress.level}, всего ${formatXp(total.toString(), { zero: '0 XP' })}.`,
      `До следующего уровня — ${formatXp(left.toString(), { zero: '0 XP' })}.`,
      '',
      // Прямо сказано, чего ещё нет: показатель, который человек считает
      // работающим, а он не работает, хуже отсутствующего.
      'Характеристики, форма и навыки появятся дальше — пока считается только общий уровень.',
    ].join('\n'),
  };
}

/**
 * Прекращение повторения по названию.
 *
 * Сверка по названию, а не выбор из списка кнопками: остановка — действие
 * редкое и обдуманное, а третья кнопка в ряду с «Сделал» и «Убрать» означала
 * бы, что однажды её нажмут случайно и перестанут получать напоминания, не
 * поняв почему.
 *
 * Ни пустой, ни неоднозначный запрос не выполняется наугад. Остановить не то
 * задание — ошибка, которая обнаруживается через неделю тишины, и восстановить
 * её причину человеку будет нечем.
 */
async function stopRecurrence(
  db: Database,
  client: TransactionClient,
  update: PendingUpdate,
  userId: string,
  line: string,
  options: ProcessOptions,
): Promise<Reply> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
  const repeating = await ownTemplates(client, true);

  const listing =
    repeating.length === 0
      ? 'Сейчас ничего не повторяется.'
      : ['Повторяются:', ...repeating.map((row) => `• ${row.title}`)].join('\n');

  const wanted = line.trim().replace(/^\/stop(?:@\S+)?/iu, '');
  if (normalizeTitle(wanted) === '') {
    return {
      kind: 'stop_usage',
      body: [`Как пользоваться: /stop Английский`, '', listing].join('\n'),
    };
  }

  const matched = matchByTitle(repeating, wanted);
  if (matched.length === 0) {
    return { kind: 'stop_not_found', body: [`Не нашёл повторяющегося: ${wanted.trim()}`, '', listing].join('\n') };
  }
  if (matched.length > 1) {
    return {
      kind: 'stop_ambiguous',
      body: `Так называются ${matched.length} задания. Переименуйте одно из них, чтобы я не остановил не то.`,
    };
  }

  const template = matched[0] as TemplateRow;
  const now = options.now ?? ((): Date => new Date());
  const outcome = await executeEnvelope(db, userId, {
    schema_version: 1,
    command_id: derivedCommandId('stop', update.update_id),
    device_id: derivedCommandId('stop', 'device', update.update_id),
    kind: 'stop_recurrence',
    aggregate_id: template.id,
    // Версия снята в этой же транзакции: если шаблон успели изменить, остановка
    // относится к состоянию, которого человек не видел.
    expected_version: Number(template.version),
    client_created_at: now().toISOString(),
    depends_on_command_id: null,
    payload: {},
  });

  if (outcome.status !== 'committed' && outcome.status !== 'already_applied') {
    return {
      kind: 'stop_failed',
      body: 'Не получилось остановить повторение. Попробуйте ещё раз.',
    };
  }

  return {
    kind: 'stop_done',
    body: `Больше не буду повторять: ${template.title}. Сегодняшнее задание останется в списке.`,
  };
}

/**
 * Переименование задания.
 *
 * Разделитель `->` явный, а не «первое слово — старое имя»: название из
 * нескольких слов иначе не отделить от нового, и половина попыток
 * переименовала бы не то. Делится по первому вхождению: название с двумя
 * стрелками встречается реже, чем желание переименовать во что-то со стрелкой.
 */
async function renameQuest(
  db: Database,
  client: TransactionClient,
  update: PendingUpdate,
  userId: string,
  line: string,
  options: ProcessOptions,
): Promise<Reply> {
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);

  const usage: Reply = {
    kind: 'rename_usage',
    body: 'Как пользоваться: /rename Старое название -> Новое название',
  };
  const wanted = line.trim().replace(/^\/rename(?:@\S+)?/iu, '');
  const separator = wanted.indexOf('->');
  if (separator === -1) {
    return usage;
  }
  const oldTitle = wanted.slice(0, separator);
  const newTitle = wanted.slice(separator + 2).trim().replace(/\s+/gu, ' ');
  if (normalizeTitle(oldTitle) === '' || newTitle === '' || newTitle.length > MAX_TITLE_LENGTH) {
    return usage;
  }

  const all = await ownTemplates(client, false);
  const matched = matchByTitle(all, oldTitle);
  if (matched.length === 0) {
    const listing =
      all.length === 0 ? 'Заданий пока нет.' : ['Есть:', ...all.map((row) => `• ${row.title}`)].join('\n');
    return { kind: 'rename_not_found', body: [`Не нашёл: ${oldTitle.trim()}`, '', listing].join('\n') };
  }
  if (matched.length > 1) {
    // Тупик признаётся вслух, а не обходится выбором первого попавшегося:
    // переименовать не то задание человек заметит не сразу.
    return {
      kind: 'rename_ambiguous',
      body: `Так называются ${matched.length} задания, и я не знаю, которое вы имеете в виду. Уберите лишнее командой /stop или создайте новое с другим названием.`,
    };
  }

  const template = matched[0] as TemplateRow;
  const now = options.now ?? ((): Date => new Date());
  const outcome = await executeEnvelope(db, userId, {
    schema_version: 1,
    command_id: derivedCommandId('rename', update.update_id),
    device_id: derivedCommandId('rename', 'device', update.update_id),
    kind: 'rename_quest',
    aggregate_id: template.id,
    expected_version: Number(template.version),
    client_created_at: now().toISOString(),
    depends_on_command_id: null,
    payload: { title: newTitle },
  });

  if (outcome.status !== 'committed' && outcome.status !== 'already_applied') {
    return { kind: 'rename_failed', body: 'Не получилось переименовать. Попробуйте ещё раз.' };
  }

  return {
    kind: 'rename_done',
    body: `Теперь это «${newTitle}». Уже завершённые дни сохранили прежнее название.`,
  };
}

async function createQuestFromLine(
  db: Database,
  client: TransactionClient,
  update: PendingUpdate,
  userId: string,
  line: string,
  options: ProcessOptions,
): Promise<Reply> {
  const parsed = parseNewQuest(line);
  if (!parsed.ok) {
    return { kind: 'new_usage', body: parsed.hint };
  }
  const repeating = /^\/every\b/iu.test(line.trim());

  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
  const now = options.now ?? ((): Date => new Date());
  const day = await localDay(client, userId, now);

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
      // Разовое задание остаётся разовым: молчаливое превращение `/new` в
      // ежедневное означало бы, что система решила за человека.
      ...(repeating ? { recurrence: { kind: 'daily' } } : {}),
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
      timezone: day.timezone,
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
    body: repeating
      ? `Записал: ${parsed.title}. Будет появляться каждый день. Отправьте /today, чтобы увидеть список.`
      : `Записал: ${parsed.title}. Отправьте /today, чтобы увидеть список с кнопками.`,
  };
}

/**
 * Награда словами.
 *
 * Хранится она в milli-XP целым числом, а показывается в XP: тысячные доли
 * человеку не нужны, но округлять в большую сторону нельзя — показанное должно
 * сходиться с журналом, иначе сумма за неделю не совпадёт с суммой дней.
 *
 * Ноль называется прямо. Промолчать о нём значило бы дать понять, что награда
 * была: выполнение без измеренного времени её не даёт, и лучше сказать об этом
 * сразу, чем оставить человека гадать.
 */
function formatXp(milliXp: string, options: { zero?: string } = {}): string {
  const mxp = BigInt(milliXp);
  if (mxp === 0n) {
    return options.zero ?? 'XP за это не начислено: время не измерено';
  }
  const whole = mxp / 1000n;
  const fraction = (mxp < 0n ? -mxp : mxp) % 1000n;
  const tail = fraction === 0n ? '' : `.${fraction.toString().padStart(3, '0').replace(/0+$/u, '')}`;
  return `${whole}${tail} XP`;
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

  /**
   * Нагрузка нажатия.
   *
   * Отмечая «Сделал» у задания «Английский, 30 минут», человек подтверждает
   * именно то определение, которое сам и задал. Это самоотчёт — множитель
   * доказательства самый низкий, — а не выдача «сделал» за измеренные часы,
   * которую запрещает docs/05, раздел 5: там речь о придуманной величине там,
   * где её никто не назначал.
   *
   * Пустая нагрузка означала бы «выполнено, объём неизвестен», и основной
   * способ отмечать выполнение не приносил бы ничего — RPG-слой существовал бы
   * только на бумаге.
   */
  async function completionPayload(occurrenceId: string): Promise<Record<string, unknown>> {
    const snapshot = await client.query<{ spec: { success_rule?: string; duration_seconds?: number; amount?: number } }>(
      `SELECT template_snapshot -> 'normal_spec' AS spec FROM quest_occurrences WHERE id = $1`,
      [occurrenceId],
    );
    const spec = snapshot.rows[0]?.spec;
    if (spec?.success_rule === 'duration' && typeof spec.duration_seconds === 'number') {
      return { actual_duration_seconds: spec.duration_seconds, source: 'self' };
    }
    if (spec?.success_rule === 'amount' && typeof spec.amount === 'number') {
      return { actual_amount: spec.amount, source: 'self' };
    }
    return {};
  }

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
    payload: token.action === 'complete_quest' ? await completionPayload(token.occurrence_id) : {},
  });

  await client.query(
    `UPDATE telegram_action_tokens SET consumed_at = COALESCE(consumed_at, now())
      WHERE token = $1`,
    [data],
  );

  if (outcome.status === 'committed' || outcome.status === 'already_applied') {
    // Ответ называет сделанное своим именем. «Записал» после нажатия «Убрать»
    // читается как «выполнено», и человек решит, что задание засчитано.
    if (token.action === 'cancel_quest') {
      return { kind: 'button_cancelled', body: 'Убрал. Отправьте /today, чтобы увидеть остальное.' };
    }
    // Награда берётся из квитанции движка прогрессии, а не из текста здесь.
    // Число, названное ботом от себя, разошлось бы с журналом, и сошлось бы
    // оно только в тот день, когда человек перестал бы доверять обоим.
    const awarded = outcome.result?.['awarded_global_mxp'];
    const level = outcome.result?.['lifetime_level'];
    // О повышении сообщается только когда оно случилось. Говорить об уровне
    // каждый раз значит обесценить то единственное сообщение, ради которого
    // весь этот слой и нужен.
    const levelUp =
      outcome.result?.['leveled_up'] === true && typeof level === 'number'
        ? ` Уровень ${level}!`
        : '';
    return {
      kind: 'button_done',
      body:
        typeof awarded === 'string'
          ? `Записал. ${formatXp(awarded)}.${levelUp} Отправьте /today, чтобы увидеть остальное.`
          : 'Записал. Отправьте /today, чтобы увидеть остальное.',
    };
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
            : await composeReply(db, client, update, userId, options);

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
