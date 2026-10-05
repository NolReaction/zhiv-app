# Сервер, API и данные

[Документация](../README.md) · [Архитектура](../architecture.md) · [Локальный запуск](local-development.md)

Настоящий API — Kotlin/Ktor в `apps/api/`, данные — PostgreSQL. `app/api/v1/` — локальная имитация Next/Vinext. На VPS Caddy отправляет `/api/*`, `/healthz`, `/readyz` прямо в Ktor.

Новая экономика V32–V34: [полный контракт, баланс и миграция](../game/economy-foundation.md). `features/economy/` ↔ `ru.zhiv.economy` ↔ `JdbcEconomyRepository`/`JdbcEconomyMarketRepository`; endpoints `/api/v1/economy`, `/commands`, `/market`, `/market/commands`. Каталог v2 задаёт цепочки переработки, зависимости построек и вместимость склада. Старый world API обслуживает гардероб, альбомы и завершение прежних походов; валюту за тапы и мгновенную стройку больше не выдаёт.

## Где искать правило

Пути Ktor ниже относительно `apps/api/src/main/kotlin/ru/zhiv/`.

| Область и основные endpoints | HTTP и правила | Хранение | Контракт клиента |
|---|---|---|---|
| `GET/PATCH /api/v1/me`, calendar, time-zone, status, bootstrap | [identity/IdentityRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/identity/IdentityRoutes.kt), `identity/*` | [db/JdbcZhivRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcZhivRepository.kt), [db/CheckInCalendarQuery.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/CheckInCalendarQuery.kt) | [lib/check-in-contract.ts](../../lib/check-in-contract.ts), [lib/check-in-api.ts](../../lib/check-in-api.ts) |
| `POST /api/v1/check-ins` | [checkins/CheckInRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/checkins/CheckInRoutes.kt), [CheckInRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/checkins/CheckInRepository.kt) | [db/JdbcZhivRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcZhivRepository.kt) | [lib/check-in-api.ts](../../lib/check-in-api.ts) |
| `/people`, `/users/{publicId}`, `/direct-requests` | [relationships/RelationshipRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/relationships/RelationshipRoutes.kt) | [db/JdbcRelationshipRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcRelationshipRepository.kt) | [lib/check-in-api.ts](../../lib/check-in-api.ts) |
| `/groups`, `/group-invites` | [groups/GroupRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/groups/GroupRoutes.kt) | [db/JdbcGroupRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcGroupRepository.kt) | [lib/check-in-api.ts](../../lib/check-in-api.ts) |
| `/direct-invite-links`, preview, redeem | [invites/DirectInviteRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/invites/DirectInviteRoutes.kt) | [db/JdbcDirectInviteRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcDirectInviteRepository.kt) | [lib/check-in-api.ts](../../lib/check-in-api.ts), [lib/invite-import.ts](../../lib/invite-import.ts) |
| `/auth/*`, `/recovery-code` | [auth/AuthRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/auth/AuthRoutes.kt), [recovery/CodeRecoveryRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/recovery/CodeRecoveryRoutes.kt) | [db/JdbcAuthRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcAuthRepository.kt), [JdbcAccountLifecycleRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcAccountLifecycleRepository.kt), [JdbcCodeRecoveryRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcCodeRecoveryRepository.kt) | [lib/auth-api.ts](../../lib/auth-api.ts), [lib/account-lifecycle.ts](../../lib/account-lifecycle.ts) |
| `/game/progress`, sessions, batches, achievements, leaderboard, visibility | [game/GameRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/game/GameRoutes.kt), [GameRewards.kt](../../apps/api/src/main/kotlin/ru/zhiv/game/GameRewards.kt) | [db/JdbcGameRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcGameRepository.kt), [GameAchievementWrites.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/GameAchievementWrites.kt) | [features/game/game-api.ts](../../features/game/game-api.ts) |
| `GET /world`, `POST /world/commands` | [world/WorldRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/world/WorldRoutes.kt), [WorldModel.kt](../../apps/api/src/main/kotlin/ru/zhiv/world/WorldModel.kt) | [db/JdbcWorldRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcWorldRepository.kt) | [features/world/model.ts](../../features/world/model.ts), [api.ts](../../features/world/api.ts) |
| `GET /economy`, `POST /economy/commands`, `GET /economy/market`, `POST /economy/market/commands` | [economy/EconomyRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/economy/EconomyRoutes.kt), [EconomyMarketRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/economy/EconomyMarketRoutes.kt), `EconomyRules.kt` | [db/JdbcEconomyRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcEconomyRepository.kt), [JdbcEconomyMarketRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcEconomyMarketRepository.kt), [JdbcEconomyLifecycle.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcEconomyLifecycle.kt) | [features/economy/model.ts](../../features/economy/model.ts), [api.ts](../../features/economy/api.ts) |
| `GET /world/forest-memory`, `POST /world/forest-memory/commands` | [forest/ForestMemoryRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/forest/ForestMemoryRoutes.kt), [ForestMemory.kt](../../apps/api/src/main/kotlin/ru/zhiv/forest/ForestMemory.kt) | [db/JdbcForestMemoryRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcForestMemoryRepository.kt) | [forest-memory-model.ts](../../features/world/forest-memory-model.ts), [forest-memory-sync.ts](../../features/world/forest-memory-sync.ts) |
| `GET/POST /feedback`, `/admin/feedback` | [feedback/FeedbackRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/feedback/FeedbackRoutes.kt), [FeedbackRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/feedback/FeedbackRepository.kt) | [db/JdbcFeedbackRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcFeedbackRepository.kt) | [features/feedback/feedback-api.ts](../../features/feedback/feedback-api.ts) |
| `/admin/*` | [admin/AdminRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/admin/AdminRoutes.kt), [AdminRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/admin/AdminRepository.kt) | [db/JdbcAdminRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcAdminRepository.kt) | [features/admin/admin-api.ts](../../features/admin/admin-api.ts) |
| `/game-events`, клиентские инциденты, метрики | [game/GameEventRoutes.kt](../../apps/api/src/main/kotlin/ru/zhiv/game/GameEventRoutes.kt), `observability/*` | [UserIncidents.kt](../../apps/api/src/main/kotlin/ru/zhiv/observability/UserIncidents.kt), [db/TapActivityRecorder.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/TapActivityRecorder.kt) | [features/game/game-events.ts](../../features/game/game-events.ts), [lib/client-incidents.ts](../../lib/client-incidents.ts) |

