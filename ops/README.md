# Развёртывание

## Что здесь проверено, а что нет

| Путь | Состояние |
|---|---|
| `scripts/dev_db.sh` — локальный PostgreSQL без Docker | **Проверен**: полный цикл start/status/stop/повторный start, 16 интеграционных тестов против созданной им базы |
| `compose.yaml`, `Dockerfile` | **Не проверены**: в среде разработки не было демона Docker. Синтаксис YAML разобран, запуск и сборка не выполнялись |

Непроверенные файлы помечены и в самих файлах. Перед первым использованием их нужно запустить и исправить найденное — считать их рабочими нельзя.

## Роли базы данных: migration owner, API runtime, worker

Миграции выполняются владельцем таблиц, приложение — отдельной ролью `app_runtime` без `SUPERUSER` и `BYPASSRLS`. Это не формальность: под владельцем политики RLS не действуют, и изоляция пользователей исчезает без единой ошибки. Запуск в production под небезопасной ролью отклоняется проверкой при старте.

Роль создаётся вне миграций — в managed PostgreSQL у мигратора может не быть права создавать роли. `scripts/dev_db.sh` создаёт её для разработки; на сервере роль создаётся один раз вручную:

```sql
CREATE ROLE app_runtime LOGIN PASSWORD 'из secret manager' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE app_worker  LOGIN PASSWORD 'из secret manager' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
```

Ролей две. API видит только строки своего пользователя; worker обрабатывает задания всех пользователей, и его расширенный доступ задан отдельными политиками на `jobs` и `outbox_events`, а не отключением RLS для этих таблиц: исключение видно в списке политик, а не спрятано в отсутствии защиты.

Если роли нет, миграция останавливается с явным сообщением.

## Разработка без Docker

```bash
scripts/dev_db.sh start                  # поднимает кластер и роль, печатает обе строки подключения
export DATABASE_URL=postgres://system@127.0.0.1:5433/system_test
npm run test:integration
npm run migrate
npm run dev                      # API
npm run worker                   # фоновая обработка, роль app_worker
scripts/dev_db.sh stop
```

Кластер слушает только localhost и использует доверительную аутентификацию: он одноразовый и не предназначен для реальных данных.

Каталог кластера зависит от того, кто запускает скрипт. Под обычным пользователем это `.pgdata` в репозитории; под root — `/var/lib/postgresql/system-dev`, потому что PostgreSQL работает от пользователя `postgres`, а каталог внутри `/root` ему недоступен на обход. Свой путь задаётся переменной `PGDATA`.

## Разработка через Docker

```bash
cp ops/env.example .env                  # задать POSTGRES_PASSWORD
docker compose -f ops/compose.yaml up --build
```

Процесс `src/worker.ts` уже реализован. Worker отдельным сервисом в Compose ещё не описан; до Telegram deployment добавить/проверить его запуск и отдельный WORKER_DATABASE_URL. Lease correctness требует T-00b, реальные reminder handlers пока отсутствуют.

## Чего здесь нет

Личный пилот и публичная beta (docs/09, раздел 7) требуют TLS reverse proxy, резервных копий с проверенным восстановлением, secret manager и мониторинга. Ничего из этого не настроено и не выбрано: хостинг, регион и бюджет — решение владельца проекта, а не предположение этих файлов.

## Telegram deployment

Текущий план T-04 — web assets + API/worker/PostgreSQL, HTTPS origin/webhook, bot configuration, allowlist, backups/restore. Railway — кандидат, не проверенное развёртывание. Подробности в [архитектуре](../docs/01-system-architecture.md) и [плане](../docs/10-implementation-plan.md). Наличие рабочего локального сервера не доказывает production readiness.
