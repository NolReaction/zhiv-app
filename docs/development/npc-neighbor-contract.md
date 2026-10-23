# Лесной сосед Берест: контракт 0.7.2

Берест — `kind: "world_character"`, постоянный `id: "berest"`. Это не пользователь: у него нет publicId, входа, геопозиции или признака онлайн. Настройки по умолчанию — `apps/api/src/main/resources/world/neighbor-catalog.json`. Данные DEV находятся только на сервере в памяти; production — Ktor/PostgreSQL.

## Игрок

`GET /api/v1/economy/neighbor` без параметров возвращает:

```ts
{
  ownerPublicId: string;
  serverTime: string;
  character: {
    id: "berest"; name: string; description: string; kind: "world_character";
    world: { buildings: Record<string, number>; equipment: { palette: string; head: string | null; neck: string | null; rod: string | null }; gifts: string[]; hiddenGifts: string[]; jobs: [] };
  };
  shop: {
    cycleId: string; // дата UTC
    refreshAt: string;
    available: boolean;
    reason: string | null;
    offers: { id: string; itemId: string; quantity: number; totalPrice: number; purchased: boolean }[];
  };
  buying: {
    enabled: boolean; firstDelaySeconds: number; staleAfterSeconds: number;
    maxLotsPerDay: number; dailyBudgetCoins: number; maxLotCoins: number;
    usedLots: number; spentCoins: number;
  };
}
```

`POST /api/v1/economy/neighbor/commands` принимает `{ requestId: UUID, ownerPublicId, expectedRevision, action: "buy_offer", targetId: UUID, quantity, totalPrice }`. `totalPrice` — максимальная принятая цена, списывается сохранённая цена предложения. Возвращает обычный `EconomyResult` (`state`, `message`, `acceptedRevision`, `replayed`). Общая очередь экономики сериализует команду с другими действиями. Повтор того же requestId возвращает квитанцию; другой payload с тем же ID — конфликт. Нужны авторизация, активная игровая сессия, совпадение owner/revision, открытый рынок, доступный предмет, монеты, вместимость и дневной торговый бюджет.

Ассортимент персональный, фиксируется при первом доступном чтении дня. Пока рынок закрыт, GET возвращает пустой список без записи дневного цикла; восстановление моста открывает первую поставку в тот же день. Разблокировка предмета, обновление страницы, сессия и изменение настроек не перебрасывают уже созданные предложения. Изменение безопасности (пауза, запрет предмета) может отключить покупку без замены ID. Три небольших предложения состоят только из уже открытых обычных торговых предметов. Жемчуг, реликвии и рыбные виды/классы исключены. GET не покупает товары игроков.

## Покупки лотов игроков

Периодический обработчик и ручное действие администратора вызывают одну транзакцию. Она повторно проверяет активный лот, рынок и открытие предмета продавца, возраст лота, лимиты, допустимую цену и состояние аккаунта. Первое подтверждённое приобретение у продавца без прежних подтверждённых продаж и выкупов Береста может произойти через 180 секунд, обычные лоты — через 6 часов; не более 2 лотов и 300 монет на продавца в UTC-сутки, 150 за лот и 10000 монет глобально. Лимиты и первый опыт сохраняются при сбросе игры и объединении аккаунтов. Ручное действие обходит только ожидание возраста лота, сохраняя паузу, активные часы и все денежные ограничения. Купленный у Береста предмет нельзя продать ему в те же сутки.

Продажа использует обычную комиссию сохранённого лота и ручное получение выручки. `sale` расширяется необязательными `buyerKind: "player" | "world_character"` (по умолчанию `player`) и `buyerCharacterId: "berest" | null`; у Береста `buyerPublicId: null`, `buyerAvatarUrl: null`. Имя покупателя — снимок имени персонажа при сделке. Не создавать фиктивный аккаунт.

Покупная цена у соседа не ниже допустимой цены его обратного выкупа с учётом округления: цена магазина округляется вверх до 10 монет, потолок выкупа вниз. Это защищает и от разделения купленной партии на несколько лотов. Цены настроек дополнительно ограничиваются сервером; покупка в лавке и перепродажа Бересту или обычному NPC не дают прямой прибыли.

## Администратор

Только production Ktor с существующей проверкой администратора. Web/DEV/Sites не симулируют административную авторизацию и отвечают 503.

- `GET /api/v1/admin/neighbor?publicId=...`: `{ serverTime, settings, version, pausedReason, player: null | { publicId, name }, receipt: null, usage: { usedLots, spentCoins, globalSpentCoins }, pending: [{ id, sellerPublicId, sellerName, itemId, quantity, totalPrice, proceedsCoins, createdAt, eligible, reason }], history: [{ id, listingId, sellerPublicId, itemId, quantity, totalPrice, proceedsCoins, createdAt, source }] }`. Параметр publicId необязателен; без него список выбранного игрока пуст. До 100 ожидающих лотов и 50 событий; `source` — `auto` или `manual`. Комиссия равна `totalPrice - proceedsCoins`; клиент также допускает необязательный `feeCoins`. Ответ мутации содержит `receipt: {requestId, replayed}`.
- `POST /api/v1/admin/neighbor/settings`: `{ requestId: UUID, expectedVersion: number, reason: string, settings: NeighborSettings }`.
- `POST /api/v1/admin/neighbor/buy`: `{ requestId: UUID, listingId: UUID, playerPublicId, expectedTotalPrice, reason: string }`. Цена и продавец привязаны к подтверждению администратора. Ручная покупка не обходит дневные бюджеты и правила автоматического покупателя. Причина обоих действий содержит 8–240 символов.

`NeighborSettings` — полный объект из общего JSON: `enabled`, `autoBuyEnabled`, `name`, `description`, `buildings`, `equipment`, `offerSlots`, `offerQuantity`, `allowedItemIds`, `sellPriceBps`, `buyPriceBps`, `firstDelaySeconds`, `staleAfterSeconds`, `maxLotsPerDay`, `dailyBudgetCoins`, `maxLotCoins`, `globalDailyBudgetCoins`, `activeFromHourUtc`, `activeUntilHourUtc`. Сутки и часы в UTC, конец интервала исключён; 0–24 означает весь день. Ночной интервал разрешён через переход полуночи.

Клиентские схемы: `features/economy/domain/neighbor-model.ts`; чистые правила: `neighbor-rules.ts`. Контракт не меняет каталог экономики и награды просьб жителей.

## Эксплуатация и объединение веток

Миграция `V71__world_neighbor.sql` не создаёт пользователя. Она сохраняет признак прежней продажи у существующих продавцов; дальнейшие продажи человеку или Бересту также закрывают льготный первый выкуп. Лимиты, купленные предложения и история выкупов переживают сброс игрового прогресса. История содержит снимок UUID лота и не зависит от его последующего удаления. Полное удаление аккаунта удаляет его персональные данные.

Ktor запускает обработчик каждые 30 секунд, до 40 кандидатов за проход. Курсор проходит очередь дальше, даже если старые лоты не подходят. После трёх последовательных ошибок обработчик сохраняет защитную паузу с объяснением в админке; после проверки сервера сохранение настроек снимает её. Дополнительный cron не требуется.

Перед объединением с параллельными изменениями `work/0.7.2` проверить уникальность версии V71 и обновлённые allowlist схемы в reset/CI. Применённую миграцию не переписывать. Репутация жителей и её награды от этого контракта не зависят.
