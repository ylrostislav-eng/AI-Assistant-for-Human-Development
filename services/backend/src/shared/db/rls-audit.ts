import type { Database } from './pool.ts';

/**
 * Перечисляет таблицы без включённой или без принудительной RLS.
 *
 * Изоляция задаётся у каждой таблицы отдельно тремя действиями: ENABLE, FORCE
 * и политика. Забытая таблица ничем себя не проявляет — запросы к ней просто
 * возвращают чужие строки. Поэтому нужна проверка, перечисляющая все таблицы,
 * а не доверие к тому, что автор миграции не забыл.
 *
 * FORCE проверяется наравне с ENABLE: без него владелец таблиц читает всё, и
 * запуск приложения не той ролью снимает изоляцию.
 */

export interface TableRlsState {
  readonly table: string;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly policyCount: number;
}

/** Таблицы без пользовательских данных, которым изоляция не нужна. */
export const RLS_EXEMPT_TABLES: readonly string[] = ['schema_migrations'];

export async function readTableRlsState(
  db: Database,
  schema = 'public',
): Promise<readonly TableRlsState[]> {
  const result = await db.query<{
    table_name: string;
    rls_enabled: boolean;
    rls_forced: boolean;
    policy_count: string;
  }>(
    `SELECT c.relname AS table_name,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS rls_forced,
            count(p.polname) AS policy_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_policy p ON p.polrelid = c.oid
      WHERE n.nspname = $1 AND c.relkind = 'r'
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname`,
    [schema],
  );

  return result.rows.map((row) => ({
    table: row.table_name,
    rlsEnabled: row.rls_enabled,
    rlsForced: row.rls_forced,
    policyCount: Number(row.policy_count),
  }));
}

export async function findTablesWithoutRls(
  db: Database,
  exempt: readonly string[] = RLS_EXEMPT_TABLES,
  schema = 'public',
): Promise<readonly TableRlsState[]> {
  const state = await readTableRlsState(db, schema);
  return state.filter(
    (table) =>
      !exempt.includes(table.table) &&
      (!table.rlsEnabled || !table.rlsForced || table.policyCount === 0),
  );
}
