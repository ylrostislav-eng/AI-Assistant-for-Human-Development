# 14. Telegram: возможности, протоколы и сохранение потенциала

Решение от 2026-09-16. Этот документ уточняет ADR-013: переезд меняет доставку продукта, а не цикл Goal → AI Plan → Daily Quest → Completion → XP → Adaptation. Технические возможности сверены по официальным источникам; device-проверки ещё не выполнены. Архитектурные лимиты ниже — наши стартовые настройки, не ограничения Telegram, если не указано иное.

## 1. Что сохраняем и чем заменяем

| Возможность | В Telegram | Решение проекта | Честная граница |
|---|---|---|---|
| Атмосфера Системы | HTML/CSS/SVG, fullscreen, haptic, safe areas | Самостоятельный дизайн Mini App, пять вкладок, персонаж, анимации подтверждённых наград | Плавность проверяется на устройстве; клиент Telegram контролирует своё окно |
| Открыть с домашнего экрана | Shortcut Mini App при поддержке клиента | Предложить после первого полезного действия | Ярлык не является виджетом или отдельной offline PWA |
| Отметить при обрыве сети | Уже загруженный UI может сохранить локальную команду | IndexedDB journal, статус «ожидает связи», повторный sync | Холодный запуск и сохранность WebView storage не гарантируются |
| Надёжнее работать вне Telegram | Отдельный запуск того же web клиента | Опциональная установленная PWA + offline shell | Нужны отдельный вход и device-tests; фоновые задачи не гарантируются |
| Шаги / тренировки | Прямого HealthKit доступа у Mini App нет | Ручной ввод → проверяемый Shortcuts bridge / provider adapter → native companion при необходимости | Доступность конкретных Health-действий и автоматизаций проверить; полная автоматизация не обещана |
| Apple Calendar | EventKit внутри Mini App нет | ICS export/subscription; busy windows через Shortcuts или внешний provider | Подписка односторонняя и обновляется с задержкой; не заменяет чтение личного календаря |
| Action Button | Через назначенный пользователем Shortcut | Открыть Today / capture / voice entry; позже scoped bridge command | Нужен поддерживаемый iPhone; системные разрешения выдаёт пользователь |
| Виджеты | Собственного WidgetKit extension у web-клиента нет | Shortcuts widget с кнопками, ярлык, карточка дня в боте | Это быстрый доступ, не автоматически обновляемый RPG-виджет |
| Live Activities | Собственной ActivityKit extension нет | Таймер в Mini App, reminder по завершению, карточка текущего действия | Dynamic Island/lock-screen Live Activity — только будущий native companion |
| Голос | Voice message в чате; запись в Mini App при поддержке | ASR → тот же AI/CommandBus → canonical receipt; TTS опционален | Сообщение не равно постоянному голосовому диалогу; realtime отдельный этап |
| Напоминания | Сообщение от бота | Серверный schedule + preferences + delivery state | Сеть, настройки уведомлений Telegram, mute/blocked влияют на получение |

