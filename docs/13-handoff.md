# 13. Передача работы следующей модели

Обновлено: 2026-09-16. Текущий документ заменяет накопленные противоречивые статусы; прежний журнал сохранён в [историческом архиве](archive/pre-telegram-2026-09-16.txt). Архив не является планом следующих действий.

## 1. Продукт и актуальное поручение

Сначала личная Система развития, затем публичный продукт. Клиент — **Telegram Mini App + бот**, ADR-013–016. Пять вкладок, Goal → AI Plan → Quest → Completion → XP → Adaptation сохраняются. Сервер детерминированно считает прогресс; Telegram — интерфейс и транспорт.

Последнее поручение: проверить уже сделанный backend и переписать план/архитектуру под Telegram с минимальной потерей функций. Законченный документационный scope **T-DOC-01**: аудит, Telegram architecture/auth/bot/offline/voice/integration protocols, новый план, инструкции агентам. Это не поручение реализовать все перечисленные фазы и не факт готовности клиента.

## 2. Фактическая реализация

| Область | Есть | Осталось |
|---|---|---|
| Toolchain | npm workspaces, pins/lockfile, TS/Fastify/pg, test tooling | Web scaffold/lock additions после compatibility smoke |
| DB | Миграции 001–008, identity/profile/goals/quests/calendar/sync/jobs, RLS/roles | Activity/ledger и новые Telegram tables по задачам |
| Identity | Dev synthetic login, opaque access/refresh, rotation/logout, закрытый доступ | Signed Telegram login + external identities + installation binding |
| Commands | Bus, receipts, user counters, batches, own-key registry, семантический hash, каноническая цель/версия, закрытые схемы нагрузки (**T-00a выполнен**) | Расширения domain; политика фоновых исполнителей |
| Worker | Outbox/dispatch/jobs, аренда с владельцем, CAS на завершении/неудаче/продлении, ограниченный повторный захват (**T-00b выполнен**) | Реальные domain/Telegram handlers, delivery ledger |
| Quests | Create template/materialize/start/complete/partial/cancel states | Сохранение Activity/объёма/вариантов, timer/undo; сейчас completion status-only |
| Time | Pure CalendarMath, ensureUserDay, unit/integration | T-00c/d DST и policy transition; Scheduler/day-close/reminders |
| Клиент/бот | Архитектура и будущие контракты | Mini App, webhook, real Telegram auth, read/bootstrap/pull API отсутствуют |
| AI/RPG | Документация, JSON rules, arithmetic sanity | Production AI/Progression/ledger/Recovery/reviews отсутствуют |
| Operations | Локальный DB script, непроверенные Docker/Compose sketches | HTTPS hosting, bot setup, secrets, backup/restore, реальный пилот |

Реальные routes: `GET /health`, `GET /health/ready`, `POST /auth/dev-login`, `/auth/refresh`, `/auth/logout`, `GET /me`, `POST /commands`. [OpenAPI](../packages/contracts/openapi.yaml) отражает их; будущие маршруты в docs/06 пока не существуют. `apps/miniapp` пока не создан.

## 3. Найденные ограничения кода

[Полный отчёт R1–R7](15-backend-review.md) с воспроизведением, файлами и acceptance tests:

- ~~R1: top-level expected_version/aggregate теряются при dispatch.~~ Исправлено в T-00a (`453cf3f`).
- ~~R2: hash команды не учитывает kind, возвращается receipt другой операции.~~ Исправлено в T-00a (`453cf3f`), миграция 009.
- ~~R3: нет lease ownership CAS; expired lease может превысить max attempts.~~ Исправлено в T-00b, миграция 010.
- R4: 8 из 12 проб DST gap по 5 минут дают неверную первую допустимую границу.
- R5: смена boundary 04:00→00:00 создаёт overlapping user days.
- R6: **частично исправлено в T-00a** (`a2b2345` и далее): закрытые схемы нагрузки по видам, own-key registry, minimum только по принятой спецификации. Осталось из P1-06: Activity root с фактическим объёмом/длительностью/временем, source/variant snapshot, correction path.
- R7: raw error logging и общий catch refresh требуют исправления до реальных данных.

**Исправления production-кода не выполнены в T-DOC-01.** Проходящий baseline не является подтверждением этих новых сценариев. Не подключать реальные награды и imports в обход исправлений.

### 3.1 Что сделано в T-00a

Три коммита, каждый с живой проверкой на PostgreSQL 18.6.

1. `453cf3f` — канонические цель и версия из конверта, семантический хеш повтора (схема, вид, цель, версия, зависимость, нагрузка), миграция 009 с `kind`/`hash_version`. Квитанции прежней схемы (`hash_version = 1`) не угадываются: их повтор отклоняется как конфликт, потому что доказать тождество нечем.
2. `a2b2345` — закрытые схемы нагрузки по видам команд в `packages/contracts/schemas/commands/`, сверка реестра со схемами в обе стороны, minimum только по принятой спецификации, явный отказ на неподдержанный `depends_on_command_id`.
3. Политика версии: изменяющая команда обязана назвать цель и версию, создающая присылает оба поля пустыми. Это меняет контракт клиента — кнопка бота обязана нести версию в action token (docs/14, раздел про callback data; таблица `telegram_action_tokens` в docs/02 это уже предполагает).

