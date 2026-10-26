import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const money = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const relations = await vite.ssrLoadModule("/features/economy/domain/trade-relations.ts");
const effort = await vite.ssrLoadModule("/features/economy/domain/order-effort.ts");
const { fishingOfferUnitPrice } = await vite.ssrLoadModule("/features/economy/domain/fishing-shop.ts");
const { leaftailShopView } = await vite.ssrLoadModule("/features/economy/domain/leaftail-shop.ts");
const catalog = model.economyCatalog;
const vectors = JSON.parse(await readFile(new URL("../apps/api/src/test/resources/world/trade-relations-vectors.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-23T12:00:00.000Z"), day = 86400000, week = 7 * day;
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const developed = () => {
  const state = fresh();
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.progression.recipes = Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, 100]));
  state.fishing.ownedRods = catalog.fishing.rods.map(rod => rod.id);
  state.fishing.ownedHooks = catalog.fishing.hooks.map(hook => hook.id);
  state.wallet.coins = 1_000_000;
  return state;
};
const command = (action, targetId, extra = {}) => ({ requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0,
  action, targetId, quantity: 1, totalPrice: 0, ...extra });
const apply = (state, action, targetId, at = now, extra = {}) => rules.applyEconomyCommand(state, command(action, targetId, extra), at, () => crypto.randomUUID(), {}, () => 0);
const unchangedFailure = (state, action, target, code, at = now, extra = {}) => {
  const before = structuredClone(state);
  assert.throws(() => apply(state, action, target, at, extra), { code });
  assert.deepEqual(state, before, "a rejected command must preserve stock, jobs, payouts and every reputation counter");
};
const fill = (state, items) => { for (const [id, quantity] of Object.entries(items)) state.inventory[id] = (state.inventory[id] ?? 0) + quantity; };

// Backward compatibility and the absence of retroactive rewards are distinct
// from normal progression: a read or a legacy lifetime counter is not a grant.
test("old states gain empty synchronized relationships without retroactive experience", () => {
  const state = fresh(); delete state.tradeRelations;
  const before = structuredClone(state);
  const parsed = model.economyTradeRelationsSchema.parse(undefined);
  assert.deepEqual(parsed, { version: 1, reputation: {}, dailyCycle: -1, dailyOrderXp: {}, dailyPurchaseXp: {}, weekly: null, weeklyAvailableAt: null, completedWeekly: 0 });
  state.residentOrders.completed = 99999; state.residentOrders.earnedCoins = 500000;
  assert.equal(relations.tradeRelationProgress(state, "builder", catalog, now).xp, 0);
  assert.deepEqual(relations.tradeRelationsState(state), parsed);
  assert.deepEqual(state.inventory, before.inventory);
  assert.equal(state.tradeRelations, undefined, "deriving empty state cannot write or grant progress");
});

test("rank thresholds give only the resident's capped benefit and never decay", () => {
  const state = developed();
  for (const [index, rank] of catalog.tradeRelations.ranks.entries()) {
    state.tradeRelations.reputation.builder = rank.requiredXp;
    assert.equal(relations.tradeRelationProgress(state, "builder", catalog, now).rankIndex, index);
    assert.equal(relations.tradeRelationBonusBps(state, "builder"), rank.bonusBps);
    assert.equal(relations.tradeRelationBonusBps(state, "lopukh"), 0);
    if (index > 0) {
      state.tradeRelations.reputation.builder--;
      assert.equal(relations.tradeRelationProgress(state, "builder", catalog, now).rankIndex, index - 1);
    }
  }
  state.tradeRelations.reputation.builder = 1_000_000;
  assert.equal(relations.tradeRelationBonusBps(state, "builder"), 1000);
  assert.equal(relations.tradeRelationProgress(state, "builder", catalog, now + 365 * day).xp, 1_000_000);
});

