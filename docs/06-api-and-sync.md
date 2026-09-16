# 06. API, offline и синхронизация

## 1. Основной принцип

Клиент синхронизирует **команды и подтверждённые изменения**, а не произвольные копии таблиц. PostgreSQL определяет confirmed state; IndexedDB хранит confirmed projection + pending overlay. Уже загруженный UI поддерживает локальные действия при обрыве связи. Запуск Mini App без сети/после очистки WebView не гарантируется; отдельный PWA режим проходит собственные проверки. См. [14](14-telegram-platform.md).

Не реализовывать last-write-wins для XP, completion, elapsed time и timetable: это теряет данные или даёт двойные награды.

## 2. Базовый HTTP contract

HTTPS, JSON, ISO 8601 instants с offset/Z, явная IANA zone. Сейчас backend routes без `/v1`; web proxy планируется `/api` с удалением префикса на proxy. Не менять пути незаметно. Версия контракта пока в envelope/schema; будущий `/v1` только отдельным migration decision. Auth: Bearer app access token. `X-Request-ID` для диагностики; command idempotency — поле `command_id`, при `Idempotency-Key` оно обязано совпадать.

Команда имеет [JSON Schema envelope](../packages/contracts/schemas/command-envelope.schema.json):

```json
{
  "schema_version": 1,
  "command_id": "22222222-2222-4222-8222-222222222222",
  "device_id": "33333333-3333-4333-8333-333333333333",
  "kind": "complete_quest",
  "aggregate_id": "11111111-1111-4111-8111-111111111111",
  "expected_version": 3,
  "client_created_at": "2026-09-15T18:01:00Z",
  "depends_on_command_id": null,
  "payload": {
    "actual_duration_seconds": 900,
    "actual_amount": null,
    "variant": "minimum",
    "completed_at": "2026-09-15T18:00:00Z",
    "evidence_id": null
  }
}
```

Envelope проверяет транспорт. `payload` обязательно отдельно проверяется закрытой схемой для `kind` из registry; schema envelope сама по себе не разрешает свободные поля. Текущие payload parsers неполны: T-00a закрывает схемы и нормализацию top-level aggregate/version. [OpenAPI](../packages/contracts/openapi.yaml) описывает фактические routes, этот документ — целевой контракт. Пример выше использует aggregate_id как target; adapter к существующему occurrence_id должен быть согласован в T-00a, а не продублирован несогласованно.

Response: `command_id, status, aggregate_version, committed_seq, canonical_changes, result, server_time`. Status: committed / already_applied / rejected / conflict / pending_review. `pending_review` сохраняет факт, но не обещает начисленного XP.

## 3. Endpoint map (целевой, не перечень готового API)

Уже реализованы `/health`, `/health/ready`, `/auth/dev-login`, `/auth/refresh`, `/auth/logout`, `/me`, `/commands`. Форма command receipt сейчас `command_id, committed_seq, duplicate, result`; расширение до контракта раздела 2 выполняется вместе с consumers и fixtures. Auth Telegram, read/sync и остальные routes ниже пока будущие.

| Route | Назначение |
|---|---|
| POST /auth/telegram | Проверка raw initData + identity mapping + installation registration |
| POST /auth/refresh; POST /auth/logout | Ротация/отзыв app sessions |
| GET /bootstrap | Согласованный initial snapshot + cursor + rules |
| POST /commands | Одна команда через registry/CommandBus |
| POST /sync/push | Пачка ≤50 команд, независимые receipts, dependency ordering |
| GET /sync/pull?after=&limit= | Committed change batches и next cursor |
| GET /profile; GET /goals; GET /goals/:id | Bounded reads |
| GET /quests?from=&to= | Occurrences + schedule + variants |
| GET /calendar?from=&to= | Read model всех событий/placements |
| GET /character; GET /skills; GET /history | Confirmed progression/report views |
| POST /planning/proposals | Создать draft через deterministic scheduler |
| POST /planning/proposals/:id/accept | Versioned accept; тот же CommandBus |
| POST /ai/turns; GET /ai/turns/:id/events | Turn job + SSE stream с event IDs |
| GET /reviews?period= | Factual reports/narrative revisions |
| GET /memory; POST /memory/commands | Видимая редактируемая память |
| POST /voice/notes; POST /voice/sessions | Phase 4: ASR note; session только для отдельного realtime scope |
| POST /telegram/webhook | Secret-verified update inbox; отдельная auth boundary, не app bearer |
| POST /privacy/exports; GET /privacy/exports/:id | Создание/статус expiring export |
| POST /privacy/deletion; GET /privacy/deletion/:id | Re-authenticated account removal workflow |
| GET /health; GET /health/ready | Минимальная служебная диагностика без секретов |

