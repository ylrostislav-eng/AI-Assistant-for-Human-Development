# Персональная ИИ-Система развития

iPhone-приложение, которое связывает реальные цели, ежедневные действия и долгосрочное развитие персонажа. Первая версия — для автора, следующая — для публичного использования.

**Состояние на 15 сентября 2026: подготовлена архитектура v0.1; из кода существует только backend scaffold (health, пул PostgreSQL, команда миграций). iOS-приложение не реализовано, ничего не развёрнуто.**

## С чего начать

1. [Общий план и суть продукта](docs/00-product-and-decisions.md).
2. [Архитектура и структура проекта](docs/01-system-architecture.md).
3. [Пошаговая реализация Phase 0–6](docs/10-implementation-plan.md).
4. [Правила для моделей-разработчиков](AGENTS.md) и [текущее состояние передачи работы](docs/13-handoff.md).
5. [Среда, версии и команды проверки](docs/toolchain.md) — завершены P0-01a и backend-часть P0-01b; сборка iOS остаётся незакрытым критерием P0-01.

## Запуск backend

```bash
npm install
cp ops/env.example .env          # заполнить DATABASE_URL своими значениями
npm run typecheck
npm test                         # unit
DATABASE_URL=... npm run test:integration   # нужен отдельный тестовый PostgreSQL
DATABASE_URL=... npm run migrate
npm run dev                      # GET /health и /health/ready
```

## Полная спецификация

| Документ | Содержание |
|---|---|
| [00. Продукт и решения](docs/00-product-and-decisions.md) | Сохранённый замысел, улучшения, MVP, предположения, архитектурные решения |
| [01. Архитектура](docs/01-system-architecture.md) | iOS, backend, модули, потоки данных, дерево будущего репозитория |
| [02. Модель данных](docs/02-domain-and-data.md) | Сущности, отношения, ограничения, состояния Quest |
| [03. Прогрессия](docs/03-progression-engine.md) | XP, уровни, навыки, характеристики, Current Form, Rank, anti-grind |
| [04. Планирование и восстановление](docs/04-scheduler-and-recovery.md) | Календарная математика, Scheduler, Minimum Protocol, Recovery Debt |
| [05. ИИ](docs/05-ai-system.md) | OpenAI, function calling, роли, память, права, примеры команд |
| [06. API и синхронизация](docs/06-api-and-sync.md) | Контракты, offline, повторные запросы, конфликты, транзакции |
| [07. iOS и интерфейс](docs/07-ios-and-experience.md) | Экраны, навигация, SwiftUI, дизайн, доступность |
| [08. Голос и Apple](docs/08-voice-and-apple.md) | Realtime, EventKit, HealthKit, Widgets, App Intents, Live Activities |
| [09. Безопасность и эксплуатация](docs/09-security-and-operations.md) | Секреты, персональные данные, развёртывание, стоимость, восстановление |
| [10. План реализации](docs/10-implementation-plan.md) | Задачи, зависимости, файлы, данные, тесты, критерии готовности |
| [11. Проверки](docs/11-testing-and-edge-cases.md) | Тестовая стратегия, сквозные сценарии, пограничные случаи |
| [12. Покрытие и источники](docs/12-traceability-and-sources.md) | Все 77 разделов концепции, 32 технических требования, официальные источники |
| [13. Передача работы](docs/13-handoff.md) | Что готово, что ещё не сделано, первая задача для следующей модели |

Исходный файл сохранён [без изменений](docs/source/original-concept.ru.md). Документы написаны по его требованиям; предложенные уточнения обозначены явно. Числа игрового баланса — проверяемая стартовая гипотеза, а не научная оценка способностей человека.

Машиночитаемые черновики: [баланс](docs/contracts/progression-v0.1.json), [конверт команды](docs/contracts/command-envelope.schema.json), [AI tool](docs/contracts/complete-quest.tool.json). Проверка расчётов: `python3 docs/validation/check_architecture.py`.
