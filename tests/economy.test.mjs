import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/rules.ts");
const now = Date.now();
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());
const player = () => identities.createDevIdentity("Лесной житель", crypto.randomUUID());
const read = (p, time = now) => economy.getDevEconomy(p.token, time);
const command = (p, action, targetId, quantity = 1, totalPrice = 0, time = now) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, time).revision, action, targetId, quantity, totalPrice: totalPrice * 10,
});
const issue = (p, action, targetId, quantity = 1, time = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, quantity, 0, time), time);
const trade = (p, action, targetId, quantity = 1, totalPrice = 0, time = now) => economy.commandDevEconomyMarket(p.token, command(p, action, targetId, quantity, totalPrice, time), time);
// Test fixture only: production routes deliberately have no balance or item grant command.
function fixture(p, { coins = 5000, items = { wood: 30, stone: 30, berries: 30 }, home = 2, completedExplorations = 1, buildings = {} } = {}) {
  read(p);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.wallet.coins = coins; row.state.inventory = { ...items }; row.state.buildings.home = home; row.state.completedExplorations = completedExplorations;
  Object.assign(row.state.buildings, buildings);
  return row;
}

test("fresh account starts empty with free garden and exploration, cosmetic memory cannot mint goods", () => {
  const p = player(), state = read(p);
  assert.equal(model.economyViewSchema.safeParse(state).success, true);
  assert.deepEqual(state.wallet, { coins: 0, pearls: 0 }); assert.deepEqual(state.inventory, {});
  assert.equal(state.buildings.home, 1); assert.equal(state.buildings.garden, 1);
  assert.equal(state.buildings.warehouse, 1); assert.equal(state.buildings.kiln, 0);
  assert.deepEqual(state.storage, { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 });
  const grown = issue(p, "start_production", "grow_berries").state.jobs[0];
  const walking = issue(p, "start_exploration", "forest").state.jobs.find(job => job.kind === "exploration");
  assert.deepEqual(read(p).inventory, {});
  const returnedAt = Date.parse(walking.finishesAt);
  issue(p, "claim_job", walking.id, 1, returnedAt);
  const collecting = issue(p, "start_collection", grown.id, 1, returnedAt).state.jobs[0];
  const collected = issue(p, "claim_job", grown.id, 1, Date.parse(collecting.collection.finishesAt)).state;
  const expected = { ...grown.rewards };
  for (const [item, amount] of Object.entries(walking.rewards)) expected[item] = (expected[item] ?? 0) + amount;
  assert.deepEqual(collected.inventory, expected);
  assert.equal(collected.completedExplorations, 1);
  assert.deepEqual(issue(p, "sell", "berries", expected.berries).state.wallet, { coins: rules.economyLocalSellPrice(model.economyCatalog.items.find(item => item.id === "berries").baseSellPrice, expected.berries, model.economyCatalog.localBuyer), pearls: 0 });
});

test("new quarry and workshop furnace need home two before spending, while starter gathering stays free", () => {
  for (const id of ["quarry", "kiln"]) {
    const p = player(), target = model.economyCatalog.buildings.find(building => building.id === id).levels[0];
    fixture(p, { coins: target.cost.coins, items: target.cost.items, home: 1, buildings: target.requiredBuildings });
    const before = read(p);
    assert.throws(() => issue(p, "start_construction", id), { code: "ECONOMY_HOME_REQUIRED" });
    assert.deepEqual(read(p), before, "locked construction cannot spend goods, create a job or alter its revision");
  }
  const p = player(), fresh = read(p);
  assert.equal(fresh.buildings.quarry, 0); assert.equal(fresh.buildings.kiln, 0);
  assert.equal(issue(p, "start_production", "grow_berries").state.wallet.coins, 0);
  const forest = issue(p, "start_exploration", "forest").state.jobs.find(job => job.kind === "exploration");
  assert.ok(forest.rewards.stone > 0, "free starter exploration remains an early source of building stone");
  assert.deepEqual(forest.cost, { coins: 0, items: {} });
});