Resource routes для mutations — только удобные adapters над теми же командами. Никаких обходных CRUD-endpoints для ledger/snapshots/rules.

## 4. Ошибки

Формат: `{code,message_key,request_id,details,retry_after_seconds?}`. Details не раскрывают существование чужих IDs и private values.

| HTTP / code | Поведение клиента |
|---|---|
| 400 invalid_schema / 422 domain_violation | Quarantine command, показать исправление; не retry loop |
| 401 session_expired | Один refresh; иначе re-auth, сохранить локальную очередь |
| 403 capability_denied | Обновить policy, предложить доступную альтернативу |
| 404 entity_unavailable | Чужой/несуществующий/deleted объект; не угадывать |
| 409 version_conflict | Получить canonical record и conflict options |
| 409 idempotency_key_reused | Та же command_id с другой семантикой (kind/target/version/payload); ошибка клиента |
| 409 proposal_stale | Пересчитать видимый diff |
| 410 cursor_expired | Fresh bootstrap + replay pending |
| 429 budget_exceeded / rate_limited | Respect Retry-After; manual core продолжает работать |
| 503 provider_unavailable | Сохранить draft, factual/manual fallback |

## 5. Локальный цикл offline

1. Создать UUID команды. Store canonical read version и semantic intent; не отправлять искусственные локальные server versions.
2. Одной IndexedDB-транзакцией записать pending command и optimistic overlay. Напоминания подтверждаются сервером; локально показывается их pending настройка. При quota/permission error сохранить успех нельзя — показать отказ или online-only mode.
3. UI сразу показывает результат; reward estimate — pending, если нужен backend.
4. Sync запускается при foreground, восстановлении сети, successful auth, ручном refresh; background opportunity — только необязательное ускорение, не гарантия.
5. Для одного aggregate commands последовательны. Команда B, зависящая от A, ожидает receipt A; `expected_version` B заполняется по результату A **до первого отправления** и затем immutable.
6. Push → сохранить receipts → pull committed batches → транзакционно обновить canonical → replay оставшиеся overlays.
7. Event celebration привязан к server award/transition ID; после синхронизации не проигрывать Level Up второй раз.

Целевой scope после T-03b при загруженном shell и исправном storage: Today/calendar/character/skills/history из кэша; создание/редактирование ручных goals/tasks/events; completion/partial/excuse/reschedule; timer; inbox. Изменение reminders ждёт sync, фоновой локальной доставки Mini App не обещает. Новая AI-программа/voice требует сети. Архивация возможна локально, account deletion требует сервера и re-auth.

Первый запуск без загруженного shell/auth может быть недоступен. Не обещать гостевой offline onboarding внутри Telegram. Draft уже начатого onboarding сохранять локально; привязка к аккаунту требует явной проверки владельца. При смене Telegram account прежний локальный store не открывается новому. Режим отдельной PWA описан в документе 14.

## 6. Server command transaction и идемпотентность

Порядок:

1. Validate access token, envelope/schema, request size. Вывести user_id из token.
2. Begin; установить transaction-local tenant context. Lock `user_change_counters` row для этого user.
3. Найти `(user_id, command_id)`. Hash включает schema_version, kind, aggregate_id, expected_version, dependency и canonical payload; версия алгоритма сохранена. Если hash совпадает, вернуть сохранённый receipt без повторной версии/XP. Если hash другой — reject.
4. Проверить текущие permissions, target ownership, expected_version, semantic duplicates и domain invariants.
5. Выполнить domain mutation; Activity → progression result при необходимости.
6. Записать ledger/projections/domain events/outbox; повысить объектные версии.
7. Увеличить user sequence и вставить **один атомарный change batch** для этой транзакции + receipt.
8. Commit; только после этого отвечать committed.

Сериализация мутаций одного пользователя приемлема для личного планировщика и упрощает award caps/sync order. Между разными пользователями она не блокирует работу. Длинный AI/replay job готовит расчёт вне lock и при commit проверяет input versions, иначе повторяет.

### Важный нюанс cursor

Не использовать обычный global auto-increment event ID как гарантию порядка commit: транзакция с меньшим ID может завершиться позже и быть потеряна клиентом. В v1 counter увеличивается **под тем же per-user lock, удержанным до commit**. Каждый user sequence соответствует завершённому атомарному batch; выдача cursor не пропускает незакоммиченные изменения.

Receipt с `committed_seq=25` не означает, что клиент уже видел batches 21–24. Его изменения можно применить идемпотентно, но contiguous pull cursor продвигается только после получения всей последовательности. Не обновлять cursor просто до максимального увиденного seq.

## 7. Pull и bootstrap

