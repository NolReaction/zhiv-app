import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { EconomyPanel, EconomyBalances, economyDuration } = await vite.ssrLoadModule("/features/economy/economy-panel.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/rules.ts");
const { economyBuildingDestination } = await vite.ssrLoadModule("/features/economy/world-adapter.ts");
after(() => vite.close());

const now = Date.parse("2026-09-30T21:00:00Z");
function snapshot(overrides = {}) {
  const result = { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(),
    wallet: { coins: 0, pearls: 0 }, inventory: {}, buildings: { home: 1, garden: 1, warehouse: 1 }, jobs: [],
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 },
    catalog: structuredClone(economyCatalog), completedExplorations: 0, ...overrides };
  return { ...result, storage: overrides.storage ?? economyStorage(result) };
}
function controller(overrides = {}) {
  return { snapshot: snapshot(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
}
const render = (tab, economy = controller(), focusId) => renderToStaticMarkup(createElement(EconomyPanel, { initialTab: tab, initialFocusId: focusId, economy }));
const buttons = html => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2].replace(/<[^>]*>/g, "") }));
const button = (html, text) => {
  const found = buttons(html).find(entry => entry.text.includes(text));
  assert.ok(found, `Missing button: ${text}`); return found;
};
const disabled = entry => /\bdisabled=/.test(entry.attributes);

test("standalone map market keeps trade actions without the old economy hub or repeated wallet", () => {
  const html = renderToStaticMarkup(createElement(EconomyPanel, {
    initialTab: "market", standalone: true, onNavigate() {},
    economy: controller({ notice: "DEV: Дом Мохлика — уровень 2" }),
  }));
  assert.match(html, /aria-label="Рынок между игроками"/);
  assert.doesNotMatch(html, /Разделы хозяйства|aria-label="Кошелёк"|DEV: Дом Мохлика/);
  assert.ok(button(html, "Продолжить обустройство"));
  assert.match(html, /Лесной рынок/);
});

function job(overrides = {}) {
  return { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "production", targetId: "garden", recipeId: "grow_berries", targetLevel: null,
    startedAt: new Date(now - 100_000).toISOString(), finishesAt: new Date(now + 500_000).toISOString(),
    rewards: { berries: 6 }, cost: { coins: 0, items: {} }, catalogVersion: 1, ...overrides };
}

test("fresh players can grow and explore without coins; expensive buildings explain missing materials", () => {
  const production = render("production");
  assert.equal(disabled(button(production, "Начать · 15 мин")), false);
  assert.match(production, /Без затрат/);
  assert.equal(disabled(button(render("exploration"), "Отправиться: Лесная разведка")), false);
  const construction = render("buildings");
  assert.equal(disabled(button(construction, "Улучшить до ур. 2: Дом Мохлика")), true);
  assert.match(construction, /нужен уровень 1/);
  assert.match(construction, /Древесина: 0 \/ 20/);
  assert.match(construction, /Камень: 0 \/ 15/);
  assert.ok(button(construction, "Где взять недостающие материалы?"));
  assert.match(construction, /30 мин/);
});

test("construction checks materials together with coins and only opens when the full cost is available", () => {
  const target = economyCatalog.buildings.find(building => building.id === "home").levels[1];
  const state = snapshot({ wallet: { coins: target.cost.coins, pearls: 0 }, inventory: { ...target.cost.items, stone: target.cost.items.stone - 1 },
    buildings: { home: 1, garden: 1, ...target.requiredBuildings } });
  assert.equal(disabled(button(render("buildings", controller({ snapshot: state })), "Улучшить до ур. 2: Дом Мохлика")), true);
  state.inventory.stone = target.cost.items.stone;
  assert.equal(disabled(button(render("buildings", controller({ snapshot: state })), "Улучшить до ур. 2: Дом Мохлика")), false);
});

