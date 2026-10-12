# Экономика

| Папка | Ответственность |
|---|---|
| `domain/` | Модели и расчёты: деньги, стройка, рецепты, рыбалка, рынок, вместимость и награды |
| `sync/` | HTTP, очередь команд, revision, повторы, сессия и `use-economy` |
| `integration/` | Связь хозяйства со сценой и сбором урожая |
| `ui/` | Окна по темам: `construction`, `market`, `food`, `fishing`, `inventory`, `production`, `expeditions`; общие элементы в `shared` |
| `dev/` | Локальные модели и пресеты разработки |

Для оформления рынка откройте `ui/market/`; для правил торговли — `domain/market-rules.ts`. Цены, сроки и требования берутся из [economy-catalog.json](../../apps/api/src/main/resources/world/economy-catalog.json). Каталог общий для TypeScript и Kotlin; подтверждение команд и транзакции выполняет [Ktor](../../apps/api/src/main/kotlin/ru/zhiv/economy/), локальный API в `lib/dev/` повторяет контракт.

`domain/` не загружает React/UI/сессии. `sync/` не загружает UI; например, общая блокировка команд принадлежит `sync/controller-state.ts`. Интеграция передаёт подтверждённые уровни и задания в мир; анимация не начисляет награды.

[Экономические правила](../../docs/game/economy-foundation.md) · [Организация кода](../../docs/development/code-organization.md) · [Карта файлов](../../docs/repository-guide.md).
