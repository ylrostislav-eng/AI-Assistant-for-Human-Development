import {
  withTransaction,
  type Database,
  type TransactionClient,
  type TransactionOptions,
} from './pool.ts';

/**
 * Контекст пользователя для политик RLS.
 *
 * Значение живёт до конца транзакции (`set_config(..., is_local => true)`):
 * соединение возвращается в пул без контекста, и следующая транзакция чужого
 * пользователя не унаследует предыдущий. Проверено в
 * `tests/integration/tenant-isolation.test.ts`.
 *
 * Параметризация обязательна: `SET LOCAL` не принимает параметры, а склейка
 * идентификатора в текст запроса открыла бы SQL-инъекцию через значение из
 * токена.
 */
export async function withTenantTransaction<T>(
  db: Database,
  userId: string,
  run: (client: TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return withTransaction(
    db,
    async (client) => {
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
      return run(client);
    },
    options,
  );
}
