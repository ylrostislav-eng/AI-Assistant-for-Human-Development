# 08. Голос, календарь, здоровье и быстрые действия в Telegram

Актуально: 2026-09-16. Имя файла сохранено для совместимости ссылок. Вместо обязательных iOS-фреймворков используем adapters к общему backend. Нативный companion остаётся возможным расширением, не условием запуска. Ни одна интеграция ниже ещё не реализована.

## 1. Голос: сначала Telegram voice messages

Поток: проверенный webhook → voice file reference → bounded download → ASR → transcript/intent → существующий AI ToolGateway → CommandBus → receipt → текстовая карточка, при включении TTS — озвучка.

- Входной voice update дедуплицируется по bot/update ID. ASR job не создаёт отдельный completion при повторе.
- Download только по проверенному Telegram file path через server adapter, с ограничениями размера, времени, MIME/container и длительности; URL с bot token не попадает в логи/клиент. Не скачивать произвольный URL, продиктованный пользователем/моделью.
- Стартовый лимит одной заметки 120 секунд, дневной voice budget 10 минут, настраиваемые сервером. Проверять фактические bytes/duration, а не только metadata.
- Raw audio по умолчанию временный: удалить после ASR и на failure/TTL cleanup; transcript под обычной chat retention. Согласие на ASR/provider обработку показывается до включения.
- «Тренировка выполнена» без объёма требует уточнения; неоднозначный target/дата — выбор. Явное однозначное действие исполняется в пределах policy. Большой plan diff/удаление — подтверждение, как в [05](05-ai-system.md).
- Озвучка описывает committed receipt, не догадку модели. Остановка генерации не отменяет уже committed command; показать Undo по контракту.
- Ошибка ASR оставляет пользователю текстовый путь. Низкая уверенность не превращается в факт действия. Сведения о болезни сохраняются только в выбранном объёме.