test("berry production owns its station and collection opens only after the server deadline", () => {
  const state = snapshot({ jobs: [job()] });
  let html = render("production", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Начать · 15 мин")), true);
  assert.equal(disabled(button(html, "Растут: Вырастить ягоды")), true);
  assert.match(html, /Здание занято текущим заказом/);
  state.jobs[0].finishesAt = new Date(now).toISOString();
  html = render("production", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Собрать: Вырастить ягоды")), false);
  assert.equal(disabled(button(html, "Начать · 15 мин")), true);
  assert.match(html, /Ягоды созрели/);
});

test("an active house build keeps the current level and does not offer a second construction", () => {
  const state = snapshot({ wallet: { coins: 9990, pearls: 0 }, inventory: { wood: 99, stone: 99 },
    jobs: [job({ kind: "construction", targetId: "home", recipeId: null, targetLevel: 2, rewards: {} })] });
  const html = render("buildings", controller({ snapshot: state }));
  assert.match(html, /Прежний уровень продолжает действовать/);
  assert.equal(disabled(button(html, "Завершить: Дом Мохлика · уровень 2")), true);
  assert.equal(disabled(button(render("buildings", controller({ snapshot: state }), "woodlot"), "Построить: Лесной участок")), true);
  assert.doesNotMatch(html, /Улучшить до ур\. 3/);
});

test("uncertain commands and retry cooldown prevent duplicate actions while navigation remains usable", () => {
  const state = snapshot({ jobs: [job({ finishesAt: new Date(now - 1).toISOString() })] });
  let html = render("overview", controller({ snapshot: state, uncertain: true, error: "No response" }));
  assert.equal(disabled(button(html, "Собрать: Вырастить ягоды")), true);
  assert.equal(disabled(button(html, "Проверить результат")), false);
  assert.equal(disabled(button(html, "Производство")), false);
  html = render("production", controller({ snapshot: snapshot(), retryAt: now + 15_000, error: "Повторите позже" }));
  assert.equal(disabled(button(html, "Начать · 15 мин")), true);
  assert.equal(disabled(button(html, "Повторить через 15 с")), true);
});

test("loading and failed initial reads never display a spend action or a made-up balance", () => {
  let html = render("buildings", controller({ snapshot: null }));
  assert.match(html, /Открываем ваше хозяйство/);
  assert.doesNotMatch(html, /Построить|aria-label="Кошелёк"/);
  html = render("buildings", controller({ snapshot: null, error: "Нет связи" }));
  assert.match(html, /Нет связи/);
  assert.ok(button(html, "Попробовать ещё раз"));
});

test("market shows real full-lot quotes, escapes seller text and applies catalog access requirements", () => {
  const market = { listings: [{ id: "offer", sellerPublicId: "OTHER", sellerName: "<script>seller</script>", itemId: "wood", quantity: 6, totalPrice: 420,
    status: "active", createdAt: new Date(now).toISOString(), closedAt: null, owned: false }], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() };
  const state = snapshot({ wallet: { coins: 420, pearls: 0 }, buildings: { home: 2, garden: 1 }, completedExplorations: 1 });
  let html = render("market", controller({ snapshot: state, market }));
  assert.match(html, /Древесина × 6/);
  assert.match(html, /за весь лот/);
  assert.match(html, /&lt;script&gt;seller&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(disabled(button(html, "Купить весь лот")), false);
  state.wallet.coins = 410;
  assert.equal(disabled(button(render("market", controller({ snapshot: state, market })), "Не хватает монет")), true);
  state.catalog.market.requiredHomeLevel = 3;
  html = render("market", controller({ snapshot: state, market }));
  assert.equal(disabled(button(html, "Рынок пока закрыт")), true);
  assert.match(html, /Дом: 2 \/ 3 ур/);
});

test("an empty player market is honest and offers a next action without fictional merchants", () => {
  const html = render("market", controller({ snapshot: snapshot({ buildings: { home: 2, garden: 1 }, completedExplorations: 1 }),
    market: { listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() } }));
  assert.match(html, /Прилавки пока свободны/);
  assert.ok(button(html, "Выставить товар"));
  assert.doesNotMatch(html, /Продавец:/);
});

test("a personal showcase explains its fixed window and disables stale quotes until refresh", () => {
  const market = { listings: [{ id: "offer", sellerPublicId: "OTHER", sellerName: "Лесник", itemId: "wood", quantity: 6, totalPrice: 420,
    status: "active", createdAt: new Date(now).toISOString(), closedAt: null, owned: false }], mine: [], nextCursor: null, serverTime: new Date(now).toISOString(),
    showcase: { refreshAt: new Date(now + 1800_000).toISOString(), slots: 12, maxPerSeller: 2, refreshSeconds: 1800 } };
  const economy = controller({ snapshot: snapshot({ wallet: { coins: 10000, pearls: 0 }, buildings: { home: 2 }, completedExplorations: 1 }), market });
  let html = render("market", economy);
  assert.match(html, /Ваша витрина · 1 \/ 12/);
  assert.match(html, /До 2 лотов от одной лавки/);
  assert.match(html, /Купленные и снятые лоты до смены не заменяются/);
  assert.ok(button(html, "Проверить наличие"));
  assert.equal(disabled(button(html, "Купить весь лот")), false);
  assert.doesNotMatch(html, /Показать ещё/);
  html = render("market", { ...economy, now: now + 1800_000 });
  assert.equal(disabled(button(html, "Обновите витрину")), true);
  assert.equal(disabled(button(html, "Обновить витрину")), false);
});

test("stale or older-server offers cannot bypass home tiers or the NPC resale price floor", () => {
  const market = { listings: [{ id: "offer", sellerPublicId: "OTHER", sellerName: "Лесник", itemId: "tools", quantity: 1, totalPrice: 1000,
    status: "active", createdAt: new Date(now).toISOString(), closedAt: null, owned: false }], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() };
  const state = snapshot({ wallet: { coins: 10000, pearls: 0 }, buildings: { home: 2 }, completedExplorations: 1 });
  assert.equal(disabled(button(render("market", controller({ snapshot: state, market })), "Нужен дом 4 ур.")), true);
  state.buildings.home = 4;
  assert.equal(disabled(button(render("market", controller({ snapshot: state, market })), "Купить весь лот")), false);
  market.listings[0].totalPrice = 990;
  assert.equal(disabled(button(render("market", controller({ snapshot: state, market })), "Предложение недоступно")), true);
});

test("conversion is disclosed once as history and premium balance never exposes a checkout", () => {
  const html = render("overview", controller({ snapshot: snapshot({ migration: { version: 1, coinsGranted: 1260, woodGranted: 10, stoneGranted: 4 } }) }));
  assert.match(html, /Прежние запасы перенесены/);
  assert.match(html, /1(?:\s|&nbsp;|\u202f)260 монет, 10 древесины и 4 камня/);
  assert.match(html, /покупка пока недоступна/i);
  assert.ok(buttons(html).every(entry => !/Купить жемчуг|Пополнить/.test(entry.text)));
  const wallet = renderToStaticMarkup(createElement(EconomyBalances, { wallet: { coins: 250, pearls: 0 } }));
  assert.match(wallet, /Монеты: 250/);
  assert.doesNotMatch(wallet, /Искры/);
});

test("building progression requires the actual workshop and quarry, not only an upgraded home or money", () => {
  const target = economyCatalog.buildings.find(building => building.id === "home").levels[1];
  const state = snapshot({ wallet: { coins: 10000000, pearls: 0 }, inventory: { ...target.cost.items },
    buildings: { home: 1, garden: 1, warehouse: 1, workshop: 0, quarry: 1 } });
  const html = render("buildings", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Улучшить до ур. 2: Дом Мохлика")), true);
  assert.match(html, /Условия открытия/);
  assert.ok(button(html, "Мастерская: 0 / 1 ур."));
  assert.match(html, /Что даёт этот уровень/);
  assert.ok(button(html, "Мастерская · ур. 2"));
  assert.equal(buttons(html).filter(entry => /^Ур\. [1-5]$/.test(entry.text)).length, 5);
  assert.ok(buttons(html).every(entry => !/^Построить:/.test(entry.text)), "Only the chosen building expands into a full card");
});

test("warehouse shows real occupied, escrow, free and overflow counts and its next capacity upgrade", () => {
  const state = snapshot({ inventory: { wood: 190 }, storage: { capacity: 200, used: 190, reserved: 30, available: 0, overflow: 20 } });
  const html = render("inventory", controller({ snapshot: state }));
  assert.match(html, /В запасах: 190 · На прилавках: 30 · Свободно: 0/);
  assert.match(html, /Сверх вместимости: 20/);
  assert.match(html, /отмена всегда вернёт вещи/);
  assert.ok(button(html, "Расширить склад"));
  const upgrade = render("buildings", controller({ snapshot: state }), "warehouse");
  assert.match(upgrade, /Вместимость склада: 500 предметов/);
  assert.ok(button(upgrade, "Улучшить до ур. 2: Кладовая"));
});

test("full storage leaves ready rewards safe and offers recovery without preventing fitting production", () => {
  const readyJob = job({ finishesAt: new Date(now).toISOString() });
  const state = snapshot({ inventory: { wood: 197 }, jobs: [readyJob], storage: { capacity: 200, used: 197, reserved: 0, available: 3, overflow: 0 } });
  let html = render("overview", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Собрать: Вырастить ягоды")), true);
  assert.match(html, /нужно 6 мест, свободно 3/);
  assert.match(html, /не портятся/);
  assert.ok(button(html, "Освободить место"));
  state.jobs = [];
  html = render("production", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Начать · 15 мин")), false, "Production can finish while the player frees storage");
  state.jobs = [job({ finishesAt: new Date(now).toISOString(), rewards: { berries: 250 }, catalogVersion: 1 })];
  html = render("overview", controller({ snapshot: state }));
  assert.ok(button(html, "Расширить склад"));
});

test("production batch options fit the entire result in warehouse capacity, even if current free space is lower", () => {
  const state = snapshot({ storage: { capacity: 200, used: 195, reserved: 0, available: 5, overflow: 0 } });
  Object.assign(state.catalog.recipes.find(recipe => recipe.id === "grow_berries"), { rewards: { berries: 70, fiber: 20 }, maxBatch: 10 });
  const html = render("production", controller({ snapshot: state }));
  const size = html.match(/Размер заказа<select[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...size.matchAll(/<option value="(\d+)"/g)].map(match => Number(match[1])), [1, 2]);
  assert.match(html, /Результат займёт 90 мест/);
  assert.equal(disabled(button(html, "Начать · 15 мин")), false);
});

test("player market cannot buy an unaffordable storage lot and offers the warehouse as a next action", () => {
  const market = { listings: [{ id: "offer", sellerPublicId: "OTHER", sellerName: "Лесник", itemId: "wood", quantity: 6, totalPrice: 420,
    status: "active", createdAt: new Date(now).toISOString(), closedAt: null, owned: false }], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() };
  const state = snapshot({ wallet: { coins: 420, pearls: 0 }, buildings: { home: 2, garden: 1, warehouse: 1 }, completedExplorations: 1,
    storage: { capacity: 200, used: 190, reserved: 5, available: 5, overflow: 0 } });
  const html = render("market", controller({ snapshot: state, market }));
  assert.equal(disabled(button(html, "Не хватает места на складе")), true);
  assert.match(html, /Лот занимает 6 мест, свободно 5/);
  assert.ok(button(html, "Освободить место"));
});

test("material guide includes zero-stock goods, production sources, construction uses and respects non-tradable items", () => {
  let html = render("inventory", controller(), "planks");
  assert.match(html, /Доски · на складе 0/);
  assert.match(html, /Где получить/);
  assert.match(html, /Для чего пригодится/);
  assert.ok(button(html, "Стройка: Дом Мохлика"));
  assert.ok(button(html, "Доски"));
  assert.ok(html.includes(`Все товары · ${economyCatalog.items.length}`));
  assert.match(html, /<option value="fishing">Рыболовные товары<\/option>/);
  for (const fish of economyCatalog.fishing.fish) {
    assert.equal(economyCatalog.items.find(item => item.id === fish.itemId).category, "produce", "all fish share the existing harvest and fish category");
  }
  assert.doesNotMatch(html, /<option value="fish">fish<\/option>/);
  assert.match(html, /Сырьё/);
  const state = snapshot({ inventory: { planks: 8 } });
  state.catalog.items.find(item => item.id === "planks").tradable = false;
  html = render("inventory", controller({ snapshot: state }), "planks");
  assert.match(html, /Этот предмет нельзя продавать/);
  assert.doesNotMatch(html, /Продать торговцу:/);
});

test("days are readable and higher tier recipes explain their actual prerequisite buildings", () => {
  assert.equal(economyDuration(60), "1 мин");
  assert.equal(economyDuration(604800), "7 д");
  assert.equal(economyDuration(90000), "1 д 1 ч");
  const html = render("production", controller(), "workshop");
  assert.match(html, /Будущие рецепты/);
  assert.match(html, /Условия открытия/);
  assert.ok(button(html, "Мастерская: 0 / 1 ур."));
  assert.ok(button(html, "К постройке"));
});

test("placed workshop opens production while the mine keeps activity unlocks and upgrade details", () => {
  for (const id of ["workshop", "quarry"]) {
    let state = snapshot();
    const building = state.catalog.buildings.find(entry => entry.id === id);
    let destination = economyBuildingDestination(id, state);
    assert.deepEqual(destination, { tab: "buildings", focusId: id });
    let html = render(destination.tab, controller({ snapshot: state }), destination.focusId);
    assert.match(html, new RegExp(`<h3>${building.name}</h3>`));
    assert.equal(disabled(button(html, `Построить: ${building.name}`)), true);
    assert.match(html, /Условия открытия/);
    assert.doesNotMatch(html, /Открыть производство/);

    state = snapshot({ buildings: { home: 2, workshop: 1, quarry: 1, garden: 1, warehouse: 1 } });
    destination = economyBuildingDestination(id, state);
    assert.deepEqual(destination, { tab: id === "quarry" ? "buildings" : "production", focusId: id });
    html = render(destination.tab, controller({ snapshot: state }), destination.focusId);
    if (id === "quarry") {
      assert.ok(button(html, "Выбрать участок для добычи"));
      assert.doesNotMatch(html, /Открыть производство/);
      assert.match(html, /Что даёт этот уровень/);
    } else {
      assert.match(html, new RegExp(`<option value="${id}" selected="">`));
      assert.ok(button(html, `Развитие: ${building.name}`));
      assert.ok(button(render("buildings", controller({ snapshot: state }), id), "Открыть производство"));
    }

    state.jobs = [job({ kind: "construction", targetId: id, targetLevel: 2, recipeId: null })];
    destination = economyBuildingDestination(id, state);
    assert.deepEqual(destination, { tab: "buildings", focusId: id }, "an ongoing upgrade opens its timer instead of production");
    html = render(destination.tab, controller({ snapshot: state }), destination.focusId);
    assert.equal(disabled(button(html, `Завершить: ${building.name}`)), true);
    state.jobs[0].finishesAt = new Date(now - 1000).toISOString();
    assert.deepEqual(economyBuildingDestination(id, state), destination, "elapsed local time never confirms a new level");
  }
  assert.deepEqual(economyBuildingDestination("home", snapshot({ buildings: { home: 5 } })), { tab: "buildings", focusId: "home" });
  assert.deepEqual(economyBuildingDestination("workshop", null), { tab: "buildings", focusId: "workshop" });
});

test("inventory guide and sale consistently show the actual discounted payout", () => {
  const state = snapshot({ inventory: { fish: 3 } }); state.catalog.localBuyer = { payoutBps: 6000 };
  const html = render("inventory", controller({ snapshot: state }), "fish");
  assert.match(html, /Быстрая продажа с уценкой 40%/);
  assert.match(html, /Быстрая продажа торговцу: 60% базовой цены/);
  assert.match(html, /Плёска купит дороже: 80 монет за штуку/);
  assert.equal(disabled(button(html, "Продать 1 шт. за 40 монет")), false);
  assert.doesNotMatch(html, /Продать 1 шт. за 80 монет|Торговец покупает сразу по 80/);
  state.wallet.coins = 10_000_000_000;
  assert.equal(disabled(button(render("inventory", controller({ snapshot: state }), "fish"), "Продать — шт.")), true);
});

test("legacy inventory sale keeps full price; tiny stock cannot disappear for zero proceeds", () => {
  const state = snapshot({ inventory: { crumb_bait: 1 } }); state.catalog.localBuyer = { payoutBps: 6000 };
  let html = render("inventory", controller({ snapshot: state }), "crumb_bait");
  assert.match(html, /нужно хотя бы 2 шт/); assert.equal(disabled(button(html, "Продать — шт.")), true);
  delete state.catalog.localBuyer;
  html = render("inventory", controller({ snapshot: state }), "crumb_bait");
  assert.doesNotMatch(html, /уценкой|округляется/);
  assert.equal(disabled(button(html, "Продать 1 шт. за 10 монет")), false);
});


test("generic economy keeps legacy quarry occupancy and mine construction behind departure guards", () => {
  const legacy = job({ targetId: "quarry", recipeId: "quarry_stone", rewards: { stone: 8 } });
  const state = snapshot({ buildings: { home: 5, quarry: 5, warehouse: 5 }, jobs: [legacy] });
  let html = render("exploration", controller({ snapshot: state }));
  assert.equal(disabled(button(html, "Отправиться: Лесная разведка")), true);
  assert.match(html, /Мохлик работает в каменоломне/);
  state.jobs = [job({ kind: "construction", targetId: "quarry", recipeId: null, rewards: {} })];
  html = render("exploration", controller({ snapshot: state }));
  const mine = economyCatalog.explorations.find(route => route.id === "quarry_stone");
  assert.equal(disabled(button(html, `Отправиться: ${mine.name}`)), true);
  assert.equal(disabled(button(html, "Отправиться: Лесная разведка")), false);
  assert.match(html, /Дождитесь улучшения шахты/);
});

test("generic economy will not offer a mine upgrade during an unclaimed actor shift", () => {
  const target = economyCatalog.buildings.find(building => building.id === "quarry").levels.find(level => level.level === 2);
  const state = snapshot({ buildings: { home: 5, quarry: 1, warehouse: 5, ...target.requiredBuildings },
    wallet: { coins: target.cost.coins, pearls: 0 }, inventory: { ...target.cost.items },
    jobs: [job({ kind: "exploration", targetId: "quarry_stone", recipeId: null, rewards: { stone: 8 } })] });
  const html = render("buildings", controller({ snapshot: state }), "quarry");
  assert.match(html, /Дождитесь Мохлика и заберите добычу/);
  assert.equal(disabled(button(html, "Улучшить до ур. 2: Каменоломня")), true);
});