test("an empty account reaches home two with bush and forest goods before opening the quarry and furnace", () => {
  const p = player();
  let clock = now;
  const complete = (action, targetId, quantity = 1) => {
    const started = issue(p, action, targetId, quantity, clock).state;
    const job = started.jobs.at(-1);
    clock = Date.parse(job.finishesAt);
    if (job.collection) {
      const collecting = issue(p, "start_collection", job.id, 1, clock).state.jobs.find(item => item.id === job.id);
      clock = Date.parse(collecting.collection.finishesAt);
    }
    return issue(p, "claim_job", job.id, 1, clock).state;
  };
  assert.deepEqual(read(p).inventory, {});
  for (let cycle = 0; cycle < 8; cycle++) {
    const harvest = complete("start_production", "grow_berries_overnight");
    issue(p, "sell", "berries", harvest.inventory.berries, clock);
  }
  for (let trip = 0; trip < 8; trip++) complete("start_exploration", "forest");
  complete("start_construction", "woodlot");
  complete("start_construction", "workshop");
  complete("start_exploration", "forest");
  complete("start_production", "gather_wood");
  complete("start_production", "make_planks", 6);
  complete("start_production", "make_rope", 2);
  const beforeHome = read(p, clock);
  assert.equal(beforeHome.buildings.home, 1);
  assert.equal(beforeHome.buildings.quarry, 0); assert.equal(beforeHome.buildings.kiln, 0);
  assert.throws(() => trade(p, "create_listing", "fiber", 1, 2, clock), { code: "ECONOMY_MARKET_LOCKED" });
  const upgraded = complete("start_construction", "home");
  assert.equal(upgraded.buildings.home, 2);
  assert.equal(upgraded.buildings.quarry, 0); assert.equal(upgraded.buildings.kiln, 0);
  const listing = trade(p, "create_listing", "fiber", 1, 2, clock).listing;
  assert.equal(listing.quantity, 1, "home two and a claimed exploration permit trading without a quarry");
  trade(p, "cancel_listing", listing.id, 1, 0, clock);

  complete("start_exploration", "forest_camp");
  const mined = complete("start_construction", "quarry");
  assert.equal(mined.buildings.quarry, 1); assert.equal(mined.buildings.kiln, 0);
  complete("start_exploration", "quarry_stone");
  const equipped = complete("start_construction", "kiln");
  assert.equal(equipped.buildings.kiln, 1);
  assert.ok(equipped.wallet.coins >= 0);
});

test("home two furnace is workshop equipment and existing home one producers and jobs remain usable", () => {
  const furnace = model.economyCatalog.buildings.find(building => building.id === "kiln").levels[0];
  const p = player();
  const row = fixture(p, { home: 2, coins: furnace.cost.coins, items: furnace.cost.items, buildings: { quarry: 1, workshop: 0 } });
  assert.throws(() => issue(p, "start_construction", "kiln"), { code: "ECONOMY_BUILDING_REQUIRED" });
  row.state.buildings.workshop = 1;
  assert.equal(issue(p, "start_construction", "kiln").state.jobs[0].targetLevel, 1);

  const legacy = player();
  const legacyRow = fixture(legacy, { home: 1, coins: 0, items: { wood: 2 }, buildings: { quarry: 1, kiln: 1 } });
  const reopening = read(legacy);
  assert.equal(reopening.buildings.quarry, 1); assert.equal(reopening.buildings.kiln, 1);
  const stone = { id: crypto.randomUUID(), kind: "production", targetId: "quarry", recipeId: "quarry_stone", targetLevel: null,
    startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 1800_000).toISOString(),
    rewards: { stone: 8 }, cost: { coins: 0, items: {} }, catalogVersion: 3 };
  legacyRow.state.jobs.push(stone);
  assert.throws(() => issue(legacy, "start_production", "quarry_stone"), { code: "ECONOMY_MINING_ACTIVITY" });
  const charcoal = issue(legacy, "start_production", "make_charcoal").state.jobs.find(job => job.targetId === "kiln");
  const claimed = issue(legacy, "claim_job", charcoal.id, 1, Date.parse(charcoal.finishesAt)).state;
  assert.equal(claimed.inventory.charcoal, charcoal.rewards.charcoal);
  assert.deepEqual(claimed.jobs[0], stone);
  assert.equal(claimed.buildings.home, 1);
  assert.equal(claimed.buildings.quarry, 1); assert.equal(claimed.buildings.kiln, 1);
});

