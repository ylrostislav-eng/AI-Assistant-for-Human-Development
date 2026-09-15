#!/usr/bin/env bash
# Локальный PostgreSQL для разработки и интеграционных тестов.
#
# Зачем отдельный скрипт, а не docker compose: демон Docker доступен не везде
# (в среде, где выполнялся P0-01b, его не было), а для проверок нужен реальный
# сервер, а не клиент psql. Здесь кластер поднимается штатными initdb/pg_ctl.
# Вариант с compose лежит в ops/compose.yaml и предполагает работающий демон.
#
# Кластер одноразовый и с доверительной аутентификацией: он слушает только
# localhost и не предназначен ни для каких реальных данных.
#
# Использование:
#   scripts/dev_db.sh start     поднять кластер и создать базы
#   scripts/dev_db.sh stop      остановить
#   scripts/dev_db.sh status    состояние
#   scripts/dev_db.sh url       напечатать DATABASE_URL тестовой базы

set -euo pipefail

PGPORT="${PGPORT:-5433}"
PGDATA="${PGDATA:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.pgdata}"
PGUSER_NAME="${PGUSER_NAME:-system}"
DEV_DB="${DEV_DB:-system_dev}"
TEST_DB="${TEST_DB:-system_test}"
RUNTIME_ROLE="${RUNTIME_ROLE:-app_runtime}"

find_bindir() {
  # Версия сервера зависит от дистрибутива, поэтому берётся самая новая из
  # установленных, а не захардкоженная.
  local candidate
  candidate="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$candidate" ]]; then
    echo "$candidate"
    return 0
  fi
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return 0
  fi
  echo "PostgreSQL server не найден: нет ни /usr/lib/postgresql/*/bin, ни pg_ctl в PATH" >&2
  return 1
}

BINDIR="$(find_bindir)"

# PostgreSQL отказывается работать под root, поэтому от root команды
# выполняются от имени системного пользователя postgres. Под обычным
# пользователем su не нужен.
run_pg() {
  if [[ "$(id -u)" -eq 0 ]]; then
    su postgres -c "$*"
  else
    bash -c "$*"
  fi
}

# Проверка тоже идёт через run_pg: под root pg_ctl отказывается работать
# целиком, включая status. Прямой вызов возвращал «не запущен» для живого
# сервера, и повторный start пытался поднять второй экземпляр поверх первого.
is_running() {
  run_pg "$BINDIR/pg_ctl -D '$PGDATA' status" >/dev/null 2>&1
}

cmd_start() {
  if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
    mkdir -p "$PGDATA"
    if [[ "$(id -u)" -eq 0 ]]; then
      chown postgres:postgres "$PGDATA"
    fi
    run_pg "$BINDIR/initdb -D '$PGDATA' -U '$PGUSER_NAME' --auth=trust -E UTF8" >/dev/null
    echo "Кластер создан: $PGDATA"
  fi

  if is_running; then
    echo "Кластер уже запущен на порту $PGPORT"
  else
    # Сокет в /tmp: каталог по умолчанию может быть недоступен на запись.
    run_pg "$BINDIR/pg_ctl -D '$PGDATA' -l '$PGDATA/server.log' -o '-p $PGPORT -k /tmp' start" >/dev/null
    echo "Кластер запущен на порту $PGPORT"
  fi

  for db in "$DEV_DB" "$TEST_DB"; do
    if ! psql -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_NAME" -lqt | cut -d'|' -f1 | grep -qw "$db"; then
      createdb -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_NAME" "$db"
      echo "База создана: $db"
    fi
  done

  # Роль времени выполнения создаётся здесь, а не миграцией: создание ролей
  # требует прав, которых у мигратора может не быть в managed PostgreSQL.
  # NOSUPERUSER и NOBYPASSRLS обязательны — под суперпользователем политики RLS
  # не действуют, и изоляция пользователей исчезает молча.
  psql -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_NAME" -d "$TEST_DB" -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$RUNTIME_ROLE') THEN
    EXECUTE 'CREATE ROLE $RUNTIME_ROLE LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  END IF;
END
\$\$;
SQL

  cmd_url
}

cmd_stop() {
  if is_running; then
    run_pg "$BINDIR/pg_ctl -D '$PGDATA' stop" >/dev/null
    echo "Кластер остановлен"
  else
    echo "Кластер не запущен"
  fi
}

cmd_status() {
  if is_running; then
    echo "Запущен: $PGDATA, порт $PGPORT"
  else
    echo "Не запущен: $PGDATA"
    exit 1
  fi
}

cmd_url() {
  # Две строки подключения: миграции идут владельцем, приложение — ролью без
  # BYPASSRLS, иначе политики изоляции не действуют.
  echo "DATABASE_URL=postgres://$PGUSER_NAME@127.0.0.1:$PGPORT/$TEST_DB"
  echo "RUNTIME_DATABASE_URL=postgres://$RUNTIME_ROLE@127.0.0.1:$PGPORT/$TEST_DB"
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  url) cmd_url ;;
  *)
    echo "Использование: $0 {start|stop|status|url}" >&2
    exit 1
    ;;
esac
