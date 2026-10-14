import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const unlocks = await vite.ssrLoadModule("/features/economy/domain/item-unlocks.ts");
const market = await vite.ssrLoadModule("/features/economy/domain/market-rules.ts");
const now = Date.parse("2026-10-14T09:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = p => economy.getDevEconomy(p.token, now);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
function player(home = 3) {
  const p = identities.createDevIdentity("Открытия товаров", crypto.randomUUID()); read(p);
  Object.assign(row(p).state.buildings, { home, warehouse: 1, garden: 1, woodlot: 0, workshop: 0, quarry: 0, kiln: 0, dryer: 0 });
  row(p).state.completedExplorations = 1; row(p).state.wallet.coins = 10000; row(p).state.inventory = {};
  return p;
}
const request = (p, action, targetId, quantity = 1, totalPrice = 0) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p).revision,
  action, targetId, quantity, totalPrice,
});
const send = (p, action, targetId, quantity = 1, at = now) => economy.commandDevEconomy(p.token,
  request(p, action, targetId, quantity), at);
const trade = (p, action, targetId, quantity = 1, price = 0) => economy.commandDevEconomyMarket(p.token,
  request(p, action, targetId, quantity, price), now);
const markLegacy = p => { delete row(p).state.itemUnlockVersion; delete row(p).state.unlockedItems; };

test("current home alone does not open goods whose real station or prior recipe is still missing", () => {
  const p = player(5), stored = structuredClone(row(p).state), view = read(p);
  assert.equal(market.marketItemUnlocked(view, "glass"), false);
  assert.equal(market.marketItemUnlocked(view, "planks"), false);
  assert.equal(market.marketItemUnlocked(view, "strawberries"), false);
  assert.deepEqual(row(p).state, stored, "read-only discovery does not seal or alter the profile");
  row(p).state.buildings.woodlot = 1; row(p).state.buildings.workshop = 1;
  assert.equal(market.marketItemUnlocked(read(p), "planks"), true);
  row(p).state.progression.recipes.cook_compote = 1;
  assert.equal(market.marketItemUnlocked(read(p), "strawberries"), true);
});

test("owned fishing rods unlock their reachable classes while private pending catches cannot open others", () => {
  const p = player(), state = row(p).state;
  assert.equal(market.marketItemUnlocked(read(p), "fish_common"), true);
  assert.equal(market.marketItemUnlocked(read(p), "fish_legendary"), false);
  state.jobs.push({ id: crypto.randomUUID(), kind: "exploration", targetId: "shore", recipeId: null, actorId: "mochlik", targetLevel: null,
    startedAt: new Date(now - 60000).toISOString(), finishesAt: new Date(now + 60000).toISOString(), rewards: { fish_shark: 1 },
    cost: { coins: 0, items: {} }, catalogVersion: 7, fishing: { rodId: "reed_rod", hookId: "bare_hook", baitId: null, fishId: "fish_shark" } });
  const pending = read(p);
  assert.equal(market.marketItemUnlocked(pending, "fish_legendary"), false);
  assert.equal(pending.unlockedItems.includes("fish_legendary"), false);
  state.jobs = [];
  const rod = model.economyCatalog.fishing.rods.find(rod => rod.rarity === "legendary");
  state.fishing.ownedRods.push(rod.id);
  assert.equal(market.marketItemUnlocked(read(p), "fish_legendary"), true);
  assert.equal(state.fishing.catches.fish_shark, undefined, "opening a class is distinct from a personal catch");
});

test("accepted source openings are permanent after supplies are spent or the producer no longer exists", () => {
  const p = player(), state = row(p).state;
  state.buildings.woodlot = 1; state.buildings.workshop = 1;
  state.inventory = { wood: 1 };
  const started = send(p, "start_production", "make_planks");
  assert(started.state.unlockedItems.includes("planks"));
  const job = started.state.jobs.find(job => job.recipeId === "make_planks");
  send(p, "claim_job", job.id, 1, Date.parse(job.finishesAt));
  row(p).state.buildings.workshop = 0; row(p).state.buildings.woodlot = 0;
  const current = read(p); assert(current.unlockedItems.includes("planks"));
  const sold = send(p, "sell", "planks").state;
  assert.equal(sold.inventory.planks, undefined); assert.equal(market.marketItemUnlocked(sold, "planks"), true);
  assert.equal(Object.hasOwn(sold, "itemUnlockVersion"), false, "private initialization markers do not leak to views");
});

