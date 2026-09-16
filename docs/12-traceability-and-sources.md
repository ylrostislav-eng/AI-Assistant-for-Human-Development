# 12. Покрытие исходной концепции и источники

## 1. Как читать матрицу

Исходный документ сохранён [без изменений](source/original-concept.ru.md). Строка матрицы означает, что требование **специфицировано**, а не реализовано. Phase показывает планируемый этап появления функции. Статус реализации — в [handoff](13-handoff.md). Платформенные требования iOS пересмотрены пользователем в ADR-013–015: «покрыто» может означать адаптацию/bridge/отложенный native companion, а не наличие полного эквивалента в Telegram. [Матрица возможностей](14-telegram-platform.md) и [новый план](10-implementation-plan.md) обязательны для чтения этих строк.

## 2. Все 77 разделов концепции

| № | Требование | Спецификация | Phase |
|---:|---|---|---|
| 1 | Главный принцип приложения | [00](00-product-and-decisions.md) | 0–3 |
| 2 | Первый запуск — диагностика | [02](02-domain-and-data.md), [05](05-ai-system.md), [07](07-ios-and-experience.md) | 1–2 |
| 3 | Создание цели | [02](02-domain-and-data.md), [05](05-ai-system.md), [07](07-ios-and-experience.md) | 1–2 |
| 4 | Roadmap | [02](02-domain-and-data.md), [05](05-ai-system.md), [07](07-ios-and-experience.md) | 1–2 |
| 5 | Ежедневные квесты | [02](02-domain-and-data.md), [03](03-progression-engine.md), [04](04-scheduler-and-recovery.md) | 1–3 |
| 6 | Минимальная версия | [02](02-domain-and-data.md), [03](03-progression-engine.md), [04](04-scheduler-and-recovery.md) | 1–3 |
| 7 | Собственный календарь | [04](04-scheduler-and-recovery.md), [07](07-ios-and-experience.md) | 1–2 |
| 8 | Голосовой ввод | [08](08-voice-and-apple.md) | 4 |
| 9 | ИИ как управляющий слой | [05](05-ai-system.md) | 2 |
| 10 | Function Calling | [05](05-ai-system.md) | 2 |
| 11 | Реальный RPG-прогресс | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 12 | Базовые характеристики | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 13 | Динамические навыки | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 14 | Защита навыка от нажатий | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 15 | Mastery и Current Form | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 16 | Глобальный уровень | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 17 | Тяжёлые уровни | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 18 | Ранги | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 19 | Подтверждение выполнения | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 20 | Невыполненные задания | [02](02-domain-and-data.md), [03](03-progression-engine.md), [04](04-scheduler-and-recovery.md) | 1–3 |
| 21 | После MISSED | [04](04-scheduler-and-recovery.md) | 2–3 |
| 22 | Уважительная причина | [04](04-scheduler-and-recovery.md) | 2–3 |
| 23 | Последствия пропуска | [04](04-scheduler-and-recovery.md) | 2–3 |
| 24 | Recovery Protocol | [04](04-scheduler-and-recovery.md) | 2–3 |
| 25 | Повторяющиеся пропуски | [04](04-scheduler-and-recovery.md) | 2–3 |
| 26 | Адаптивная сложность | [04](04-scheduler-and-recovery.md) | 2 базово; 6 расширенно |
| 27 | Progressive Overload | [04](04-scheduler-and-recovery.md) | 2 базово; 6 расширенно |
| 28 | Принципы развития личности | [05](05-ai-system.md) | 2 |
| 29 | Мотивация без пустых цитат | [05](05-ai-system.md) | 2 |
| 30 | Контекстное ободрение | [05](05-ai-system.md) | 2 |
| 31 | Daily Review | [05](05-ai-system.md), [07](07-ios-and-experience.md) | 2–3 |
| 32 | Weekly Review | [04](04-scheduler-and-recovery.md), [05](05-ai-system.md), [10](10-implementation-plan.md) | 6 |
| 33 | Monthly Review | [04](04-scheduler-and-recovery.md), [05](05-ai-system.md), [10](10-implementation-plan.md) | 6 |
| 34 | Главный экран | [07](07-ios-and-experience.md) | 1–3 |
| 35 | Character | [07](07-ios-and-experience.md) | 1–3 |
| 36 | Skills | [07](07-ios-and-experience.md) | 1–3 |
| 37 | Unlock Skill | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 38 | Level Up | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 39 | Milestones / Boss Battles | [03](03-progression-engine.md), [07](07-ios-and-experience.md), [10](10-implementation-plan.md) | 3 checkpoints; 6 Boss UI |
| 40 | Quest Difficulty | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 41 | Anti-Grind | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 42 | Не награждать вредную продуктивность | [03](03-progression-engine.md), [04](04-scheduler-and-recovery.md) | 1–3 |
| 43 | Scheduler Engine | [04](04-scheduler-and-recovery.md), [07](07-ios-and-experience.md) | 1–2 |
| 44 | Перестройка дня | [04](04-scheduler-and-recovery.md), [07](07-ios-and-experience.md) | 1–2 |
| 45 | Приоритеты | [04](04-scheduler-and-recovery.md), [07](07-ios-and-experience.md) | 1–2 |
| 46 | Связь задачи с целью | [02](02-domain-and-data.md), [05](05-ai-system.md), [07](07-ios-and-experience.md) | 1–2 |
| 47 | Inbox | [02](02-domain-and-data.md), [05](05-ai-system.md), [07](07-ios-and-experience.md) | 1–2 |
| 48 | Умные уведомления | [08](08-voice-and-apple.md) | 1; 5 расширенно |
| 49 | Интеграция с iPhone | [08](08-voice-and-apple.md) | 5 |
| 50 | HealthKit: bridge spike / native companion позже | [08](08-voice-and-apple.md) | 5 |
| 51 | Home Screen Widget: быстрые действия сейчас, native widget отдельно | [08](08-voice-and-apple.md) | 5, optional companion |
| 52 | Live Activity: in-app timer; native extension отдельно | [08](08-voice-and-apple.md) | 5, optional companion |
| 53 | Память Системы | [05](05-ai-system.md) | 2 |
| 54 | История | [05](05-ai-system.md) | 2 |
| 55 | Роли ИИ | [05](05-ai-system.md) | 2 |
| 56 | Database + Rule Engine | [05](05-ai-system.md) | 2 |
| 57 | Progression Engine | [02](02-domain-and-data.md), [03](03-progression-engine.md), [07](07-ios-and-experience.md) | 2–3 |
| 58 | Motivation Engine | [05](05-ai-system.md) | 2 |
| 59 | Forecast Engine | [04](04-scheduler-and-recovery.md), [05](05-ai-system.md), [10](10-implementation-plan.md) | 6 |
| 60 | Эксперименты | [04](04-scheduler-and-recovery.md), [05](05-ai-system.md), [10](10-implementation-plan.md) | 6 |
| 61 | UI / атмосфера | [07](07-ios-and-experience.md) | 1–3 |
| 62 | Звуковой дизайн | [07](07-ios-and-experience.md) | 1–3 |
| 63 | Основная навигация | [07](07-ios-and-experience.md) | 1–3 |
| 64 | Экран System | [05](05-ai-system.md) | 2 |
| 65 | Ручное управление | [02](02-domain-and-data.md), [05](05-ai-system.md), [07](07-ios-and-experience.md) | 1–2 |
| 66 | AI Provider abstraction | [05](05-ai-system.md) | 2 |
| 67 | Backend → OpenAI | [05](05-ai-system.md) | 2 |
| 68 | Собственный API key | [09](09-security-and-operations.md) | После MVP, опционально |
| 69 | Offline: загруженный Mini App + journal; отдельная PWA позже | [06](06-api-and-sync.md) | 1–3; PWA 5 |
| 70 | Privacy | [09](09-security-and-operations.md) | 1; public gate |
| 71 | MVP в адаптации Telegram | [00](00-product-and-decisions.md), [10](10-implementation-plan.md) | 1–3 |
| 72 | Вторая стадия | [00](00-product-and-decisions.md), [10](10-implementation-plan.md) | 1–6 |
| 73 | Третья стадия | [00](00-product-and-decisions.md), [10](10-implementation-plan.md) | 1–6 |
| 74 | Философия продукта | [00](00-product-and-decisions.md) | 0–3 |
| 75 | Эмоциональный эффект | [00](00-product-and-decisions.md) | 0–3 |
| 76 | Идеальный сценарий | [00](00-product-and-decisions.md), [10](10-implementation-plan.md), [11](11-testing-and-edge-cases.md) | 1–5 |
| 77 | Главная идея | [00](00-product-and-decisions.md) | 0–3 |

