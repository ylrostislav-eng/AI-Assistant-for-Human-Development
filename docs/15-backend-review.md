# 15. Аудит backend перед подключением Telegram

Дата: 2026-09-16. Проверенный baseline: commit `4ecfee7`; рабочее дерево до аудита чистое. Scope: чтение реализации, существующие тесты, дополнительные synthetic probes, согласование архитектуры. **Перечисленные дефекты в этой задаче не исправлялись в production-коде.** Их закрывают T-00 и остаток P1-06. Это не полный security audit и не доказательство готовности публичного сервиса.

## 1. Что сделано хорошо и сохраняется

- Модульный Fastify/TypeScript backend, SQL migrations и зафиксированный toolchain. Клиент можно заменить без переписывания домена.
- RLS, составные ownership constraints, отдельные API/worker роли, закрытый доступ по умолчанию, dev bypass выключен в production.
- Собственные opaque access/refresh sessions, rotation/revoke; identity provider можно добавить отдельно.
- CommandBus, per-user сериализация, receipts и transactional change batches/outbox. Правильное направление для Telegram retries и нескольких клиентов.
- Template/occurrence разделены, есть state machine; calendar policy вынесена в тестируемый модуль.
- Интеграционные тесты идут на реальном PostgreSQL. OpenAPI сверяется с реальными routes.

Нет Mini App, Telegram auth/webhook, read/bootstrap/pull API, AI orchestrator, production Progression Engine/XP ledger. Команда `complete_quest` пока меняет состояние occurrence; это не реализация полного факта активности и награды. Комментарий теста о «невозможности второй награды» не доказывает то, чего ещё нет в коде.

## 2. Приоритетные находки

### R1. P1 — expected_version конверта не проверяется

Места: [sync/routes.ts](../services/backend/src/modules/sync/routes.ts), строки 70–89; [quests/commands.ts](../services/backend/src/modules/quests/commands.ts), строки 166–214.

Route передаёт только `envelope.payload`; обработчик ищет `payload.expected_version`. Канонический top-level `expected_version` игнорируется, как и `aggregate_id`. Проходящий тест stale version использует другой путь, поэтому не защищает контракт клиента.

**Воспроизведено через HTTP inject + реальную БД:** создать occurrence, выполнить start (version=2), затем отправить complete с новым command ID, `aggregate_id=occurrence.id`, top-level `expected_version=0`, payload только с occurrence_id. Ответ **200/completed/version=3**, ожидалось **409/version_conflict**.

**T-00a:** нормализованный CommandRequest обязан нести target/version из одного канонического места. Для изменения существующего aggregate требовать корректную версию; creation/null и system actor имеют явную отдельную policy. Отвергать противоречие между envelope target и payload target. Обновить HTTP/AI/bot fixtures и schema; проверить версии как целые без потери точности. `device_id` проверять на принадлежность после регистрации, неподдержанную dependency явно отклонять, не игнорировать.

### R2. P1 — hash повторной команды не включает kind

Место: [bus.ts](../services/backend/src/shared/commands/bus.ts), строки 110 и 127.

**Воспроизведено:** `start_quest` с command ID X и payload `{occurrence_id:A}`, затем `complete_quest` с тем же X и тем же payload. Второй запрос получает **200, duplicate=true, execution_status=active**. Это receipt другой операции, не корректное подтверждение complete. Ожидалось **409/command_id_reused**.

**T-00a:** versioned canonical hash семантического envelope: schema/kind/target/expected_version/dependency/payload. Определить отдельно transport metadata, которые допустимо менять при retry; не менять semantic bytes после первой отправки. Проверить same intent/reordered keys, другой kind/target/version, concurrency и lost response. Хранить hash version и command kind; миграция старых receipts не должна угадывать отсутствовавшие данные или терять защиту от повторов. Для несовместимого legacy replay выбрать явную policy и покрыть её upgrade-test.

### R3. P1 — устаревший worker может завершить новую аренду

Место: [worker.ts](../services/backend/src/modules/sync/worker.ts), `claimJobs`, `completeJob`, `failJob`.

**Воспроизведено на реальной БД:** job с `max_attempts=1`; A получает attempt=1; lease искусственно истекает; B получает тот же job с **attempt=2**, несмотря на max=1; A вызывает `completeJob(id)` и переводит чужую актуальную аренду в **done**. Compare-and-set по lease owner отсутствует. Аналогично late failure способен вернуть новую работу в pending. Claim пачки из 10 с последовательной обработкой может исчерпать lease ещё до старта последних.

**T-00b:** fencing token/lease generation, CAS complete/fail/renew, bounded reclaim, dead-letter исчерпанных попыток, claim по реальной capacity. Tests с двумя workers и контролируемыми pause points. Наличие fencing не обещает exactly-once внешнего Telegram send: отдельный delivery ledger и обработка uncertain outcome обязательны.

### R4. P2 — DST gap корректен не для всех минут

Место: [user-day.ts](../services/backend/src/shared/time/user-day.ts), `offsetAt`/`findTransition` (строки 76–145).

`wallTimeAt` не сохраняет секунды, а offset сравнивается на произвольных millisecond timestamps бинарного поиска. Получившееся значение зависит от секунд/миллисекунд самого instant, поэтому предикат не является правильным сравнением timezone offset.