test("already paid home one quarry and furnace construction keeps its snapshot and may finish after the new gate", () => {
  for (const id of ["quarry", "kiln"]) {
    const p = player(), target = model.economyCatalog.buildings.find(building => building.id === id).levels[0];
    const row = fixture(p, { home: 1, coins: 170, items: { wood: 5 }, buildings: id === "kiln" ? { quarry: 1 } : {} });
    const paid = { id: crypto.randomUUID(), kind: "construction", targetId: id, targetLevel: 1, recipeId: null,
      startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 1000).toISOString(),
      cost: structuredClone(target.cost), rewards: {}, catalogVersion: 2 };
    row.state.jobs.push(paid);
    const before = read(p);
    assert.deepEqual(before.jobs[0], paid, "catalog changes never rewrite the paid order");
    assert.throws(() => issue(p, "claim_job", paid.id, 1, now), { code: "ECONOMY_JOB_NOT_READY" });
    const claimed = issue(p, "claim_job", paid.id, 1, now + 1000).state;
    assert.equal(claimed.buildings[id], 1);
    assert.equal(claimed.buildings.home, 1); assert.equal(claimed.buildings.workshop, 0);
    assert.deepEqual(claimed.wallet, before.wallet); assert.deepEqual(claimed.inventory, before.inventory);
    assert.deepEqual(claimed.jobs, []);
  }
});

test("legacy conversion is modest, monotonic and capped for safe-integer beta balances", () => {
  assert.deepEqual(rules.convertLegacyEconomy({ sparks: 0, wood: 0, stone: 0 }), { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 });
  assert.deepEqual(rules.convertLegacyEconomy({ sparks: 100, wood: 25, stone: 9 }), { version: 1, coinsGranted: 280, woodGranted: 5, stoneGranted: 3 });
  assert.deepEqual(rules.convertLegacyEconomy({ sparks: Number.MAX_SAFE_INTEGER, wood: Number.MAX_SAFE_INTEGER, stone: Number.MAX_SAFE_INTEGER }),
    { version: 1, coinsGranted: 5000, woodGranted: 30, stoneGranted: 30 });
  const initial = rules.newEconomyState({ resources: { sparks: 100, wood: 25, stone: 9 }, houseLevel: 5, workshopLevel: 3 });
  assert.equal(initial.buildings.home, 5); assert.equal(initial.buildings.workshop, 3);
  assert.equal(initial.wallet.pearls, 0);
});

test("the browser accepts explicit nullable Kotlin catalog fields and validates warehouse capacity", () => {
  const response = read(player());
  for (const building of response.catalog.buildings) for (const level of building.levels) {
    level.warehouseCapacity ??= null;
    level.requiredBuildings ??= {};
  }
  for (const definition of [...response.catalog.recipes, ...response.catalog.explorations]) definition.requiredBuildings ??= {};
  for (const route of response.catalog.explorations) route.activity ??= null;
  assert.equal(model.economyViewSchema.safeParse(response).success, true, "Kotlin encodeDefaults/explicitNulls includes null capacity outside warehouses");
  const warehouseLevel = response.catalog.buildings.find(building => building.id === "warehouse").levels[0];
  for (const invalidCapacity of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    warehouseLevel.warehouseCapacity = invalidCapacity;
    assert.equal(model.economyViewSchema.safeParse(response).success, false);
  }
});

test("production batch snapshots ingredients, duration and output; another slot still works", () => {
  const p = player(), row = fixture(p);
  row.state.buildings.workshop = 1;
  const recipe = model.economyCatalog.recipes.find(item => item.id === "make_planks");
  Object.assign(row.state.buildings, recipe.requiredBuildings);
  const started = issue(p, "start_production", "make_planks", 3).state;
  const job = started.jobs[0];
  assert.equal(started.inventory.wood, 30 - recipe.cost.items.wood * 3); assert.deepEqual(job.cost, rules.scaledEconomyCost(recipe.cost, 3));
  assert.equal(Date.parse(job.finishesAt) - now, recipe.seconds * 3 * 1000); assert.deepEqual(job.rewards, { planks: recipe.rewards.planks * 3 });
  assert.equal(job.catalogVersion, 3);
  assert.throws(() => issue(p, "start_production", "make_rope"), { code: "ECONOMY_BUILDING_BUSY" });
  assert.equal(issue(p, "start_production", "grow_berries").state.jobs.length, 2);
  assert.throws(() => issue(p, "start_production", "grow_berries", 11), { code: "INVALID_ECONOMY_COMMAND" });
  assert.throws(() => issue(p, "claim_job", job.id, 1, Date.parse(job.finishesAt) - 1), { code: "ECONOMY_JOB_NOT_READY" });
  assert.equal(issue(p, "claim_job", job.id, 1, Date.parse(job.finishesAt)).state.inventory.planks, 3);
});