## 3. Все 32 технических пункта из задания

| № | Технический пункт | Документ |
|---:|---|---|
| 1 | Архитектура клиента: iOS заменён Telegram по ADR-013 | [01](01-system-architecture.md), [07](07-ios-and-experience.md) |
| 2 | Архитектура backend | [01](01-system-architecture.md), [09](09-security-and-operations.md) |
| 3 | Модель данных | [02](02-domain-and-data.md) |
| 4 | Сущности БД | [02](02-domain-and-data.md) |
| 5 | Связи Goal/Milestone/Quest/Skill/Stat | [02](02-domain-and-data.md) |
| 6 | Архитектура AI System | [05](05-ai-system.md) |
| 7 | OpenAI integration | [05](05-ai-system.md), [08](08-voice-and-apple.md) |
| 8 | Function calling | [05](05-ai-system.md), [06](06-api-and-sync.md) |
| 9 | Voice architecture | [08](08-voice-and-apple.md) |
| 10 | Память ИИ | [05](05-ai-system.md) |
| 11 | Scheduler Engine | [04](04-scheduler-and-recovery.md) |
| 12 | Progression Engine | [03](03-progression-engine.md) |
| 13 | Recovery Engine | [04](04-scheduler-and-recovery.md) |
| 14 | XP | [03](03-progression-engine.md) |
| 15 | Уровни | [03](03-progression-engine.md) |
| 16 | Decay | [03](03-progression-engine.md) |
| 17 | Current Form | [03](03-progression-engine.md) |
| 18 | Rank | [03](03-progression-engine.md) |
| 19 | Anti-grind | [03](03-progression-engine.md) |
| 20 | Жизненный цикл Quest | [02](02-domain-and-data.md) |
| 21 | Календарь | [04](04-scheduler-and-recovery.md), [07](07-ios-and-experience.md), [08](08-voice-and-apple.md) |
| 22 | Уведомления | [08](08-voice-and-apple.md) |
| 23 | Offline | [06](06-api-and-sync.md) |
| 24 | Синхронизация | [06](06-api-and-sync.md) |
| 25 | Безопасность API | [05](05-ai-system.md), [06](06-api-and-sync.md), [09](09-security-and-operations.md) |
| 26 | Apple integrations: адаптация и границы Telegram | [08](08-voice-and-apple.md) |
| 27 | Структура экранов | [07](07-ios-and-experience.md) |
| 28 | UI architecture | [01](01-system-architecture.md), [07](07-ios-and-experience.md) |
| 29 | Этапы разработки | [10](10-implementation-plan.md) |
| 30 | Тестирование | [11](11-testing-and-edge-cases.md) |
| 31 | Edge cases | [11](11-testing-and-edge-cases.md) |
| 32 | Структура директорий | [01](01-system-architecture.md) |