test("ordinary daily cap, purchase cap and weekly reputation have independent budgets", () => {
  const state = fresh();
  assert.equal(relations.awardTradeOrderXp(state, "builder", 58, now), 58);
  assert.equal(relations.awardTradeOrderXp(state, "builder", 18, now), 2);
  assert.equal(relations.awardTradeOrderXp(state, "builder", 18, now), 0);
  assert.equal(relations.awardTradeOrderXp(state, "plesk", 18, now), 18);
  assert.equal(relations.awardTradePurchaseXp(state, "builder", now), 1);
  assert.equal(relations.awardTradePurchaseXp(state, "builder", now), 1);
  assert.equal(relations.awardTradePurchaseXp(state, "builder", now), 0);
  assert.equal(relations.awardTradeOrderXp(state, "builder", 40, now, true), 40);
  const progress = relations.tradeRelationProgress(state, "builder", catalog, now);
  assert.equal(progress.xp, 102); assert.equal(progress.dailyOrderXpRemaining, 0); assert.equal(progress.dailyPurchaseXpRemaining, 0);
  assert.equal(relations.awardTradeOrderXp(state, "builder", 10, now - day), 0, "clock rollback cannot reopen the previous day's allowance");
  assert.equal(relations.awardTradePurchaseXp(state, "builder", now - day), 0);
  assert.equal(relations.tradeRelationProgress(state, "builder", catalog, now - day).dailyOrderXpRemaining, 0);
  assert.equal(relations.awardTradeOrderXp(state, "builder", 10, now + day), 10);
  assert.equal(relations.tradeRelationProgress(state, "builder", catalog, now + day).dailyPurchaseXpRemaining, 2);
});

test("every introduced profession receives an obtainable ordinary card; locked residents remain empty", () => {
  const state = fresh();
  assert.deepEqual(food.residentOrderBoard(state, now).offers.map(offer => offer.residentId), ["plesk", "builder"]);
  const developedState = developed(), before = structuredClone(developedState);
  const board = food.residentOrderBoard(developedState, now);
  assert.deepEqual(board.offers.map(offer => offer.residentId), ["plesk", "builder", "lopukh", "kamneshmyg", "leaftail"]);
  for (const offer of board.offers) {
    assert(offer.reputationXp > 0 && offer.reputationXp <= 18);
    assert(offer.effortSeconds >= offer.manufacturingSeconds);
    assert(Object.keys(offer.items).every(id => effort.obtainableResidentOrderItems(developedState).has(id)));
  }
  assert.deepEqual(developedState, before, "preview does not create a board or advance reputation");
});

test("new reward fingerprints include XP and work while legacy promise fingerprints remain unchanged", () => {
  const legacy = { id: "builder_wood_supply", residentId: "builder", name: "Saved", items: { wood: 8 }, coins: 400 };
  assert.equal(food.residentOrderFingerprint(legacy), "552746322");
  assert.notEqual(food.residentOrderFingerprint({ ...legacy, reputationXp: 2 }), food.residentOrderFingerprint(legacy));
  assert.notEqual(food.residentOrderFingerprint({ ...legacy, reputationXp: 2 }), food.residentOrderFingerprint({ ...legacy, reputationXp: 3 }));
});

test("v2 migration preserves exact old IDs goods money and zero XP while adding missing professions", () => {
  const state = developed(), cycle = Math.floor(now / (catalog.food.orders.refreshSeconds * 1000));
  const legacy = [
    { id: "saved_fish", residentId: "plesk", name: "Old fish", items: { fish_common: 1 }, coins: 100 },
    { id: "saved_wood", residentId: "builder", name: "Old wood", items: { wood: 1 }, coins: 400 },
    { id: "saved_rope", residentId: "builder", name: "Old rope", items: { rope: 1 }, coins: 180 },
  ];
  state.residentOrders = { ...food.initialResidentOrders(), version: 2, cycle, slots: legacy.map((terms, index) => ({ sequence: index,
    readyAt: new Date(now).toISOString(), templateId: terms.id, terms })) };
  const expectedIds = legacy.map((terms, index) => `order2_${cycle}_${index}_${index}_${food.residentOrderFingerprint(terms)}`);
  const board = food.residentOrderBoard(state, now);
  assert.deepEqual(board.offers.slice(0, 3).map(offer => offer.id), expectedIds);
  assert.equal(board.offers.length, 6);
  assert.deepEqual(new Set(board.offers.map(offer => offer.residentId)), new Set(relations.TRADE_RESIDENT_IDS));
  for (let i = 0; i < 3; i++) { assert.deepEqual(board.offers[i].items, legacy[i].items); assert.equal(board.offers[i].coins, legacy[i].coins); assert.equal(board.offers[i].reputationXp, undefined); }
  fill(state, board.offers[2].items);
  const coins = state.wallet.coins;
  apply(state, "complete_resident_order", board.offers[2].id);
  assert.equal(state.wallet.coins, coins + 180); assert.equal(state.tradeRelations.reputation.builder ?? 0, 0);
  assert.equal(state.residentOrders.slots[2].retired, true);
  assert(!food.residentOrderBoard(state, now).offers.some(offer => offer.slot === 2));
  const nextCycle = food.residentOrderBoard(state, now + catalog.food.orders.refreshSeconds * 1000);
  assert.equal(nextCycle.offers.length, 5);
  assert.deepEqual(nextCycle.offers.map(offer => offer.residentId), relations.TRADE_RESIDENT_IDS);
});