test("construction consumes coins and materials once, retains old level and completes only after due time", () => {
  const p = player(), target = model.economyCatalog.buildings.find(building => building.id === "home").levels[1];
  fixture(p, { home: 1, coins: target.cost.coins + 1000, items: { ...target.cost.items }, buildings: target.requiredBuildings });
  const cmd = command(p, "start_construction", "home"), before = read(p);
  const started = economy.commandDevEconomy(p.token, cmd, now), job = started.state.jobs[0];
  assert.equal(started.state.buildings.home, 1); assert.equal(started.state.wallet.coins, before.wallet.coins - target.cost.coins);
  assert.equal(started.state.inventory.wood, before.inventory.wood - target.cost.items.wood || undefined); assert.equal(started.state.inventory.stone, before.inventory.stone - target.cost.items.stone || undefined);
  assert.equal(economy.commandDevEconomy(p.token, cmd, now).replayed, true);
  assert.equal(read(p).jobs.length, 1);
  assert.throws(() => issue(p, "start_construction", "home"), { code: "ECONOMY_CONSTRUCTION_BUSY" });
  assert.throws(() => issue(p, "claim_job", job.id, 1, Date.parse(job.finishesAt) - 1), { code: "ECONOMY_JOB_NOT_READY" });
  assert.equal(issue(p, "claim_job", job.id, 1, Date.parse(job.finishesAt)).state.buildings.home, 2);
  assert.throws(() => issue(p, "claim_job", job.id, 1, Date.parse(job.finishesAt) + 1), { code: "ECONOMY_JOB_GONE" });
});

test("failed spending is atomic and new house unlocks only follow completed construction", () => {
  const p = player(), target = model.economyCatalog.buildings.find(building => building.id === "home").levels[1];
  fixture(p, { coins: 0, items: {}, home: 1, completedExplorations: 0, buildings: target.requiredBuildings });
  const before = read(p);
  assert.throws(() => issue(p, "start_construction", "home"), { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(read(p), before);
  assert.throws(() => issue(p, "start_exploration", "cave"), { code: "ECONOMY_HOME_REQUIRED" });
  assert.throws(() => issue(player(), "start_production", "make_planks"), { code: "ECONOMY_BUILDING_REQUIRED" });
});

test("one explorer, receipts, stale revisions and foreign owners cannot duplicate rewards", () => {
  const p = player(), other = player(), cmd = command(p, "start_exploration", "forest");
  const result = economy.commandDevEconomy(p.token, cmd, now);
  assert.equal(result.state.jobs[0].id, cmd.requestId);
  assert.throws(() => issue(p, "start_exploration", "forest"), { code: "ECONOMY_EXPLORER_BUSY" });
  assert.throws(() => economy.commandDevEconomy(other.token, cmd, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cmd, targetId: "shore" }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...cmd, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  const claim = command(p, "claim_job", result.state.jobs[0].id);
  const dueAt = Date.parse(result.state.jobs[0].finishesAt);
  const claimed = economy.commandDevEconomy(p.token, claim, dueAt);
  assert.equal(economy.commandDevEconomy(p.token, claim, dueAt + 100000).acceptedRevision, claimed.acceptedRevision);
  assert.equal(read(p).completedExplorations, 1);
});

test("commands reject public minting, untrusted counts and unknown fields", () => {
  const p = player(), base = command(p, "sell", "berries");
  for (const quantity of [0, -1, 1.5, "2", 10001, NaN, Infinity])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...base, quantity }, now), { code: "INVALID_ECONOMY_COMMAND" });
  for (const patch of [{ action: "grant_pearls" }, { coins: 1000 }, { rewards: { berries: 999 } }, { totalPrice: -1 }, { action: "claim_job", quantity: 2 }])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...base, ...patch }, now), { code: "INVALID_ECONOMY_COMMAND" });
  assert.deepEqual(read(p).wallet, { coins: 0, pearls: 0 });
  assert.throws(() => economy.getDevEconomy(undefined, now), { code: "UNAUTHORIZED" });
});