Bot API поддерживает voice messages и file retrieval; детали методов и действующие ограничения проверить при реализации. [Telegram Bot API](https://core.telegram.org/bots/api#voice)

## 2. Голос внутри Mini App и realtime

P4-04: кнопка записи в System, если WebView разрешает microphone/recording. Feature detection, явное разрешение, foreground-only capture, отправка blob на тот же ASR путь. При отказе — предложение отправить voice боту, без бесконечного permission prompt. Safari/Telegram/iOS/Android проверяются отдельно.

Полноценный разговор с перебиваниями остаётся отдельной задачей P4-05: browser WebRTC, краткоживущая server-issued авторизация, проверяемая привязка user/session, один владелец tool execution на backend, quotas/timeouts, transcript/receipt reconciliation. Exact provider API и model ID сверить в spike; старый native WebRTC design находится в архиве и не является инструкцией поставить Swift-библиотеку.

Успешные голосовые сообщения не доказывают работоспособность realtime. Realtime не блокирует основной цикл и не превращается в скрытую постоянно слушающую функцию.

## 3. Apple Calendar: три отдельных направления

### 3.1. Система → Calendar: ICS export/subscription — P5-01

Пользователь выбирает, что показать в отдельном календаре «Система»: scheduled quest blocks/selected milestones, без заметок/чата. Разовая загрузка `.ics` — snapshot; подписка на HTTPS feed — последующие обновления. Apple Calendar поддерживает подписку на внешний read-only iCalendar. [Apple](https://support.apple.com/en-mide/guide/iphone/iph3d1110d4/ios)

Контракт feed:

- Стабильный `UID` для placement/event, `SEQUENCE` при revision, корректные `DTSTART/DTEND`, UTC или TZID; all-day — date-only. В соответствии с iCalendar, проверять parser fixture и реальный Calendar. [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545)
- Непредсказуемый отзывной capability token, scope только выбранного feed, на сервере hash; URL не логировать. Кто получил ссылку, может читать feed: объяснить это в UI; минимальный нейтральный title по умолчанию. Не требовать публиковать личный iCloud календарь.
- Актуальное окно feed, например −30/+90 дней. Отменённые/перенесённые события получают стабильные revisions/cancellation semantics; проверка на дубли, DST, исключения и смену зоны обязательна.
- Время обновления выбирает клиент Calendar, поэтому мгновенную синхронизацию не обещать. Для срочного reminder использовать основной notification channel. Alarm в ICS по умолчанию выключен, чтобы не дублировать бота.
- Отмена подписки/отзыв feed не удаляет Goal, Activity или XP. Export из Системы не является импортом занятости обратно.

### 3.2. Calendar → Система: busy-only import — P5-02

Первый необязательный мост — Shortcut «Передать занятость»: прочитать выбранный период/календари, отправить только start/end/timezone/all-day и source IDs в scoped endpoint. Apple Shortcuts имеет Find Calendar Events и HTTP requests. Это основание для spike; background execution/конкретные поля и разрешения проверяются на телефоне. [Find actions](https://support.apple.com/en-euro/guide/shortcuts/apd3c845e881/ios), [HTTP в Shortcuts](https://support.apple.com/en-lamr/guide/shortcuts/apd58d46713f/ios)

Каждая import batch сообщает полный/частичный охват, observed_at, range и source. Частичный/упавший импорт не стирает остальные события. Внешние events хранятся отдельно с mapping, ownership/provenance; absence в полном snapshot может дать tombstone только в его scope. Exported «Система» календарь исключить из busy import, иначе возникнет цикл и удвоится занятость.

Другой путь — OAuth connector облачного календаря, которым уже пользуется владелец. Отдельно проверить scopes, delta sync, provider terms и цену на этапе подключения. Не собирать Apple ID password и не обещать EventKit из браузера. Ручная занятость всегда остаётся доступной; показывать «обновлено …» и stale indicator.

### 3.3. Двусторонняя синхронизация

Позже, только с отдельными conflict/mapping rules. Изменение во внешнем календаре порождает proposal или versioned command. Никогда не превращать удаление календарного события в отмену факта выполненной тренировки. Native EventKit adapter возможен в companion, если он станет нужен; текущему пилоту он не обязателен.

## 4. Здоровье: постепенно повышать автоматизацию — P5-03

Mini App не имеет прямого HealthKit/Health Connect доступа. Акселерометр Telegram не является фоновым шагомером и не даёт доступ к истории Apple Health. Сначала полноценный self-report, затем **проверяемый мост**, затем при необходимости native companion.

### Shortcuts bridge

Apple Shortcuts включает Find Health Samples и умеет отправлять JSON в HTTP API; из этого следует возможность исследовать импорт выбранных данных без собственного iOS-приложения. Это архитектурный вывод, не гарантия корректного подсчёта шагов/доступности всех workouts или автономной фоновой работы. [Health samples в Shortcuts](https://support.apple.com/en-euro/guide/shortcuts/apd3c845e881/ios), [HTTP requests](https://support.apple.com/en-lamr/guide/shortcuts/apd58d46713f/ios)

Spikes до включения:

1. Доступны ли нужные типы, source/sample ID, start/end/unit и корректный агрегат на реальном iPhone?
2. Как получить итог шагов без двойного сложения перекрывающихся phone/watch samples? Сравнить результат с Apple Health. Если надёжный агрегат недоступен, оставить ручной подтверждённый дневной итог; не выпускать неверный автоматический счётчик.
3. Работает ли запуск вручную и выбранная автоматизация при заблокированном экране, после перезагрузки, без сети/при отзыве permission? Зафиксировать факты; не обещать push из HealthKit через Shortcut.
4. Показать какие агрегаты покидают телефон. Устройство сначала пробует отправку; failure остаётся видимым. Не создавать «0 шагов» из ошибки чтения.

Pairing в Mini App выдаёт отдельный ограниченный, отзывной credential для `health:import`/`calendar:busy_import`; не bot token, app refresh или LLM key. Secret передаётся в HTTP Authorization, не в query. Разделить connections и scopes; health credential не может исполнять любые domain commands. Настройка пользователем выполняется явно, credential не включается в публичный шаблон Shortcut.

### Нормализованный контракт доказательства

`source/provider`, `connection_id`, `source_record_id` при наличии, `record_kind`, `observed_at`, `started_at/ended_at` или local_date+zone, `amount`, `unit`, `revision`, `dedupe_key`, `provenance`, `completeness`.

- Workouts с достоверным source ID дедуплицировать по `(user,connection,source_record_id)`; без ID — content fingerprint + review неоднозначных совпадений, не обещать идеальную дедупликацию.
- Daily aggregate заменяет предыдущую revision того же дня/источника, не добавляется повторно к итогу. Не складывать разные providers как независимые шаги.
- Matching ищет уже существующий Activity root по типу/интервалу/occurrence. Timer/self-report + import одной тренировки → attach evidence, не второй reward.
- Shortcut payload контролирует пользователь: `shortcut_import` — происхождение, не криптографическое доказательство устройства. Без специальной проверенной policy не повышать multiplier до device-verified.
- Отдельное opt-in правило привычки: «предлагать/автоматически отмечать прогулку при условии …». Domain engine проверяет thresholds/объём/reward profile, затем делает ordinary command с одним reward root. ИИ для начисления не вызывается.
- Sample correction/deletion — evidence revision, fallback self-report/уточнение, разрешённый delta/reversal; не обвинение пользователя. Отзыв доступа останавливает импорт, не обнуляет заработанную историю.
- Передача health aggregate в AI требует отдельного consent. Raw health history не отправляется на сервер по умолчанию.

### Другие adapters

Облачный fitness provider может дать часть workouts, если пользователь уже его использует. Доступ к шагам и типам данных проверять отдельно; выбор провайдера после запроса пользователя, scope/API spike и privacy review. Native companion позже даст прямые HealthKit queries и устойчивее управляемые permissions, но тоже подчиняется ограничениям ОС.

## 5. Action Button, Shortcuts, ярлыки и widgets — P5-04

Apple позволяет назначить Action Button запуск Shortcut. [Инструкция Apple](https://support.apple.com/en-my/guide/shortcuts/apdfea15680b/ios)

Без собственного native app можно дать инструкции для Shortcut, открывающего Telegram deep link на Today/capture/voice. На поддерживаемом iPhone пользователь сам назначает кнопку. Переход не исполняет completion автоматически. Позже scoped action endpoint принимает конкретную occurrence/variant/actual amount с подтверждением и idempotency, а не свободный запрос «сделать всё».

[Shortcuts widget](https://support.apple.com/en-my/guide/shortcuts/apd029b36d05/ios) — набор быстрых действий. Ярлык Telegram — запуск Mini App. Ни один не изображается как наш полноценный автоматически обновляемый виджет персонажа. В боте — компактная обновляемая карточка дня; Mini App — настоящий Character screen. Home-screen shortcut Telegram проверяется по capabilities, добавляется только по выбору пользователя.

## 6. Таймер и Live Activities — P5-05

На Telegram этапе: foreground таймер по timestamps, сохранение состояния, возобновление с уточнением спорного интервала, серверное reminder о плановом окончании. Background JS не используется как точные часы или источник XP. Нельзя гарантировать сообщение ровно в секунду окончания либо доставку без сети.

Собственная Live Activity/Dynamic Island требует native ActivityKit/WidgetKit интеграции; сайт в Telegram её не заменяет. [ActivityKit](https://developer.apple.com/documentation/activitykit)

Если практика покажет, что это существенно, следующий вариант — небольшой iOS companion для таймера/health/widgets. Общие user ID, APIs, Activity roots и receipts сохраняются. Его сборка/подпись/доставка действительно требуют Apple toolchain и отдельного этапа. Не тормозить Telegram релизы ожиданием companion.

## 7. Уведомления и приватность каналов

Основной transport — бот, правила [14](14-telegram-platform.md). В PWA возможен web push при поддержке и разрешении; native local notifications сохраняются только как будущий adapter. Нет гарантированного фонового выполнения WebView.

Бот/сообщения обрабатываются инфраструктурой Telegram; нельзя переносить обещания о полностью локальном или end-to-end хранении на этот канал. Пользователь может отключить содержательные reminders, voice, внешние integrations и AI, продолжая ручной цикл. Backend deletion не гарантирует удаления всех копий сообщений/файлов у Telegram и providers; описать реальные доступные действия перед публичным запуском.

## 8. Порядок без потери ядра

Полный основной MVP → voice notes → ICS + quick access → busy/health spikes → выбранные прошедшие проверки bridges → PWA при потребности в offline → realtime/companion по измеренной пользе. Независимые малые улучшения, например открытие с Action Button, можно включать раньше после работающего auth и client routing. Advanced RPG/планирование не ждут подключения HealthKit.
