# 10. Пошаговый план разработки: Phase 0–6

## 1. Как исполнять план

Порядок обязателен по зависимостям, а не по длине файла. Каждая задача заканчивается reviewable результатом, meaningful checks и записью в `13-handoff.md`. Одна модель может выполнять несколько связанных задач по поручению пользователя, но не отмечает готовыми зависимости, которые только описаны.

Названия файлов ниже — планируемые. Пути backend относительны `services/backend/`, Swift — `apps/ios/`; полное дерево в документе 01. Контракты до реализации лежат в `docs/contracts/`, при P1-01 переходят в production source of truth `packages/contracts/` с обновлением ссылок. Не поддерживать две расходящиеся канонические копии.

```mermaid
flowchart LR
  P0[Phase 0: решения и spikes] --> P1[Phase 1: ручное ядро + offline]
  P1 --> P2[Phase 2: текстовая Система]
  P2 --> P3[Phase 3: детерминированная RPG]
  P3 --> PILOT[Личный пилот 4 недели]
  PILOT --> P4[Phase 4: голос]
  P4 --> P5[Phase 5: Apple integrations]
  P5 --> P6[Phase 6: advanced intelligence]
```

Публичная beta — отдельный release gate после успешного личного пилота; голос и все Apple-интеграции не обязательны для проверки базовой ценности, но нужны для полной концепции.

## 2. Phase 0 — Architecture

Цель: снять технические неопределённости до большой реализации. Текущий пакет закрывает документационную часть, но device/API spikes пока не выполнялись.

| ID | Что сделать / файлы | Зависит от | Данные/доступ | Проверки | Готовый результат |
|---|---|---|---|---|---|
| P0-00 | Концепция, спецификации, `AGENTS.md`, drafts, математическая проверка | Исходный файл | Все 77 разделов, решение «сначала для себя» | Ссылки, coverage, formulas | Этот архитектурный пакет; без app code |
| P0-01 | Зафиксировать toolchain/версии в `docs/toolchain.md`; root workspace config | P0-00 | Доступная macOS/Xcode, Node LTS, PostgreSQL | Swift empty app build; backend smoke; package compatibility | Воспроизводимое окружение без фиктивных «latest» |
| P0-01a | Инвентаризация среды, `scripts/check_environment.py`, `docs/toolchain.md` | P0-00 | Доступные CLI | Реальные версии, docs/node profiles, ожидаемый отказ iOS на Linux | Завершённый аудит; не заменяет сборку приложения |
| P0-01b | Pins/lockfiles, backend/database smoke, минимальная сборка iOS | P0-01a | Package access, test DB, Mac/Xcode для iOS | Install/typecheck/health/SQL transaction/iOS build | Закрыты оставшиеся критерии P0-01 |
| P0-02 | Одноразовые spikes `spikes/ios-offline`, `spikes/voice-capability`; UX wireframes | P0-01 | iPhone/Mac; microphone/calendar dev permissions по потребности | DB transaction after kill, notification reschedule, native WebRTC feasibility | ADR о storage/voice; spike code не объявлен production |
| P0-03 | Provider contract spike, `docs/model-evaluation.md` | P0-01 | Реальный backend API key и выбранный usage budget при поручении API работ | Русский prompt, strict tool, timeout, refusal, cost capture | Проверенные model IDs/config; секрет не в git |
| P0-04 | Threat model review, auth/tenant prototype, deployment sketch | P0-01 | Личный Apple subject, dev signing когда доступно | Два synthetic tenants, isolation, key scan | Понятный путь auth и personal pilot hosting |
| P0-05 | Wireframe review Today/Goal/PlanDiff/Character; end-to-end fixture set | P0-00,02 | English goal, 2 недели графика, offline failure | Обойти все ключевые состояния UI; проверить критерии | Закреплённые contracts v1 и список рисков |

Exit gate: версии/контракты согласованы; engine formulas проходят sanity; понятен native voice path; известен способ собрать iPhone и backend. Недоступный Mac не препятствует backend/docs, но iOS build gate нельзя отметить пройденным.

## 3. Phase 1 — Core MVP

Цель: работающая ручная система целей, задач и календаря с backend/offline. **Это инженерное ядро, ещё не весь MVP §71.** Ранние reward screens могут показывать 0/недоступность функции; fake XP не выдаётся за реальный.