В таблице сокращённые пути относятся к `/api/v1`. Полный набор методов/параметров смотрите в соответствующем `*Routes.kt`; UI-тип не заменяет серверную валидацию.

Точка сборки зависимостей — [Application.kt](../../apps/api/src/main/kotlin/ru/zhiv/Application.kt): конфигурация, JDBC-репозитории, провайдеры входа, rate limits, диагностика и маршруты. Общие DTO — [http/ApiDtos.kt](../../apps/api/src/main/kotlin/ru/zhiv/http/ApiDtos.kt); модели игры/мира также определены в своих пакетах. Общие HTTP-проверки — [http/HttpSupport.kt](../../apps/api/src/main/kotlin/ru/zhiv/http/HttpSupport.kt).

## Изменение API

1. Найдите клиентскую Zod-схему и Kotlin DTO. Определите обязательные поля, ошибки и поведение старого ответа; не добавляйте поле только в React.
2. Реализуйте серверное правило в репозитории/доменной функции. Проверка формы запроса — в маршруте, проверка прав и изменение данных — на сервере.
3. Сохраните защиту записи: сессия, доверенный origin, права пользователя, идемпотентность. Обычные команды используют `Idempotency-Key`; пакеты игры — `sessionId + sequence`, мир — `requestId + expectedRevision`.
4. Обновите `app/api/v1/` и соответствующий `lib/dev/*-store.ts`, если функция поддерживается локально. Реальные OAuth, SMTP и административные права не имитируйте фиктивным успехом.
5. Добавьте контрактный тест, проверку отказа и повторного запроса. Для изменения данных/конкуренции нужна PostgreSQL integration regression.

При таймауте клиент не знает, выполнилась ли запись. Повтор использует исходный идентификатор; новый UUID может повторить покупку или начисление. Для мира конфликт версии требует актуального snapshot, а не локального вычитания ресурсов. Подробно: [синхронизация игры](../game/game-sync-reliability.md).