test("removing an old duplicate never needs pearls or spends a replacement allowance", () => {
  const state = developed(), cycle = Math.floor(now / (catalog.food.orders.refreshSeconds * 1000));
  const first = { id: "old_builder_one", residentId: "builder", name: "One", items: { wood: 1 }, coins: 10 };
  const second = { id: "old_builder_two", residentId: "builder", name: "Two", items: { rope: 1 }, coins: 20 };
  const fish = { id: "old_fish", residentId: "plesk", name: "Fish", items: { fish_common: 1 }, coins: 40 };
  state.residentOrders = { ...food.initialResidentOrders(), version: 2, cycle,
    replacementCycle: Math.floor(now / (catalog.food.orders.replacementWindowSeconds * 1000)), freeReplacementsUsed: 3,
    slots: [fish, first, second].map(terms => ({ sequence: 0, readyAt: new Date(now).toISOString(), templateId: terms.id, terms })) };
  state.wallet.pearls = 0;
  const target = food.residentOrderBoard(state, now).offers.find(offer => offer.slot === 2);
  const beforeCoins = state.wallet.coins;
  apply(state, "replace_resident_order", target.id);
  assert.equal(state.wallet.pearls, 0); assert.equal(state.wallet.coins, beforeCoins);
  assert.equal(state.residentOrders.freeReplacementsUsed, 3);
  assert.equal(state.residentOrders.slots[2].retired, true);
  assert.equal(state.tradeRelations.reputation.builder ?? 0, 0);
});

test("ordinary completion credits authored effort XP once while failed/replaced cards cannot grant it", () => {
  const state = developed(), offer = food.residentOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  state.inventory = {};
  unchangedFailure(state, "complete_resident_order", offer.id, "ECONOMY_RESOURCES");
  fill(state, offer.items);
  apply(state, "complete_resident_order", offer.id);
  assert.equal(state.tradeRelations.reputation.builder, offer.reputationXp);
  unchangedFailure(state, "complete_resident_order", offer.id, "ECONOMY_ORDER_CHANGED");
  const next = food.residentOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  apply(state, "replace_resident_order", next.id);
  assert.equal(state.tradeRelations.reputation.builder, offer.reputationXp);
});

test("weekly choices require complete accessible chains and explicit reviewed selection", () => {
  const state = fresh(); assert.equal(relations.weeklyOrderBoard(state, now).offers.length, 0);
  const advanced = developed(), board = relations.weeklyOrderBoard(advanced, now);
  assert.equal(board.offers.length, 5);
  assert.equal(new Set(board.offers.map(offer => offer.residentId)).size, 5);
  assert.deepEqual(relations.weeklyOrderBoard(advanced, now + 1000).offers, board.offers);
  const choice = board.offers[0];
  unchangedFailure(advanced, "accept_weekly_order", "weekly_choice1_invalid", "ECONOMY_WEEKLY_CHANGED");
  unchangedFailure(advanced, "accept_weekly_order", choice.id, "INVALID_ECONOMY_COMMAND", now, { quantity: 2 });
  unchangedFailure(advanced, "accept_weekly_order", choice.id, "INVALID_ECONOMY_COMMAND", now, { totalPrice: 1 });
  unchangedFailure(advanced, "accept_weekly_order", choice.id, "INVALID_ECONOMY_COMMAND", now, { fishSelection: {} });
  apply(advanced, "accept_weekly_order", choice.id);
  assert.equal(advanced.tradeRelations.weekly.stage, 0);
  assert.equal(Date.parse(advanced.tradeRelations.weekly.expiresAt), now + week);
  assert.equal(advanced.tradeRelations.weeklyAvailableAt, new Date(now + week).toISOString());
  assert.deepEqual(advanced.tradeRelations.weekly.stages, choice.stages);
  unchangedFailure(advanced, "accept_weekly_order", choice.id, "ECONOMY_WEEKLY_UNAVAILABLE");
});

