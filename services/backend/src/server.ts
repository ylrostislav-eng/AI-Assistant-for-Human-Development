import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './shared/db/pool.ts';
import { logError } from './shared/logging/logger.ts';
import { assertSafeDatabaseRole } from './shared/db/role-guard.ts';

/**
 * Точка входа API. Worker запускается отдельным процессом (docs/01, раздел 1),
 * чтобы его перезапуск не ронял приём запросов.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const database = createPool(config.database);

  // До приёма запросов: под небезопасной ролью изоляция пользователей молча
  // отсутствует, и обнаружилось бы это уже на данных.
  await assertSafeDatabaseRole(database, config.environment);

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
      logError('shutdown_failed', error, { method: signal });
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.server.host, port: config.server.port });
  console.log(`API слушает http://${config.server.host}:${config.server.port}`);
}

main().catch((error: unknown) => {
  // Строка подключения с паролем печаталась бы здесь целиком. Код ошибки
  // различает «нет сервера» и «неверный пароль» — этого достаточно для разбора.
  logError('api_start_failed', error);
  process.exit(1);
});
