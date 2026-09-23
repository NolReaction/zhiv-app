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
| Карту или детали здания | [art/README.md](../art/README.md): PNG для редактирования и соответствующие WebP |
| Фон, здания, круглая камера, положение и размер Мохлика | [world/tiled/forest.tmj](../world/tiled/forest.tmj), [инструкция Tiled](game/tiled-editor.md); экспорт — `features/world/tiled/forest.generated.json` |
| Быстро проверить изменения Tiled | `npm run world:watch` и `/prototype/tiled-world`; линии проверяются в предпросмотре, игровые походы пока отключены |
| Бабочек, светлячков, птиц и погоду новой карты | `features/world/forest-atmosphere.ts`; птицы и точки посадки — `forest-birds.ts`, капли и водные всплески — `forest-rain.ts`, попадания на землю — `forest-ground-impacts.ts`, лужи — `forest-ground-weather.ts`, река — `forest-water.ts`, границы — `Water`/`WaterExclusions` в Tiled; часы и паузы — `new-map-scene.ts` |
| Панель DEV и ручной запуск эффектов | [features/world/dev/world-dev-panel.tsx](../features/world/dev/world-dev-panel.tsx); временные настройки — `world-dev-store.ts`. Кнопка DEV в круге и большой карте при `npm run dev:local` / `dev:lan` |
| Контактную тень Мохлика и основания зданий | [features/world/grounding.ts](../features/world/grounding.ts); геометрия и размеры по-прежнему задаются в Tiled |
| Старые метки и области нажатия (сейчас отключены) | [features/world/map-layout.ts](../features/world/map-layout.ts) |
| Вход в дом и положение фонаря | [features/mochlik/home-layout.ts](../features/mochlik/home-layout.ts) |
| Камеру, перетаскивание и масштаб карты | [features/world/camera.ts](../features/world/camera.ts), `map-engine.ts` |
| Эффект входа в лес | [features/world/world-portal.tsx](../features/world/world-portal.tsx), `use-world-portal.ts`, `world.module.css` |
| Кнопки поверх карты, постройки и гардероб | [features/world/world-view.tsx](../features/world/world-view.tsx), `world-scene.tsx` |
| Меню путешествий и анимацию маршрута | [world-journeys.tsx](../features/world/world-journeys.tsx), [journey-progress.tsx](../features/world/journey-progress.tsx) |
| Внешность Мохлика | [features/mochlik/pixel-sprite.ts](../features/mochlik/pixel-sprite.ts) |
| Занятия Мохлика, рост и поедание грибов на новой карте | `features/world/forest-life.ts`, `forest-life-painter.ts`; общее состояние двух камер — `forest-session.ts` |
| Реакции кустика и листьев | [features/mochlik/bush-reaction.ts](../features/mochlik/bush-reaction.ts) |
| Факелы и камни на тропинках | [features/world/route-props.ts](../features/world/route-props.ts) |
| Рыбки, всплески и дождевые кольца реки | [features/world/water-ambience.ts](../features/world/water-ambience.ts) |
| Птицы и разбитая лодка | `features/world/bird-ambience.ts`, `features/world/boat-wreck.ts` |
| Редкие животные по погоде | `features/world/weather-visitors.ts` |
| Ночь, лунный свет и фонарь | [features/mochlik/lighting.ts](../features/mochlik/lighting.ts), `lantern-light.ts`, `lantern-glass.ts`, `scene.ts` |
| Цены зданий, длительность походов, коллекции | [Единый каталог мира](../apps/api/src/main/resources/world/catalog.json) |
| Админку, сообщения о сбоях и награды | [features/admin/](../features/admin/), [серверные обработчики](../apps/api/src/main/kotlin/ru/zhiv/admin/) |
| Локальный API для тестирования | [lib/dev/](../lib/dev/) |
| Реальный сервер и сохранение данных | [apps/api/src/main/kotlin/ru/zhiv/](../apps/api/src/main/kotlin/ru/zhiv/) |
| Таблицы и миграции БД | [apps/api/src/main/resources/db/migration/](../apps/api/src/main/resources/db/migration/) |

Изменение текста достижения на клиенте не меняет правила его выдачи сервером. Они находятся в `apps/api/src/main/kotlin/ru/zhiv/game/GameRewards.kt` и `db/GameAchievementWrites.kt`; локальный аналог — `lib/dev/api-store.ts` и `lib/dev/game-store.ts`. Проверяйте обе стороны, если меняете условие, а не оформление.

## Как устроены папки

- **`features/`** — прикладные разделы. Здесь компонент, его стиль, состояние и относящиеся к разделу функции. `mochlik/` управляет героем, `world/` — картой и игровыми панелями, `game/` — тапами и прогрессом.
- **`art/`** — редактируемые PNG: новая единая карта в `world/prototype`, сохранённый исходник лодки в `world/main`. Браузер эти исходники не получает.
- **`public/`** — файлы, которые браузер получает как есть. `public/achievements/linked_email.svg` доступен по URL `/achievements/linked_email.svg`.
- **`lib/`** — общие контракты, сеть, дата/время, приватность и функции, нужные разным разделам. `lib/dev/` имитирует API только для разработки.
- **`components/`** — общие уведомления, индикаторы свежести, переключатели и общие стили. `components/ui/` — установленная библиотека элементов интерфейса.
- **`app/`** — входные страницы и API-маршруты фреймворка. Их размещение диктует Next.js.
- **`apps/api/`** — настоящий Ktor-сервер, доступ к PostgreSQL и серверные тесты.
- **`tests/`** — веб-тесты. Префиксы `world-`, `mochlik-`, `game-` помогают найти нужные проверки.
- **`deploy/`, `scripts/`** — рабочее окружение и обслуживание. Скрипты остаются на прежних путях, которые используются в CI и инструкциях обновления.
- **`db/`, `drizzle/`, `worker/`, `build/`** — поддержка дополнительного Sites-контура. В production игровые данные находятся в PostgreSQL; пустой `db/schema.ts` не является схемой основной БД.