test("weekly future stages freeze their price XP and requirements and each stage pays only once", () => {
  const state = developed(), choice = relations.weeklyOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  apply(state, "accept_weekly_order", choice.id);
  const frozen = structuredClone(state.tradeRelations.weekly.stages), template = catalog.tradeRelations.weekly.templates.find(item => item.id === choice.templateId);
  const savedTemplate = structuredClone(template);
  try {
    for (const stage of template.stages) { stage.coins++; stage.reputationXp++; stage.items = { wood: 99 }; }
    template.requiredBuildings = { lighthouse: 100 };
    let coins = state.wallet.coins, xp = 0;
    for (let index = 0; index < 3; index++) {
      const board = relations.weeklyOrderBoard(state, now), offer = board.active;
      assert.equal(offer.stage, index); assert.equal(offer.coins, frozen[index].coins); assert.deepEqual(offer.items, frozen[index].items);
      assert.equal(board.canChoose, false); assert.equal(board.offers.length, 0);
      fill(state, offer.items);
      apply(state, "complete_resident_order", offer.id);
      coins += frozen[index].coins; xp += frozen[index].reputationXp;
      assert.equal(state.wallet.coins, coins); assert.equal(state.tradeRelations.reputation.builder, xp);
      unchangedFailure(state, "complete_resident_order", offer.id, "ECONOMY_WEEKLY_CHANGED");
    }
    assert.equal(state.tradeRelations.weekly, null); assert.equal(state.tradeRelations.completedWeekly, 1);
    assert.equal(relations.weeklyOrderBoard(state, now).canChoose, false);
    assert.equal(relations.weeklyOrderBoard(state, now + week).canChoose, true);
  } finally { Object.assign(template, savedTemplate); }
});

test("weekly finale freezes ten visible pearls, checks capacity before debit and cannot pay twice", () => {
  const state = developed(), choice = relations.weeklyOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  assert.equal(choice.pearls, 20);
  assert.deepEqual(choice.stages.map(stage => stage.pearls ?? 0), [0, 0, 20]);
  apply(state, "accept_weekly_order", choice.id);
  const template = catalog.tradeRelations.weekly.templates.find(entry => entry.id === choice.templateId);
  const saved = structuredClone(template.stages);
  try {
    template.stages.at(-1).pearls = 200;
    const initialPearls = state.wallet.pearls;
    for (let index = 0; index < 2; index++) {
      const active = relations.weeklyOrderBoard(state, now).active;
      fill(state, active.items); apply(state, "complete_resident_order", active.id);
      assert.equal(state.wallet.pearls, initialPearls);
    }
    const final = relations.weeklyOrderBoard(state, now).active;
    assert.equal(final.pearls, 20);
    fill(state, final.items);
    const { ECONOMY_MAX_PEARLS } = money;
    state.wallet.pearls = ECONOMY_MAX_PEARLS - 10;
    unchangedFailure(state, "complete_resident_order", final.id, "ECONOMY_CAPACITY");
    state.wallet.pearls = initialPearls;
    apply(state, "complete_resident_order", final.id);
    assert.equal(state.wallet.pearls, initialPearls + 20);
    unchangedFailure(state, "complete_resident_order", final.id, "ECONOMY_WEEKLY_CHANGED");
  } finally { template.stages = saved; }
});

test("legacy accepted weekly terms without pearls keep their original fingerprint and pay no new bonus", () => {
  const state = developed(), choice = relations.weeklyOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  apply(state, "accept_weekly_order", choice.id);
  for (const stage of state.tradeRelations.weekly.stages) delete stage.pearls;
  const before = state.wallet.pearls;
  for (let index = 0; index < 3; index++) {
    const active = relations.weeklyOrderBoard(state, now).active;
    assert.equal(relations.tradeOrderFingerprint(active), relations.tradeOrderFingerprint({ ...active, pearls: 0 }));
    fill(state, active.items); apply(state, "complete_resident_order", active.id);
  }
  assert.equal(state.wallet.pearls, before);
});

test("clock rollback cannot deliver a weekly stage before its accepted start", () => {
  const state = developed(), acceptedAt = now + day;
  const choice = relations.weeklyOrderBoard(state, acceptedAt).offers.find(offer => offer.residentId === "builder");
  apply(state, "accept_weekly_order", choice.id, acceptedAt);
  const offer = relations.weeklyOrderBoard(state, acceptedAt).active;
  fill(state, offer.items);
  unchangedFailure(state, "complete_resident_order", offer.id, "ECONOMY_WEEKLY_UNAVAILABLE", now);
});

