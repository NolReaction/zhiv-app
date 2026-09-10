# Путеводитель по репозиторию

Это один проект с браузерным приложением и отдельным сервером. Папки названы по их назначению; большинство изменений игры начинается в `features/` или `public/`.

## Хочу изменить…

| Задача | Открыть |
|---|---|
| Основной экран и круглую кнопку | [features/check-in/check-in-app.tsx](../features/check-in/check-in-app.tsx) и соседний CSS |
| Календарь и подарки в нём | [features/check-in/check-in-calendar.tsx](../features/check-in/check-in-calendar.tsx) |
| Профиль, вход, резервный код | [features/account/](../features/account/) |
| Людей и группы | [features/people/](../features/people/) |
| Изображение медали | [public/achievements/](../public/achievements/), файл с ID достижения |
| Название, цель и подсказку достижения | [features/game/game-rewards.ts](../features/game/game-rewards.ts) |
| Окно достижений | [features/game/game-achievements.tsx](../features/game/game-achievements.tsx) и соседний CSS |
| Уровни персонажа и их иконки | [clicker-story.ts](../features/game/clicker-story.ts), [game-level-icon.tsx](../features/game/game-level-icon.tsx) |
| Учёт и отправку игровых тапов | [features/game/use-game-progress.ts](../features/game/use-game-progress.ts), `game-sync.ts`, `game-sync-journal.ts` |
| Карту или детали здания | [public/world/](../public/world/README.md) |
| Какие изображения загружает игра | [features/world/art.ts](../features/world/art.ts) |
| Положение меток и области нажатия | [features/world/map-layout.ts](../features/world/map-layout.ts) |
| Вход в дом и положение фонаря | [features/mochlik/home-layout.ts](../features/mochlik/home-layout.ts) |
| Камеру, перетаскивание и масштаб карты | [features/world/camera.ts](../features/world/camera.ts), `map-engine.ts` |
| Эффект входа в лес | [features/world/world-portal.tsx](../features/world/world-portal.tsx), `use-world-portal.ts`, `world.module.css` |
| Кнопки поверх карты, постройки и гардероб | [features/world/world-view.tsx](../features/world/world-view.tsx), `world-scene.tsx` |
| Меню путешествий и анимацию маршрута | [world-journeys.tsx](../features/world/world-journeys.tsx), [journey-progress.tsx](../features/world/journey-progress.tsx) |
| Внешность Мохлика | [features/mochlik/pixel-sprite.ts](../features/mochlik/pixel-sprite.ts) |
| Поведение, сон, грибы, игры | [features/mochlik/habitat.ts](../features/mochlik/habitat.ts), `pixel-frame.ts`, `ambience.ts` |
| Реакции кустика и листьев | [features/mochlik/bush-reaction.ts](../features/mochlik/bush-reaction.ts) |
| Факелы и камни на тропинках | [features/world/route-props.ts](../features/world/route-props.ts) |
| Рыбки, всплески и дождевые кольца реки | [features/world/water-ambience.ts](../features/world/water-ambience.ts) |
| Птицы и разбитая лодка | `features/world/bird-ambience.ts`, `features/world/boat-wreck.ts` |
| Ночь, лунный свет и фонарь | [features/mochlik/lighting.ts](../features/mochlik/lighting.ts), `lantern-light.ts`, `scene.ts` |
| Цены зданий, длительность походов, коллекции | [Единый каталог мира](../apps/api/src/main/resources/world/catalog.json) |
| Админку, сообщения о сбоях и награды | [features/admin/](../features/admin/), [серверные обработчики](../apps/api/src/main/kotlin/ru/zhiv/admin/) |
| Локальный API для тестирования | [lib/dev/](../lib/dev/) |
| Реальный сервер и сохранение данных | [apps/api/src/main/kotlin/ru/zhiv/](../apps/api/src/main/kotlin/ru/zhiv/) |
| Таблицы и миграции БД | [apps/api/src/main/resources/db/migration/](../apps/api/src/main/resources/db/migration/) |