test("market escrow conserves goods, quoted full-lot buy transfers coins once to seller", () => {
  const seller = player(), buyer = player(); fixture(seller); fixture(buyer, { coins: 1000, items: {} });
  const listed = trade(seller, "create_listing", "berries", 6, 30), lot = listed.listing;
  assert.equal(read(seller).inventory.berries, 24); assert.equal(read(seller).wallet.coins, 5000);
  const browse = economy.getDevEconomyMarket(buyer.token, {}, now);
  assert.equal(browse.listings[0].sellerPublicId, seller.me.user.publicId); assert.equal(browse.listings[0].owned, false);
  assert.equal(economy.getDevEconomyMarket(seller.token, {}, now).mine[0].owned, true);
  assert.throws(() => trade(buyer, "buy_listing", lot.id, 6, 29), { code: "ECONOMY_MARKET_QUOTE_CHANGED" });
  const buy = command(buyer, "buy_listing", lot.id, 6, 30), result = economy.commandDevEconomyMarket(buyer.token, buy, now);
  assert.equal(result.state.wallet.coins, 700); assert.equal(result.state.inventory.berries, 6);
  assert.equal(read(seller).wallet.coins, 5285); assert.equal(read(seller).revision, 2);
  assert.equal(economy.commandDevEconomyMarket(buyer.token, buy, now).replayed, true);
  assert.equal(read(seller).wallet.coins, 5285); assert.equal(economy.getDevEconomyMarket(buyer.token, {}, now).listings.length, 0);
});

test("two buyers cannot acquire the same lot and failed purchase charges neither party", () => {
  const seller = player(), buyer = player(), rival = player(); [seller, buyer, rival].forEach(p => fixture(p));
  const lot = trade(seller, "create_listing", "wood", 5, 40).listing;
  economy.getDevEconomyMarket(buyer.token, {}, now); economy.getDevEconomyMarket(rival.token, {}, now);
  const first = command(buyer, "buy_listing", lot.id, 5, 40), second = command(rival, "buy_listing", lot.id, 5, 40);
  economy.commandDevEconomyMarket(buyer.token, first, now);
  assert.throws(() => economy.commandDevEconomyMarket(rival.token, second, now), { code: "ECONOMY_MARKET_NOT_ACTIVE" });
  assert.equal(read(seller).wallet.coins, 5380); assert.equal(read(rival).wallet.coins, 5000); assert.equal(read(rival).inventory.wood, 30);
});

test("market cancel returns exactly escrow, self buying and foreign cancellation fail", () => {
  const seller = player(), other = player(); fixture(seller); fixture(other);
  const lot = trade(seller, "create_listing", "stone", 10, 30).listing;
  assert.throws(() => trade(seller, "buy_listing", lot.id, 10, 30), { code: "ECONOMY_MARKET_SELF_TRADE" });
  assert.throws(() => trade(other, "cancel_listing", lot.id), { code: "ECONOMY_MARKET_OWNER" });
  const cancel = command(seller, "cancel_listing", lot.id);
  assert.equal(economy.commandDevEconomyMarket(seller.token, cancel, now).state.inventory.stone, 30);
  assert.equal(economy.commandDevEconomyMarket(seller.token, cancel, now).replayed, true);
  assert.equal(read(seller).inventory.stone, 30);
  assert.throws(() => trade(seller, "cancel_listing", lot.id), { code: "ECONOMY_MARKET_NOT_ACTIVE" });
});

test("market gates, limits and price range come from the shared catalog", () => {
  const p = player();
  assert.equal(economy.getDevEconomyMarket(p.token, {}, now).listings.length, 0, "browsing is available before trading unlocks");
  assert.throws(() => trade(p, "create_listing", "wood", 1, 4), { code: "ECONOMY_MARKET_LOCKED" });
  fixture(p);
  assert.throws(() => trade(p, "create_listing", "wood", 100, 100), { code: "ECONOMY_MARKET_QUANTITY" });
  assert.throws(() => trade(p, "create_listing", "wood", 1, 21), { code: "ECONOMY_MARKET_PRICE" });
  assert.throws(() => trade(p, "create_listing", "pearls", 1, 1), { code: "ECONOMY_MARKET_ITEM" });
  for (let i = 0; i < 10; i++) trade(p, "create_listing", "wood", 1, 8);
  assert.throws(() => trade(p, "create_listing", "wood", 1, 8), { code: "ECONOMY_MARKET_LIMIT" });
  assert.equal(read(p).inventory.wood, 20);
});

