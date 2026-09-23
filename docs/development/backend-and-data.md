# Сервер, API и данные

[Документация](../README.md) · [Архитектура](../architecture.md) · [Локальный запуск](local-development.md)

Настоящий API — Kotlin/Ktor в `apps/api/`, данные — PostgreSQL. `app/api/v1/` — локальная имитация Next/Vinext. На VPS Caddy отправляет `/api/*`, `/healthz`, `/readyz` прямо в Ktor.

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

Источник схемы: `apps/api/src/main/resources/db/migration/`. Текущая последовательность — V1–V28.

| Область | Миграции-ориентиры |
|---|---|
| Аккаунты и отметки | V1, V7–V8; история/часовые пояса V19 |
| Приватность, связи, группы | V2–V6, V9, V11, V13–V14, V18 |
| Статусы и восстановление | V10, V12–V13 |
| Авторизация и жизненный цикл аккаунта | V15–V17 |
| Игровой прогресс, достижения, рейтинг | V20–V24 |
| Экономика мира | V25 |
| Квитанции, writer permits, инциденты | V26 |
| Модерация и агрегаты тапов | V27 |
| Коллекции и история тапов | V28 |

Для изменения схемы добавьте следующую `V<N>__description.sql`; применённые файлы не редактируются. Учитывайте существующие строки, constraints, индексы и роли доступа. Проверяйте обновление старой схемы, а не только создание пустой БД.

[db/DatabaseFactory.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/DatabaseFactory.kt) настраивает HikariCP и Flyway; [db/MigrationMain.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/MigrationMain.kt) — отдельный запуск миграций. В Compose сначала выполняются `provision` и `migrate`, затем стартует `api`. Приложение использует ограниченную роль, мигратор — отдельную. [db/schema.ts](../../db/schema.ts) и `npm run db:generate` относятся к заготовке Sites/D1 и **не создают PostgreSQL-миграции приложения**.

Для новой награды/коллекции начните с [apps/api/src/main/resources/world/catalog.json](../../apps/api/src/main/resources/world/catalog.json): этот файл импортируют и TypeScript, и Kotlin. Проверьте `catalogVersion`, разрешённые ID в схемах, рецепты/стоимости, старый инвентарь и серверный ledger. Добавление картинки не добавляет серверную награду.

## Рецепты изменения игровых правил

### Добавить вещь в гардероб

1. Добавьте уникальный `id` в `catalog.json → items`: `name`, `slot`, `color`, `sparks`, `starter`. Поддерживаются слоты `palette`, `head`, `neck`, `rod`; новое имя слота требует изменений `WorldEquipment`, `worldStateSchema` и обработчика `equip` в обоих серверах.
2. Для обычного крафта задайте `starter: false` и положительную стоимость. Бесплатный не стартовый предмет не становится доступным сам: нужен источник выдачи, например `collectionRewards`. Стартовый набор уже созданных аккаунтов не меняется от нового флага `starter`; начальные значения заданы в `newWorldState()` и Kotlin `WorldState`.
3. Добавьте реальный внешний вид: `features/mochlik/pixel-sprite.ts → pixelSprite()` содержит палитры, шарфы и шапки; удочки — [features/world/fishing-tackle.ts](../../features/world/fishing-tackle.ts). Одного `color` в каталоге хватает для значка гардероба, но не нового рисунка персонажа.
4. Проверьте крафт/повтор/отказ без ресурсов, надевание и снятие, вид спереди/сзади, круг и карту. Регрессии: [tests/world.test.mjs](../../tests/world.test.mjs), [mochlik-sprite.test.mjs](../../tests/mochlik-sprite.test.mjs), Ktor `WorldRulesTest` и `JdbcWorldRepositoryIntegrationTest`.

### Добавить находку или награду за коллекцию

1. В `catalog.json → finds` задайте `id`, `name`, `description`, `symbol`, `group`; добавьте ID в `routes[].finds`. Для нового символа обновите `findIcons` в [world-view.tsx](../../features/world/world-view.tsx), иначе используется лист.
2. Для новой группы обновите группировку панелей [world-view.tsx](../../features/world/world-view.tsx) и обе функции `collectionRewards`: [features/world/model.ts](../../features/world/model.ts) и Ktor [WorldModel.kt](../../apps/api/src/main/kotlin/ru/zhiv/world/WorldModel.kt). Сейчас явно сопоставлены `forest → explorer_cap`, `fishing → willow_rod`.
3. При изменении полного числа находок согласуйте цель `full_collection` в `GAME_ACHIEVEMENTS`, [game-api.ts](../../features/game/game-api.ts) (проверка `target`), Ktor `GameRewards.achievements` и локальном расчёте достижений. Решите судьбу уже выданной награды; не отзывайте её случайно пересчётом.
4. Проверьте выдачу недостающей находки, повтор `claim_journey`, завершение группы, старую коллекцию и недействительные ID: [tests/world.test.mjs](../../tests/world.test.mjs), [game-achievements.test.mjs](../../tests/game-achievements.test.mjs), Ktor `JdbcWorldRepositoryIntegrationTest`.