Ошибки API несут безопасный `code`, сообщение и диагностический request ID. В логах ищите `X-Request-ID`/`requestId`, а не cookie или токены. Обработку `401`, `409`, `429` и `Retry-After` сохраняйте в API-клиентах.

## PostgreSQL и миграции

Источник схемы: `apps/api/src/main/resources/db/migration/`. Текущая последовательность — **V1–V36**.

| Область | Миграции-ориентиры |
|---|---|
| Аккаунты и отметки | V1, V7–V8; история/часовые пояса V19 |
| Приватность, связи, группы | V2–V6, V9, V11, V13–V14, V18 |
| Статусы и восстановление | V10, V12–V13 |
| Авторизация и жизненный цикл аккаунта | V15–V17 |
| Игровой прогресс, достижения, рейтинг | V20–V24 |
| Прежний кошелёк мира, гардероб и поездки | V25 |
| Квитанции, writer permits, инциденты | V26 |
| Модерация и агрегаты тапов | V27 |
| Коллекции и история тапов | V28 |
| Обращения игроков | V29 |
| Начало покрытия истории тапов без доступа runtime к журналу Flyway | V30 |
| Память полянки и квитанции записи | V31 |
| Экономика: кошелёк, предметы, заказы, проводки, однократный перерасчёт | V32 |
| Рынок игроков: резерв товаров, объявления и квитанции | V33 |
| Склад первого уровня и незастроенная печь для существующих/новых экономических профилей | V34 |
| Списание жемчуга за ускорение стройки в журнале экономики | V35 |
| Фиксированные личные витрины рынка игроков | V36 |

Для изменения схемы добавьте следующую `V<N>__description.sql`; применённые файлы не редактируются. Учитывайте существующие строки, constraints, индексы и роли доступа. Проверяйте обновление старой схемы, а не только создание пустой БД.

[db/DatabaseFactory.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/DatabaseFactory.kt) настраивает HikariCP и Flyway; [db/MigrationMain.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/MigrationMain.kt) — отдельный запуск миграций. В Compose сначала выполняются `provision` и `migrate`, затем стартует `api`. Приложение использует ограниченную роль, мигратор — отдельную. [db/schema.ts](../../db/schema.ts) и `npm run db:generate` относятся к заготовке Sites/D1 и **не создают PostgreSQL-миграции приложения**.

Для товаров, рецептов, стройки и исследований источник — [economy-catalog.json](../../apps/api/src/main/resources/world/economy-catalog.json). Старый [catalog.json](../../apps/api/src/main/resources/world/catalog.json) сохраняет ID одежды, находок и совместимость прежних поездок. Оба каталога читают TypeScript и Kotlin, но их версии независимы. Картинка сама не создаёт экономическую награду.