test("showcase has two lots per seller, no cursor and stays fixed across smaller reads", () => {
  const seller = player(), buyer = player(); fixture(seller); fixture(buyer);
  for (let i = 0; i < 5; i++) trade(seller, "create_listing", "wood", 1, 4);
  const first = economy.getDevEconomyMarket(buyer.token, { limit: 2 }, now);
  const smaller = economy.getDevEconomyMarket(buyer.token, { limit: 1 }, now);
  assert.equal(first.listings.length, 2); assert.deepEqual(smaller.listings, first.listings.slice(0, 1));
  assert.equal(first.nextCursor, null);
  for (const cursor of ["", "bad", "x".repeat(161)]) assert.throws(() => economy.getDevEconomyMarket(buyer.token, { cursor }, now), { code: "INVALID_ECONOMY_QUERY" });
});

test("escrow reserves return capacity, so harvesting cannot prevent cancellation", () => {
  const p = player(), row = fixture(p, { items: { berries: model.ECONOMY_MAX_ITEMS } });
  const lot = trade(p, "create_listing", "berries", 10, 30).listing;
  const job = issue(p, "start_production", "grow_berries").state.jobs[0];
  const before = read(p);
  assert.throws(() => issue(p, "start_collection", job.id, 1, Date.parse(job.finishesAt)), { code: "ECONOMY_CAPACITY" });
  assert.deepEqual(read(p), before);
  trade(p, "cancel_listing", lot.id);
  assert.equal(row.state.inventory.berries, model.ECONOMY_MAX_ITEMS);
  assert.equal(row.state.jobs.length, 1);
});

test("one request identifier cannot be repurposed across market and economy endpoints", () => {
  const p = player(); fixture(p);
  const sell = command(p, "sell", "berries", 1);
  economy.commandDevEconomy(p.token, sell, now);
  assert.throws(() => economy.commandDevEconomyMarket(p.token, { ...sell, expectedRevision: read(p).revision, action: "create_listing", totalPrice: 3 }, now),
    { code: "ECONOMY_REQUEST_CONFLICT" });
});

test("warehouse counts mixed goods and an unsuccessful harvest keeps the ready job and revision", () => {
  const p = player(); fixture(p, { items: { wood: 100, stone: 99 } });
  const job = issue(p, "start_production", "grow_berries").state.jobs[0];
  assert.deepEqual(read(p).storage, { capacity: 200, used: 199, reserved: 0, available: 1, overflow: 0 });
  const before = read(p);
  assert.throws(() => issue(p, "start_collection", job.id, 1, Date.parse(job.finishesAt)), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p), before);
  issue(p, "sell", "wood", Object.values(job.rewards).reduce((a, b) => a + b, 0));
  const collecting = issue(p, "start_collection", job.id, 1, Date.parse(job.finishesAt)).state.jobs.find(item => item.id === job.id);
  const claimed = issue(p, "claim_job", job.id, 1, Date.parse(collecting.collection.finishesAt)).state;
  assert.equal(claimed.jobs.length, 0); assert.equal(claimed.storage.used, 199);
});

test("market escrow occupies shared storage across item types and cancellation never needs extra room", () => {
  const p = player(); fixture(p, { items: { wood: 100, stone: 100 } });
  const lot = trade(p, "create_listing", "wood", 50, 200).listing;
  assert.deepEqual(read(p).storage, { capacity: 200, used: 150, reserved: 50, available: 0, overflow: 0 });
  const job = issue(p, "start_production", "grow_berries").state.jobs[0];
  assert.throws(() => issue(p, "start_collection", job.id, 1, Date.parse(job.finishesAt)), { code: "ECONOMY_STORAGE_FULL" });
  const cancelled = trade(p, "cancel_listing", lot.id).state;
  assert.deepEqual(cancelled.storage, { capacity: 200, used: 200, reserved: 0, available: 0, overflow: 0 });
  assert.equal(cancelled.inventory.wood, 100); assert.equal(cancelled.jobs.length, 1);
});

