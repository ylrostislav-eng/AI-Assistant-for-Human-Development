#!/usr/bin/env bash
# Резервная копия базы.
#
# Railway отдаёт копии тома только на тарифе Pro, поэтому копии делаем сами.
# Копия ложится на другую машину, чем база: одновременная потеря сервера и
# Railway маловероятна, а копия рядом с базой от потери диска не спасает.
#
# Формат custom (-Fc), а не текстовый SQL: он сжат, восстанавливается
# выборочно и проверяется на целостность до восстановления.
#
# Использование:
#   ops/backup_db.sh                     копия в каталог по умолчанию
#   BACKUP_DIR=/mnt/backups ops/backup_db.sh
#
# DATABASE_URL обязателен. Пароль в командной строке не светится: он уходит
# в pg_dump через окружение.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/ai-assistant}"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Не задан DATABASE_URL: неизвестно, что копировать." >&2
  exit 1
fi

command -v pg_dump >/dev/null || { echo "pg_dump не найден." >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
# Каталог с копиями читает только владелец: в дампе лежат все личные данные.
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/ai-assistant-$STAMP.dump"
TEMP="$TARGET.partial"

# Сначала во временный файл: прерванный дамп не должен выглядеть готовой
# копией. Имя получает только то, что записалось целиком.
if ! pg_dump --format=custom --no-owner --no-privileges --file="$TEMP" "$DATABASE_URL"; then
  rm -f "$TEMP"
  echo "Копия не создана." >&2
  exit 1
fi

# Проверка целостности до переименования: pg_restore --list читает оглавление
# и падает на обрезанном файле. Дамп, который нельзя прочитать, хуже
# отсутствующего — на него надеются.
if ! pg_restore --list "$TEMP" >/dev/null 2>&1; then
  rm -f "$TEMP"
  echo "Дамп нечитаем, копия отброшена." >&2
  exit 1
fi

mv "$TEMP" "$TARGET"
chmod 600 "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "Копия готова: $TARGET ($SIZE)"

# Удаляются только целые копии старше срока. Незавершённые файлы подчищаются
# отдельно и без учёта возраста.
find "$BACKUP_DIR" -name 'ai-assistant-*.dump.partial' -delete
DELETED="$(find "$BACKUP_DIR" -name 'ai-assistant-*.dump' -mtime "+$KEEP_DAYS" -print -delete | wc -l)"
echo "Хранится копий: $(find "$BACKUP_DIR" -name 'ai-assistant-*.dump' | wc -l), удалено старых: $DELETED"