**Воспроизведено pure probe:** `instantFromWallTime({year:2026,month:3,day:8,hour:2,minute:10}, 'America/New_York')` возвращает **07:10Z**, хотя политика файла требует первой допустимой минуты **07:00Z**. Для :05/:20/:35/:50 результат 07:05Z; :10/:25/:40/:55 — 07:10Z. Из 12 проверенных точек шага 5 минут ошиблись **8**; :00/:15/:30/:45 прошли.

**T-00c:** исправить получение offset и поиск границы либо выбрать проверенный time adapter; тестировать каждую минуту gap, fold, Lord Howe 30-minute transition, обычные и дробные timezone offsets. Не менять описанную семантику gap молча ради прохождения теста.

### R5. P1 — изменение day boundary создаёт пересекающиеся дни

Место: [user-days.ts](../services/backend/src/modules/scheduling/user-days.ts), `ensureUserDay`.

**Воспроизведено:** instant `2026-09-16T01:00Z`, зона UTC. Сначала boundary=240 создаёт день `[09-15 04:00, 09-16 04:00)`. Повтор с boundary=0 создаёт другой день `[09-16 00:00, 09-17 00:00)`. Интервалы пересекаются на четыре часа, один instant относится к двум day IDs. `ON CONFLICT(user_id, local_date)` этого не предотвращает. Влияние на будущие reward buckets существенно; текущего ledger ещё нет.

**T-00d:** effective-dated settings, поиск существующего содержащего instant дня под user lock, правило переходного дня без overlap/gap и двойного budget. Старые интервалы не пересчитывать при редактировании preferences. Проверить движение boundary в обе стороны, travel/date-line, concurrent mutations и assignment completion. Добавить DB/application guard на непротиворечивые интервалы по выбранной policy.

### R6. P1 до пилота — completion пока не хранит достаточный факт

Место: [quests/commands.ts](../services/backend/src/modules/quests/commands.ts), parsers и transition handler; [command envelope](../packages/contracts/schemas/command-envelope.schema.json).

**Воспроизведено:** template без minimum_spec; complete с `variant=minimum`, без actual duration/amount → **200/completed/minimum**. Закрытых kind-specific payload schemas нет; normal_spec проверяется только как object. Envelope schema не заменяет проверку domain payload. Дополнительно registry индексируется обычным объектом без own-property guard — добавить fixtures `constructor`/`toString`, их execution exploit не проверялся.

**T-00a:** закрытые payload schemas, нормализованные enums/types/ranges, own-key registry, version/owner constraints. **Остаток P1-06:** Activity root + actual amount/duration/occurred time + source/variant snapshot + correction path. Minimum допустим только по принятой спецификации, unknown duration не превращается в запланированную. Не выдавать старые status-only completions за измеренные Activity при migration/backfill; synthetic history отделить либо явно запросить недостающий факт. Тесты awards появятся с ledger P3-02.

### R7. P2 до реальных данных — raw errors и refresh error classification

Статический вывод, утечка реальных секретов не воспроизводилась. Места: [app.ts](../services/backend/src/app.ts), строка 72; [worker entry](../services/backend/src/worker.ts), строки 48/59; [identity/routes.ts](../services/backend/src/modules/identity/routes.ts), catch refresh.

`console.error(error)` может вывести PG detail, provider URL/token или пользовательское значение при ошибке constraint. `logger:false` не отключает console. Общий catch refresh возвращает 401 даже при сбое DB, заставляя клиента считать сессию недействительной.

**T-00e:** allowlisted structured error metadata/code/request ID, redaction перед любым sink; известные session errors → 401, infrastructure → 5xx. Тест с synthetic sentinel в ошибке БД/HTTP и capture логов; client не удаляет journal при transient error.

## 3. Реально выполненные проверки

| Проверка | Результат |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS: 53 tests, 5 files |
| `DATABASE_URL=… npm run test:integration` | PASS: 159 tests, 16 files, PostgreSQL 18.6 |
| HTTP/DB probes R1/R2/R3/R5/R6 | Подтвердили описанные дефекты; это диагностические воспроизведения, не PASS исправлений |
| DST probe R4 | 8/12 неверных результатов для gap с шагом 5 минут |

Существующая рабочая БД не использовалась: отдельный cluster `/tmp/system-telegram-audit-20260916`, порт 55437, synthetic `system_audit_test`, роли app_runtime/app_worker. Песочница сначала заблокировала chown/localhost; после разрешённого запуска вне песочницы integration suite прошёл. Первое падение EPERM не записано как дефект приложения.

Временный кластер остановлен после аудита. База и transient probe не являются новыми production files. В каждую задачу исправления перенести воспроизведение в постоянный meaningful regression test перед изменением реализации. Существующие 212 проходящих тестов полезны, но не закрывают найденные сценарии.

Не выполнялись: реальный Telegram login/webhook, устройства, ASR/OpenAI, frontend build, Docker build, hosting/deployment, нагрузка, restore реального production. Их отсутствие отражено в плане.

## 4. Инструкция следующему агенту

Начать с T-00a и R1/R2/schema части R6. Затем T-00b/c/d/e, Telegram foundation и закончить Activity path до реального дневного учёта. Не обходить эти проблемы специальными payload из бота: Mini App, bot, AI и будущие bridges должны использовать один исправленный контракт. Не переносить расчёт XP в текст бота. После исправления добавить результат проверки и commit/task ID в handoff, сохранив этот отчёт как baseline.