test("a purchase checks mixed inventory and own escrow before transferring money or closing the lot", () => {
  const seller = player(), buyer = player(); fixture(seller); fixture(buyer, { coins: 1000, items: { wood: 100, stone: 96 } });
  const reserved = trade(buyer, "create_listing", "wood", 50, 200).listing;
  const lot = trade(seller, "create_listing", "berries", 6, 30).listing;
  economy.getDevEconomyMarket(buyer.token, {}, now);
  const beforeBuyer = read(buyer), beforeSeller = read(seller);
  assert.throws(() => trade(buyer, "buy_listing", lot.id, 6, 30), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(buyer), beforeBuyer); assert.deepEqual(read(seller), beforeSeller);
  assert.equal(economy.getDevEconomyMarket(buyer.token, {}, now).listings[0].status, "active");
  issue(buyer, "sell", "stone", 2);
  const bought = trade(buyer, "buy_listing", lot.id, 6, 30).state;
  assert.equal(bought.storage.used + bought.storage.reserved, 200);
  assert.equal(bought.storage.reserved, 50);
  assert.equal(trade(buyer, "cancel_listing", reserved.id).state.storage.used, 200);
});

test("grandfathered inventory survives overflow and still permits selling, spending, listing and cancellation", () => {
  const p = player(), row = fixture(p, { items: { berries: 150, wood: 160 } });
  assert.equal(read(p).storage.overflow, 110);
  const lot = trade(p, "create_listing", "berries", 20, 60).listing;
  assert.equal(read(p).storage.overflow, 110);
  assert.equal(trade(p, "cancel_listing", lot.id).state.inventory.berries, 150);
  assert.equal(issue(p, "sell", "berries", 10).state.storage.overflow, 100);
  row.state.buildings.workshop = 1;
  const recipe = model.economyCatalog.recipes.find(item => item.id === "make_planks");
  Object.assign(row.state.buildings, recipe.requiredBuildings);
  const job = issue(p, "start_production", "make_planks").state.jobs[0];
  assert.equal(read(p).storage.overflow, 100 - Object.values(recipe.cost.items).reduce((a, b) => a + b, 0));
  assert.throws(() => issue(p, "claim_job", job.id, 1, Date.parse(job.finishesAt)), { code: "ECONOMY_STORAGE_FULL" });
  assert.equal(row.state.jobs.length, 1);
});

test("warehouse construction uses its old capacity until claimed and can complete during legacy overflow", () => {
  const p = player(), target = model.economyCatalog.buildings.find(building => building.id === "warehouse").levels[1];
  fixture(p, { coins: target.cost.coins, items: { ...target.cost.items, berries: 1200 }, home: 5,
    buildings: { ...target.requiredBuildings, warehouse: 1 } });
  const started = issue(p, "start_construction", "warehouse").state, job = started.jobs[0];
  assert.equal(started.storage.capacity, 200); assert.equal(started.storage.overflow, 1000);
  assert.throws(() => issue(p, "claim_job", job.id, 1, Date.parse(job.finishesAt) - 1), { code: "ECONOMY_JOB_NOT_READY" });
  const claimed = issue(p, "claim_job", job.id, 1, Date.parse(job.finishesAt)).state;
  assert.equal(claimed.buildings.warehouse, 2); assert.equal(claimed.storage.capacity, target.warehouseCapacity);
  assert.equal(claimed.storage.used, 1200); assert.equal(claimed.storage.overflow, 1200 - target.warehouseCapacity);
});

