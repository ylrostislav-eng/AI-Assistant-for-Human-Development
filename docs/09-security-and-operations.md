# 09. Безопасность, данные и эксплуатация

## 1. Границы доверия

Недоверенные входы: Mini App, bot update/callback, browser client, model output, сообщения/названия событий, внешние samples, загружаемые файлы, client timestamps. Доверенные вычисления: authenticated backend policy + детерминированный engine над валидированными данными. Сервер тоже может ошибаться, поэтому нужны ledger, audit, backups и replay.

| Риск | Обязательная защита |
|---|---|
| Пользователь A читает/меняет Goal B | user_id из token; составные FK; RLS; ownership tests |
| Client/LLM добавляет XP | Нет публичного endpoint для awards; validated Activity → engine |
| Повтор/гонка completion | User lock, command receipts, unique award identity |
| Prompt injection из календаря | Data/instruction separation; scoped tools; policy, не доверие prompt |
| Утечка ключей | Server secret store; SecureStorage/session-only для Mini App, HttpOnly для PWA; redaction |
| Кража refresh token | Rotation, hashed storage, expiry/revoke device, reuse detection |
| Поддельный voice session | Trusted session creation, binding user/device/provider call |
| Массовые AI-запросы | User/device rate limits, usage budgets, body caps, cancellation |
| Потеря offline действий | Transactional local outbox, conflict inbox, non-destructive bootstrap |
| Удалённая память возвращается | Invalidate summaries/embeddings и pending extraction jobs |

Нет утверждения о невозможности обмана self-report. Rate limits/allowlist/public abuse controls повышают стоимость автоматизации, но не доказывают человеческую деятельность.

## 2. Авторизация

Личная версия использует серверную проверку Telegram `initData`, identity mapping на internal UUID и allowlist Telegram user ID. Подробный протокол и replay policy — [14](14-telegram-platform.md). `initDataUnsafe`, username, client user_id и неподтверждённый webhook не дают полномочий. Bot token хранится только сервером. Webhook имеет отдельный secret; callback action tokens ограничены user/target/version/expiry.

Dev-only seed identity — только локально с явным flag; production startup отвергает включённый bypass. Не включать dev-login как fallback при отсутствии Telegram proof.

Начальные sessions: access TTL 15 минут, rotating refresh TTL 30 дней, installation/device revocation, logout отзывает family. Access в памяти; refresh в доступном SecureStorage. При отсутствии — session-only и новый вход, без plaintext localStorage/IndexedDB. Single-flight refresh обязателен; response loss ведёт к re-auth по текущей reuse policy, pending commands не стираются. PWA использует отдельный same-origin cookie/auth adapter с CSRF/Origin checks.

SQL runtime-role не owner/superuser/BYPASSRLS. Tenant setting задаётся transaction-local, не протекает между pooled connections. Worker обрабатывает explicit user job с теми же checks; административные операции отдельно, audit обязательный.

Этот механизм проверен на прототипе: [изоляция арендаторов](security-prototype-tenant-isolation.md). Проверка подтверждает RLS с `FORCE`, запрет по умолчанию и отсутствие протечки контекста между транзакциями; исторический прототип не заменяет актуальные integration tests и Telegram auth tests. Текущие результаты — [аудит](15-backend-review.md).

## 3. Секреты и шифрование

- Backend OpenAI/Telegram/webhook/integration secrets и database credentials — secret manager/environment injection; не mobile bundle/git/логи.
- TLS между приложением и backend; private DB connectivity; encryption at rest у хранения/backups.
- Mini App credentials — по разделу 2. Браузерная база не считается эквивалентом iOS Data Protection. Минимизировать локальный кэш, разделять accounts и очищать при logout/delete; XSS в origin остаётся риском даже при SecureStorage.
- Если включено дополнительное local/field encryption, ключи имеют отдельный lifecycle и recovery policy; не писать собственную криптографию.
- Envelope encryption для особо чувствительных notes/constraints на сервере при публичном этапе; ключи отдельно от DB, ротация и restore проверяются.
- Архитектура с server AI требует доступного backend plaintext в момент обработки: нельзя рекламировать полноценное end-to-end encryption всех данных.
- Logs: request/command IDs, timing, error code, counters; никаких auth headers, transcript, full goal text и raw health payload по умолчанию.

## 4. Собственный API key

Для личной версии default: один собственный OpenAI key автора в **backend secret store** — это уже экономически личное использование и не требует BYOK UI.

