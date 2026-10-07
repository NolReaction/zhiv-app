# Функции приложения: где менять и как проверять

[Документация](../README.md) · [Архитектура](../architecture.md) · [Сервер и данные](backend-and-data.md)

Все пути ниже относительно корня репозитория. [features/check-in/check-in-app.tsx](../../features/check-in/check-in-app.tsx) соединяет разделы; изменение одной функции обычно начинается с отдельного компонента или чистой функции из таблиц.

## Отметка, календарь и статус

| Задача | Где менять | Проверить |
|---|---|---|
| Кнопка «Я живой», последняя отметка, результат отправки | [features/check-in/check-in-app.tsx](../../features/check-in/check-in-app.tsx), [check-in-receipt.tsx](../../features/check-in/check-in-receipt.tsx); форматирование [lib/check-in-presentation.ts](../../lib/check-in-presentation.ts) | Успех, повтор запроса, cooldown, offline, потерянный ответ: [tests/check-in-domain.test.mjs](../../tests/check-in-domain.test.mjs) |
| Цвет/размер кнопки, простой вид | [check-in-app.module.css](../../features/check-in/check-in-app.module.css), [use-simple-view.ts](../../features/check-in/use-simple-view.ts), [features/mochlik/mochlik-terrarium.tsx](../../features/mochlik/mochlik-terrarium.tsx) | Узкий экран, клавиатура, тапы по краю; [tests/rendered-html.test.mjs](../../tests/rendered-html.test.mjs), [tap-input.ts](../../features/game/tap-input.ts) |
| Календарь отметок | [check-in-calendar.tsx](../../features/check-in/check-in-calendar.tsx), [lib/check-in-calendar.ts](../../lib/check-in-calendar.ts), [lib/time-zone.ts](../../lib/time-zone.ts) | Смена месяца/часового пояса: [tests/calendar.test.mjs](../../tests/calendar.test.mjs) |
| Серия дней | [lib/daily-streak.ts](../../lib/daily-streak.ts); сервер [identity/CheckInCalendar.kt](../../apps/api/src/main/kotlin/ru/zhiv/identity/CheckInCalendar.kt), [db/JdbcZhivRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcZhivRepository.kt) | Граница 24 часов и обрыв серии: [tests/profile-domain.test.mjs](../../tests/profile-domain.test.mjs), [tests/calendar.test.mjs](../../tests/calendar.test.mjs) |
| Текст и срок статуса | [status-editor.tsx](../../features/check-in/status-editor.tsx), [lib/user-status.ts](../../lib/user-status.ts), [components/user-status-display.tsx](../../components/user-status-display.tsx); сервер [identity/UserStatus.kt](../../apps/api/src/main/kotlin/ru/zhiv/identity/UserStatus.kt) | Пустой/длинный текст, истечение, приватность: [tests/status-privacy.test.mjs](../../tests/status-privacy.test.mjs) |

**Две разные серии:** серия дней продлевается подтверждёнными отметками с промежутком не более 24 часов, а не сменой календарной даты; серия игровых нажатий завершается после паузы, заданной `CLICKER_IDLE_RESET_MS` в [features/game/clicker-story.ts](../../features/game/clicker-story.ts) (сейчас 10 секунд). Не подменяйте одно другим.

**Панели возле кнопки:** текущая серия и её результат/рекорд находятся в плавающей панели у правого верхнего края круга (`seriesPanel`/`tapCounter` в [check-in-app.module.css](../../features/check-in/check-in-app.module.css)). Положение — `top: 24%`, `right: -3%`, предел ширины — `max-width: 36%`. При диаметре круга до 290px панель компактнее, допускает ширину до 40% и опускается до `top: 31%`, чтобы не пересекаться с заголовком. Панель абсолютно позиционирована и не создаёт строку или отступ снизу; мобильный круг использует всю доступную высоту. Небольшое выступание остаётся внутри боковых полей экрана. Рекорд отмечен кубком и золотистыми цветами, текущая серия сохраняет отсчёт и полоску времени. Панель не принимает игровые нажатия; счётчик и подтверждение рекорда сохраняют прежние правила.