| ID | Что реализовать / файлы | Зависит от | Данные | Тесты | Definition of Done |
|---|---|---|---|---|---|
| P1-01 | `packages/contracts/openapi.yaml`, schemas; migrations 001 identity/profile/goals/quests/calendar/sync | P0 | Domain 02, time fixtures | Schema lint, migrate clean DB, FK/RLS constraints | Все Phase 1 endpoints имеют закрытые schemas |
| P1-02 | `modules/identity`, `shared/auth`, Keychain adapter, account routing | P1-01 | Apple proof/dev synthetic identities | Forged/expired/replayed token, refresh rotation, two tenants | Реальный login + закрытый signup; dev bypass запрещён в release |
| P1-03 | `shared/commands`, `modules/sync`, per-user counter, receipts/outbox/jobs | P1-01,02 | Command fixtures, duplicates | Timeout-after-commit, concurrent commits, cursor holes | Exactly-once business effect при повторяемой доставке |
| P1-04 | Swift Data/SQLite/Migrations/Sync + local overlays; Repositories | P1-03 | Bootstrap, pending dependencies, tombstones | Offline edits, app kill, conflict, rebootstrap | Действия сохраняются и сходятся с сервером |
| P1-05 | Profile/Onboarding; Goals/Milestones/Projects/Metrics; Inbox | P1-02,04 | Baseline, availability, success metrics | Resume onboarding, standalone quest, measured goal | Можно вручную создать цель и понятный путь |
| P1-06 | Quests/Actions/Activity; Timer; states; undo/cancel groundwork | P1-03,04 | Normal/minimum, actual duration, day assignment | Partial→minimum→normal, duplicate, timer pause/reboot | Факты действий корректны; XP ещё не рассчитывается |
| P1-07 | CalendarMath/Scheduler; day/week/month; ReminderCoordinator; day-close job | P1-05,06 | Busy windows, recurrence, timezone | DST, boundaries, hard conflicts, notification cancel | Посильный ручной/алгоритмический план и missed |
| P1-08 | DesignSystem + Today/Goals/Character/Calendar shell; Settings/Privacy | P1-04…07 | UI state fixtures | Dynamic Type, VoiceOver smoke, no-network, long RU strings | Все основные действия доступны без ИИ; атмосфера System |
| P1-09 | Export/delete path, pilot deployment scripts, backend/iOS CI | P1-02…08 | Synthetic 30-day user data | Export parse, deletion+restore replay, install/device smoke | Ручной цикл работает 7 дней на устройстве, CI реальный |

Exit gate: manual Goal → task → calendar → completion → persisted Activity → offline sync; day-close/минимум/перенос/удаление корректны; нет cross-user доступа. Production XP и AI не имитируются.

## 4. Phase 2 — AI System

Цель: полезный русский текстовый ассистент, который делает реальные допустимые изменения, а не только пишет советы.

| ID | Что / файлы | Зависит от | Данные | Тесты | Готовность |
|---|---|---|---|---|---|
| P2-01 | `modules/ai/providers/AIProvider.ts`, `OpenAIProvider.ts`, turn/SSE lifecycle | P0-03, P1 | Model config, budgets, synthetic prompts | Stream, timeout, 429, cancel, tool result continuation | Реальный provider за interface, fallback manual |
| P2-02 | `ContextBuilder`, roles/prompts, read tools, factual cards | P2-01 | User profile, goals, current schedule, versions | Relevant-only context, no other user data, correct date math | Ответы опираются на актуальные факты |
| P2-03 | `ToolGateway`, policy/approval scopes, command adapters, PlanDiff UI | P2-02, P1-03 | Explicit intents, proposals, request IDs | Prompt injection, bogus XP args, stale approval, duplicate calls | Все mutations через policy+CommandBus |
| P2-04 | Goal interview/GoalPlanDraft; dynamic skills/classifier | P2-03 | Baseline, time budget, skill taxonomy, rubrics | Vague goal clarification, duplicate skill, infeasible roadmap | За несколько шагов принята реальная программа |
| P2-05 | Memory viewer/retrieval, DailyReview factual+AI, Motivation policy | P2-02…04 | 14/30 days synthetic facts, confirmed memories | Forget/delete propagates, false numeric claims, no shaming | Личный контекст и полезный review без всей переписки |
| P2-06 | Basic Recovery cases+reason interview, plan recalculation | P1-07, P2-03…05 | Missed/excused/load, user reasons | Sick→no debt, unknown reason, capacity cap, no debt cascade | Плохой день приводит к посильному плану |

Exit gate: «хочу английский» → interview → accepted goal plan → Today; «перенеси» меняет данные один раз; «сегодня не успеваю» выдаёт допустимый diff; refusal/error не превращается в ложный success. XP по-прежнему вычисляется только после Phase 3.

