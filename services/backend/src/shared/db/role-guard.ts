import type { AppConfig } from '../../config.ts';
import type { Database } from './pool.ts';

/**
 * Проверка роли, под которой приложение подключилось к PostgreSQL.
 *
 * Прототип изоляции арендаторов (docs/security-prototype-tenant-isolation.md)
 * показал главное свойство RLS: под владельцем таблиц или суперпользователем
 * политики не действуют. Изоляция при этом не ломается заметно — она просто
 * перестаёт существовать, а запросы продолжают возвращать данные. Поэтому
 * неверная роль должна останавливать запуск, а не обнаруживаться на чужих
 * данных.
 *
 * В разработке проверка предупреждает, но не мешает: локальный кластер обычно
 * поднимается одной ролью-владельцем, и требовать там отдельную роль значит
 * заставить обходить проверку и привыкнуть её игнорировать.
 */

export interface DatabaseRolePrivileges {
  readonly role: string;
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
}

export class UnsafeDatabaseRoleError extends Error {}

export async function readRolePrivileges(db: Database): Promise<DatabaseRolePrivileges> {
  const result = await db.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );

  const row = result.rows[0];
  if (row === undefined) {
    // current_user всегда существует в pg_roles; пустой ответ означает, что
    // запрос выполнен не там, где предполагается.
    throw new UnsafeDatabaseRoleError('Не удалось определить роль подключения к базе данных');
  }

  return { role: row.rolname, isSuperuser: row.rolsuper, bypassesRls: row.rolbypassrls };
}

export async function assertSafeDatabaseRole(
  db: Database,
  environment: AppConfig['environment'],
): Promise<DatabaseRolePrivileges> {
  const privileges = await readRolePrivileges(db);

  if (!privileges.isSuperuser && !privileges.bypassesRls) {
    return privileges;
  }

  const reason = privileges.isSuperuser ? 'является суперпользователем' : 'обходит RLS';
  const message = `Роль подключения ${privileges.role} ${reason}: изоляция пользователей не действует`;

  if (environment === 'production') {
    throw new UnsafeDatabaseRoleError(message);
  }

  console.warn(`Предупреждение: ${message}. В production запуск будет отклонён.`);
  return privileges;
}