test("cross-building dependencies require completed levels for construction, recipes and exploration", () => {
  const catalog = model.economyCatalog;
  const building = catalog.buildings.find(building => building.id !== "home" && building.levels.some(level => Object.keys(level.requiredBuildings).length));
  const level = building.levels.find(level => Object.keys(level.requiredBuildings).length);
  const recipe = catalog.recipes.find(recipe => Object.entries(recipe.requiredBuildings).some(([id]) => id !== recipe.buildingId));
  const route = catalog.explorations.find(route => Object.keys(route.requiredBuildings).length);
  assert.ok(building && level && recipe && route, "all three action families have explicit progression dependencies");
  for (const [action, targetId, definition, constructingLevel] of [
    ["start_construction", building.id, level, level.level], ["start_production", recipe.id, recipe], ["start_exploration", route.id, route],
  ]) {
    const p = player(), buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
    if (constructingLevel) buildings[targetId] = constructingLevel - 1;
    const [missingId, neededLevel] = Object.entries(definition.requiredBuildings).find(([id]) => id !== (action === "start_production" ? definition.buildingId : targetId));
    buildings[missingId] = neededLevel - 1;
    const row = fixture(p, { coins: definition.cost.coins, items: definition.cost.items, home: 5, buildings });
    const pending = { id: crypto.randomUUID(), kind: "construction", targetId: missingId, targetLevel: neededLevel, recipeId: null,
      startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now).toISOString(), cost: { coins: 0, items: {} }, rewards: {}, catalogVersion: 1 };
    row.state.jobs.push(pending);
    const before = read(p);
    assert.throws(() => issue(p, action, targetId), { code: "ECONOMY_BUILDING_REQUIRED" });
    assert.deepEqual(read(p), before, "a finished but unclaimed prerequisite does not unlock dependent work");
    assert.deepEqual(rules.unmetEconomyBuildings(row.state, definition.requiredBuildings), [{ buildingId: missingId, requiredLevel: neededLevel, currentLevel: neededLevel - 1 }]);
    issue(p, "claim_job", pending.id);
    assert.equal(issue(p, action, targetId).state.jobs.length, 1);
  }
});

test("storage fitting still rejects oversized paid output independently of queue limits", () => {
  const p = player(), row = fixture(p, { items: { berries: 200 }, home: 5,
    buildings: Object.fromEntries(model.economyCatalog.buildings.map(building => [building.id, building.levels.at(-1).level])) });
  row.state.buildings.warehouse = 1;
  const recipe = model.economyCatalog.recipes.find(recipe => recipe.id === "grow_berries");
  const original = recipe.rewards;
  try {
    recipe.rewards = { berries: 201 };
    const before = read(p);
    assert.throws(() => issue(p, "start_production", recipe.id), { code: "ECONOMY_STORAGE_FULL" });
    assert.deepEqual(read(p), before);
  } finally { recipe.rewards = original; }
  assert.equal(issue(p, "start_production", "grow_berries").state.jobs.length, 1);
});

test("catalog v1 jobs retain their original reward and deadline across the warehouse update", () => {
  const p = player(), row = fixture(p, { items: {}, home: 1, coins: 0 });
  const oldJob = { id: crypto.randomUUID(), kind: "production", targetId: "garden", recipeId: "grow_berries", targetLevel: null,
    startedAt: new Date(now - 5000).toISOString(), finishesAt: new Date(now + 1000).toISOString(),
    cost: { coins: 70, items: { wood: 3 } }, rewards: { berries: 230 }, catalogVersion: 1 };
  row.state.jobs.push(oldJob);
  delete row.state.buildings.warehouse; delete row.state.buildings.kiln;
  assert.equal(model.economyViewSchema.safeParse(read(p)).success, true);
  assert.equal(read(p).buildings.warehouse, 1); assert.equal(read(p).buildings.kiln, 0);
  assert.throws(() => issue(p, "claim_job", oldJob.id, 1, now), { code: "ECONOMY_JOB_NOT_READY" });
  assert.throws(() => issue(p, "claim_job", oldJob.id, 1, now + 1000), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(row.state.jobs[0], oldJob);
  row.state.buildings.warehouse = 2;
  const result = issue(p, "claim_job", oldJob.id, 1, now + 1000).state;
  assert.equal(result.inventory.berries, 230); assert.equal(result.wallet.coins, 0); assert.equal(result.jobs.length, 0);
});

 test("free gathering and unattended jobs reject bulk commands atomically", () => {
  for (const recipe of model.economyCatalog.recipes.filter(recipe => recipe.maxBatch === 1)) {
    const p = player(); fixture(p, { items: recipe.cost.items, coins: recipe.cost.coins * 2, home: 5,
      buildings: Object.fromEntries(model.economyCatalog.buildings.map(building => [building.id, building.levels.at(-1).level])) });
    const before = read(p);
    assert.throws(() => issue(p, "start_production", recipe.id, 2), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(read(p), before, recipe.id);
  }
});