test("legacy stock and species aliases seed known items once, without allowing later advanced gifts to add openings", () => {
  const p = player(), state = row(p).state; markLegacy(p);
  state.inventory = { glass: 2, fish_legendary: 1 };
  assert(unlocks.unlockedEconomyItems({ ...state, inventory: { fish_shark: 1 } }).includes("fish_legendary"));
  const before = structuredClone(state), first = read(p);
  assert(first.unlockedItems.includes("glass")); assert(first.unlockedItems.includes("fish_legendary"));
  assert.deepEqual(row(p).state, before);
  send(p, "start_production", "grow_berries");
  assert.equal(row(p).state.itemUnlockVersion, 1); row(p).state.inventory = { reinforced_parts: 2 };
  const later = read(p);
  assert(later.unlockedItems.includes("glass")); assert(later.unlockedItems.includes("fish_legendary"));
  assert.equal(later.unlockedItems.includes("reinforced_parts"), false);
  assert.equal(market.marketItemUnlocked(later, "reinforced_parts"), false,
    "a public view with an authoritative ledger must not reinterpret new gift stock as legacy evidence");
});

test("old escrow and closed seller history seed goods, while unclaimed jobs and forged progression ids do not", () => {
  const p = player(), state = row(p).state; markLegacy(p);
  for (const [itemId, status] of [["glass", "active"], ["beams", "sold"]]) {
    const id = crypto.randomUUID(); globalThis.__zhivDevEconomyStore.listings.set(id,
      { id, sellerPublicId: p.me.user.publicId, itemId, quantity: 1, totalPrice: 1000, status,
        currencyScale: 10, feeBps: 0, createdAt: new Date(now).toISOString(), closedAt: status === "active" ? null : new Date(now).toISOString() });
  }
  state.progression.recipes.unknown_recipe = 1; state.progression.routes.unknown_route = 1;
  const stored = structuredClone(state), view = read(p);
  assert(view.unlockedItems.includes("glass")); assert(view.unlockedItems.includes("beams"));
  assert.equal(view.unlockedItems.includes("reinforced_parts"), false);
  assert.equal(view.storage.reserved, 1); assert.deepEqual(row(p).state, stored);
  send(p, "start_production", "grow_berries");
  globalThis.__zhivDevEconomyStore.listings.clear();
  assert(read(p).unlockedItems.includes("glass")); assert(read(p).unlockedItems.includes("beams"));
});

test("unopened new stock cannot be listed, selected by a showcase or bought through an injected old selection", () => {
  const seller = player(), buyer = player();
  row(seller).state.unlockedItems.push("glass"); row(seller).state.inventory = { glass: 1 };
  const item = model.economyCatalog.items.find(item => item.id === "glass");
  const price = Math.ceil(item.baseSellPrice / 10) * 10;
  const lot = trade(seller, "create_listing", "glass", 1, price).listing;
  row(buyer).state.inventory = { glass: 1 };
  const before = read(buyer);
  assert.throws(() => trade(buyer, "create_listing", "glass", 1, price), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
  assert.equal(economy.getDevEconomyMarket(buyer.token, {}, now).listings.length, 0);
  globalThis.__zhivDevEconomyStore.showcases.get(buyer.me.user.publicId).ids = [lot.id];
  assert.throws(() => trade(buyer, "buy_listing", lot.id, lot.quantity, lot.totalPrice), { code: "ECONOMY_MARKET_ITEM_LOCKED" });
  assert.deepEqual(read(buyer), before); assert.equal(globalThis.__zhivDevEconomyStore.listings.get(lot.id).status, "active");
});

test("merging unlock ledgers conserves known goods but rejects unknown ids and never opens every high-home recipe", () => {
  const first = row(player()).state, second = row(player(5)).state;
  first.unlockedItems = ["glass", "invented_item"]; second.unlockedItems = ["beams", "fish_shark"];
  const before = [structuredClone(first), structuredClone(second)], merged = unlocks.mergeEconomyItemUnlocks(first, second);
  for (const id of ["glass", "beams", "fish_legendary"]) assert(merged.includes(id));
  assert.equal(merged.includes("invented_item"), false); assert.equal(merged.includes("reinforced_parts"), false);
  assert.deepEqual([first, second], before); assert.equal(new Set(merged).size, merged.length);
});