## Как сейчас рисуется лес

Карта — `art/world/prototype/forest-ground.png` (2560 × 2560). Её полный WebP без потерь используется большой картой и круглой камерой. Сейчас логический мир 1254 × 1254; его границы, фон, квадрат камеры и точка Мохлика с размером берутся из Tiled. Разрешение изображения не меняет координаты. `features/world/presentation.ts` читает экспорт и задаёт текущий режим чистой карты; `new-map-scene.ts` рисует её общим с прототипом композитором. Добавленные здания показываются в начальном состоянии, без включения покупок и прогресса улучшений.

Новая атмосфера задаётся в `forest-atmosphere.ts`: дневные бабочки, вечерние светлячки, редкие птицы, медленная смена облачности и лёгкой мороси. Круг и большая карта используют общий отсчёт и координаты мира; фоновые вкладки останавливают анимацию, reduced motion оставляет статичную сцену. Мохлик делает жесты на месте, играет с бабочками/светлячками и собирает выросшие рядом грибы. Лужицы около точки появления постепенно растут во время дождя и высыхают; у них влажный край, отражения и расходящиеся круги. На реке видны блики течения, удары капель и двойные круги; безопасные точки проверяются по полному размеру эффекта, исключая камни, причал и растительность. Попадания распределены по участкам обоих рукавов и меняют место после затухания. На открытой земле — отдельные короткие брызги без колец; проверенные участки заданы в `forest-ground-layout.json`, поверх них исключаются текущая вода, здания и грибы. Четыре вида птиц чередуют шесть сценариев с одиночками, парами и стаями до пяти особей. Все прилетают из-за края карты, чередуют махи и планирование; в сценариях с посадкой осматриваются, чистят перья, подпрыгивают и снова взлетают. Каждое нажатие DEV выбирает следующий сценарий через общий счётчик двух камер. Маска воды берётся из `Water` и всей вложенной группы `WaterExclusions` в Tiled; `world:watch` обновляет её вместе со сценой. При изменении берега нужно сверить контуры в редакторе. Точки посадки птиц и участки дождя на земле проверены для версии фона `fedcfbd622df`: при замене изображения нужно сверить `forest-birds.ts` и `forest-ground-layout.json`, иначе привязанные эффекты отключаются. Лужи ограничены свободной площадкой возле Мохлика, пока остальные поверхности не размечены. Грибы, влажность и часы общие для круга и большой карты в пределах сеанса, обновляет только активная камера. Пауза, фоновая вкладка и reduced motion останавливают развитие окружения. `grounding.ts` выравнивает ступни и рисует слабые контактные тени; смена изображения уровня здания получает свою маску, без правок исходника.

Прежние постройки, метки и эффекты со старыми координатами не отображаются. Их модули и сохранённый игровой прогресс остаются в проекте для следующих этапов, но ещё не привязаны к новой карте. Источники и порядок экспорта описаны в [каталоге изображений](../art/README.md).

## Что убрано при уборке

Удалены две ZIP-копии старых версий, неиспользуемая промежуточная карта `forest-world.webp`, стартовая иконка `favicon.svg`, демонстрация заметок D1 и дублирующие скрипты. Их прежнее содержимое осталось в истории Git; историю коммитов не переписывали. Все текущие растровые картинки перенесены без изменения содержимого.

Старые проектные заметки, прежние релизы и завершённые отчёты сохранены в [архиве Git на коммите 5a117b2](https://github.com/NolReaction/zhiv-app/tree/5a117b2c233874a0362cdad11fef6a0308e622ff/docs). В рабочем дереве остаются текущий релиз и [инструкция восстановления старого checkout VPS](history/vps-history-repair-0.5.1.md). Исходные художественные концепты находятся в `docs/game/concepts/` и не загружаются игрой.

### Уборка ветки мира, сентябрь 2026

Удалены 47 неиспользуемых UI-компонентов и их `use-mobile`, не подключённый `app/chatgpt-auth.ts`, старые обработчики атласов дома/мастерской и пять прежних изображений. Из package.json и lockfile убраны восемь прямых зависимостей, нужных только удалённому шаблону. Рабочие компоненты диалогов, календаря, уведомлений, админских графиков и их зависимости сохранены. Документы концептов остаются историческими.

Ktor-репозитории активно подключены: пользователь, отметки, отношения/группы, восстановление, игровой прогресс, мир и админка. Миграции, объединение аккаунтов, идемпотентность команд и два контура запуска сохранены. Подробности и дальнейшие задачи: [аудит и развитие мира](game/world-animation-audit.md).
