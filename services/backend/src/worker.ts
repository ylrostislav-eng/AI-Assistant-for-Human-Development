import { loadConfig } from './config.ts';
import { dispatchOutbox, runJobBatch, type JobHandler } from './modules/sync/worker.ts';
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
  const config = loadConfig();
  const database = createPool(config.database);

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  console.log('Worker запущен');

  while (!stopping) {
    try {
      const dispatched = await dispatchOutbox(database, { kinds: Object.keys(HANDLERS) });
      const batch = await runJobBatch(database, HANDLERS);
      if (
        dispatched.queued > 0 ||
        batch.done > 0 ||
        batch.retried > 0 ||
        batch.deadLettered > 0 ||
        batch.leasesLost > 0
      ) {
        console.log(
          `В очередь: ${dispatched.queued}; только записано: ${dispatched.recordedOnly}; выполнено: ${batch.done}; ` +
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