Pull первый page фиксирует `upper_bound_seq`; возвращает целые batches до этой границы, `next_after`, `has_more`, `upper_bound_seq`, `server_time`, `min_supported_schema`. Следующие страницы используют ту же границу. Не разрывать одну транзакцию между страницами. Большие export/history — отдельные bounded read endpoints.

Bootstrap создаёт snapshot в одной согласованной read transaction с counter at snapshot; для большой базы — materialized snapshot token и paging, не разные живые SELECT в разных транзакциях. После snapshot клиент запрашивает seq > snapshot_cursor.

Retention sync changes: стартовая политика 90 дней. Client старше окна получает 410 и rebootstrap. Tombstones доступны в пределах окна; long-absent client не может молча воскресить удалённый объект: queued update к deleted ID получает conflict. Минимальные idempotency receipts/award uniqueness сохраняются на срок жизни данных аккаунта, не удаляются вместе с 90-day change feed.

На rebootstrap локальные pending команды отдельно резервируются; canonical store заменяется; pending replayed с проверками. Ошибочные команды не теряются — conflict inbox с export/исправлением.

## 8. Таблица конфликтов

| Ситуация | Разрешение |
|---|---|
| Один completion повторно после timeout | Прежний receipt |
| Два устройства отметили одну occurrence | Уже завершённый root не награждать второй раз; вернуть canonical completion; при разных объёмах предложить correction |
| Timer + health/provider import описывают одну тренировку | Attach evidence к root; максимум небольшой delta evidence bonus, без второй duration |
| Completion пришёл после автоматического missed | Если фактическое время соответствует — correct status/debt/review; reward по фактическому дню |
| Reschedule и completion одновременно | Completion сохраняется; уже завершённое не переносить, вернуть актуальное состояние |
| Два reschedule | Первая valid версия commit; второму conflict with choices |
| Edit title и edit duration | В v1 version conflict с field diff; автоматический field merge только после отдельной спецификации |
| Delete/архив Goal и offline child task | Не воскрешать Goal; предложить standalone/relink или cancel pending |
| Undo на одном устройстве, поздний duplicate на другом | Reversal/root lifecycle и command receipt сохраняются; duplicate не возвращает отменённый XP |
| Изменена difficulty после завершения | Только explicit correction/reclassification, без новой награды за смену имени |
| Новые Rules, старый offline reward profile | Использовать закреплённую версию; не silently upgrade |

Automatic merge разрешён только там, где семантика известна: добавление уникальных inbox items, append независимых notes, attach дополнительного evidence. Тексты и расписание не сливаются произвольно.

## 9. Длительный offline и недостоверное время

До 7 дней обычного offline backfill принять self-report с сохранением источника; replay соответствующих budgets/day close. Более старые действия тоже не теряются: `pending_review` и короткое подтверждение дат/объёма, затем контролируемый backfill job. Future instant дальше 5 минут от server time — clock conflict, не награждать будущую активность.

При reboot timer использует persisted elapsed + wall timestamps, но не выдумывает доказанное continuous running. Если монотонные часы сброшены/время изменилось — запросить фактическую длительность и пометить self-report. Пользовательские часы не являются trust anchor; система v1 работает на доверии с bounded rewards.

Backfill/replay меняет ledger через deltas и вычисляет downstream Form/rank/review до актуального дня. Делать это одним atomic projection generation switch после вычисления. Пользователь видит один receipt «история синхронизирована», а не сотню level animations.

## 10. Совместимость

API schema_version, client app version, rule_version и sync projection version независимы. Изменения add nullable field обратносогласованы; enum extension требует fallback UI `unknown` и capability version. Сервер поддерживает минимум текущий и предыдущий согласованный client schema в public release window.

IndexedDB migrations: versioned upgrade transaction до открытия repository; сохранять pending commands, проверять schema/counts. Failed upgrade не удаляет прежний store. Перед несовместимым обновлением shell выполнить compatibility check, дать sync/export pending; browser storage не имеет обещания iOS Data Protection. Service worker не кэширует tokens/весь private API. SQL migrations backend — expand → deploy compatible code → backfill → contract, не drop обязательных колонок одновременно с обновлением сервера.

## 11. Единые команды из бота и интеграций

Webhook transport ID защищает при повторной доставке update; callback action token связывает стабильный command_id с target/version/user. Разные command IDs для одного факта дополнительно дедуплицируются по Activity root. Не доверять callback payload как полномочию.

Переподключение Mini App делает pull, чтобы увидеть изменения бота. Out-of-order/old button получает receipt/conflict, а не overwrite. Сохранённые mutations отправляются только после re-auth того же account. `initData` передаётся только в login, никогда в каждый command или лог. Детальный протокол — [14](14-telegram-platform.md).
