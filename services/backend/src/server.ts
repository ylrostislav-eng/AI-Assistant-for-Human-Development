import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './shared/db/pool.ts';

/**
 * Точка входа API. Worker запускается отдельным процессом (docs/01, раздел 1),
 * чтобы его перезапуск не ронял приём запросов.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const database = createPool(config.database);
  const app = createApp({ config, database });

  const shutdown = async (signal: string): Promise<void> => {
    // Сначала перестаём принимать запросы, потом закрываем пул: обратный
    // порядок обрывает уже начатые транзакции.
    try {
      await app.close();
      await database.end();
      process.exitCode = 0;
    } catch (error) {
      process.exitCode = 1;
      console.error(`Ошибка остановки по сигналу ${signal}:`, error);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.server.host, port: config.server.port });
  console.log(`API слушает http://${config.server.host}:${config.server.port}`);
}

main().catch((error: unknown) => {
  console.error('Не удалось запустить API:', error);
  process.exit(1);
});
