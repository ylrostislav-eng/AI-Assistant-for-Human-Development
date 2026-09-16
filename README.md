# Персональная ИИ-Система развития

Система развития, которая связывает реальные цели, ежедневные действия и долгосрочный прогресс. Клиент личного пилота — Telegram (бот и Mini App), см. [ADR-013](docs/00-product-and-decisions.md); нативное приложение для iPhone возможно позже поверх того же API. Первая версия — для автора, следующая — для публичного использования.

**Состояние на 16 сентября 2026:** есть частичный backend (RLS, sessions, команды, outbox/worker, задания, календарная математика). Telegram auth, Mini App, AI и production Progression Engine пока не реализованы. Архитектура/план согласованы под Telegram; перед подключением реальных данных нужно закрыть найденные ошибки [аудита](docs/15-backend-review.md).

## С чего начать

1. [Общий план и суть продукта](docs/00-product-and-decisions.md).
2. [Архитектура и структура проекта](docs/01-system-architecture.md).
3. [Пошаговая реализация Phase 0–6](docs/10-implementation-plan.md).
4. [Правила для моделей-разработчиков](AGENTS.md) и [текущее состояние передачи работы](docs/13-handoff.md).
5. [Среда, версии и команды проверки](docs/toolchain.md) — backend pins и проверенный путь PostgreSQL; Mac не блокирует Telegram.

## Запуск backend

```bash
npm ci
cp ops/env.example .env          # заполнить DATABASE_URL своими значениями
npm run typecheck
npm test                         # unit + contracts
DATABASE_URL=... npm run test:integration   # только отдельная synthetic DB: suite удаляет public schema
DATABASE_URL=... npm run migrate
npm run dev                      # GET /health и /health/ready
```

## Полная спецификация

| Документ | Содержание |
|---|---|
| [00. Продукт и решения](docs/00-product-and-decisions.md) | Сохранённый замысел, улучшения, MVP, предположения, архитектурные решения |
| [01. Архитектура](docs/01-system-architecture.md) | Mini App + бот, backend, модули, потоки данных и local journal |
| [02. Модель данных](docs/02-domain-and-data.md) | Сущности, отношения, ограничения, состояния Quest |
| [03. Прогрессия](docs/03-progression-engine.md) | XP, уровни, навыки, характеристики, Current Form, Rank, anti-grind |
| [04. Планирование и восстановление](docs/04-scheduler-and-recovery.md) | Календарная математика, Scheduler, Minimum Protocol, Recovery Debt |
| [05. ИИ](docs/05-ai-system.md) | OpenAI, function calling, роли, память, права, примеры команд |
| [06. API и синхронизация](docs/06-api-and-sync.md) | Контракты, offline, повторные запросы, конфликты, транзакции |
| [07. Mini App и интерфейс](docs/07-ios-and-experience.md) | Пять вкладок, web UI, Telegram lifecycle, RPG-дизайн и доступность |
| [08. Голос и интеграции](docs/08-voice-and-apple.md) | Voice notes, ICS, Shortcuts/health bridges, Action Button, границы native функций |
| [09. Безопасность и эксплуатация](docs/09-security-and-operations.md) | Секреты, персональные данные, развёртывание, стоимость, восстановление |
| [10. План реализации](docs/10-implementation-plan.md) | Задачи, зависимости, файлы, данные, тесты, критерии готовности |
| [11. Проверки](docs/11-testing-and-edge-cases.md) | Тестовая стратегия, сквозные сценарии, пограничные случаи |
| [12. Покрытие и источники](docs/12-traceability-and-sources.md) | Все 77 разделов концепции, 32 технических требования, официальные источники |
| [13. Передача работы](docs/13-handoff.md) | Актуальное состояние, проверки, следующий срез T-00a |
| [14. Telegram](docs/14-telegram-platform.md) | Возможности/ограничения, auth, bot, offline/PWA, device checklist |
| [15. Аудит backend](docs/15-backend-review.md) | Воспроизведённые дефекты и задания исправления для агентов |

Исходный файл сохранён [без изменений](docs/source/original-concept.ru.md). Документы написаны по его требованиям; предложенные уточнения обозначены явно. Числа игрового баланса — проверяемая стартовая гипотеза, а не научная оценка способностей человека.

Машиночитаемые контракты: [баланс](packages/rules/progression/progression-v0.1.json), [конверт команды](packages/contracts/schemas/command-envelope.schema.json), [AI tool](packages/contracts/schemas/complete-quest.tool.json). Проверка расчётов: `python3 docs/validation/check_architecture.py`.