## 4. Особые трактовки

- `rescheduled` сохранён в UI, но вынесен в ось placement_state, чтобы задача после переноса могла завершиться.
- Mastery в v1 имеет нулевой decay; убывание реализовано у Current Form. Это явное уточнение предложения «крайне медленно».
- Уровни/XP/ранги в примерах исходного файла иллюстративны; канонические формулы находятся в документе 03.
- Character metrics описывают зафиксированную практику, реальные знания/результаты — GoalMetric/Checkpoint.
- Phase 1 — ручное инженерное ядро; полный MVP §71 готов только после Phase 3.
- Голос важен для полной концепции, но следует после доказательства основного цикла, как предусмотрено §71–73.
- Автоматическая подстройка в MVP ограничена явными командами/принятыми proposals; расширенная автономия — Phase 6.
- Сначала личная версия, потом публичный продукт — прямое уточнение пользователя, добавленное к исходному файлу без его редактирования.

## 5. Официальные источники

Основные источники проверены 15 сентября 2026; Telegram/Shortcuts/PWA/React/Vite — 16 сентября 2026. Apple native/OpenAI realtime ссылки ниже относятся к сохранённым будущим вариантам, не к обязательному стеку Telegram MVP. Внешние источники подтверждают возможности и ограничения API. Стек, формулы, лимиты, сроки и продуктовые решения — авторская архитектура v0.1. Перед реализацией проверить выбранную версию SDK, model availability и действующие платформенные условия.