test("weekly expiry rejects delivery before debit and preserves already earned stage rewards", () => {
  const state = developed(), choice = relations.weeklyOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  apply(state, "accept_weekly_order", choice.id);
  const first = relations.weeklyOrderBoard(state, now).active;
  fill(state, first.items); apply(state, "complete_resident_order", first.id);
  const second = relations.weeklyOrderBoard(state, now).active;
  fill(state, second.items);
  unchangedFailure(state, "complete_resident_order", second.id, "ECONOMY_WEEKLY_EXPIRED", now + week);
  assert.equal(state.tradeRelations.reputation.builder, first.reputationXp);
  assert.equal(state.tradeRelations.completedWeekly, 0);
  assert.equal(relations.weeklyOrderBoard(state, now + week).canChoose, true);
});

test("professional speed affects only newly started work and active food retains frozen construction speed", () => {
  const state = developed(); state.tradeRelations.reputation = { builder: 4200, lopukh: 4200, kamneshmyg: 4200 };
  state.inventory = { wood: 100, stone: 100, grilled_fish: 2, fish_soup: 2 };
  apply(state, "start_production", "gather_wood");
  const wood = state.jobs.at(-1), baseWood = catalog.recipes.find(recipe => recipe.id === "gather_wood").seconds;
  assert.equal(wood.tradeSpeedBps, 1000); assert.equal(Date.parse(wood.finishesAt) - now, Math.ceil(baseWood * 10000 / 11000) * 1000);
  apply(state, "start_exploration", "quarry_stone");
  const mining = state.jobs.at(-1), baseMining = catalog.explorations.find(route => route.id === "quarry_stone").seconds;
  assert.equal(mining.tradeSpeedBps, 1000); assert.equal(Date.parse(mining.finishesAt) - now, Math.ceil(baseMining * 10000 / 11000) * 1000);
  state.jobs = [];
  state.buildings.workshop = 1;
  const target = catalog.buildings.find(building => building.id === "workshop").levels.find(level => level.level === 2);
  fill(state, target.cost.items);
  apply(state, "start_construction", "workshop");
  const construction = state.jobs[0], originalFinish = construction.finishesAt;
  assert.equal(construction.tradeSpeedBps, 1000);
  state.tradeRelations.reputation.builder = 0;
  assert.equal(construction.finishesAt, originalFinish, "rank edits do not change an already accepted deadline");
  const meal = catalog.food.meals.find(meal => meal.itemId === "fish_soup"), remaining = Date.parse(construction.finishesAt) - now;
  apply(state, "feed_builder", "fish_soup");
  assert.equal(Date.parse(construction.finishesAt) - now, Math.ceil(remaining * 11000 / (11000 + meal.builderSpeedBps)));
  assert.equal(construction.tradeSpeedBps, 1000);
});

test("paid purchases grant limited XP only after a successful debit", () => {
  const state = developed(); state.fishingShop = { id: crypto.randomUUID(), openedAt: new Date(now).toISOString(), refreshAt: new Date(now + day).toISOString(), refreshPricePearls: 100,
    offers: [{ id: "common-stock", kind: "fish", itemId: "fish_common", unitPrice: 120, remaining: 6 }] };
  for (let index = 0; index < 3; index++) {
    const offer = state.fishingShop.offers[0];
    apply(state, "buy_fishing_item", offer.id, now, { totalPrice: fishingOfferUnitPrice(state, offer) });
  }
  assert.equal(state.tradeRelations.reputation.plesk, 2); assert.equal(state.tradeRelations.dailyPurchaseXp.plesk, 2);
  const offer = state.fishingShop.offers[0]; state.wallet.coins = 0;
  unchangedFailure(state, "buy_fishing_item", offer.id, "ECONOMY_RESOURCES", now, { totalPrice: offer.unitPrice });
  assert.equal(state.tradeRelations.reputation.plesk, 2);
});