## 5. Phase 3 — Progression

Цель: вся детерминированная RPG-механика и полный MVP из исходной концепции.

| ID | Что / файлы | Зависит от | Данные | Тесты | Готовность |
|---|---|---|---|---|---|
| P3-01 | `packages/rules/progression`, `progression/engine.ts`, decimal utilities | P1-06, P2-04 | v0.1 config, canonical activities, rubrics | Golden examples, split invariance, caps, zero input | XP pure engine без AI/IO |
| P3-02 | ledger migrations/service, user transaction, reversals/replay | P3-01, P1-03 | Multi-device, late activities, evidence upgrades | Complete+retry+undo, concurrent caps, replay twice | Ledger authoritative, no double awards |
| P3-03 | Skill/stat mastery, levels/gates, canonical hierarchy/merge | P3-02 | Allocation profiles, milestones/checkpoints | Conservation, no parent double count, merge/rename | Навыки появляются с 0 и растут по реальным действиям |
| P3-04 | Form/CurrentLevel/Rank/Streak/Protection; RecoveryDebt projection | P3-03, P2-06 | 365-day timelines, maintenance targets | Decay/no-decay, rank hysteresis, pause, return, no sick penalty | Текущая форма меняется, история сохраняется |
| P3-05 | Swift ProgressionPreview + shared golden fixtures; Character/Skill UI/celebrations | P3-01…04 | Canonical server snapshots and pending commands | Preview/reconcile parity, animations once, accessibility | Заработанный и pending XP различимы |
| P3-06 | End-to-end MVP audit + 4-week personal pilot; balance report | P1…P3 | Реальное личное использование с согласиями | All MVP scenarios, backups, costs, no overload incentives | Главный цикл доказан; перечень исправлений завершён |

Exit gate: все 20 пунктов §71 работают; профиль 0 → Goal → AI Plan → Quest → Completion → XP → Review → Adaptation; offline и повторные операции не нарушают reward. Pilot feedback может менять коэффициенты новой версией, но не произвольным текстом ИИ.

## 6. Phase 4 — Voice

| ID | Что / файлы | Зависит от | Данные/доступ | Тесты | Готовность |
|---|---|---|---|---|---|
| P4-01 | Native WebRTC dependency, AudioSessionManager, transport adapter | P0-02, P3 pilot | iPhone, headset, microphone permission | Audio routing, interruption, supported iOS/device | Стабильный звук без hardcoded main key |
| P4-02 | Voice session backend, trusted call binding, sideband, quotas | P4-01, P2-03 | Provider config, session scope | Forged call ID, expiry, reconnect, budget limit | Session принадлежит ровно user/device |
| P4-03 | Transcript/intent cards, tool bridge, spoken canonical receipts | P4-02 | Ambiguous/clear RU phrases | Duplicate completion, reschedule conflict, stop after commit | Голос реально меняет приложение один раз |
| P4-04 | Fallback transcription/text, cost/latency/device regression | P4-03 | Noisy room, poor network, provider failure | Barge-in, call interruption, no audio retention | Доступный надёжный push-to-talk сценарий |

Exit gate: создание/перенос/завершение и перестройка дня голосом; отказ permission и сеть не ломают manual core; cost session контролируется.

## 7. Phase 5 — Apple integrations

| ID | Что / файлы | Зависит от | Данные/доступ | Тесты | Готовность |
|---|---|---|---|---|---|
| P5-01 | EventKit adapter/mappings, busy import, selective export | P1-07, P3 | Calendars/permissions | Read-only, recurring edits, DST, external change, revoke | План учитывает выбранный Apple Calendar |
| P5-02 | Reminders adapter, explicit mapping/complete proposals | P5-01, P2-03 | Reminder permission | Import loop, duplicate completion, deletion | Нет двойных задач/XP |
| P5-03 | HealthKit queries, evidence matching, per-habit auto-complete | P3-02,04 | Steps/workouts opt-in | Phone/watch duplicates, absent data, revoked access, sample deletion | Подтверждение добавлено к правильной Activity |
| P5-04 | Widget extension, App Group snapshot/queue, App Intents/Shortcuts | P3-05, P4 | Extension entitlements/device | Locked device, stale snapshot, two processes, logout | Capture/next quest/complete используют core commands |
| P5-05 | Live Activity timer, Action Button intent path, privacy/device matrix | P5-04 | Supported iPhone, Activity capabilities | Timer after kill, expiry, lock privacy, intent retry | Полный удобный iPhone flow без фоновых обещаний |