BYOK UI не входит в Telegram MVP. Не переносить личный OpenAI key в JavaScript bundle, Vite public env, чат бота, localStorage или Shortcut. Будущий server-BYOK требует отдельного consent, encryption, revocation и tenant budgets. Нативный device-BYOK из старого плана относится только к будущему native client, не к текущему web app.

## 5. Данные и согласия

Категории: profile/goals/calendar/activities; sensitive user constraints; chat/memory; health evidence; operational metadata. Scope consent разделяет использование внутри app, sync на backend, передачу AI, permissions внешних calendar/health bridges и optional analytics. Системное разрешение HealthKit не заменяет согласие отправлять данные LLM.

В Settings: что хранится, что отправляется, что подключено, memory viewer, export/delete. Минимизация: AI получает только relevant data, health raw остаётся на устройстве, event notes импортируются только при явной необходимости.

Стартовая retention policy проекта (настраивается до beta):

| Данные | Срок |
|---|---|
| Goals, Activity, ledger, metric history | До удаления пользователем/аккаунта |
| Chat | 90 дней по умолчанию, пользователь может уменьшить; нужная память отдельно и видима |
| Raw voice audio | Не сохранять по умолчанию |
| Tool audit metadata | 90 дней; без полного user text |
| Diagnostic logs | 14 дней личная версия, до 30 beta |
| Sync feed | 90 дней; затем bootstrap |
| Backups | 30 дней, encrypted, с контролируемым истечением |
| Export download | До 24 часов после готовности; signed link живёт 15 минут |

Это проектная политика, не описание гарантий сторонних providers. Перед публичным запуском согласовать region/retention/provider terms с реальными сервисами и рынком; не утверждать юридическое соответствие без такой проверки.

## 6. Export / удаление / восстановление

Export job: snapshot user data → JSON с schema_version + CSV activities/metrics + README единиц/времени → encrypted object → expiring signed URL. Исключить API/session keys, чужие данные и internal security artifacts. Содержимое включает earned ledger объяснения, цели, расписание, history, memory, consent и settings.

Delete account:

1. Re-auth + конкретное подтверждение удаления в UI.
2. Account state deleting: запрет новых commands/AI sessions/jobs, revoke sessions.
3. Удалить user rows, snapshots, ledger, messages, memories, embeddings, attachments; external provider objects удалить при наличии и поддержке.
4. Отменить reminders/jobs, очистить device state при следующем контакте; удаление собственных Calendar exports только по выбранной пользователем политике, чужие события не трогать.
5. Выдать минимальный deletion receipt без личного содержания. Backups истекают по retention; восстановление backup обязано повторно применить deletion registry до выдачи доступа.

Не обещать удаление с полностью offline телефона мгновенно. После logout пользователь выбирает удалить локальную копию; revoked account при следующем подключении не должен возродить данные pending commands.

## 7. Развёртывание по стадиям

**Личный dev:** backend API + worker + отдельная PostgreSQL, web dev server, synthetic fixtures. Docker Compose пока не проверен; доступен скрипт локальной БД. Для реального Telegram launch нужен отдельный HTTPS test origin и bot, не публичный dev bypass. Локальный HTTP только Debug в пределах разработки; release только HTTPS.

**Личный ежедневный пилот:** один небольшой сервер/container host, managed или обслуживаемый PostgreSQL, TLS reverse proxy, daily backups + PITR если доступно, закрытый signup, минимальные alerts, private logs. Статические assets Mini App + HTTPS API, webhook и bot menu/Main App configuration. Только allowlisted user; live smoke на телефоне. Выбор host/регион/бюджет — перед фактическим запуском.

**Public beta:** staging/prod разделены; managed DB с PITR; ограниченный signup; API/worker независимые replica; secret manager; migrate job; monitoring; support/deletion/export runbooks. Redis/векторная БД не обязательны. Нагрузка одного пользователя остаётся сериализованной, разных пользователей масштабируется horizontally.

**Рост:** read replicas/cache для read-heavy metrics, отдельные AI/replay workers, queue adapter при необходимости. Разделять сервисы по измеренному bottleneck, не заранее.

## 8. CI/CD

PR: format/lint/typecheck → unit/domain tests → PostgreSQL migrations+integration → contract compatibility → AI eval fixtures → web typecheck/build + browser E2E и отдельно реальные Telegram device smoke → build artifacts.

Release: migration expand → compatible backend/worker → smoke → версионированный web build → Telegram smoke → pilot → public release после выполненного launch checklist. Это план будущих операций, не выполненная публикация.