Изменение текста достижения на клиенте не меняет правила его выдачи сервером. Они находятся в `apps/api/src/main/kotlin/ru/zhiv/game/GameRewards.kt` и `db/GameAchievementWrites.kt`; локальный аналог — `lib/dev/api-store.ts` и `lib/dev/game-store.ts`. Проверяйте обе стороны, если меняете условие, а не оформление.

## Как устроены папки

- **`features/`** — прикладные разделы. Здесь компонент, его стиль, состояние и относящиеся к разделу функции. `mochlik/` управляет героем, `world/` — картой и игровыми панелями, `game/` — тапами и прогрессом.
- **`public/`** — файлы, которые браузер получает как есть. `public/achievements/linked_email.svg` доступен по URL `/achievements/linked_email.svg`.
- **`lib/`** — общие контракты, сеть, дата/время, приватность и функции, нужные разным разделам. `lib/dev/` имитирует API только для разработки.
- **`components/`** — общие уведомления, индикаторы свежести, переключатели и общие стили. `components/ui/` — установленная библиотека элементов интерфейса.
- **`app/`** — входные страницы и API-маршруты фреймворка. Их размещение диктует Next.js.
- **`apps/api/`** — настоящий Ktor-сервер, доступ к PostgreSQL и серверные тесты.
- **`tests/`** — веб-тесты. Префиксы `world-`, `mochlik-`, `game-` помогают найти нужные проверки.
- **`deploy/`, `scripts/`** — рабочее окружение и обслуживание. Скрипты остаются на прежних путях, которые используются в CI и инструкциях обновления.
- **`db/`, `drizzle/`, `worker/`, `build/`** — поддержка дополнительного Sites-контура. В production игровые данные находятся в PostgreSQL; пустой `db/schema.ts` не является схемой основной БД.

## Как сейчас рисуется лес

Карта — `public/world/maps/forest-region-v3.png` (1254 × 1254). Кнопка показывает домашний квадрат `(486,514,256,256)` той же карты. Его детальная текстура `home-detail-v1.png` используется обоими видами с сохранением исходных пикселей по краю. Геометрию задаёт `features/world/map-manifest.ts`.

Дом первого уровня нарисован в фоне. Слоты `house-variants.ts` пока пусты: сохранённые улучшения работают в игровой модели, совместимую графику для них ещё нужно подготовить. Старые атласы не используются. Мохлик, реакция кустика, рыбки, рябь, насекомые, дождь и свет рисуются кодом поверх неизменных текстур.

## Что убрано при уборке

Удалены две ZIP-копии старых версий, неиспользуемая промежуточная карта `forest-world.webp`, стартовая иконка `favicon.svg`, демонстрация заметок D1 и дублирующие скрипты. Их прежнее содержимое осталось в истории Git; историю коммитов не переписывали. Все текущие растровые картинки перенесены без изменения содержимого.

Старые проектные заметки сохранены в `docs/history/`, а исходные художественные концепты — в `docs/game/concepts/`. Они не загружаются игрой.

### Уборка ветки мира, сентябрь 2026

Удалены 47 неиспользуемых UI-компонентов и их `use-mobile`, не подключённый `app/chatgpt-auth.ts`, старые обработчики атласов дома/мастерской и пять прежних изображений. Из package.json и lockfile убраны восемь прямых зависимостей, нужных только удалённому шаблону. Рабочие компоненты диалогов, календаря, уведомлений, админских графиков и их зависимости сохранены. Документы концептов остаются историческими.

Ktor-репозитории активно подключены: пользователь, отметки, отношения/группы, восстановление, игровой прогресс, мир и админка. Миграции, объединение аккаунтов, идемпотентность команд и два контура запуска сохранены. Подробности и дальнейшие задачи: [аудит и развитие мира](game/world-animation-audit.md).
