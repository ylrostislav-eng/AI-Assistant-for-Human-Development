import { loadConfig } from './config.ts';
import { reconcileExpiredAttempts } from './modules/ai/budget.ts';
import { createAiProviderFactory } from './modules/ai/providers/routing.ts';
import { closeElapsedDays } from './modules/scheduling/day-close.ts';
import { loadEnvFile } from './shared/config/load-env.ts';
import { dispatchOutbox, runJobBatch, type JobHandler } from './modules/sync/worker.ts';
import {
  createBotApiTransport,
  deliverPendingMessages,
  reapStuckSends,
} from './modules/telegram/delivery.ts';
import { processPendingUpdates, purgeProcessedPayloads } from './modules/telegram/inbox.ts';
import { createPool } from './shared/db/pool.ts';
import { logError } from './shared/logging/logger.ts';

/**
 * Процесс фоновой обработки. Отдельный от API намеренно (docs/01, раздел 1):
 * его перезапуск не должен ронять приём запросов.
 *
 * Подключается ролью `app_worker`: обработка заданий всех пользователей задана
 * политиками для этой роли, а не отключением изоляции.
 *
 * Обработчики появляются вместе с функциями: напоминания — в P1-07, закрытие
 * дня — там же. Сейчас известных видов нет, и это честное состояние: задание
 * неизвестного вида не пропускается молча, а уходит в повтор и затем в
 * dead_letter, где его видно.
 */

const HANDLERS: Record<string, JobHandler> = {};

const POLL_INTERVAL_MS = 5_000;

async function main(): Promise<void> {
  // Файл окружения читается до конфигурации, иначе значения из него не увидит
  // ни одна проверка обязательных переменных.
  loadEnvFile();
  const config = loadConfig();
  const database = createPool(config.database);

  // Без токена бота отправлять нечем и некуда: worker продолжает работать,
  // но молча делать вид, что доставляет, он не должен.
  const transport =
    config.telegram.botToken === null ? null : createBotApiTransport(config.telegram.botToken);

  // Настройки разбираются и проверяются на старте, а сам провайдер собирается
  // под каждый ход: списание привязано к человеку и ходу, и общий на всех
  // объект записал бы все обращения на того, чьё сообщение пришло первым.
  // Отсутствие ключа — рабочее состояние: бот продолжает понимать команды и
  // кнопки.
  const aiConfig = config.ai;
  const ai =
    aiConfig === null
      ? null
      : createAiProviderFactory({ config: aiConfig, database, budget: aiConfig.budget });
  if (ai === null) {
    console.log('ИИ не настроен: свободный текст разбираться не будет');
  }

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  console.log('Worker запущен');

  while (!stopping) {
    try {
      // Разбор обновлений Telegram идёт здесь, а не в приёме: внешний вызов
      // внутри приёма упёрся бы в таймаут Telegram и задержал бы подтверждение,
      // из-за которого он перестаёт повторять доставку.
      const updates = await processPendingUpdates(database, {
        allowedUserIds: config.telegram.allowedUserIds,
        ai,
      });
      // Сырые тела — личная переписка: они нужны до разбора и недолго после
      // него, а дальше хранятся без причины.
      const purged = await purgeProcessedPayloads(database);

      // Оборванные отправки разбираются до новых: иначе строка, оставленная
      // умершим процессом, держится в `sending` весь следующий проход.
      const reaped = transport === null ? 0 : await reapStuckSends(database);
      const delivery =
        transport === null
          ? { sent: 0, retried: 0, failed: 0, unknown: 0 }
          : await deliverPendingMessages(database, transport);

      // Закрытие прошедших дней: без него несделанное вчера остаётся
      // «запланированным» навсегда, и пропуск не отличается от «ещё успею».
      const dayClose = await closeElapsedDays(database);

      // Резервы, брошенные умершим процессом, закрываются по оценке. Оставить
      // их незакрытыми значит навсегда занять ими бюджет человека; освободить —
      // открыть способ не платить, падая вовремя.
      const attempts = await reconcileExpiredAttempts(database);

      const dispatched = await dispatchOutbox(database, { kinds: Object.keys(HANDLERS) });
      const batch = await runJobBatch(database, HANDLERS);
      if (
        updates.processed > 0 ||
        purged > 0 ||
        reaped > 0 ||
        delivery.sent > 0 ||
        delivery.retried > 0 ||
        delivery.failed > 0 ||
        delivery.unknown > 0 ||
        dispatched.queued > 0 ||
        batch.done > 0 ||
        batch.retried > 0 ||
        batch.deadLettered > 0 ||
        batch.leasesLost > 0 ||
        dayClose.closed > 0 ||
        dayClose.skipped > 0 ||
        attempts > 0
      ) {
        console.log(
          `Обновлений Telegram: ${updates.processed}, ответов: ${updates.replies}; ` +
            `тел очищено: ${purged}; ` +
            `доставлено: ${delivery.sent}, к повтору: ${delivery.retried}, ` +
            // Неизвестный исход виден отдельно: это не успех и не отказ, и
            // накопление таких строк означает, что связь рвётся.
            `неизвестно: ${delivery.unknown}, отказов: ${delivery.failed}, ` +
            `оборвано: ${reaped}; ` +
            `дней закрыто: ${dayClose.closed}, пропущено по версии: ${dayClose.skipped}; ` +
            `брошенных обращений закрыто: ${attempts}; ` +
            `в очередь: ${dispatched.queued}; только записано: ${dispatched.recordedOnly}; выполнено: ${batch.done}; ` +
            `к повтору: ${batch.retried}; в dead_letter: ${batch.deadLettered}; ` +
            // Потерянная аренда означает, что проход шёл дольше её срока: это
            // повод увеличить срок, а не молча пропустить строку в отчёте.
            `аренда потеряна: ${batch.leasesLost}`,
        );
      }
    } catch (error) {
      // Ошибка одного прохода не должна останавливать процесс: очередь
      // переживает временную недоступность базы.
      logError('worker_pass_failed', error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await database.end();
  console.log('Worker остановлен');
}

main().catch((error: unknown) => {
  logError('worker_start_failed', error);
  process.exit(1);
});