Telegram документирует fullscreen/safe areas и home-screen shortcuts (API 8.0+), DeviceStorage/SecureStorage (9.0+), HapticFeedback и lifecycle. Использовать feature detection; API version не заменяет проверку платформы. [Telegram Mini Apps](https://core.telegram.org/bots/webapps)

Составные решения с Shortcuts/PWA — наша архитектурная возможность, а не уже проверенная готовая интеграция. Источники Apple и точные ограничения — [08](08-voice-and-apple.md).

## 2. Роли двух интерфейсов

**Mini App:** onboarding, Today, System chat с карточками, roadmap, Character/skills, calendar day/week/month, Settings, Memory, History, export/delete. Пять вкладок остаются доступными на мобильном экране.

**Бот:** `/start`, `/today`, `/capture`, `/settings`, `/help`; кнопка «Открыть Систему»; текст/voice input, короткие подтверждения и reminders. Сложный plan diff и неизвестный объём выполнения открывают соответствующий экран/уточнение. Бот не создаёт второй набор целей и не получает собственные формулы XP.

**Связность:** действие в боте отражается в Mini App через change feed при возврате; завершённый в Mini App квест делает старую кнопку бота неактуальной. `/today` читает серверный snapshot, а не разбирает предыдущие сообщения. User-visible chat IDs и message IDs не являются domain entity IDs.

Личный пилот принимает только личный чат и allowlisted Telegram user ID. Группы, inline mode, attachment menu, платежи и социальные механики не нужны для первого цикла. Недоступность advanced Telegram API не блокирует основные HTML controls.

## 3. Вход через Telegram — T-01

### Поток

1. Пользователь открывает Main Mini App / menu button / поддерживаемую direct link. Выбранный режим запуска должен передавать signed user в `initData`; пустые данные не заменять `initDataUnsafe` или dev-login.
2. Клиент отправляет исходную строку `initData` по HTTPS на будущий `POST /auth/telegram`, плюс installation ID и поддерживаемую client schema. Не передавать bot token.
3. Backend ограничивает размер/частоту, отклоняет дубли query keys и некорректную кодировку, проверяет Telegram HMAC по текущей официальной спецификации. Secret key: HMAC-SHA256 с ключом `WebAppData` и сообщением bot token; затем HMAC data-check-string этим secret. Сравнение constant-time. Набор подписываемых полей, сортировка и обработка `signature` обязаны совпадать с выбранным официальным HMAC-протоколом; не смешивать его с Ed25519-проверкой третьей стороны.
4. Проверяет `auth_date`: начальная политика age ≤5 минут, future skew ≤30 секунд; проверяет подписанного `user.id`, разрешённого бота и pilot allowlist. Username/display name не доказательство личности.
5. Через узкую identity lookup/create функцию находит `(issuer=telegram, subject=user.id)` и неизменный internal UUID. Без публичного обхода RLS. Регистрация и привязка installation выполняются атомарно; Telegram ID хранить без потери точности.
6. Выпускает собственную access/refresh family, привязанную к account/installation. Телеграмовское proof не пересылается на каждый domain request.
7. Отправляет bootstrap после входа. Возврат из background сначала проверяет сессию и capability; отсутствие сети не стирает pending journal.

Точная валидация: [официальная спецификация](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). Raw `initData` — краткоживущее bearer proof: подпись не делает украденную строку безопасной. Не логировать URL/строку, исключить analytics capture, CSP/XSS защита обязательна.

**Повтор proof:** стартовая политика — один обмен digest канонических проверенных полей proof с bot/environment scope на session. Перестановка query keys или иная эквивалентная кодировка не создаёт новый digest; использованный digest хранится до истечения replay window, повтор не выпускает новую family. Если ответ обмена потерян, клиент открывает новый Telegram launch и получает свежее proof; не подменять ошибку успехом. Это сознательная цена простой политики. Idempotent exchange с восстановлением ответа допустим позже только с отдельной спецификацией binding к installation secret. Один лишь неподписанный request ID не защищает от кражи proof.

**Sessions:** access в памяти, rotating refresh в SecureStorage при подтверждённой поддержке. Если secure storage недоступен — session-only режим и свежий вход после закрытия, без fallback на plaintext localStorage. Single-flight refresh на клиенте; утрата ответа refresh сейчас приводит к re-auth по существующей reuse policy. Pending commands сохраняются. Для PWA выбрать отдельный same-origin HttpOnly cookie adapter с CSRF/Origin контролем либо отдельный безопасный browser login; Telegram API не считается доступным вне Telegram.

**Account portability:** Telegram — внешний identity provider, не primary key всех данных. Не объединять пользователей по username/телефону. Связывание будущего Apple/browser account требует подтверждения обеих сторон. Account deletion/revocation запрещает последующий replay старых команд.

## 4. Webhook, бот и защита от дублей — T-02

Endpoint будущий: `POST /telegram/webhook`. Это исключение из app bearer authentication, но не из проверки происхождения. Проверять `X-Telegram-Bot-Api-Secret-Token`, configured bot/environment, HTTPS, body size и закрытую схему update. Secret не равен bot token. Dev long polling допускается отдельно; не запускать polling одновременно с webhook.

```text
HTTP update → verify → INSERT inbox UNIQUE(bot_id, update_id) → COMMIT → HTTP 200
                                      ↓
worker → resolve sender/user → normalize intent → CommandBus → receipt → delivery
```

При недоступной БД не возвращать успешный ack за несохранённый update. Повтор обработанного update получает ack без нового эффекта. Временный raw payload inbox ограничен retention (целевой срок ≤24h после обработки); metadata дедупликации хранится отдельно. Bot sender берётся из соответствующего поля проверенного update; `chat.id` не подменяет `from.id`. Forwarded content — данные, не полномочия переславшегося автора. Edited messages в MVP не переисполняют команды: предложить явное исправление.

Callback data содержит короткий opaque action token, укладывающийся в лимит Bot API 1–64 байта. Серверная запись связывает token с user, occurrence/proposal, expected_version, типом действия, expiry и стабильным command_id. Проверить владельца, чат и версию; atomically consume token + domain mutation или вернуть прежний receipt. Двойное нажатие порождает разные callback IDs, поэтому дедупликации только по update/callback недостаточно. Просроченная кнопка предлагает обновить Today. Результат callback подтверждается через `answerCallbackQuery`; «принято в обработку» не означает completion.

`sendData`/`web_app_data` не используются как обход signed authentication или прямой способ начисления. Все каналы нормализуют одинаковый command contract. [Bot API](https://core.telegram.org/bots/api)

## 5. Доставка напоминаний

- Mini App предлагает включить сообщения после первой настройки reminder. Учитывать разрешение на сообщения/начатый личный чат; не считать вход в Mini App автоматически включёнными уведомлениями.
- Хранить `notification_key`, target/revision, user-day, desired_at, latest_valid_at, channel, status, message_id. Перед отправкой повторно проверить occurrence/protection/quiet hours.
- Дефолт: ≤4 proactive сообщения/день, кроме явно заданных time reminders; minimum ≤1/day, review ≤1/day. Неактивность уменьшает частоту. Decay alerts выключены.
- На 429 — `retry_after`; на блокировку/потерю write access — отключить доставку и показать состояние при следующем входе. Retry ограничен сроком полезности reminder.
- Старое отправленное уведомление невозможно сделать никогда не увиденным: по возможности обновить карточку; callback всегда проверяет актуальное состояние. Отмена задания отменяет будущую отправку.
- Содержимое по умолчанию нейтральное, без чувствительных названий. Системные preview/mute настройки Telegram контролирует пользователь.
- PWA push позже — альтернативный выбранный канал для данного notification key. Не рассылать одновременно в бот и web push без явного выбора.

## 6. Offline: четыре разных обещания

| Сценарий | Что проектируем | Что надо проверить |
|---|---|---|
| WebView открыт, связь пропала | Кэшированные экраны, draft/completion в journal; delayed sync | Транзакции и storage failures |
| Mini App закрыли и открыли | Восстановление journal после доступного launch | Telegram может запросить shell/launch онлайн; не обещать offline cold start |
| Приложение/ОС очистили storage | Серверные данные восстановятся, unsynced могут быть утрачены | Показывать last synced и pending; не рекламировать неограниченную локальную сохранность |
| Установленная PWA offline | Cached shell + IndexedDB + foreground sync | Service worker lifecycle, cache eviction, auth expiry, actual iOS/Android |

DeviceStorage не становится транзакционной реляционной базой: применять для небольших settings/capabilities. CloudStorage не заменяет offline journal. Если IndexedDB недоступен/ломается — явно включить online-only режим; локально не подтверждать запись без долговременного сохранения. Не переключать тихо между двумя журналами команд.

Кэшируемые данные минимальны: ближайшие дни, активные цели, Character snapshot, pending edits. Raw health/voice и весь чат offline не копировать по умолчанию. SDK shell loading и storage quota — реальные риски платформы, не причина выкинуть command sync. Подробности: [06](06-api-and-sync.md).

## 7. PWA как дополнительный путь — P5-06

Переиспользуются React features, repositories, command schemas и backend. Отдельные только bootstrap/lifecycle/auth/notifications adapters. Telegram shortcut и установка PWA — разные действия и разные хранилища; не рассчитывать на общий IndexedDB между ними.

Для входа вне Telegram предлагается pairing: browser создаёт challenge/secret; короткоживущая одноразовая ссылка открывает подтверждение в уже аутентифицированной Системе; UI показывает устройство и совпадающий код; backend связывает одобрение с browser proof и выпускает отдельную session. Refresh token не передавать в deep link/query. До реализации pairing угрозы session swapping и replay покрываются tests; без этого standalone app не работает как authenticated продукт.

Service worker кэширует версионированный shell, не auth responses и не весь private API. Canonical records хранит repository; logout удаляет account store и private caches. Обновление shell не удаляет pending journal. Background Sync/push не являются гарантированным таймером. Web Push у Apple доступен для добавленных на Home Screen web apps при разрешении пользователя; это не обещание Push API внутри Telegram. [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## 8. Проверка на устройствах — T-05, T-06

Завести фактическую таблицу: OS, Telegram version, device, date, supported/succeeded, ограничения. Минимум личный iPhone; перед beta — iOS/Android/Desktop на минимальной выбранной и текущей поддерживаемой версии. Не объявлять версию минимальной до spike.

1. Main App/menu/deep link: валидный signed user, expired proof, свежий re-entry, чужой account.
2. Fullscreen/BackButton/safe areas: keyboard open, rotate, theme change, long Russian title, системные элементы не перекрывают Complete.
3. Storage: save→close→reopen; airplane mode while open; offline cold launch; OS kill; quota denied; account switch; app update. Каждый исход записать отдельно.
4. Network: response lost after commit; повтор tap; одновременно callback и Mini App completion; server restart; refresh rotation response lost.
5. Timer: background/lock/call/process kill/clock change; elapsed не начисляется по числу JS ticks.
6. Notifications: no permission, muted chat, blocked bot, 429/timeout, completion before send, queued stale reminder.
7. Performance/accessibility: реальные scroll/input/animation, screen reader, large text, reduced motion; simplified motion режим.

Playwright проверяет browser логику. Реальный Telegram launch, secure storage и delivery требуют устройства/бота; их нельзя отметить PASS по mock bridge. Создание/публикация бота и хостинга — отдельные фактические действия T-04, а не выполненный результат этой документации.