test("buying and reselling bait at either resident cannot manufacture free reputation", () => {
  for (const existingXp of [0, 4200]) {
    const state = developed();
    state.tradeRelations.reputation = { plesk: existingXp, leaftail: existingXp };
    const initialCoins = state.wallet.coins;
    for (let index = 0; index < 3; index++) {
      const at = now + index * day;
      state.fishingShop = { id: `bait-${index}`, openedAt: new Date(at).toISOString(), refreshAt: new Date(at + day).toISOString(), refreshPricePearls: 0,
        offers: [{ id: `bait-offer-${index}`, kind: "bait", itemId: "crumb_bait", unitPrice: 1, remaining: 20 }] };
      const offer = state.fishingShop.offers[0];
      apply(state, "buy_fishing_item", offer.id, at, { totalPrice: fishingOfferUnitPrice(state, offer) });
      apply(state, "sell", offer.itemId, at);
      const leaf = leaftailShopView({ ...state, ownerPublicId: "0123-4567-89AB" }, at).offers.find(item => item.kind === "bait");
      assert(leaf, "the actual personal daily supply must contain bait");
      apply(state, "buy_leaftail_item", leaf.targetId, at, { totalPrice: leaf.unitPrice });
      apply(state, "sell", leaf.itemId, at);
    }
    assert.equal(state.wallet.coins, initialCoins, "the former zero-loss cycle is really exercised");
    assert.deepEqual(state.tradeRelations.reputation, { plesk: existingXp, leaftail: existingXp }, "already earned XP stays, the cycle adds none");
    assert.deepEqual(state.tradeRelations.dailyPurchaseXp, {}, "bait does not consume the allowance for eligible purchases");
  }
});

test("a frozen refundable fish quote grants no XP but a genuine expense still does", () => {
  const state = developed(), resale = catalog.items.find(item => item.id === "fish_common").baseSellPrice;
  const initial = state.wallet.coins;
  state.fishingShop = { id: "old-fish", openedAt: new Date(now).toISOString(), refreshAt: new Date(now + day).toISOString(), refreshPricePearls: 0,
    offers: [{ id: "refundable-fish", kind: "fish", itemId: "fish_common", unitPrice: resale, remaining: 6 }] };
  apply(state, "buy_fishing_item", "refundable-fish", now, { totalPrice: resale });
  apply(state, "sell_fish", "fish_common");
  assert.equal(state.wallet.coins, initial);
  assert.equal(state.tradeRelations.reputation.plesk ?? 0, 0);
  assert.equal(relations.tradePurchaseXpEligible("bait", 100, 0), false);
  assert.equal(relations.tradePurchaseXpEligible("item", 10, 10), false);
  assert.equal(relations.tradePurchaseXpEligible("item", 9, 10), false);
  assert.equal(relations.tradePurchaseXpEligible("item", 11, 10), true);
  assert.equal(relations.tradePurchaseXpEligible("rod", 0), false);
  assert.equal(relations.tradePurchaseXpEligible("rod", 1), true);
});

test("work estimates include raw inputs and upstream processing and flag random catches", () => {
  const state = developed(), mixed = effort.orderEffort(state, { dried_berries: 1, rope: 1 });
  assert.equal(mixed.obtainable, true); assert.equal(mixed.manufacturingSeconds, 900);
  assert(mixed.effortSeconds > mixed.manufacturingSeconds); assert(mixed.criticalPathSeconds < mixed.effortSeconds);
  const fish = effort.orderEffort(state, { fish_legendary: 1 });
  assert.equal(fish.obtainable, true); assert.equal(fish.fishingUncertain, true); assert(fish.effortSeconds > 0);
  const locked = effort.orderEffort(fresh(), { reinforced_parts: 1 });
  assert.equal(locked.obtainable, false);
});


test("shared Kotlin vectors match every authored quote, weekly stage and rank boundary", () => {
  assert.equal(vectors.orders.length, catalog.food.orders.templates.length);
  for (const expected of vectors.orders) {
    const template = catalog.food.orders.templates.find(template => template.id === expected.templateId);
    assert(template, expected.templateId);
    for (const key of ["residentId", "items", "coins", "reputationXp", "effortSeconds", "manufacturingSeconds", "fishingUncertain"])
      assert.deepEqual(template[key], expected[key], `${expected.templateId}:${key}`);
    assert.equal(template.requiredHomeLevel, expected.home);
    assert.deepEqual(template.requiredBuildings, expected.requiredBuildings);
  }
  assert.equal(vectors.weekly.length, catalog.tradeRelations.weekly.templates.length);
  for (const expected of vectors.weekly) {
    const template = catalog.tradeRelations.weekly.templates.find(template => template.id === expected.templateId);
    assert.equal(template.residentId, expected.residentId);
    assert.equal(template.requiredHomeLevel, expected.home);
    for (let index = 0; index < 3; index++) {
      const stage = template.stages[index], quote = expected.stages[index];
      assert.equal(stage.id, quote.templateId);
      for (const key of ["items", "coins", "reputationXp", "effortSeconds", "manufacturingSeconds", "fishingUncertain"])
        assert.deepEqual(stage[key], quote[key], `${expected.templateId}:${index}:${key}`);
    }
  }
  const state = developed();
  for (const expected of vectors.ranks) {
    state.tradeRelations.reputation.builder = expected.xp;
    const progress = relations.tradeRelationProgress(state, "builder", catalog, now);
    assert.equal(progress.rankIndex, expected.rankIndex); assert.equal(progress.bonusBps, expected.bonusBps);
  }
});