Записывать build SHA, database schema, client contract, rules checksum, prompt/model IDs. Backend rollback не должен требовать destructive down migration; данные пишутся в совместимый формат release window. Rule rollback не удаляет ledger.

## 9. Наблюдаемость и SLO

Targets для начала измерений:

- zero duplicate awards/lost committed commands — инвариант, не процентная цель;
- API non-AI p95 <500ms при pilot load, sync одного дня <3s при нормальной сети;
- chat first useful output p95 <5s — предварительная цель, зависит от модели/сети;
- public service availability 99.5% initial target; core offline снижает влияние сбоя;
- RPO ≤24h в простом личном пилоте, ≤1h beta; RTO ≤4h — проверить restore rehearsal.

Метрики: command failures/conflicts, pending queue age, duplicate receipts, ledger reconciliation difference (должна быть 0), scheduler infeasible rate, missed day-close lag, reminder dispatch failures, AI cost/turn, usage cap hits, memory retrieval leakage tests, db latency/space, job lease/dead-letter.

Alerts — только actionable: растущий backlog, backups failed, tenant/security violations, provider bill surge, repeated 5xx, ledger invariant failure. Личные содержательные данные в alerts не включать.

## 10. Стоимость

Не фиксировать быстро устаревающие цены. Модель бюджета:

`monthly = infrastructure + active_users × (turns × text_cost + voice_minutes × voice_cost + optional_embeddings) + storage/egress`.

`text_cost = input_tokens/1e6 × input_price + cached_tokens/1e6 × cached_price + output_tokens/1e6 × output_price`, при этом обычные input_tokens исключают уже выделенные cached_tokens. Для voice брать фактические единицы тарифа/usage API, не считать аудио бесплатным.

В личном пилоте записывать реальные usage/cost без private prompt. Начальные configurable quotas: 30 chat turns/day, 3 roadmap generations/day, voice 10 min/day после Phase 4; автор может менять лимиты. Quota не ограничивает manual/offline функции и не изменяет XP. Точные model IDs/prices/budget согласуются при настройке API, а не выдумываются в плане.

## 11. Incident runbooks

- Provider outage: выключить AI/voice initiation, сохранить drafts, manual planning/reviews; tool receipts по-прежнему доступны.
- Bad RuleSet: stop activation/new affected awards, сохранить Activity pending, исправить rules/replay по версии, один visible correction.
- DB failure: read local, queue commands, восстановить из backup/PITR, проверить command/ledger checksums, затем reopen sync.
- Compromised secret: rotate/revoke, invalidate impacted sessions, audit минимальных metadata, recovery communication по реальному scope.
- Incorrect plan: disable automation flag, preserve current accepted version, предложить корректный diff; не переносить всё без контроля.

## 12. Web и Telegram boundaries

CSP с конкретными script/connect origins, без произвольного inline code; разрешить только необходимый официальный bridge. React/HTML не рендерят сырые user/model HTML; ссылки проходят scheme allowlist. CORS — конкретный own origin, а не wildcard с credentials. Bot API не вызывается из браузера. Проверить proxy/body limits, rate limits на login/webhook/voice; не логировать initData, auth headers, file URLs и feed tokens.

Web/browser response caches не сохраняют credentials и private API wholesale. При смене account UI сначала закрывает старый store. Telegram cloud messages/voice проходят через Telegram; продукт не обещает их end-to-end secrecy или полного удаления всех внешних копий. В notification preview по умолчанию нейтральный текст. Voice/health/LLM processing имеют отдельные согласия.

Восстановление backup перед открытием доступа применяет deletion registry и revoke state, не восстанавливает старые webhook/bridge credentials. Задания удалённого пользователя не запускаются из старого inbox. Leases и внешние delivery outcomes — по документам 01/14.

Ошибки пишутся выжимкой по разрешённому списку полей (`shared/logging/logger.ts`,
T-00e): вид ошибки, код, отпечаток текста и разрешённый контекст —
идентификатор запроса, маршрут, идентификатор задания. Сам текст, `detail`
PostgreSQL со значением нарушившей строки, адрес базы и URL провайдера не
выводятся. Прямой `console.error` с объектом ошибки в коде приложения считается
дефектом: `logger: false` у Fastify выключает его собственный вывод, но не
консоль. Клиенту при ошибке сервера возвращается `request_id` вместо текста:
человек может сослаться на свой случай, а внутренности остаются в логах.
Ответ 401 на обновление сессии означает именно приговор сессии; сбой
инфраструктуры отвечает 503, потому что по 401 клиент стирает локальный журнал.