| Источник | Что сверялось |
|---|---|
| [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling) | Tool calls, strict schema и требования к полям |
| [OpenAI Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) | Текстовый API, tool input/output, streaming/config |
| [OpenAI WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc) | WebRTC, временная авторизация, серверный ключ |
| [OpenAI server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls) | Sideband, единый владелец tool execution; различие Realtime/GPT-Live |
| [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) | Хранение зависит от endpoint/настроек, store=false не обещает ZDR |
| [Apple EventKit](https://developer.apple.com/documentation/eventkit/accessing-the-event-store) | Разделение Calendar access и соответствующие permissions |
| [Apple TN3152](https://developer.apple.com/documentation/technotes/tn3152-migrating-to-the-latest-calendar-access-levels) | Современные уровни доступа Calendar/EventKitUI |
| [Apple HealthKit authorization](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data) | Permission по типам, отсутствие данных не раскрывает read denial |
| [Apple HealthKit privacy](https://developer.apple.com/documentation/healthkit/protecting-user-privacy) | Ограничение области использования и privacy |
| [Apple local notifications](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app) | Scheduled notifications и отмена pending requests |
| [Apple background strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app) | Фоновое выполнение зависит от системы |
| [Apple verifying a user](https://developer.apple.com/documentation/signinwithapple/verifying-a-user) | Проверка identity token на сервере |
| [GRDB: официальный репозиторий](https://github.com/groue/GRDB.swift) | SQLite toolkit для Swift |
| [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) | JSON Schema validation/serialization |
| [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | Row-level policies и ограничения обхода владельцем |

Точные книги и исследования по поведению не пересказывались и не объявляются проверенными источниками эффективности в этом пакете. База принципов добавляется отдельной задачей после чтения источников, без копирования книг.

## 6. Источники переноса на Telegram (2026-09-16)

- [Telegram Mini Apps](https://core.telegram.org/bots/webapps): signed initData, fullscreen/safe areas, lifecycle, storage и home shortcut.
- [Telegram Bot API](https://core.telegram.org/bots/api): webhook secret, callbacks, сообщения/voice, transport errors.
- [Apple Shortcuts Find actions](https://support.apple.com/en-euro/guide/shortcuts/apd3c845e881/ios): Calendar Events и Health Samples.
- [Shortcuts HTTP requests](https://support.apple.com/en-lamr/guide/shortcuts/apd58d46713f/ios): JSON POST для необязательных bridges.
- [Apple Action Button](https://support.apple.com/en-my/guide/shortcuts/apdfea15680b/ios): пользовательское назначение Shortcut.
- [Apple Calendar subscriptions](https://support.apple.com/en-mide/guide/iphone/iph3d1110d4/ios): read-only ICS.
- [WebKit Home Screen Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/): отдельная установленная PWA, не обещание внутри Telegram.
- [ActivityKit](https://developer.apple.com/documentation/activitykit): native Live Activities как отдельный будущий scope.
- [React](https://react.dev/learn), [Vite](https://vite.dev/guide/): выбранные frontend components/build; версии фиксируются после compatibility smoke.

Составной Shortcuts bridge и его точность/автоматизация пока гипотеза для spike. Показанные возможности API не являются фактом реализации приложения.