V32 сохраняет исходные три баланса в `economy_conversion_audit`, выдаёт ограниченный запас по замороженной формуле и обнуляет прежний кошелёк. Для аккаунта, впервые открывшего мир после миграции, тот же переход выполняется под блокировкой пользователя. Аудит запрещает повторную конвертацию после административного сброса. Сброс не входит в обновление: выполняются backup и штатные миграции. Подробности и примеры — [экономика](../game/economy-foundation.md#перевод-старых-накоплений).

V34 добавляет отсутствующие `warehouse: 1` и `kiln: 0`, не обнуляя инвентарь, уровень дома или начатые заказы. Награды, цены, сроки и `catalogVersion: 1` старых работ сохраняются; новые работы используют каталог v2. Прежний запас сверх вместимости можно расходовать и продавать, но нельзя увеличивать до освобождения места. `storage` в API вычисляется из уровня склада, всего инвентаря и активного резерва рынка.

При объединении аккаунтов сохраняются кошельки, предметы и максимальные уровни зданий. Активные заказы сначала требуется получить; объявления отменяются с возвратом товара. Общие запасы и резерв должны помещаться в склад максимального из двух уровней: иначе операция полностью отклоняется и предлагает освободить место. Хеш подтверждения учитывает профили экономики, квитанции и объявления. Исходные UUID уже исполненных запросов остаются занятыми. При удалении аккаунта активные объявления закрываются до удаления экономического профиля; квитанция конвертации остаётся у выведенного из обращения UUID.

## Память полянки и экономический прогресс

Это независимые контуры. `/economy` управляет монетами, складом, производством, стройкой, исследованиями и торговлей. `/world` сохраняет гардероб, коллекции, переключение подарков и завершение прежних поездок; уровень дома и мастерской синхронизируется из экономики. `forest-memory` хранит безопасный снимок локальной симуляции: потребности, короткую историю занятий, положение/сон, грибы, рост и влажность ягодного куста, уже принесённые ягоды. Декоративный сбор ягод не начисляет валюту или предметы каталога.

У памяти своя `revision`, аренда записи на 90 секунд и идемпотентный `requestId`. Сервер проверяет владельца, токен аренды, версию и форму снимка; старое устройство после передачи управления не может его перезаписать. Клиент сохраняет примерно раз в 15 секунд активной сессии; при загрузке, потере связи и чужой аренде симуляция ждёт. Полный протокол и сценарии проверки — [память Мохлика](../game/forest-memory-sync.md).

Текущий формат снимка — **v2**, чтение v1 сохраняется. V31 хранит JSONB и не требует новой SQL-миграции для v2. Однако новый web и API выпускаются вместе: старый API не принимает v2, а старый web не читает его после первого сохранения. Откат на старую сборку после появления v2 также требует совместимости. Не очищайте память или БД ради обновления.

Позиции, ID объектов и fingerprint карты влияют на восстановление пространственной части; смена фона не является основанием сбрасывать потребности и ягоды. У декоративной полянки нет серверной фоновой симуляции, роста за время отсутствия или сохранения каждого кадра анимации. Экономические заказы, напротив, заканчиваются по сохранённому серверному времени и ждут команды получения результата. Изменение контракта проверяйте в браузере, локальной имитации и Ktor, включая merge/delete/recovery аккаунтов.

## Рецепты изменения игровых правил

### Добавить вещь в гардероб

1. Добавьте уникальный `id` в `catalog.json → items`: `name`, `slot`, `color`, `sparks`, `starter`. Поддерживаются слоты `palette`, `head`, `neck`, `rod`; новое имя слота требует изменений `WorldEquipment`, `worldStateSchema` и обработчика `equip` в обоих серверах.
2. `sparks` сохраняется для чтения прежнего каталога: крафт за искры закрыт. Для новой одежды нужен отдельный источник выдачи; сейчас доступны коллекционные награды и административная выдача. Новая экономика производит складские товары, её рецепт сам по себе не выдаёт одежду. Стартовый набор уже созданных аккаунтов не меняется от нового флага `starter`; начальные значения заданы в `newWorldState()` и Kotlin `WorldState`.
3. Добавьте реальный внешний вид: `features/mochlik/pixel-sprite.ts → pixelSprite()` содержит палитры, шарфы и шапки; удочки — [features/world/fishing-tackle.ts](../../features/world/fishing-tackle.ts). Одного `color` в каталоге хватает для значка гардероба, но не нового рисунка персонажа.
4. Проверьте выдачу и повтор без дублирования, надевание и снятие, вид спереди/сзади, круг и карту. Регрессии: [tests/world.test.mjs](../../tests/world.test.mjs), [mochlik-sprite.test.mjs](../../tests/mochlik-sprite.test.mjs), Ktor `WorldRulesTest` и `JdbcWorldRepositoryIntegrationTest`.

### Добавить находку или награду за коллекцию

1. В `catalog.json → finds` задайте `id`, `name`, `description`, `symbol`, `group` и явный источник выдачи. Старые маршруты больше не запускаются; изменение `routes[].finds` не добавит новую находку в уже сохранённое путешествие. Связь новых исследований с альбомом пока не реализована. Для нового символа обновите `findIcons` в [world-view.tsx](../../features/world/world-view.tsx), иначе используется лист.
2. Для новой группы обновите группировку панелей [world-view.tsx](../../features/world/world-view.tsx) и обе функции `collectionRewards`: [features/world/model.ts](../../features/world/model.ts) и Ktor [WorldModel.kt](../../apps/api/src/main/kotlin/ru/zhiv/world/WorldModel.kt). Сейчас явно сопоставлены `forest → explorer_cap`, `fishing → willow_rod`.
3. При изменении полного числа находок согласуйте цель `full_collection` в `GAME_ACHIEVEMENTS`, [game-api.ts](../../features/game/game-api.ts) (проверка `target`), Ktor `GameRewards.achievements` и локальном расчёте достижений. Решите судьбу уже выданной награды; не отзывайте её случайно пересчётом.
4. Проверьте выдачу недостающей находки, повтор `claim_journey`, завершение группы, старую коллекцию и недействительные ID: [tests/world.test.mjs](../../tests/world.test.mjs), [game-achievements.test.mjs](../../tests/game-achievements.test.mjs), Ktor `JdbcWorldRepositoryIntegrationTest`.

### Изменить производство, стройку или исследование

- Общий каталог: `economy-catalog.json → items`, `buildings[].levels`, `recipes`, `explorations`, `market`. Цена `cost` содержит монеты и карту количества предметов; длительность задаётся в секундах. Стройка требует и монеты, и материалы, занимает единственную очередь; активное производство в этом здании надо сначала получить.
- `EconomyRules.apply` и `features/economy/rules.ts` должны одинаково проверять доступ, расход, занятость и награду. В запросе только действие и параметры выбора; клиент не присылает новую сумму кошелька, результат или время окончания. `requestId`/владелец/версия защищают повтор и две вкладки.
- Заказ сохраняет стоимость, выход, целевой уровень и сроки на момент старта. Изменение каталога не пересчитывает уже оплаченные работы. `claim_job` применяет результат один раз, в том числе после офлайна. Открытие страницы само награду не выдаёт.
- Рынок использует те же товары: `tradable`, цена выкупа, максимум партии/объявлений и ценовой коридор. Публикация резервирует товар, покупка переносит монеты и предметы между игроками одной транзакцией. Не реализуйте покупку двумя независимыми запросами.
- Старый `/world/commands` принимает `equip`, `set_decoration`, `claim_journey`, `recall_journey`. Запуск прежнего маршрута, мгновенная стройка и крафт возвращают `WORLD_ECONOMY_MOVED`. Старый `grant_resource` администратора возвращает `ADMIN_RESOURCE_RETIRED`. Тапы сохраняют игровой счёт, но валюту больше не начисляют.
- Для нового здания/перехода нужна отдельная графическая интеграция в Tiled. Подтверждённые уровни из `economyBuildings` выбирают рисунок и всю геометрию совпадающих `siteId`, сейчас это `home`, `workshop` и `quarry`. Если точного рисунка нет, берётся ближайший доступный младший уровень; экономический прогресс при этом не уменьшается. Карточки хозяйства остаются источником требований, таймеров и команд, DEV меняет только внешний вид. [Правила выбора и разметки](../game/building-workbench.md).
- Проверки: достижимость рецептов с нулевого старта, достаточность материалов, граница таймера, повтор, конкуренция двух покупателей, возврат резерва, ограничения слияния, сохранённые поездки. Ktor: `EconomyRulesTest`, `JdbcEconomyRepositoryIntegrationTest`, `JdbcEconomyMarketRepositoryIntegrationTest`, `JdbcAccountLifecycleIntegrationTest`; web: `tests/economy*.test.mjs` и [tests/world.test.mjs](../../tests/world.test.mjs).

### Изменить уровни или добавить достижение

- Уровни: `features/game/clicker-story.ts → CLICKER_LEVELS`, `getClickerLevel()`, `CLICKER_ICON_LEVELS`; значки — [game-level-icon.tsx](../../features/game/game-level-icon.tsx). Основа — подтверждённые `lifetimeTaps`, отдельного XP нет. Проверьте точный порог, значение перед ним и верхнюю границу; начисления тапов менять не требуется.
- Достижение: `features/game/game-rewards.ts → GAME_ACHIEVEMENTS`; в [game-api.ts](../../features/game/game-api.ts) обновите enum ID, цели и допустимый размер/состав ответа. Добавьте иконку в `public/achievements/` с учётом пути в [achievement-medal.tsx](../../features/game/achievement-medal.tsx).
- Сервер: [game/GameRewards.kt](../../apps/api/src/main/kotlin/ru/zhiv/game/GameRewards.kt), расчёт/запись в [db/GameAchievementWrites.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/GameAchievementWrites.kt) и [db/JdbcGameRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcGameRepository.kt); локально — [lib/dev/api-store.ts](../../lib/dev/api-store.ts). Проверьте allowlist выдачи и клиентские схемы в админке. Для нового ID нужна новая миграция CHECK-ограничений `game_achievements` и `admin_actions` (образец — V28), старую V28 не редактируйте.
- Дата выдачи сохраняется, повтор не создаёт новую награду. Проверьте чтение старым каталогом, выдачу, повтор, слияние аккаунтов и административную выдачу: [tests/game-achievements.test.mjs](../../tests/game-achievements.test.mjs), [admin-api.test.mjs](../../tests/admin-api.test.mjs), Ktor `JdbcGameRepositoryIntegrationTest`, `JdbcAdminRepositoryIntegrationTest`.

## Локальная имитация

| Файл | Обязанность |
|---|---|
| [lib/dev/api-store.ts](../../lib/dev/api-store.ts) | Тестовые аккаунты, отметки, связи, группы, статусы |
| [lib/dev/game-store.ts](../../lib/dev/game-store.ts), [game-validation.ts](../../lib/dev/game-validation.ts) | Игровые разрешения, пакеты и прогресс |
| [lib/dev/world-store.ts](../../lib/dev/world-store.ts) | Гардероб/коллекции, завершение прежних поездок, синхронизация уровня дома |
| [lib/dev/economy-store.ts](../../lib/dev/economy-store.ts), [economy-route.ts](../../lib/dev/economy-route.ts) | Кошелёк, склад, таймеры, стройка, торговля и повтор запросов |
| [lib/dev/forest-memory-store.ts](../../lib/dev/forest-memory-store.ts), [forest-memory-state.ts](../../lib/dev/forest-memory-state.ts), [forest-memory-route.ts](../../lib/dev/forest-memory-route.ts) | Снимки полянки, аренда, повторы и строгая проверка HTTP |
| [lib/dev/feedback-store.ts](../../lib/dev/feedback-store.ts) | Обращения, суточный лимит и квитанции |
| [lib/dev/api-guard.ts](../../lib/dev/api-guard.ts), [api-origin.ts](../../lib/dev/api-origin.ts), [api-route.ts](../../lib/dev/api-route.ts) | Режим запуска, origin, JSON, cookie, ключи записи |

Память процесса теряется после перезапуска и не разделяется между экземплярами сервера. Сохранённая браузером cookie после перезапуска не восстанавливает аккаунт. Production-запуск без Ktor всегда вернёт `DEV_API_DISABLED`, даже при `ENABLE_DEV_API=true`. Имитация доступна только в `development`/`test` и не предназначена для реальных пользовательских данных.

## Тесты и диагностика

- Ktor contracts: [apps/api/src/test/kotlin/ru/zhiv/ApiContractTest.kt](../../apps/api/src/test/kotlin/ru/zhiv/ApiContractTest.kt), [GameEventRoutesTest.kt](../../apps/api/src/test/kotlin/ru/zhiv/GameEventRoutesTest.kt), чистые тесты соответствующего пакета.
- PostgreSQL: `apps/api/src/test/kotlin/ru/zhiv/db/Jdbc*IntegrationTest.kt`; нужны Docker/Testcontainers. CI отклоняет пропущенные ключевые integration suites.
- Web: `tests/*-domain.test.mjs`, `game-*.test.mjs`, `world*.test.mjs`; порядок запуска — [проверки](local-development.md#проверки).
- Техническая готовность: `/healthz` и `/readyz`. Метрики доступны внутри инфраструктуры; Caddy закрывает публичные `/internal/*` и `/metrics`.

Настройки сервера: [config/AppConfig.kt](../../apps/api/src/main/kotlin/ru/zhiv/config/AppConfig.kt), [auth/AuthConfig.kt](../../apps/api/src/main/kotlin/ru/zhiv/auth/AuthConfig.kt), безопасный образец `deploy/.env.example`. Авторизация — [инструкция](../operations/auth-0.5.0.md); админские права — [админка](../operations/admin-panel.md); расследование — [инциденты](../operations/incident-response.md), [диагностика API](../../apps/api/DIAGNOSTICS.md).

Запуск/обновление/backup находятся в [эксплуатации](../operations/operations.md) и [VPS](../operations/vps.md). Сброс — отдельные явные процедуры: [пользовательские данные](../operations/reset-user-data.md), [база целиком](../operations/reset-database.md). Они не являются шагом обычной разработки.
