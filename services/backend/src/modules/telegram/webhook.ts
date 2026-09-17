import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { TelegramConfig } from '../../config.ts';
import type { Database } from '../../shared/db/pool.ts';
import { withTransaction } from '../../shared/db/pool.ts';

/**
 * Приём обновлений Telegram (T-02a, docs/14, раздел 4).
 *
 * Отдельная граница доверия: сюда стучится не наш клиент, а Telegram, и
 * access-токена здесь нет. Происхождение подтверждает секрет в заголовке — он
 * **не** равен токену бота и сам по себе не даёт права ничего менять.
 *
 * Главное свойство маршрута: обновление сохраняется **до** ответа. Telegram не
 * повторяет то, что мы подтвердили успехом, поэтому ответ «принято» за
 * несохранённое обновление теряет его навсегда. Отсюда же отказ вместо 200 при
 * недоступной базе.
 *
 * Здесь обновление только принимается. Разбор, сопоставление отправителя с
 * аккаунтом и ответы — работа обработчика (T-02b): внешний вызов внутри приёма
 * задержал бы ответ Telegram и упёрся бы в его таймаут.
 */

/**
 * Предел тела запроса. Telegram присылает обновления заметно меньше; всё, что
 * крупнее, — либо не от него, либо то, с чем мы всё равно не работаем.
 */
const MAX_BODY_BYTES = 128 * 1024;

/** Виды обновлений, у которых мы умеем найти отправителя. */
const SENDER_FIELDS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'callback_query',
  'inline_query',
  'my_chat_member',
  'chat_member',
] as const;

export interface UpdateOrigin {
  readonly kind: string | null;
  readonly senderTelegramId: string | null;
}

/**
 * Вид обновления и его отправитель.
 *
 * Отправитель берётся только из подписанного `from`. `chat.id` его не заменяет:
 * в пересланном сообщении это разные люди, и перепутать их значит выполнить
 * чужую команду от имени владельца. `forward_from` тоже не отправитель —
 * пересланное содержимое это данные, а не полномочия его автора.
 *
 * Неизвестный вид возвращает пустые поля, но обновление всё равно сохраняется:
 * Telegram добавляет виды со временем, и отбросить незнакомое значит молча
 * потерять то, что могло быть важным.
 */
export function readUpdateOrigin(update: Record<string, unknown>): UpdateOrigin {
  for (const field of SENDER_FIELDS) {
    const section = update[field];
    if (typeof section !== 'object' || section === null) {
      continue;
    }
    const from = (section as { from?: unknown }).from;
    const id = (from as { id?: unknown } | undefined)?.id;
    if (typeof id === 'number' && Number.isSafeInteger(id)) {
      return { kind: field, senderTelegramId: String(id) };
    }
    // Вид знаком, а отправителя нет — например, пост в канале от имени канала.
    return { kind: field, senderTelegramId: null };
  }
  return { kind: null, senderTelegramId: null };
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

/** Идентификатор бота из токена: часть до двоеточия, сам токен не раскрывается. */
function botScope(botToken: string | null): string {
  return botToken === null ? 'unknown' : (botToken.split(':')[0] ?? 'unknown');
}

/**
 * Схема тела намеренно закрыта только по тому, на что мы опираемся.
 *
 * Полностью закрытая схема отвергала бы обновления с полями, которые Telegram
 * добавит завтра, — то есть теряла бы сообщения ради формальной строгости.
 * Обязателен только `update_id`: без него нечем отличить повтор от нового
 * сообщения. Остальное сохраняется как есть и разбирается обработчиком.
 */
const updateSchema = {
  type: 'object',
  required: ['update_id'],
  properties: {
    update_id: { type: 'integer', minimum: 0 },
  },
} as const;

export function registerTelegramWebhook(
  app: FastifyInstance,
  telegram: TelegramConfig,
  database: Database,
): void {
  app.post(
    '/telegram/webhook',
    { schema: { body: updateSchema }, bodyLimit: MAX_BODY_BYTES },
    async (request, reply) => {
      if (telegram.webhookSecret === null) {
        // 404, а не 503: ненастроенный приём не должен подтверждать своё
        // существование.
        return reply.code(404).send({ error: 'not_found' });
      }

      const presented = request.headers['x-telegram-bot-api-secret-token'];
      if (typeof presented !== 'string' || !constantTimeEquals(presented, telegram.webhookSecret)) {
        // Причина не уточняется и в лог не пишется: секрет действующий, и его
        // место — только в настройке.
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const update = request.body as Record<string, unknown>;
      const origin = readUpdateOrigin(update);

      // Запись до ответа и в своей транзакции. Ошибка здесь обязана дойти до
      // обработчика ошибок и вернуть 5xx: Telegram повторит доставку только
      // если мы не подтвердили приём.
      const inserted = await withTransaction(database, async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO telegram_updates (bot_id, update_id, payload, kind, sender_telegram_id)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (bot_id, update_id) DO NOTHING
           RETURNING id`,
          [
            botScope(telegram.botToken),
            update['update_id'],
            JSON.stringify(update),
            origin.kind,
            origin.senderTelegramId,
          ],
        );
        return result.rowCount === 1;
      });

      // Повтор подтверждается так же, как первая доставка: Telegram обязан
      // перестать повторять, а второго эффекта у него и так не будет.
      return reply.send({ ok: true, duplicate: !inserted });
    },
  );
}