test("even maximum daily XP and the largest weekly reward cannot reach the last rank before six weeks", () => {
  const state = fresh(), target = catalog.tradeRelations.ranks.at(-1).requiredXp;
  const weeklyMax = Math.max(...catalog.tradeRelations.weekly.templates.map(template => template.stages.reduce((sum, stage) => sum + stage.reputationXp, 0)));
  let reached = null;
  for (let elapsed = 0; elapsed <= 60; elapsed++) {
    const at = now + elapsed * day;
    for (let order = 0; order < 4; order++) relations.awardTradeOrderXp(state, "builder", 18, at);
    for (let purchase = 0; purchase < 3; purchase++) relations.awardTradePurchaseXp(state, "builder", at);
    if (elapsed % 7 === 0) relations.awardTradeOrderXp(state, "builder", weeklyMax, at, true);
    if ((state.tradeRelations.reputation.builder ?? 0) >= target) { reached = elapsed; break; }
  }
  assert(reached >= vectors.optimisticMinimumElapsedDays, "catalog lower bound also permits a second UTC cap at the start");
  assert(reached >= 42);
});

test("literal UTF-16 and live board vectors pin TS/Kotlin IDs, frozen weekly promises and stage transitions", () => {
  for (const expected of vectors.hashCases) assert.equal(relations.tradeHash(expected.input), expected.expected, expected.input);
  const project = (actual, expected) => Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]]));
  for (const scenario of vectors.idCases) {
    const state = fresh(), at = Date.parse(scenario.now);
    state.buildings = { ...scenario.buildings };
    state.fishing.ownedRods = [...scenario.ownedRods]; state.fishing.ownedHooks = [...scenario.ownedHooks];
    state.progression.recipes = { ...scenario.completedRecipes };
    const ordinary = food.residentOrderBoard(state, at).offers;
    assert.equal(ordinary.length, scenario.ordinary.length, scenario.label);
    ordinary.forEach((offer, index) => assert.deepEqual(project(offer, scenario.ordinary[index]), scenario.ordinary[index], `${scenario.label}:ordinary:${index}`));
    const choices = relations.weeklyOrderBoard(state, at).offers;
    assert.equal(choices.length, scenario.weeklyChoices.length, scenario.label);
    for (let index = 0; index < choices.length; index++) {
      const choice = choices[index], expected = scenario.weeklyChoices[index];
      for (const key of ["id", "templateId", "residentId", "coins", "reputationXp", "effortSeconds", "manufacturingSeconds", "fishingUncertain", "stages"])
        assert.deepEqual(choice[key], expected[key], `${scenario.label}:weekly:${index}:${key}`);
      const accepted = structuredClone(state);
      relations.acceptWeeklyOrder(accepted, choice, at);
      assert.equal(accepted.tradeRelations.weekly.id, expected.savedWeeklyId);
      assert.equal(accepted.tradeRelations.weekly.acceptedAt, expected.acceptedAt);
      assert.equal(accepted.tradeRelations.weekly.expiresAt, expected.expiresAt);
      for (let stage = 0; stage < 3; stage++) {
        accepted.tradeRelations.weekly.stage = stage;
        const active = relations.weeklyOrderBoard(accepted, at).active;
        assert.deepEqual(project(active, expected.activeStages[stage]), expected.activeStages[stage], `${scenario.label}:active:${index}:${stage}`);
        assert.equal(active.stage, stage); assert.equal(active.stages, 3); assert.equal(active.weekly, true);
      }
    }
  }
});
