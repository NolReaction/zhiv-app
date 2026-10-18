import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { Dialog } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/ui/construction/world-upgrade-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
after(() => vite.close());

const now = Date.parse("2026-10-03T12:00:00Z");
function state(overrides = {}) {
  const snapshot = { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), wallet: { coins: 5000, pearls: 0 }, inventory: { wood: 20 },
    buildings: { home: 1, warehouse: 1 }, jobs: [], completedExplorations: 0,
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: structuredClone(economyCatalog), ...overrides };
  return { ...snapshot, storage: economyStorage(snapshot) };
}
function construction(overrides = {}) {
  return { id: "da818fb4-6c9e-4b42-9b78-60669b234f0a", kind: "construction", targetId: "home", recipeId: null, targetLevel: 2,
    startedAt: new Date(now - 100_000).toISOString(), finishesAt: new Date(now + 500_000).toISOString(), rewards: {},
    cost: { coins: 1500, items: { wood: 20, stone: 15, planks: 6, rope: 2 } }, catalogVersion: 2, ...overrides };
}
function render(stationId = "home", overrides = {}) {
  const economy = { snapshot: state(), market: null, marketError: null, busy: false, uncertain: false, error: null, notice: "", now, retryAt: 0,
    act() {}, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {}, ...overrides };
  return renderToStaticMarkup(createElement(Dialog.Root, { open: true }, createElement(WorldUpgradeContent, {
    stationId, economy, onClose() {}, onOpenPantry() {}, navigation: { canOpen: () => true, open() {}, explore() {} },
  })));
}
const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const buttons = html => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: text(match[2]) }));

test("warehouse expansion respects its authored home tier without extra building gates when its cost is owned", () => {
  const warehouse = economyCatalog.buildings.find(building => building.id === "warehouse");
  assert.equal(warehouse.levels.find(level => level.level === 2).requiredHomeLevel, 2);
  for (const target of warehouse.levels.filter(level => level.level > 1)) {
    const snapshot = state({ buildings: { home: target.requiredHomeLevel, warehouse: target.level - 1, workshop: 0 },
      inventory: { ...target.cost.items }, wallet: { coins: target.cost.coins, pearls: 0 } });
    const html = render("warehouse", { snapshot });
    assert.doesNotMatch(html, /aria-label="Недостающие условия"|Нужны улучшения/);
    const start = buttons(html).find(button => button.text.includes(`Улучшить до ур. ${target.level}`));
    assert.ok(start, `warehouse ${target.level} keeps its normal upgrade action`);
    assert.doesNotMatch(start.attributes, /disabled/, `warehouse ${target.level} is available after its declared home tier`);
  }
  const first = warehouse.levels.find(level => level.level === 2);
  const locked = render("warehouse", { snapshot: state({ buildings: { home: 1, warehouse: 1 },
    inventory: { ...first.cost.items }, wallet: { coins: first.cost.coins, pearls: 0 } }) });
  assert.match(locked, /aria-label="Недостающие условия"/);
  assert.match(text(locked), /Дом Мохлика Сейчас ур\. 1 Нужен ур\. 2/);
  assert.match(buttons(locked).find(button => /Улучшить до ур\. 2/.test(button.text)).attributes, /disabled/);
});

test("upgrade leads with its result and keeps exact costs and missing-level navigation", () => {
  const html = render("home", { notice: "DEV: Дом Мохлика → 2" });
  assert.match(text(html), /Дом Мохлика.*Уровень 1.*Уровень 2/);
  assert.ok(html.indexOf('aria-label="Что изменится"') < html.indexOf('aria-label="Подготовка к улучшению"'));
  assert.match(html, /aria-label="Где получить: Камень, В путь\. Есть 0, нужно [0-9]+"/);
  assert.match(html, /aria-label="Недостающие условия"/);
  assert.match(text(html), /Монеты 5 000 \/ 250/);
  assert.ok(!buttons(html).some(button => button.text.trim() === "Кладовая"));
  assert.doesNotMatch(html, /DEV: Дом Мохлика/);
});

