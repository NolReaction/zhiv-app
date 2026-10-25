import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const social = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const localNeighbor = await vite.ssrLoadModule("/lib/dev/neighbor-store.ts");
const { neighborDefaultSettings, neighborStockItems } = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const { neighborOfferItems } = await vite.ssrLoadModule("/features/economy/domain/neighbor-rules.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const stamp = Date.parse("2026-10-25T09:00:00Z"), tomorrow = stamp + 86400000;
beforeEach(() => social.resetDevStoreForTests());
const maxBuildings = Object.fromEntries(economyCatalog.buildings.map(building => [building.id, Math.max(...building.levels.map(level => level.level))]));
const base = () => newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const opened = state => neighborOfferItems(state, neighborDefaultSettings);
const settings = changes => ({ ...structuredClone(neighborDefaultSettings), ...changes });
function owner() {
  const player = social.createDevIdentity("Покупатель", crypto.randomUUID());
  economy.getDevEconomy(player.token, stamp);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(player.me.user.publicId);
  row.state.buildings = { ...row.state.buildings, home: 2, bridge: 1, warehouse: 6 };
  row.state.wallet.coins = 100000;
  row.state.inventory = {};
  return { ...player, row };
}
const view = (player, at = stamp) => economy.getDevEconomyNeighbor(player.token, at);

test("the default assortment includes the entire ordinary tradable catalog rather than only starter materials", () => {
  assert.deepEqual([...neighborDefaultSettings.allowedItemIds].sort(), neighborStockItems.map(item => item.id).sort());
  for (const id of ["tools", "research_gear", "cranberry_glaze", "strawberry_compote"])
    assert.ok(neighborDefaultSettings.allowedItemIds.includes(id), id);
  assert.ok(neighborStockItems.every(item => item.tradable && item.baseSellPrice > 0 && item.category !== "special" && !item.id.startsWith("fish")));
});

test("starter, developed and maximum player settlements receive progressively richer eligible goods", () => {
  const early = base(); Object.assign(early.buildings, { home: 2, bridge: 1 });
  const middle = base(); Object.assign(middle.buildings, { home: 3, bridge: 1, warehouse: 3, workshop: 2, quarry: 2, garden: 2, kiln: 1, dryer: 1, woodlot: 2 });
  const late = base(); late.buildings = { ...maxBuildings };
  const untouched = [early, middle, late].map(state => JSON.stringify(state));
  const first = opened(early), second = opened(middle), third = opened(late);
  for (const id of ["wood", "berries"]) assert.ok(first.includes(id));
  for (const id of ["planks", "cloth", "blueberries"]) { assert.ok(!first.includes(id)); assert.ok(second.includes(id)); }
  for (const id of ["tools", "research_gear", "cranberry_glaze"]) { assert.ok(!second.includes(id)); assert.ok(third.includes(id)); }
  assert.deepEqual([early, middle, late].map(state => JSON.stringify(state)), untouched, "Reading eligible stock cannot grant knowledge");
});

test("a high house alone does not reveal locked production or unlearned recipe chains", () => {
  const bare = base(); bare.buildings.home = 5;
  assert.ok(!opened(bare).includes("tools"));
  const developed = base(); developed.buildings = { ...maxBuildings };
  assert.ok(!opened(developed).includes("strawberries"));
  assert.ok(!opened(developed).includes("strawberry_compote"));
  developed.progression.recipes.cook_compote = 1;
  assert.ok(opened(developed).includes("strawberries"));
  assert.ok(opened(developed).includes("strawberry_compote"));
});

test("gifted late stock does not open an item but prior confirmed discovery survives an empty warehouse", () => {
  const gifted = base(); Object.assign(gifted.buildings, { home: 2, bridge: 1 });
  gifted.inventory = { tools: 1, research_gear: 1 };
  assert.ok(!opened(gifted).includes("tools")); assert.ok(!opened(gifted).includes("research_gear"));
  gifted.inventory = {}; gifted.unlockedItems = ["research_gear"];
  assert.ok(opened(gifted).includes("research_gear"));
});

test("newly unlocked goods wait for the next daily delivery without rerolling existing stock", () => {
  const player = owner();
  localNeighbor.configureDevNeighbor(settings({ allowedItemIds: ["wood", "tools"] }));
  const first = view(player).shop.offers;
  assert.deepEqual(first.map(offer => offer.itemId), ["wood"]);
  player.row.state.buildings = { ...maxBuildings };
  const second = view(player, stamp + 1000).shop.offers;
  assert.deepEqual(second, first);
  assert.deepEqual(view(player, tomorrow).shop.offers.map(offer => offer.itemId).sort(), ["tools", "wood"]);
});

test("current restrictions hide a frozen offer without replacing it or replenishing a bought party", () => {
  const player = owner();
  localNeighbor.configureDevNeighbor(settings({ allowedItemIds: ["wood"] }));
  const offer = view(player).shop.offers[0];
  economy.commandDevEconomyNeighbor(player.token, { requestId: crypto.randomUUID(), ownerPublicId: player.me.user.publicId,
    expectedRevision: economy.getDevEconomy(player.token, stamp).revision, action: "buy_offer", targetId: offer.id,
    quantity: offer.quantity, totalPrice: offer.totalPrice }, stamp);
  localNeighbor.configureDevNeighbor(settings({ allowedItemIds: ["stone"] }));
  assert.deepEqual(view(player).shop.offers, []);
  const stored = localNeighbor.devNeighborCycle(player.me.user.publicId, stamp).offers;
  assert.equal(stored[0].id, offer.id); assert.equal(stored[0].purchased, true);
  localNeighbor.configureDevNeighbor(settings({ allowedItemIds: ["wood", "stone"] }));
  const restored = view(player).shop.offers;
  assert.deepEqual(restored.map(item => [item.id, item.purchased]), [[offer.id, true]]);
});

test("reset knowledge hides late goods until rediscovery while the day's stored quote remains intact", () => {
  const player = owner(); player.row.state.unlockedItems = ["tools"];
  localNeighbor.configureDevNeighbor(settings({ allowedItemIds: ["tools"] }));
  const offer = view(player).shop.offers[0];
  player.row.state.unlockedItems = [];
  assert.deepEqual(view(player).shop.offers, []);
  assert.equal(localNeighbor.devNeighborCycle(player.me.user.publicId, stamp).offers[0].id, offer.id);
  player.row.state.unlockedItems = ["tools"];
  assert.deepEqual(view(player).shop.offers, [offer]);
});

test("future delivery quantity and prices cannot hide rewrite or replenish today's open or purchased quote", () => {
  const player = owner();
  localNeighbor.configureDevNeighbor(settings({ allowedItemIds: ["wood"] }));
  const first = view(player).shop.offers;
  localNeighbor.configureDevNeighbor(settings({ allowedItemIds: ["wood"], offerQuantity: 1000000, sellPriceBps: Number.MAX_SAFE_INTEGER }));
  assert.deepEqual(view(player).shop.offers, first);
  const offer = first[0];
  economy.commandDevEconomyNeighbor(player.token, { requestId: crypto.randomUUID(), ownerPublicId: player.me.user.publicId,
    expectedRevision: economy.getDevEconomy(player.token, stamp).revision, action: "buy_offer", targetId: offer.id,
    quantity: offer.quantity, totalPrice: offer.totalPrice }, stamp);
  assert.deepEqual(view(player).shop.offers, [{ ...offer, purchased: true }]);
  assert.deepEqual(view(player, tomorrow).shop.offers, [], "A new quote outside the supported wallet range is omitted before choosing slots");
});