Exit gate: permissions optional; отключение любой integration не блокирует ядро; нет повторных rewards, циклов sync и раскрытия sensitive lock-screen текста.

## 8. Phase 6 — Advanced intelligence

| ID | Что / файлы | Зависит от | Данные | Тесты | Готовность |
|---|---|---|---|---|---|
| P6-01 | Weekly/Monthly Review, pattern aggregates, uncertainty labels | P3, 4+ недели данных | Factual history, consent | Small sample, changed plan denominator, narrative accuracy | Отчёты полезны и не придумывают выводы |
| P6-02 | Deep memory/search, provenance, preference/hypothesis correction | P2-05, P6-01 | Opted-in longitudinal data | Cross-tenant retrieval, stale/sensitive memory, deletion | Memory управляется пользователем и объяснима |
| P6-03 | Advanced Scheduler/auto-policy, DifficultyScaling, diagnostics | P6-01, P5-01 | Capacity/history/baseline versions | Regression constraints, withdrawn consent, solver-vs-greedy fixtures | Autonomy в выбранных пределах, безопасный rollback |
| P6-04 | Forecast/experiments with confidence range | P6-01,03 | 4–8+ недель comparable metric data | Insufficient data, non-linear goal, intervention attribution | Прогноз показывает assumptions и границы |
| P6-05 | Skill Trees, Boss presentation, avatar evolution | P3-03, P6-01 | Checkpoints, milestones, owned visual assets | No new reward loopholes, gates, accessibility | Визуальная глубина усиливает реальные достижения |
| P6-06 | Watch companion + public scale/abuse/launch readiness | P5, P6 chosen scope | Watch device, pilot performance, launch decisions | Delayed Watch commands, load, restore, export/delete, secret rotation | Готовый согласованный scope публичного продукта |

Phase 6 не обязана выпускаться одним большим релизом. Каждая функция включается отдельно по feature flag и измеренной пользе.

## 9. Минимальные данные для разработки

Synthetic fixtures, без копирования личной переписки:

- Пользователь с работой 09–18, дорогой, сном, boundary 04:00; 3 цели (английский, проект, бег).
- 14-дневный roadmap и расписание с full/minimum/partial/excused/missed.
- 30-дневная история для reviews; 365/1825/3650-day симуляции прогрессии.
- Два tenants; два устройства одного tenant; timezone travel/DST; duplicate device evidence.
- Рубрики навыков и checkpoints, manual baseline, 6 stats, 2–3 стилистических режима для UI/eval.

Реальные данные автора нужны лишь для личного pilot/calibration после базовых privacy и restore gates.

## 10. Definition of Done каждой задачи

1. Выполняются acceptance criteria из этой таблицы и соответствующие инварианты спецификации.
2. Нет production mock/fake success на изменённом пути.
3. Контракты/migrations/examples согласованы; обратная совместимость явно описана.
4. Необходимые unit/integration/UI/eval tests реально выполнены либо точно указан блокирующий environment gap.
5. Ошибки/offline/empty/permission denial пути реализованы для новой функции.
6. Нет секретов/личного текста в git/logs; user ownership проверяется.
7. Handoff обновлён: completed IDs, проверки, unresolved risks, next task.

## 11. Оценка объёма

Грубая оценка одного опытного разработчика с помощью моделей, при доступных Mac/устройствах и без отвлечений: Phase 0 1–2 недели; Phase 1 5–8; Phase 2 3–5; Phase 3 3–5 плюс 4 недели наблюдения пилота (частично совмещается с исправлениями); Voice 2–4; Apple integrations 3–6; Advanced 6–12+.

Это диапазоны планирования, не обещанный срок. Основная неопределённость — качество взаимодействия, offline correctness, native voice, выбранный публичный scope. Рабочий личный MVP вероятнее займёт месяцы, а полноценная концепция — последовательные релизы. Наличие моделей не заменяет device testing и проверку на реальной жизни.

## 12. Первый конкретный запрос следующей модели

> Прочитай AGENTS.md, docs/13-handoff.md, документы 00/01/10. Начни P0-01: проверь текущий репозиторий и доступную среду, зафиксируй совместимый toolchain и минимальные команды сборки. Продолжи доступные задачи Phase 0, сверяя критерии. Не считай документы реализацией. Не добавляй произвольные XP или production mocks. По итогам обнови handoff с реально выполненными проверками.

Если окружение Linux без Mac, сначала выполнить доступный backend/contracts/toolchain scope и явно сохранить невыполненный iOS gate. Не утверждать, что приложение собирается, на основании одного TypeScript-теста.