**Размер панели занятия внутри круга** регулируется в [world-activity-badge.module.css](../../features/world/world-activity-badge.module.css): `--activity-dial-size` в `.badge` — 44px, для круга до 230px — 34px в `@container`. Ширину задают текст, `gap` и `padding`; шрифты — `.text > span` и `.text > strong`. Размещение и предел ширины задаёт `.activity` в [mochlik-terrarium.module.css](../../features/mochlik/mochlik-terrarium.module.css): `bottom: 10%`, `max-width: 80%`. При изменении проверить длинное название, готовность/сбор, ширину 320px и низкий экран; `transform: scale()` не меняет занимаемое в компоновке место.

**Отправка:** `createCheckIn()` в [lib/check-in-api.ts](../../lib/check-in-api.ts) передаёт `Idempotency-Key`. Повтор потерянного ответа использует тот же ключ. UI берёт `checkedAt`, `serverTime`, `nextAllowedAt` из ответа; время устройства не подтверждает отметку. Сейчас серверный cooldown — 30 секунд; игровая кнопка может продолжать принимать отдельные тапы.

**Статус:** новые записи ограничены 30 символами (`MAX_STATUS_LENGTH`), но чтение старых записей допускает более длинный текст. Меняя лимит или сроки, согласуйте TypeScript, Ktor и тесты, а не только поле ввода.

## Люди, группы, профиль, доступ

| Задача | Где менять | Проверить |
|---|---|---|
| «Свои»: поиск, заявки, избранное, личное имя | [features/people/people-view.tsx](../../features/people/people-view.tsx), [lib/people-search.ts](../../lib/people-search.ts), [lib/person-nickname.ts](../../lib/person-nickname.ts) | [tests/relationships-domain.test.mjs](../../tests/relationships-domain.test.mjs), [people-search.test.mjs](../../tests/people-search.test.mjs), [person-nickname.test.mjs](../../tests/person-nickname.test.mjs) |
| Группы, участники, роли и приглашения | [features/people/groups-section.tsx](../../features/people/groups-section.tsx), [lib/group-input.ts](../../lib/group-input.ts) | Роли владельца/участника, выход и отзыв: [tests/groups-domain.test.mjs](../../tests/groups-domain.test.mjs) |
| Видимость отметок | [components/sharing-switch.tsx](../../components/sharing-switch.tsx), [lib/identity-sharing.ts](../../lib/identity-sharing.ts), [lib/check-in-contract.ts](../../lib/check-in-contract.ts) | OFF/LATEST_ONLY, отключение и повторное включение: [tests/identity-sharing.test.mjs](../../tests/identity-sharing.test.mjs), [relationships-domain.test.mjs](../../tests/relationships-domain.test.mjs) |
| Ссылки-приглашения | [lib/invite-import.ts](../../lib/invite-import.ts), [invite-dialog-state.ts](../../lib/invite-dialog-state.ts), [features/account/capability-landing.tsx](../../features/account/capability-landing.tsx) | Вход по ссылке, повтор, истечение: [tests/invite-import.test.mjs](../../tests/invite-import.test.mjs), [invite-dialog-state.test.mjs](../../tests/invite-dialog-state.test.mjs) |
| Профиль, имя, часовой пояс | [features/account/profile-view.tsx](../../features/account/profile-view.tsx), [time-zone-setting.tsx](../../features/account/time-zone-setting.tsx), [lib/time-zone.ts](../../lib/time-zone.ts) | Ограничение смены имени, валидность зоны: [tests/profile-domain.test.mjs](../../tests/profile-domain.test.mjs), [calendar.test.mjs](../../tests/calendar.test.mjs) |
| Вход и привязанные способы доступа | [features/account/account-entry.tsx](../../features/account/account-entry.tsx), [account-access.tsx](../../features/account/account-access.tsx), [lib/auth-api.ts](../../lib/auth-api.ts) | [tests/auth-entry.test.mjs](../../tests/auth-entry.test.mjs); реальные провайдеры — Ktor `auth/*` |
| Резервный код | [features/account/recovery-code-card.tsx](../../features/account/recovery-code-card.tsx), [recovery-starter.tsx](../../features/account/recovery-starter.tsx), [lib/recovery-code.ts](../../lib/recovery-code.ts) | [tests/recovery-code.test.mjs](../../tests/recovery-code.test.mjs), [recovery-capabilities.test.mjs](../../tests/recovery-capabilities.test.mjs) |
| Слияние/удаление профиля, завершение сессий | [features/account/account-lifecycle.tsx](../../features/account/account-lifecycle.tsx), [lib/account-lifecycle.ts](../../lib/account-lifecycle.ts) | Подтверждение текущего аккаунта: [tests/account-lifecycle.test.mjs](../../tests/account-lifecycle.test.mjs); SQL — `JdbcAccountLifecycleRepositoryIntegrationTest` |

