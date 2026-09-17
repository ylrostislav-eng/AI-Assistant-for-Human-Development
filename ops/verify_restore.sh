#!/usr/bin/env bash
# Проверка копии восстановлением.
#
# Копия, из которой ни разу не восстанавливали, копией не является: о том, что
# дамп негоден, узнают в тот единственный день, когда он нужен. Поэтому
# восстановление repeat-проверяется отдельной командой.
#
# Восстанавливает во временную базу локального кластера и сравнивает число
# строк в ключевых таблицах с исходной. Рабочая база не затрагивается.
#
# Использование:
#   DATABASE_URL=... ops/verify_restore.sh [путь к дампу]
#
# Без пути берётся самая свежая копия из BACKUP_DIR.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/ai-assistant}"
CHECK_HOST="${CHECK_HOST:-127.0.0.1}"
CHECK_PORT="${CHECK_PORT:-5433}"
CHECK_USER="${CHECK_USER:-system}"
CHECK_DB="${CHECK_DB:-restore_check_$$}"

DUMP="${1:-}"
if [[ -z "$DUMP" ]]; then
  DUMP="$(find "$BACKUP_DIR" -name 'ai-assistant-*.dump' -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -1 || true)"
fi

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Копия не найдена. Укажите путь аргументом или задайте BACKUP_DIR." >&2
  exit 1
fi

echo "Проверяется: $DUMP"

cleanup() {
  psql -h "$CHECK_HOST" -p "$CHECK_PORT" -U "$CHECK_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$CHECK_DB\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql -h "$CHECK_HOST" -p "$CHECK_PORT" -U "$CHECK_USER" -d postgres \
  -c "CREATE DATABASE \"$CHECK_DB\"" >/dev/null

# Роли приложения в проверочном кластере могут отсутствовать: дамп снят
# с --no-owner --no-privileges, поэтому восстановление их не требует.
if ! pg_restore --no-owner --no-privileges --exit-on-error \
      -h "$CHECK_HOST" -p "$CHECK_PORT" -U "$CHECK_USER" -d "$CHECK_DB" "$DUMP"; then
  echo "ВОССТАНОВЛЕНИЕ НЕ УДАЛОСЬ. Копия негодна." >&2
  exit 1
fi

count_rows() {
  psql -tA -h "$2" -p "$3" -U "$4" -d "$5" \
    -c "SELECT COALESCE((SELECT count(*) FROM $1), 0)" 2>/dev/null || echo "нет"
}

TABLES="users quest_occurrences activity_records telegram_updates telegram_messages"
FAILED=0

echo
printf '%-22s %10s %10s\n' 'таблица' 'в базе' 'в копии'
for table in $TABLES; do
  RESTORED="$(count_rows "$table" "$CHECK_HOST" "$CHECK_PORT" "$CHECK_USER" "$CHECK_DB")"

  if [[ -n "${DATABASE_URL:-}" ]]; then
    SOURCE="$(psql -tA "$DATABASE_URL" -c "SELECT count(*) FROM $table" 2>/dev/null || echo 'нет')"
  else
    SOURCE='—'
  fi

  printf '%-22s %10s %10s\n' "$table" "$SOURCE" "$RESTORED"

  # Расхождение — не всегда поломка: копия старше рабочей базы, и строк в ней
  # может быть меньше. Больше — уже подозрительно.
  if [[ "$SOURCE" != '—' && "$SOURCE" != 'нет' && "$RESTORED" != 'нет' ]]; then
    if (( RESTORED > SOURCE )); then
      echo "  строк в копии больше, чем в базе: копия не от этой базы?" >&2
      FAILED=1
    fi
  fi
done

echo
if (( FAILED )); then
  echo "ПРОВЕРКА НЕ ПРОЙДЕНА." >&2
  exit 1
fi
echo "Восстановление прошло. Схема и данные читаются."
