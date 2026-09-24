# Где менять код

Для ручной работы в редакторе начните с [памятки Tiled: слои и конкретные действия](game/tiled-quickstart.md).

Ищите задачу в таблице и открывайте указанный файл. Подробности изменения и проверки — в последнем столбце. Пути ниже относятся к текущей Tiled-карте; прежний рендер отделён в конце.

## Карта, свет и анимации

| Задача | Главные файлы | Как менять и проверять |
|---|---|---|
| Расставить фонари и факелы | [`forest.tmj`](../world/tiled/forest.tmj), слой `Lights` | [Освещение](game/world-lighting.md) |
| Изменить ночной цвет, световое пятно, пламя, мерцание | [`forest-lighting.ts`](../features/world/forest-lighting.ts) | [Освещение](game/world-lighting.md) |
| Изменить расписание дня/ночи | [`lighting.ts`](../features/mochlik/lighting.ts), переход в [`new-map-scene.ts`](../features/world/new-map-scene.ts) | [Освещение](game/world-lighting.md) |
| Изменить погоду и общие параметры окружения | [`forest-atmosphere.ts`](../features/world/forest-atmosphere.ts) | [Атмосфера](game/world-atmosphere.md) |
| Доработать падающие капли и попадания в реку | [`forest-rain.ts`](../features/world/forest-rain.ts), [`forest-water.ts`](../features/world/forest-water.ts) | [Дождь и вода](game/world-atmosphere.md) |
| Изменить границы реки и исключить листья, камни, причал | [`forest.tmj`](../world/tiled/forest.tmj): `Water`, `WaterExclusions` | [Разметка Tiled](game/tiled-editor.md) |
| Изменить попадания на землю и существующие лужи | [`forest-ground-impacts.ts`](../features/world/forest-ground-impacts.ts), [`forest-ground-layout.json`](../features/world/forest-ground-layout.json), [`forest-ground-weather.ts`](../features/world/forest-ground-weather.ts) | [Атмосфера](game/world-atmosphere.md) |
| Добавить вид птиц, стаю, маршрут или посадку | [`forest-birds.ts`](../features/world/forest-birds.ts) | [Птицы и привязка к фону](game/world-atmosphere.md) |
| Изменить жизнь бабочек/светлячков, отдых и встречу | [`forest-fauna.ts`](../features/world/forest-fauna.ts), [`hero-anchors.ts`](../features/world/hero-anchors.ts); рисунок — [`forest-wildlife.ts`](../features/world/forest-wildlife.ts) | [Атмосфера](game/world-atmosphere.md) |
| Изменить вычитание полянки и обход её насекомыми | [`forest-habitats.ts`](../features/world/forest-habitats.ts); `excludeHabitatId` в Habitats | [Исключения территорий](game/tiled-editor.md#территории-и-посадки-насекомых) |
| Разметить территории и посадки насекомых | `Habitats`, `WildlifeAnchors` в [`forest.tmj`](../world/tiled/forest.tmj) | [Посадки в Tiled](game/tiled-editor.md#территории-и-посадки-насекомых) |
| Изменить реакцию сидящих птиц на шаги/куст | [`forest-bird-reactions.ts`](../features/world/forest-bird-reactions.ts), события в [`forest-director.ts`](../features/world/forest-director.ts) | [Атмосфера](game/world-atmosphere.md) |
| Расставить грибы в Tiled, изменить их рост и общие часы | `Mushrooms` в `world/tiled/forest.tmj`, [`forest-life.ts`](../features/world/forest-life.ts), [`forest-life-painter.ts`](../features/world/forest-life-painter.ts), [`forest-session.ts`](../features/world/forest-session.ts) | [Устройство мира](game/world-foundation.md) |
| Изменить проходимость и поиск пути | [`navigation.ts`](../features/world/navigation.ts); `WalkAreas`, `Obstacles`, `PointsOfInterest` в [`forest.tmj`](../world/tiled/forest.tmj) | [Поиск пути: алгоритм, границы, диагностика](game/world-navigation.md) |
| Изменить выбор занятия, подход к предмету и прерывание | [`forest-director.ts`](../features/world/forest-director.ts), [`forest-behavior.ts`](../features/world/forest-behavior.ts) | [Устройство мира](game/world-foundation.md) |
| Изменить подход к дому/кусту и точный переход | [`interaction-navigation.ts`](../features/world/interaction-navigation.ts); `Buildings`, `Bushes` в Tiled | [Поиск пути и входы](game/world-navigation.md) |
| Изменить исполнение ходьбы, прятки, пробуждение и сон | [`clearing-activity.ts`](../features/world/clearing-activity.ts); `Routes` — только для прежнего режима | [Устройство мира](game/world-foundation.md#прерывания-и-сон-в-домике) |
| Изменить порядок слоёв и работу двух камер | [`new-map-scene.ts`](../features/world/new-map-scene.ts), [`map-engine.ts`](../features/world/map-engine.ts), [`world-scene.tsx`](../features/world/world-scene.tsx) | [Устройство мира](game/world-foundation.md) |
| Исправить масштаб, перетаскивание и границы камеры | [`camera.ts`](../features/world/camera.ts), [`map-engine.ts`](../features/world/map-engine.ts) | [Устройство мира](game/world-foundation.md) |
| Перенести героя, дом или круглую камеру | [`forest.tmj`](../world/tiled/forest.tmj): `Actors`, `Buildings`, `Clearing focus` | [Разметка Tiled](game/tiled-editor.md) |
| Заменить рисунок мира или дома | [`art/world/prototype/`](../art/world/prototype/), [`public/world/prototype/`](../public/world/prototype/) | [Исходники и экспорт](../art/README.md) |
| Изменить программный спрайт Мохлика и его контактную тень | [`pixel-sprite.ts`](../features/mochlik/pixel-sprite.ts), [`grounding.ts`](../features/world/grounding.ts) | [Устройство мира](game/world-foundation.md) |
| Изменить экспорт Tiled и валидацию свойств | [`scripts/lib/tiled-world.mjs`](../scripts/lib/tiled-world.mjs), [`types.ts`](../features/world/tiled/types.ts), [`scripts/tiled-world.mjs`](../scripts/tiled-world.mjs) | [Разметка Tiled](game/tiled-editor.md) |
| Доработать страницу проверки без аккаунта | [`tiled-world-preview.tsx`](../features/world/tiled/tiled-world-preview.tsx), [`renderer.ts`](../features/world/tiled/renderer.ts) | [Разметка Tiled](game/tiled-editor.md) |
| Добавить управление эффектом или диагностику в DEV | [`world-dev-panel.tsx`](../features/world/dev/world-dev-panel.tsx), [`world-dev-store.ts`](../features/world/dev/world-dev-store.ts), [`living-world-debug.ts`](../features/world/living-world-debug.ts) | [Атмосфера](game/world-atmosphere.md) |

`features/world/tiled/forest.generated.json` — результат `npm run world:export`, его не редактируют вручную. Проверка соответствия: `npm run world:check`.

Реализованная локальная основа, её инварианты и дальнейшие границы: [живой лес](game/living-world-plan.md). Экспортёр поддерживает свободную полянку и территории; сеть дальних переходов и новые путешествия остаются отдельным этапом.

## Интерфейс и правила игры

| Задача | Главные файлы | Инструкция |
|---|---|---|
| Кнопки над картой, коллекции, гардероб, игровые панели | [`world-view.tsx`](../features/world/world-view.tsx), [`world.module.css`](../features/world/world.module.css) | [Устройство мира](game/world-foundation.md) |
| Тексты игровой справки | [`world-help-content.ts`](../features/world/world-help-content.ts) | Правило редактирования ниже |
| Поиск, раскрываемые темы и оформление справки | [`world-help.tsx`](../features/world/world-help.tsx), [`world-help.module.css`](../features/world/world-help.module.css) | Проверка ниже |
| Включить перенесённые возможности новой карты | [`presentation.ts`](../features/world/presentation.ts) | [Текущие ограничения мира](game/world-foundation.md); смена флага не переносит старую геометрию |
| Переход между главным экраном и миром | [`world-portal.tsx`](../features/world/world-portal.tsx), [`use-world-portal.ts`](../features/world/use-world-portal.ts) | [Устройство мира](game/world-foundation.md) |
| Меню поездок, подтверждение наград, отображение пути | [`world-journeys.tsx`](../features/world/world-journeys.tsx), [`journey-progress.tsx`](../features/world/journey-progress.tsx) | [Правила и данные](development/backend-and-data.md), [рыбалка](game/fishing.md) |
| Цены, ресурсы, одежда, коллекции и длительности | [`catalog.json`](../apps/api/src/main/resources/world/catalog.json), [`model.ts`](../features/world/model.ts), [`WorldModel.kt`](../apps/api/src/main/kotlin/ru/zhiv/world/WorldModel.kt) | [Правила и данные](development/backend-and-data.md) |
| Игровые команды, повторы запросов и сохранение | [`session.ts`](../features/world/session.ts), [`api.ts`](../features/world/api.ts), [`use-world.ts`](../features/world/use-world.ts) | [Правила и данные](development/backend-and-data.md) |
| Уровни, достижения, рейтинг и искры от тапов | [`features/game/`](../features/game/), [`GameRewards.kt`](../apps/api/src/main/kotlin/ru/zhiv/game/GameRewards.kt) | [Правила и данные](development/backend-and-data.md) |
| Группы уровней, полоса прогресса и заблокированные значки | [`game-levels-button.tsx`](../features/game/game-levels-button.tsx), [`game-levels.module.css`](../features/game/game-levels.module.css) | [Меню уровней](development/updates-and-levels.md#как-устроено-меню-уровней) |
| Потерянные тапы, несколько вкладок, смена аккаунта | [`use-game-progress.ts`](../features/game/use-game-progress.ts), [`game-sync.ts`](../features/game/game-sync.ts), [`game-sync-journal.ts`](../features/game/game-sync-journal.ts) | [Синхронизация](game/game-sync-reliability.md) |
| Картинка достижения | [`public/achievements/`](../public/achievements/) | [Каталог медалей](../public/achievements/README.md) |

**Как поддерживать справку.** Добавляйте короткий ответ в `world-help-content.ts`, а не в JSX панели. Числа берите из каталога/правил, доступность — из `WORLD_PRESENTATION`. Отличайте существующую механику от доступной сейчас кнопки. Пользователю нужны действия и последствия; пути исходников и команды запуска остаются в `docs/`.

Проверьте: ⓘ рядом с коллекциями → открытие темы → поиск по тексту → отсутствие результатов → очистка поиска → закрытие и возврат фокуса на ⓘ. Убедитесь, что панель прокручивается на телефоне шириной 320 px и работает клавиатурой. Тесты справки: [`tests/world-help.test.mjs`](../tests/world-help.test.mjs).

## Приложение и сервер

| Задача | Главные файлы | Инструкция |
|---|---|---|
| Главный экран, отправка отметки, статус | [`features/check-in/`](../features/check-in/), [`check-in-api.ts`](../lib/check-in-api.ts) | [Разделы приложения](development/app-features.md) |
| Новости версий, сотрудничество и счётчик beta-test | [`updates.json`](../public/updates.json), [`beta-info.tsx`](../features/check-in/beta-info.tsx), [`features/updates/`](../features/updates/) | [Публикация обновления](development/updates-and-levels.md) |
| Обращения игроков и суточный лимит | [`features/feedback/`](../features/feedback/), [`feedback/`](../apps/api/src/main/kotlin/ru/zhiv/feedback/), [`JdbcFeedbackRepository.kt`](../apps/api/src/main/kotlin/ru/zhiv/db/JdbcFeedbackRepository.kt) | [Обратная связь](development/feedback.md) |
| Техработы, версия открытого клиента и принудительное обновление | [`features/updates/`](../features/updates/), [`deploy-update.sh`](../scripts/deploy-update.sh), [`app-build.mjs`](../scripts/app-build.mjs) | [Обновление клиента](operations/client-updates.md) |
| Календарь, серия отметок, часовой пояс | [`check-in-calendar.tsx`](../features/check-in/check-in-calendar.tsx), [`daily-streak.ts`](../lib/daily-streak.ts), [`time-zone.ts`](../lib/time-zone.ts) | [Разделы приложения](development/app-features.md) |
| Люди, группы, приглашения, прозвища и приватность | [`features/people/`](../features/people/), [`check-in-contract.ts`](../lib/check-in-contract.ts) | [Разделы приложения](development/app-features.md) |
| Вход, профиль, сеансы, резервный код | [`features/account/`](../features/account/), [`auth-api.ts`](../lib/auth-api.ts), [`auth/`](../apps/api/src/main/kotlin/ru/zhiv/auth/) | [Разделы приложения](development/app-features.md) |
| Страницы, глобальные стили, установка PWA | [`app/`](../app/), [`components/`](../components/) | [Разделы приложения](development/app-features.md) |
| Контракты, эндпоинт, транзакция или миграция | [`apps/api/src/main/kotlin/ru/zhiv/`](../apps/api/src/main/kotlin/ru/zhiv/), [`migration/`](../apps/api/src/main/resources/db/migration/) | [Backend и данные](development/backend-and-data.md) |
| Поведение API при локальной разработке | [`lib/dev/`](../lib/dev/), [`app/api/`](../app/api/) | [Локальный запуск](development/local-development.md) |
| Админские действия, выдачи, аудит и доступ | [`features/admin/`](../features/admin/), [`admin/`](../apps/api/src/main/kotlin/ru/zhiv/admin/) | [Админка](operations/admin-panel.md), [модерация](operations/player-moderation.md) |
| Сборки, CI, контейнеры, бэкапы и диагностика | [`package.json`](../package.json), [`scripts/`](../scripts/), [`deploy/`](../deploy/) | [Проверки](development/local-development.md), [эксплуатация](operations/operations.md) |

Правила, меняющие данные, проверяются сервером. Изменение цены или условия только в интерфейсе недостаточно: сверяйте каталог, Ktor и локальный API. Постоянная схема находится в миграциях Ktor; `db/`, `drizzle/`, `worker/` и `build/` обслуживают Sites.

## Прежний рендер

`features/mochlik/home-layout.ts`, `lantern-light.ts` и `features/world/route-props.ts`, `water-ambience.ts`, `bird-ambience.ts`, `weather-visitors.ts`, `map-layout.ts` относятся к прежней карте. Они сохранены для совместимости и последующего переноса. **Новый свет — в `forest-lighting.ts`, новый дождь — в `forest-rain.ts`.** Общие модули Мохлика продолжают использоваться: `pixel-sprite.ts` рисует героя, `lighting.ts` задаёт расписание ночи, а `scene.ts` выбирает текущий рендер.

История решений и отчёты — в [индексе документации](README.md#история-и-материалы); актуальный этап — в [WORK_STATE.md](../WORK_STATE.md).
