# Архитектура приложения

Актуально для Tiled-мира в `feature/mochlik-tiled-world`. Поиск файла для задачи — [путеводитель](repository-guide.md); запуск — [локальная разработка](development/local-development.md).

## Контуры запуска

| Контур | Страница | API и данные | Конфигурация |
|---|---|---|---|
| Локальная разработка | Next.js, `npm run dev:local` | `app/api/v1/` → `lib/dev/`, память процесса | [next.config.ts](../next.config.ts), `.env.example` |
| Sites | Vite/Vinext, `npm run dev` | Те же route handlers; это не PostgreSQL-сервер | [vite.config.ts](../vite.config.ts), [worker/index.ts](../worker/index.ts), `build/` |
| VPS | Caddy → Next.js | Caddy направляет `/api/*` в Ktor → PostgreSQL | `deploy/compose.yml`, `deploy/Caddyfile` |

В production локальный API заблокирован без явного `ENABLE_DEV_API=true`. Флаг не подключает Ktor и не делает память постоянной. [db/schema.ts](../db/schema.ts) — пустая заготовка Sites/D1; схема настоящего приложения находится в Flyway-миграциях `apps/api/`.

## Границы модулей

| Модуль | Ответственность | Подробнее |
|---|---|---|
| `app/` | Страницы, layout, manifest, локальные API-маршруты | [Запуск](development/local-development.md) |
| `features/check-in/` | Главный экран, отметка, календарь, статус | [Функции приложения](development/app-features.md) |
| `features/account/`, `features/people/` | Вход, профиль, восстановление, связи, группы | [Функции приложения](development/app-features.md) |
| `features/game/` | Тапы, журнал отправки, уровни, рейтинг, достижения | [Синхронизация](game/game-sync-reliability.md) |
| `features/world/` | Tiled-сцена, камера, свет, погода, живность, UI и серверное состояние мира | [Редактор карты](game/tiled-editor.md), [освещение](game/world-lighting.md) |
| `features/mochlik/` | Рисование Мохлика и сохранённые модули прежней сцены | Текущий лес собирается в [features/world/new-map-scene.ts](../features/world/new-map-scene.ts) |
| `features/admin/` | Закрытые инструменты поддержки и модерации | [Админка](operations/admin-panel.md) |
| `components/`, `lib/` | Общий UI, API-клиенты, контракты и чистые функции | [Функции приложения](development/app-features.md) |
| `apps/api/` | Серверные правила, авторизация, транзакции, миграции | [Сервер и данные](development/backend-and-data.md) |

[app/page.tsx](../app/page.tsx) открывает `CheckInApp`. Он соединяет аккаунт, отметки, людей и игровое состояние. CSS-компонента лежит рядом в `.module.css`; общие токены и базовые стили — [app/globals.css](../app/globals.css).

## Кто владеет состоянием

| Состояние | Источник истины | Клиентская сторона |
|---|---|---|
| Аккаунт, отметки, приватность, статус | Ktor/PostgreSQL; локально — имитация | [lib/check-in-api.ts](../lib/check-in-api.ts), [lib/auth-api.ts](../lib/auth-api.ts) |
| Подтверждённые тапы, рекорды, достижения | Серверные квитанции | [game-sync.ts](../features/game/game-sync.ts) повторяет неподтверждённые пакеты из журнала |
| Ресурсы, инвентарь, путешествия | Серверный snapshot с `revision` | [world/session.ts](../features/world/session.ts) отправляет команды с `requestId` и `expectedRevision` |
| Геометрия карты, водная маска, свет | `world/tiled/forest.tmj` | Экспорт [forest.generated.json](../features/world/tiled/forest.generated.json), общий `TILED_WORLD` |
| Время анимации, птицы, грибы, события DEV | [forest-session.ts](../features/world/forest-session.ts) для текущего аккаунта | Круг и большая карта читают общую живую сцену |
| Вид интерфейса и анимационные эффекты | React и локальные настройки | Не начисляют серверные награды |

Не смешивайте [features/world/session.ts](../features/world/session.ts) (экономика/HTTP) и [forest-session.ts](../features/world/forest-session.ts) (отрисовка/поведение). Старый [features/mochlik/session.ts](../features/mochlik/session.ts) не является владельцем текущего Tiled-леса.

Тап по кнопке и серверная отметка — разные события. Отметка имеет ограничение частоты и влияет на календарь/серию дней; игровые тапы идут пакетами и имеют отдельные подтверждения. Offline-оболочка PWA не означает успешную отправку отметки.

## Путь графики

1. Редактируемая сцена — `world/tiled/forest.tmj`; PNG-исходники — `art/world/prototype/`.
2. `world:export` проверяет Tiled и формирует [features/world/tiled/forest.generated.json](../features/world/tiled/forest.generated.json). WebP экспортируются отдельно: [арт-процесс](../art/README.md).
3. [presentation.ts](../features/world/presentation.ts) выдаёт единый `TILED_WORLD`. Круг и большая карта используют [new-map-scene.ts](../features/world/new-map-scene.ts), Tiled preview — общий renderer и те же данные.
4. Геометрия, свет и анимации работают в координатах мира; камера переводит их в координаты canvas. Основной новый лес рисуется Canvas 2D.

`WORLD_PRESENTATION.rebuilding = true` временно скрывает строительство и запуск новых путешествий, блокирует крафт; существующие поездки можно завершить. Коллекция, гардероб и старый прогресс сохраняются. `streakDecor = false` скрывает старую кастомизацию подарками. Наличие серверной команды не означает, что функция сейчас открыта в UI.

## Как менять поведение

Для изменения только картинки достаточно сцены/рендера. Для изменения правил нужны клиентский контракт, локальная имитация и Ktor; изменение хранимых данных дополнительно требует новой миграции. Каталог мира общий для TypeScript и Kotlin: [apps/api/src/main/resources/world/catalog.json](../apps/api/src/main/resources/world/catalog.json).

Веб-тесты проверяют UI/контракты/рендер/очередь, Kotlin-тесты — сервер, PostgreSQL integration tests — транзакции и миграции. Порядок — [проверки](development/local-development.md#проверки). Выпуск и сервер описаны отдельно в [эксплуатации](operations/operations.md).