### Изменить стоимость, маршрут или начисление

- Стоимости: `catalog.json → houseUpgrades`, `workshop`, `workshopUpgrades`, `items[].sparks`. Искры за тапы: `tapsPerSpark`, `dailySparkLimit`; применение — [db/JdbcWorldRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcWorldRepository.kt) и `lib/dev/world-store.ts → creditDevWorldTaps()`.
- Маршрут: `routes[]` задаёт время `seconds`, доступ `houseLevel`, признак `once`, ресурсы и находки. Сохранённое путешествие уже содержит свои награды и время: изменение каталога не должно пересчитывать старые поездки при получении.
- Новый маршрут подключите к UI [world-journeys.tsx](../../features/world/world-journeys.tsx) (сейчас выбор ID явный), фазам [journey-timeline.ts](../../features/world/journey-timeline.ts) и нужной анимации. Добавление ID в JSON не размещает маршрут на Tiled-карте. `rebuilding` пока блокирует новые старты в интерфейсе.
- При новой версии каталога обновите допускаемые версии `worldSnapshotSchema` в [model.ts](../../features/world/model.ts) и Kotlin `WorldSnapshot.catalogVersion`; проверьте старые snapshots/поездки. Не удаляйте сохранённые ID без совместимости.
- Проверки: граница стоимости, дневной UTC-лимит, идемпотентность, старое путешествие после изменения каталога — [tests/world.test.mjs](../../tests/world.test.mjs), [world-session.test.mjs](../../tests/world-session.test.mjs), `WorldRulesTest`, `JdbcWorldRepositoryIntegrationTest`.

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
| [lib/dev/world-store.ts](../../lib/dev/world-store.ts) | Snapshot и команды мира |
| [lib/dev/api-guard.ts](../../lib/dev/api-guard.ts), [api-origin.ts](../../lib/dev/api-origin.ts), [api-route.ts](../../lib/dev/api-route.ts) | Режим запуска, origin, JSON, cookie, ключи записи |

Память процесса теряется после перезапуска и не разделяется между экземплярами сервера. Сохранённая браузером cookie после перезапуска не восстанавливает аккаунт. Production-запуск без Ktor вернёт `DEV_API_DISABLED`; `ENABLE_DEV_API=true` включает только имитацию. Не используйте её для реальных пользовательских данных.

## Тесты и диагностика

- Ktor contracts: [apps/api/src/test/kotlin/ru/zhiv/ApiContractTest.kt](../../apps/api/src/test/kotlin/ru/zhiv/ApiContractTest.kt), [GameEventRoutesTest.kt](../../apps/api/src/test/kotlin/ru/zhiv/GameEventRoutesTest.kt), чистые тесты соответствующего пакета.
- PostgreSQL: `apps/api/src/test/kotlin/ru/zhiv/db/Jdbc*IntegrationTest.kt`; нужны Docker/Testcontainers. CI отклоняет пропущенные ключевые integration suites.
- Web: `tests/*-domain.test.mjs`, `game-*.test.mjs`, `world*.test.mjs`; порядок запуска — [проверки](local-development.md#проверки).
- Техническая готовность: `/healthz` и `/readyz`. Метрики доступны внутри инфраструктуры; Caddy закрывает публичные `/internal/*` и `/metrics`.

Настройки сервера: [config/AppConfig.kt](../../apps/api/src/main/kotlin/ru/zhiv/config/AppConfig.kt), [auth/AuthConfig.kt](../../apps/api/src/main/kotlin/ru/zhiv/auth/AuthConfig.kt), безопасный образец `deploy/.env.example`. Авторизация — [инструкция](../operations/auth-0.5.0.md); админские права — [админка](../operations/admin-panel.md); расследование — [инциденты](../operations/incident-response.md), [диагностика API](../../apps/api/DIAGNOSTICS.md).

Запуск/обновление/backup находятся в [эксплуатации](../operations/operations.md) и [VPS](../operations/vps.md). Сброс — отдельные явные процедуры: [пользовательские данные](../operations/reset-user-data.md), [база целиком](../operations/reset-database.md). Они не являются шагом обычной разработки.