Игровой профиль открывается по нажатию имени друга: [доступ, безопасные поля и проверки](../game/friend-profiles.md). Переключатель исходящей видимости закрывает также эту карточку; посещение поляны пока в плане.

Личная связь не равна группе. Видимость проверяется на сервере; нельзя показывать скрытую отметку, потому что она осталась в старом клиентском ответе. При смене аккаунта сбрасывайте данные предыдущего владельца и игнорируйте запоздалые HTTP-ответы.

Вход поддерживает VK ID, Telegram и email-код при включённых серверных настройках. Локальный адаптер возвращает `legacy: true` и отключённые провайдеры: он позволяет создать тестовый профиль, но не имитирует подтверждённый email/соцсеть. Настройка — [авторизация](../operations/auth-0.5.0.md), [жизненный цикл аккаунта](../operations/account-0.5.1.md).

## Загрузка профиля и восстановление связи

`features/account/recovery-attempt.ts` сохраняет краткоживущий идентификатор восстановления по коду до POST. Повтор после закрытия окна или перезагрузки требует заново ввести тот же резервный код; его сырой текст не хранится. Срок десять минут не продлевается, автоматического восстановления нет. Проверка потерянного ответа и изоляции разных кодов — `tests/recovery-attempt.test.mjs`; [эксплуатационные правила](../operations/account-0.5.1.md#обрывы-связи-и-диагностика).

`features/check-in/identity-recovery.ts` управляет чтением `/api/v1/me`: после временного сбоя делает до двух повторов через 1 и 3 секунды, учитывает более длинный `Retry-After`, возобновляет проверку после возврата сети/страницы. Одновременно работает один запрос; скрытие страницы отменяет его, устаревшие ответы не меняют профиль. Ответ 401 переводит к входу, постоянные ошибки вроде 403 не повторяются автоматически. Регрессии: `tests/identity-recovery.test.mjs`.

`lib/request-deadline.ts` объединяет отмену вызывающей стороны с таймаутом, действующим до окончания чтения ответа. Запросы основного API ограничены 8 секундами, авторизации — 30, диагностического игрового события — 4. Нативный `AbortSignal.timeout` не требуется. Ошибка чтения при отмене сохраняет причину, ошибочный ответ — безопасный `X-Request-ID`. Транспорт не переотправляет операции записи; их существующие квитанции и сверка результата сохраняются. Проверки: `tests/network-request.test.mjs`, `tests/auth-entry.test.mjs`.

Ошибки начальной загрузки собирает `lib/client-incidents.ts` и отправляет после подтверждения профиля. Границы доставки и связь с админкой описаны в [диагностике пользователей](../operations/admin-panel.md#если-игрок-видел-ошибку-а-журнал-пуст); проверки — `tests/client-incidents.test.mjs`.

## Игровые нажатия, прогресс, рейтинг

| Слой | Файл | Что менять здесь |
|---|---|---|
| Ввод и видимая серия | [features/game/tap-input.ts](../../features/game/tap-input.ts), [clicker-story.ts](../../features/game/clicker-story.ts) | Область нажатия, отсечение двойного pointer/click, истории и уровни |
| Подключение React | [features/game/use-game-progress.ts](../../features/game/use-game-progress.ts) | Владелец аккаунта, выбор вкладки-отправителя, lifecycle |
| Очередь/повторы | [game-sync.ts](../../features/game/game-sync.ts), [game-sync-journal.ts](../../features/game/game-sync-journal.ts), [game-tab-inbox.ts](../../features/game/game-tab-inbox.ts) | Пакеты, подтверждения, сохранение, передача между вкладками |
| Контракт HTTP | [game-api.ts](../../features/game/game-api.ts) | Zod-схемы, таймауты, `Retry-After`, endpoints |
| Награды и UI | [game-rewards.ts](../../features/game/game-rewards.ts), [game-achievements.tsx](../../features/game/game-achievements.tsx), [game-levels-button.tsx](../../features/game/game-levels-button.tsx), [game-leaderboard.tsx](../../features/game/game-leaderboard.tsx) | Представление наград, достижений и рейтинга |
| Сервер | Ktor `game/`, [db/JdbcGameRepository.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/JdbcGameRepository.kt), [db/GameAchievementWrites.kt](../../apps/api/src/main/kotlin/ru/zhiv/db/GameAchievementWrites.kt) | Принятие пакетов, серия, начисления, видимость рейтинга |

Уровень определяется подтверждённым `lifetimeTaps`, отдельного XP нет. Тапы продолжают увеличивать игровой счёт, серии и достижения, но больше не начисляют искры или валюту новой экономики. Монеты и товары выдаются только через подтверждённые сервером экономические действия; правила — в [каталоге экономики](../../apps/api/src/main/resources/world/economy-catalog.json).

Перед правкой очереди прочитайте [инварианты синхронизации](../game/game-sync-reliability.md). Уже отправленный пакет нельзя пересобрать под новым ID: потерянный ответ мог скрывать успешное начисление. Подтверждённый прогресс и неподтверждённые локальные тапы показываются раздельно.

Основные регрессии: [tests/game-sync.test.mjs](../../tests/game-sync.test.mjs), [game-deferred-sync.test.mjs](../../tests/game-deferred-sync.test.mjs), [game-queue-recovery.test.mjs](../../tests/game-queue-recovery.test.mjs), [game-tab-inbox.test.mjs](../../tests/game-tab-inbox.test.mjs), [game-burst.test.mjs](../../tests/game-burst.test.mjs), [game-achievements.test.mjs](../../tests/game-achievements.test.mjs). Меняя начисления/лимиты, добавьте проверку Ktor/PostgreSQL; веб-тест не доказывает корректность настоящей транзакции.

## Мир и доступные функции

[features/world/world-view.tsx](../../features/world/world-view.tsx) — панели мира. [use-world.ts](../../features/world/use-world.ts)/`session.ts` хранят гардероб, коллекции и прежние поездки из [каталога мира](../../apps/api/src/main/resources/world/catalog.json); их команды — в [features/world/model.ts](../../features/world/model.ts). Кошелёк, товары, здания и заказы принадлежат отдельному [use-economy.ts](../../features/economy/use-economy.ts)/[session.ts](../../features/economy/session.ts) и [каталогу экономики](../../apps/api/src/main/resources/world/economy-catalog.json).

Сейчас `WORLD_PRESENTATION.rebuilding = true` выбирает Tiled-лес и скрывает прежние действия мира. Запуск старых путешествий, мгновенная стройка и прежний крафт закрыты также на сервере; уже начатые путешествия можно завершить. Новые строительство, улучшения, производство, исследования и рынок доступны через `EconomyPanel`. Коллекции и гардероб сохраняются. `streakDecor = false` скрывает старую кастомизацию подарками. Перед добавлением кнопки проверьте, к какому протоколу относится действие.

Карта/объекты — [Tiled](../game/tiled-editor.md), ночь/источники — [свет](../game/world-lighting.md). За графические эффекты отвечает [new-map-scene.ts](../../features/world/new-map-scene.ts) и модули `forest-*`, за серверные награды — Ktor. DEV-панель не заменяет админку.

В рабочей ветке доступны прогулки по свободной земле, сон дома, грибы, встречи с насекомыми, полив и сбор ягод с корзинкой, отдых у костра. Потребности и выбор занятий задаёт [Utility AI](../game/world-mind.md); птицы и насекомые — отдельные локальные симуляции окружения. Подтверждённые уровни зданий выбирают доступные рисунки и их геометрию в обеих камерах; нажатия на дом, мастерскую и каменоломню открывают хозяйство. DEV позволяет временно примерить авторский уровень без покупки и изменения прогресса. Наличие рисунка маяка не реализует его восстановление; мост пока не открывает новый проход.

Жизнь полянки подключена через `forest-session.ts` и отдельный [протокол памяти](../game/forest-memory-sync.md). Сервер хранит снимок и право записи одного устройства; растущие ягоды и доставленные в корзинку плоды пока декоративны, к инвентарю не относятся. При изменении аккаунта, входе на втором устройстве, потере связи и закрытии карты проверяйте и игровую очередь тапов, и независимую память полянки. Успешное сохранение одного не доказывает сохранение другого.

## Общий интерфейс и PWA

| Задача | Точки входа | Проверка |
|---|---|---|
| Нижняя навигация | [features/app/navigation.tsx](../../features/app/navigation.tsx), переключение в [check-in-app.tsx](../../features/check-in/check-in-app.tsx) | Активная вкладка, возврат из мира, узкий экран |
| Общие цвета/шрифты/отступы | [app/globals.css](../../app/globals.css); локальные `*.module.css` | День/ночь, длинные имена, safe-area на телефоне |
| Диалоги | [components/ui/dialog.tsx](../../components/ui/dialog.tsx), [components/glass-dialog.module.css](../../components/glass-dialog.module.css) | Tab, Escape, возврат фокуса, прокрутка длинного текста |
| Уведомления и состояние данных | [components/app-notifications.tsx](../../components/app-notifications.tsx), [data-freshness.tsx](../../components/data-freshness.tsx), [lib/data-freshness.ts](../../lib/data-freshness.ts) | [tests/app-notifications.test.mjs](../../tests/app-notifications.test.mjs), [data-freshness.test.mjs](../../tests/data-freshness.test.mjs) |
| Установка PWA/иконки | [app/manifest.ts](../../app/manifest.ts), [app/layout.tsx](../../app/layout.tsx), `public/icon*`, `public/apple-touch-icon.png` | [tests/pwa-contract.test.mjs](../../tests/pwa-contract.test.mjs) |
| Анимированный запуск и фирменная графика | [features/startup/](../../features/startup/), [lib/brand-assets.ts](../../lib/brand-assets.ts), [scripts/prepare-brand-assets.mjs](../../scripts/prepare-brand-assets.mjs) | [Готовность сцены, повторы и экспорт иконок](startup-and-brand.md) |
| Offline и обновление ассетов | `public/sw.js`, [components/service-worker-registration.tsx](../../components/service-worker-registration.tsx) | Обновление сборки, offline после первого открытия: [tests/pwa-contract.test.mjs](../../tests/pwa-contract.test.mjs), [world-loading.test.mjs](../../tests/world-loading.test.mjs) |

Service Worker регистрируется только в production. Он кэширует оболочку и версионированные ресурсы; `/api/*` и `/admin` всегда идут в сеть. Не добавляйте кэширование ответов аккаунта ради исправления offline-экрана. Проверка PWA требует localhost или HTTPS; обычный LAN HTTP подходит для UI, но не доказывает работу установки/offline.

Админка: `features/admin/`, API-клиент [admin-api.ts](../../features/admin/admin-api.ts), страница [app/admin/page.tsx](../../app/admin/page.tsx). Права проверяет серверный allowlist, не видимость кнопки: [доступ и диагностика](../operations/admin-panel.md), [модерация](../operations/player-moderation.md).