test("paid construction stays above the unlocks with one timer and one claim; it cannot charge again", () => {
  const html = render("home", { snapshot: state({ jobs: [construction()] }) });
  assert.ok(html.indexOf('aria-label="Ход улучшения"') < html.indexOf('aria-label="Что изменится"'));
  assert.equal((html.match(/<progress /g) ?? []).length, 1);
  const claims = buttons(html).filter(button => /aria-label="Завершить:/.test(button.attributes));
  assert.equal(claims.length, 1);
  assert.match(claims[0].attributes, /disabled/);
  assert.match(text(html), /\d+:\d{2}/);
  assert.doesNotMatch(text(html), /Осталось/);
  assert.doesNotMatch(html, /Подготовка к улучшению|Улучшить до ур\./);
});

test("a ready construction has one enabled completion action and reuses normal request locks", () => {
  const snapshot = state({ jobs: [construction({ finishesAt: new Date(now).toISOString() })] });
  const claim = overrides => buttons(render("home", { snapshot, ...overrides })).filter(button => /aria-label="Завершить:/.test(button.attributes));
  assert.equal(claim({}).length, 1);
  assert.doesNotMatch(claim({})[0].attributes, /disabled/);
  for (const lock of [{ busy: true }, { uncertain: true }, { retryAt: now + 30_000 }]) assert.match(claim(lock)[0].attributes, /disabled/);
  assert.doesNotMatch(render("home", { snapshot }), /data-construction-speedup|Завершить сейчас за/);
});

test("active construction shows its real pearl quote without spending on first press", () => {
  const snapshot = state({ wallet: { coins: 1000, pearls: 400 }, jobs: [construction()] });
  const html = render("home", { snapshot });
  const accelerate = buttons(html).find(button => /aria-label="Завершить сейчас за 4 жемчужины"/.test(button.attributes));
  assert.ok(accelerate);
  assert.doesNotMatch(accelerate.attributes, /disabled/);
  assert.match(accelerate.attributes, /aria-expanded="false"/);
  assert.match(html, /data-item-icon="pearls"/);
  assert.doesNotMatch(html, /Подтвердить завершение за/);
  for (const lock of [{ busy: true }, { uncertain: true }, { retryAt: now + 30_000 }]) {
    const button = buttons(render("home", { snapshot, ...lock })).find(button => /aria-label="Завершить сейчас за/.test(button.attributes));
    assert.match(button.attributes, /disabled/);
  }
});

test("insufficient pearls explain the shortfall and the server catalog supplies pricing", () => {
  const snapshot = state({ jobs: [construction()] });
  snapshot.catalog.constructionSpeedup.pricingPoints = [{ seconds: 60, pearls: 2 }, { seconds: 500, pearls: 20 }];
  const html = render("home", { snapshot });
  const button = buttons(html).find(button => /aria-label="Завершить сейчас за 10 жемчужин"/.test(button.attributes));
  assert.match(button.attributes, /disabled/);
  assert.match(text(html), /Не хватает жемчужин: 10/);
});

test("a paid production order remains claimable before upgrading its station", () => {
  const recipe = economyCatalog.recipes.find(entry => entry.id === "make_planks");
  const job = construction({ kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null,
    rewards: recipe.rewards, cost: recipe.cost, finishesAt: new Date(now).toISOString() });
  const html = render("workshop", { snapshot: state({ buildings: { home: 2, warehouse: 1, workshop: 1 }, jobs: [job] }) });
  assert.match(html, /Сначала заберите заказ/);
  const collect = buttons(html).find(button => /aria-label="Забрать:/.test(button.attributes));
  assert.ok(collect);
  assert.doesNotMatch(collect.attributes, /disabled/);
  assert.match(buttons(html).find(button => /Улучшить до ур\./.test(button.text)).attributes, /disabled/);
});

test("legacy and new berry orders retain gathering access and block upgrades until claimed", () => {
  const recipe = economyCatalog.recipes.find(entry => entry.id === "grow_berries");
  const collection = { ...recipe.collection, startedAt: null, finishesAt: null };
  for (const stage of [
    { collection: undefined, label: "Собрать", disabled: false },
    { collection, label: "Собрать", disabled: false },
    { collection: { ...collection, startedAt: new Date(now - 4_000).toISOString(), finishesAt: new Date(now + 4_000).toISOString() }, label: "Собирает…", disabled: true },
    { collection: { ...collection, startedAt: new Date(now - 8_000).toISOString(), finishesAt: new Date(now).toISOString() }, label: "В кладовую", disabled: false },
  ]) {
    const job = construction({ kind: "production", targetId: recipe.buildingId, recipeId: recipe.id, targetLevel: null,
      rewards: recipe.rewards, cost: recipe.cost, finishesAt: new Date(now - 8_000).toISOString(), collection: stage.collection });
    const html = render("garden", { snapshot: state({ buildings: { home: 2, warehouse: 1, garden: 1 }, jobs: [job] }) });
    const actions = buttons(html), collect = actions.find(button => button.attributes.includes(`aria-label="${stage.label}:`));
    assert.ok(collect, stage.label);
    assert.equal(/disabled/.test(collect.attributes), stage.disabled, stage.label);
    assert.match(actions.find(button => /Улучшить до ур\./.test(button.text)).attributes, /disabled/);
    assert.match(html, /Сначала заберите заказ/);
    assert.ok(!actions.some(button => /aria-label="Забрать:/.test(button.attributes)), "Berry orders must use the gathering flow instead of direct claiming");
  }
});

test("a maximum-level pantry reports real capacity and does not offer another upgrade", () => {
  const maximum = Math.max(...economyCatalog.buildings.find(building => building.id === "warehouse").levels.map(level => level.level));
  const html = render("warehouse", { snapshot: state({ buildings: { home: 1, warehouse: maximum } }) });
  assert.match(text(html), /Максимум.*Все улучшения получены/);
  assert.match(text(html), /Вместимость кладовой/);
  assert.ok(!buttons(html).some(button => /Улучшить|Начать обустройство/.test(button.text)));
});

test("the claimed maximum home offers a playful finale instead of another-level instructions", () => {
  const maximum = Math.max(...economyCatalog.buildings.find(building => building.id === "home").levels.map(level => level.level));
  const snapshot = state({ buildings: { home: maximum, warehouse: 1 } }), before = structuredClone(snapshot);
  const html = render("home", { snapshot });
  assert.match(text(html), /Поздравляем! Вы прошли игру\./);
  assert.match(html, /data-home-finale="celebration"/);
  assert.ok(buttons(html).some(button => button.text.trim() === "Смотреть титры"));
  assert.ok(buttons(html).some(button => button.text.trim() === "В лес!"));
  assert.doesNotMatch(text(html), /Новый уровень открывает|Все улучшения получены/);
  assert.deepEqual(snapshot, before, "the celebration never mutates progress or rewards");
});

test("a pending final upgrade and a newly added catalog tier never trigger credits early", () => {
  const home = economyCatalog.buildings.find(building => building.id === "home");
  const maximum = Math.max(...home.levels.map(level => level.level));
  for (const finishesAt of [now + 60_000, now]) {
    const html = render("home", { snapshot: state({ buildings: { home: maximum - 1, warehouse: 1 },
      jobs: [construction({ targetLevel: maximum, finishesAt: new Date(finishesAt).toISOString() })] }) });
    assert.doesNotMatch(html, /data-home-finale|Смотреть титры|Вы прошли игру/);
    assert.match(html, /aria-label="Ход улучшения"/);
  }
  const expanded = state({ buildings: { home: maximum, warehouse: 1 } });
  const catalogHome = expanded.catalog.buildings.find(building => building.id === "home");
  catalogHome.levels.push({ ...catalogHome.levels.at(-1), level: maximum + 1 });
  assert.doesNotMatch(render("home", { snapshot: expanded }), /data-home-finale|Вы прошли игру/);
});

test("maximum workshops, storage and restorations retain their own completion state", () => {
  for (const building of economyCatalog.buildings.filter(building => building.id !== "home")) {
    const maximum = Math.max(...building.levels.map(level => level.level));
    const html = render(building.id, { snapshot: state({ buildings: { home: 5, warehouse: 1, [building.id]: maximum } }) });
    assert.doesNotMatch(html, /data-home-finale|Смотреть титры|Вы прошли игру/);
  }
});

test("late pantry expansion has three distinct relic counters and no house, building or coin gate", () => {
  const snapshot = state({ buildings: { home: 1, warehouse: 9 }, wallet: { coins: 0, pearls: 0 }, inventory: { ancient_core: 10, moon_crystal: 3, living_resin: 3 } });
  const html = render("warehouse", { snapshot });
  assert.match(text(html), /Вместимость кладовой 450 500 \+50 мест/);
  for (const id of ["ancient_core", "moon_crystal", "living_resin"]) assert.match(html, new RegExp(`data-relic="${id}"`));
  assert.equal((html.match(/width="34" height="34"/g) ?? []).length, 3);
  assert.match(text(html), /Древнее ядро 10 \/ 10/);
  assert.match(text(html), /Лунный кристалл 3 \/ 3/);
  assert.match(text(html), /Живая смола 3 \/ 3/);
  assert.doesNotMatch(buttons(html).find(button => /Улучшить до ур\. 10/.test(button.text)).attributes, /disabled/);
  assert.doesNotMatch(html, /Нужны улучшения|data-item-icon="coins"|Купить.*жемч/);
  snapshot.inventory.living_resin = 2;
  const missing = render("warehouse", { snapshot });
  assert.match(text(missing), /Живая смола 2 \/ 3/);
  assert.match(missing, /data-relic="living_resin" data-missing="true"/);
  assert.match(buttons(missing).find(button => /Улучшить до ур\. 10/.test(button.text)).attributes, /disabled/);
});

test("relic cost navigation separates an available project reward from chance finds and respects their actual home unlock", () => {
  const navigation = { canOpen() { return true; }, open() {}, explore() {} };
  const snapshot = state({ buildings: { home: economyCatalog.rareDrops.requiredHomeLevel, warehouse: 3 }, inventory: {} });
  const pending = render("warehouse", { snapshot, navigation });
  const pendingFinds = buttons(pending).filter(button => /aria-label="Где искать:/.test(button.attributes));
  assert.equal(pendingFinds.length, 2);
  assert.ok(pendingFinds.some(button => /Где искать: Древнее ядро/.test(button.attributes)));
  assert.ok(pendingFinds.some(button => /Где искать: Лунный кристалл/.test(button.attributes)));
  assert.ok(!pendingFinds.some(button => /Где искать: Живая смола/.test(button.attributes)));
  assert.match(text(pending), /Гарантированный источник: завершите проект к дому 4.*Награда: Живая смола × 1/);
  snapshot.stageOrders = { version: 1, stages: { 3: { step: 8, completed: true, terms: null, completionRewards: { living_resin: 1 } } } };
  const html = render("warehouse", { snapshot, navigation });
  assert.equal(buttons(html).filter(button => /aria-label="Где искать:/.test(button.attributes)).length, 3);
  assert.doesNotMatch(html, /Гарантированный источник: завершите проект/);
  assert.match(html, /конкретный предмет не гарантирован/);
  assert.doesNotMatch(html, /Где получить: (Древнее ядро|Лунный кристалл|Живая смола)/);
  snapshot.buildings.home = economyCatalog.rareDrops.requiredHomeLevel - 1;
  const locked = render("warehouse", { snapshot, navigation });
  assert.ok(!buttons(locked).some(button => /aria-label="Где искать:/.test(button.attributes)));
  assert.ok(text(locked).includes(`Находки реликвий в вылазках доступны с домом ур. ${economyCatalog.rareDrops.requiredHomeLevel}.`));
  snapshot.inventory = { ...economyCatalog.buildings.find(building => building.id === "warehouse").levels.find(level => level.level === 4).cost.items };
  assert.doesNotMatch(render("warehouse", { snapshot, navigation }), /Находки реликвий в вылазках доступны с домом/);
});


test("pantry expansion shows only its real capacity gain, without dependent building upgrades", () => {
  const html = render("warehouse", { snapshot: state({ buildings: { home: 2, warehouse: 1, workshop: 1 } }) });
  assert.match(text(html), /Вместимость кладовой 50 100 \+50 мест/);
  assert.doesNotMatch(html, /Развитие хозяйства|Дом Мохлика|Ягодный куст|Можно развивать|Новые рецепты|другие постройки/);
  assert.match(text(html), /Доска 0 \/ 3/);
  assert.match(text(html), /Камень 0 \/ 2/);
  assert.match(text(html), /Верёвка 0 \/ 2/);
});

test("workshop upgrade presents only its two unit products, with recipe details initially closed", () => {
  const html = render("workshop", { snapshot: state({ buildings: { home: 3, warehouse: 1, workshop: 1, woodlot: 2, kiln: 2 } }) });
  const products = buttons(html).filter(button => /data-recipe=/.test(button.attributes));
  assert.deepEqual(products.map(button => button.attributes.match(/data-recipe="([^"]+)"/)[1]), ["make_metal_parts", "weave_cloth"]);
  assert.ok(products.every(button => /aria-expanded="false"/.test(button.attributes)));
  assert.match(text(html), /Металлическая деталь ×1 · 30 мин/);
  assert.match(text(html), /Полотно ×1 · 40 мин/);
  assert.doesNotMatch(html, /Набор · 3 вида|data-recipe="workshop_overnight"/);
  assert.doesNotMatch(html, /Развитие хозяйства|Дом Мохлика|Старый лес|Результат рецепта/);
});

test("a furnace upgrade does not claim that it manufactures workshop products unlocked by the furnace", () => {
  const html = render("kiln", { snapshot: state({ buildings: { home: 3, warehouse: 1, workshop: 1, quarry: 2, kiln: 1 } }) });
  assert.deepEqual(buttons(html).filter(button => /data-recipe=/.test(button.attributes)).map(button => button.attributes.match(/data-recipe="([^"]+)"/)[1]), ["smelt_iron"]);
  assert.doesNotMatch(html, /Металлическая деталь|Сделать металлические детали/);
});

test("the first furnace previews one charcoal and one brick per separate second-stage job", () => {
  const html = render("kiln", { snapshot: state({ buildings: { home: 2, warehouse: 1, workshop: 1, quarry: 2, kiln: 0 } }) });
  const products = buttons(html).filter(button => /data-recipe=/.test(button.attributes));
  assert.deepEqual(products.map(button => button.attributes.match(/data-recipe="([^"]+)"/)[1]), ["make_charcoal", "fire_bricks"]);
  assert.match(products[0].text, /Древесный уголь ×1 · 2 мин/);
  assert.match(products[1].text, /Кирпич ×1 · 3 мин/);
  assert.doesNotMatch(html, /data-recipe="smelt_iron"/);
});

test("home previews each opportunity with explicit collapsed disclosures for additional requirements", () => {
  const html = render("home");
  assert.match(text(html), /Новый облик дома Можно развивать постройки до ур\. 2/);
  assert.match(html, /aria-roledescription="карусель"/);
  assert.doesNotMatch(html, /<details/);
  assert.match(text(html), /Каменоломня.*Печь.*Добыть камень.*Добыть глину.*Рынок между игроками/);
  for (const id of ["home", "building:quarry", "building:kiln", "route:quarry_stone", "route:quarry_clay", "market"]) assert.ok(html.includes(`data-upgrade-benefit="${id}"`));
  assert.doesNotMatch(html, /data-upgrade-benefit="route:cave"|data-upgrade-benefit="route:quarry_stone_overnight"/);
  assert.match(buttons(html).find(button => /aria-label="Предыдущая возможность"/.test(button.attributes)).attributes, /disabled/);
  assert.doesNotMatch(buttons(html).find(button => /aria-label="Следующая возможность"/.test(button.attributes)).attributes, /disabled/);
  assert.match(text(html), /Торговля Рынок между игроками Покупайте материалы и продавайте свои запасы\. Ещё условия/);
  assert.doesNotMatch(html, /<section[^>]*aria-label="Подробнее: Рынок между игроками"/, "prerequisites open only on an explicit card press");
  assert.doesNotMatch(text(html), /Нужно завершить вылазок/);
  assert.doesNotMatch(html, /Развитие хозяйства|Новых рецептов|Выплавить железо/);
});

test("every next home tier previews its new berry and dish with the real station and distinct food effects", () => {
  for (const [level, crop, dish] of [[2, "grow_blueberries", "cook_blueberry_compote"], [3, "grow_currants", "cook_currant_jelly"],
    [4, "grow_blackberries", "cook_blackberry_preserve"], [5, "grow_cranberries", "cook_cranberry_glaze"]]) {
    const html = render("home", { snapshot: state({ buildings: { home: level - 1, warehouse: 1 } }) });
    assert.ok(html.includes(`data-upgrade-benefit="recipe:${crop}"`));
    assert.ok(html.includes(`data-upgrade-benefit="recipe:${dish}"`));
    const recipe = economyCatalog.recipes.find(entry => entry.id === dish);
    const meal = economyCatalog.food.meals.find(entry => recipe.rewards[entry.itemId]);
    assert.match(text(html), /Новый рецепт · Ягодный куст/);
    assert.match(text(html), /Новый рецепт · Костёр/);
    assert.ok(text(html).includes(`Вылазка +${meal.heroSpeedBps / 100}% · стройка +${meal.builderSpeedBps / 100}% скорости`));
    assert.match(text(html), /Ещё условия/);
  }
});


test("mine route cards retain actual yields, times and the additional home requirements", () => {
  const html = render("quarry", { snapshot: state({ buildings: { home: 1, warehouse: 1 } }) });
  for (const id of ["cave", "deep_cave", "quarry_stone", "quarry_stone_overnight"]) assert.ok(html.includes(`data-upgrade-benefit="route:${id}"`));
  assert.match(text(html), /Новая добыча · 1 ч Вход в пещеру Камень ×8 Железная руда ×4 Ещё условия/);
  assert.match(text(html), /Новая добыча · 4 ч Глубокий проход Камень ×30 Железная руда ×15 Ещё условия/);
  assert.match(text(html), /Новая добыча · 3 мин Добыть камень Камень ×1 Ещё условия/);
  assert.match(html, /aria-label="Подробнее: Вход в пещеру" aria-expanded="false"/);
  assert.doesNotMatch(html, /<section[^>]*aria-label="Подробнее:/);
  assert.doesNotMatch(text(html), /Для этой добычи/);
  assert.match(text(html), /Шахта работает независимо от Мохлика/);
  assert.match(html, /data-item-icon="stone"/);
});

test("fishing cards preview only gear unlocked by this home level and never promise a guaranteed delivery", () => {
  for (const level of [2, 3, 4, 5]) {
    const html = render("home", { snapshot: state({ buildings: { home: level - 1, warehouse: 1 } }) });
    const ids = [...html.matchAll(/data-upgrade-benefit="fishing:([^"]+)"/g)].map(match => match[1]);
    const expected = [...economyCatalog.fishing.rods, ...economyCatalog.fishing.hooks, ...economyCatalog.fishing.baits]
      .filter(item => item.requiredHomeLevel === level).map(item => item.id ?? item.itemId);
    assert.deepEqual(ids, expected);
    for (const rod of economyCatalog.fishing.rods.filter(item => item.requiredHomeLevel === level)) assert.ok(html.includes(`data-fishing-rod="${rod.id}"`));
    if (expected.length) assert.match(text(html), /Сможет появиться в новых поставках/);
  }
});


test("home, bridge and lighthouse keep future conditions closed while their actual building cost remains visible", () => {
  for (const stationId of ["home", "bridge", "lighthouse"]) {
    const html = render(stationId);
    assert.match(html, /aria-label="Что изменится"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /<section[^>]*aria-label="Подробнее:/);
    assert.match(html, /aria-label="Подготовка к улучшению"/);
    assert.match(html, /aria-label="Стоимость"/);
    assert.match(text(html), /Потребуется/);
  }
});