Регрессионные сценарии написаны **до** исправления и проверены отрицательным контролем: с выключенными проверками падают именно они, законные пути продолжают проходить.

Не сделано в T-00a: R3, R4, R5, R7 и Activity-часть R6 — по ним код не менялся.

### 3.2 Что сделано в T-00b

Миграция 010 добавляет `lease_token`: маркер владения арендой. Завершение,
неудача и продление проверяют его compare-and-set, поэтому ожившая после паузы
задача не трогает работу, которую уже взял другой. Повторный захват ограничен
`attempts < max_attempts`, а задание с исчерпанными попытками и истёкшей
арендой уходит в dead_letter, а не остаётся навсегда в `running`. Резервирование
идёт по одному заданию: обработчики выполняются последовательно, и пачка,
взятая разом, теряла аренду на последних заданиях ещё до их запуска.

Четыре сценария R3 и два сценария продления написаны с двумя исполнителями и
проверены отрицательным контролем: с убранными проверками падают все четыре.

**Fencing не обещает exactly-once внешней отправки.** Таймаут запроса в Telegram
может означать уже доставленное сообщение; для этого нужен отдельный delivery
ledger (docs/01, раздел 6, пункт 6), которого пока нет.

## 4. Проверки T-DOC-01

Baseline `4ecfee7`, исходное дерево чистое.

- `npm run typecheck` — PASS.
- `npm test` — PASS: **53 tests / 5 files**.
- После правки описания OpenAPI: `npm exec --workspace services/backend -- vitest run tests/contracts` — повторный PASS: **10 tests / 2 files** (входят в те же 53, не дополнительные новые тесты).
- `DATABASE_URL=… npm run test:integration` — PASS: **159 tests / 16 files**, PostgreSQL **18.6**.
- Дополнительные HTTP/DB probes R1/R2/R3/R5/R6 и pure DST probe R4 — воспроизвели описанные ошибки, не доказывают их исправление.
- Integration tests использовали отдельный `/tmp/system-telegram-audit-20260916`, порт 55437, synthetic `system_audit_test`; рабочая БД не затрагивалась. Песочница блокировала localhost/chown; запуск с разрешённым выходом из неё дал PASS.
- `python3 docs/validation/check_architecture.py --write-report` — PASS: 24 Markdown-файла, 273 локальные ссылки, покрытие 77 разделов / 32 требований, 2002 порога уровней и 250 split cases.
- `npm run scan:secrets` — PASS: 94 файла; только известные формы секретов, не доказательство полного отсутствия.
- `git diff --check` — PASS.
- Временный кластер аудита остановлен после проверок.
- Исходная концепция побайтово совпадает с вложением; concept и progression JSON совпадают с HEAD.

Не проверялись реальные Telegram clients/webhook/login, Shortcuts/Health, OpenAI/ASR/TTS, browser build, Docker build, deploy, performance/load/production restore. Mac не нужен для следующей серверной/web задачи; device proof требует телефона и настроенного test bot/HTTPS.

## 5. Изменённые спецификации и контракты

- Docs 00–03, 05–12, README, AGENTS, toolchain/ops актуализированы; новые [14](14-telegram-platform.md), [15](15-backend-review.md).
- Docs/06/14 **проектируют** Telegram auth/webhook, normalized commands, web sync и integrations; это не новые реализованные endpoints.
- В `packages/contracts/openapi.yaml` изменено только описание текущего состояния. Wire schemas/JSON fixtures, SQL migrations, backend implementation и числовые правила не менялись.
- `check_architecture.py` и generated balance report: уточнена только граница проверки, формулы прежние.
- Исходная концепция и progression JSON сохраняются без правок; в docs/03 изменено только имя клиента для preview. Native design/history — в `docs/archive/`; актуальные 07/08 сохраняют прежние имена файлов для ссылок.

## 6. Следующий законченный scope

**T-00a**, по [плану](10-implementation-plan.md), regression R1/R2/schema часть R6. Прочитать AGENTS → этот файл → 00/10 → 15 → 02/06. Исправить общий контракт и consumers, не писать специальный несовместимый протокол для бота. Учесть legacy receipts и ещё отсутствующую регистрацию devices. Затем отдельно T-00b/c/d/e; после foundation — T-01 Telegram auth, T-05 device spike, T-06 read/sync, T-02 bot, T-03 Mini App.

Реальная частичная реализация P1-01/02/03/06/07 не равна завершению фаз. Не повторять уже выполненный P0-01 и не ожидать Mac для Telegram. Не заявлять core MVP по кнопке бота: продуктовый MVP включает Phase 1–3 и четырёхнедельную проверку пользы.

## 7. Формат следующего обновления

На завершающей проверке T-DOC-01 пятичасовой лимит использован на 84%, оставалось 16%; новые этапы реализации не начинались. Лимит общий для аккаунта, это снимок, не гарантия будущего остатка.

Task ID и scope; фактические файлы/изменённые контракты; PASS/FAIL с числом проверок и средой; что не запускалось; оставшиеся дефекты; следующая задача. Проверить usage до выбора объёма и перед завершением, оставить ~10 процентных пунктов пятичасового окна. Новую крупную задачу без оставшегося времени на проверку и handoff не начинать.
