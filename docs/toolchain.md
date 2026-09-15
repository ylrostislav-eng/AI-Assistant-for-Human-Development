# Среда разработки: P0-01a

Дата аудита: 2026-09-15. **Завершённый scope: инвентаризация CLI, повторяемая проверка и определение следующих технических проверок.** Установка framework dependencies и сборка приложения относятся к P0-01b.

## Найденная среда

| Компонент | Наблюдение |
|---|---|
| ОС | Ubuntu 26.04.1 LTS, Linux x86_64 |
| Node.js | 22.23.2 |
| npm | 12.0.2 |
| Python | 3.14.4 |
| Git | 2.53.0 |
| PostgreSQL client (`psql`) | 18.6 |
| Docker CLI | 29.1.3 |
| Swift / Xcode | Отсутствуют |

Это вывод локальных команд `--version`, а не перечень установленных серверных сервисов. Наличие psql не доказывает работающую БД, наличие Docker CLI — работающий daemon. Точные версии TypeScript/Fastify/GRDB и lockfiles ещё не фиксировались.

## Повторяемые команды

Из корня репозитория:

```bash
python3 scripts/check_environment.py
python3 scripts/check_environment.py --profile docs
python3 scripts/check_environment.py --profile node
python3 scripts/check_environment.py --profile ios
python3 scripts/check_environment.py --json
python3 docs/validation/check_architecture.py
```

`inventory` сообщает наблюдения; отсутствующий Swift не делает полный список ошибкой. Другие profiles проверяют свой минимальный набор CLI. Exit code 0 — выбранные CLI-условия выполнены; 2 — не выполнены. `ios` на Linux ожидаемо возвращает 2. Ни один profile не заявляет успешную сборку приложения.

Скрипт использует только Python standard library, фиксированные команды версий без shell, timeout 5 секунд на инструмент. Он не устанавливает зависимости, не запускает контейнеры, не подключается к БД и не читает ключи API. stdout в JSON подходит для будущей CI-диагностики.

## Выбор версий следующего шага

Node 22 остаётся LTS на дату проверки; линия 24 тоже LTS. Для начала можно использовать установленную 22.23.2, а окончательный pin выбирать вместе с package compatibility smoke и проверкой актуального patch. Это не обещание, что данная локальная patch-версия будет подходить для будущего публичного релиза. [Node.js Releases](https://nodejs.org/en/about/previous-releases)

Архитектурный backend candidate — Fastify 5. Его LTS-таблица включает Node 22; конкретные package versions всё равно должны пройти install/typecheck/smoke, прежде чем появятся lockfiles. [Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/)

Для PostgreSQL нужен отдельно запущенный тестовый сервер поддерживаемой версии, выделенные test credentials и успешная транзакция/миграция. Версия локального клиента не определяет версию сервера.

Для iOS нужен доступный Mac: проверить `xcodebuild -version`, SDK/simulator runtimes, сборку минимального SwiftUI app и deployment target iOS 17+. На основании Linux-аудита нельзя зафиксировать работающий Xcode/Swift/GRDB набор.

## P0-01b — следующая отдельная задача

1. Выбрать package manager и pin Node/packages; установить зависимости в проект с lockfile.
2. Создать минимальный backend scaffold согласно документу 01, запустить typecheck и проверку health route.
3. Подключить отдельный test PostgreSQL, проверить транзакции и подготовить migration command.
4. На Mac выполнить минимальную iOS сборку, зафиксировать Xcode/Swift/SDK/GRDB.
5. Только после этих результатов отмечать **весь P0-01** завершённым. Отдельные backend/iOS проверки допустимо поручать отдельными законченными задачами.
