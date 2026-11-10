import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-fish-stock-commerce-vite",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const now = Date.parse("2026-10-15T00:30:00Z");
const price = catalog.items.find(item => item.id === "fish_epic").baseSellPrice;
// New listings use integral coin steps; NPC sale value stays the exact class price.
const listingPrice = quantity => Math.ceil(price * quantity / catalog.currencyScale) * catalog.currencyScale;
const fresh = () => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 0 });
  Object.assign(state.buildings, { bridge: 1, warehouse: 10 });
  state.wallet.coins = 10_000;
  state.inventory = { fish_epic: 3, wood: 1 };
  state.fishing.stock = { fish_sturgeon: 1, fish_mirror_koi: 2 };
  state.fishing.catches = { fish_shark: 77 };
  state.unlockedItems = ["fish_epic", "wood"];
  return state;
};
const input = (action, extra = {}) => ({ action, targetId: "fish_epic", quantity: 1, totalPrice: 0,
  requestId: crypto.randomUUID(), expectedRevision: 0, ownerPublicId: "AAAA-0000-0001", ...extra });
const apply = (state, command) => rules.applyEconomyCommand(state, command, now, () => crypto.randomUUID(), {}, () => 0);
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
const read = p => economy.getDevEconomy(p.token, now);
const stored = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const player = name => {
  const p = identities.createDevIdentity(name, crypto.randomUUID()); read(p);
  Object.assign(stored(p), fresh());
  return p;
};
const command = (p, action, extra = {}) => ({ ...input(action, extra), ownerPublicId: p.me.user.publicId, expectedRevision: read(p).revision });
const issue = (p, action, extra = {}) => economy.commandDevEconomy(p.token, command(p, action, extra), now);
const trade = (p, action, extra = {}) => economy.commandDevEconomyMarket(p.token, command(p, action, extra), now);

test("NPC and local fish sales consume chosen species at the unchanged class price", () => {
  for (const action of ["sell", "sell_fish"]) {
    const state = fresh(), before = structuredClone(state);
    apply(state, input(action, { quantity: 2, fishSelection: { fish_mirror_koi: 2 } }));
    assert.equal(state.inventory.fish_epic, 1);
    assert.deepEqual(state.fishing.stock, { fish_sturgeon: 1 });
    const coins = action === "sell_fish" ? price * 2 : rules.economyLocalSellPrice(price, 2, catalog.localBuyer, "fish_epic");
    assert.equal(state.wallet.coins, before.wallet.coins + coins);
    assert.deepEqual(state.fishing.catches, before.fishing.catches);
  }
});

test("invalid sale choices never consume a different fish or pay coins", () => {
  for (const action of ["sell", "sell_fish"]) for (const fishSelection of [{}, { fish_shark: 1 },
    { fish_sturgeon: 2 }, { fish_mirror_koi: 2 }, { fish_epic: 1 }, { fish_mirror_koi: 1, wood: 1 }]) {
    const state = fresh(), before = structuredClone(state);
    assert.throws(() => apply(state, input(action, { fishSelection })), { code: "ECONOMY_FISH_SELECTION_CHANGED" });
    assert.deepEqual(state, before);
  }
});

test("sale receipts bind the selected species and replay an equivalent reordered map only once", () => {
  for (const action of ["sell", "sell_fish"]) {
    const p = player("Seller");
    const request = command(p, action, { quantity: 2, fishSelection: { fish_sturgeon: 1, fish_mirror_koi: 1 } });
    const accepted = economy.commandDevEconomy(p.token, request, now);
    assert.deepEqual(accepted.state.fishing.stock, { fish_mirror_koi: 1 });
    const replay = economy.commandDevEconomy(p.token, { ...request, fishSelection: { fish_mirror_koi: 1, fish_sturgeon: 1 } }, now);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.state, accepted.state);
    assert.throws(() => economy.commandDevEconomy(p.token, { ...request, fishSelection: { fish_mirror_koi: 2 } }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
    const before = read(p);
    assert.throws(() => issue(p, action, { fishSelection: { fish_sturgeon: 1 } }), { code: "ECONOMY_FISH_SELECTION_CHANGED" });
    assert.deepEqual(read(p), before);
  }
});

test("a chosen listing freezes exact species in escrow and cancellation restores them", () => {
  const p = player("Seller");
  const request = command(p, "create_listing", { quantity: 2, totalPrice: listingPrice(2), fishSelection: { fish_sturgeon: 1, fish_mirror_koi: 1 } });
  const accepted = economy.commandDevEconomyMarket(p.token, request, now), listing = accepted.listing;
  assert.equal(listing.itemId, "fish_epic"); assert.equal(listing.totalPrice, listingPrice(2));
  assert.deepEqual(accepted.state.fishing.stock, { fish_mirror_koi: 1 });
  assert.deepEqual(accepted.state.fishing.escrow[listing.id], { fish_sturgeon: 1, fish_mirror_koi: 1 });
  const replay = economy.commandDevEconomyMarket(p.token, { ...request, fishSelection: { fish_mirror_koi: 1, fish_sturgeon: 1 } }, now);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state, accepted.state);
  assert.throws(() => economy.commandDevEconomyMarket(p.token, { ...request, fishSelection: { fish_mirror_koi: 2 } }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.equal(economy.getDevEconomyMarket(p.token, {}, now).mine.length, 1);
  const returned = trade(p, "cancel_listing", { targetId: listing.id }).state;
  assert.equal(returned.inventory.fish_epic, 3);
  assert.deepEqual(returned.fishing.stock, { fish_sturgeon: 1, fish_mirror_koi: 2 });
  assert.deepEqual(returned.fishing.catches, accepted.state.fishing.catches);
});

test("invalid listing choices preserve class inventory, coins, reservations, revision and receipts", () => {
  const p = player("Seller"), before = read(p);
  const receipts = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).receipts.size;
  for (const fishSelection of [{}, { fish_shark: 2 }, { fish_sturgeon: 2 }, { fish_mirror_koi: 1 }, { fish_epic: 2 }]) {
    assert.throws(() => trade(p, "create_listing", { quantity: 2, totalPrice: listingPrice(2), fishSelection }), { code: "ECONOMY_FISH_SELECTION_CHANGED" });
    assert.deepEqual(read(p), before);
    assert.equal(globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).receipts.size, receipts);
    assert.deepEqual(economy.getDevEconomyMarket(p.token, {}, now).mine, []);
  }
});

test("a buyer receives the selected listing species without personal catch records", () => {
  const seller = player("Seller"), buyer = player("Buyer");
  stored(buyer).inventory = {}; delete stored(buyer).fishing.stock;
  const catches = structuredClone(read(buyer).fishing.catches);
  const listing = trade(seller, "create_listing", { totalPrice: listingPrice(1), fishSelection: { fish_sturgeon: 1 } }).listing;
  economy.getDevEconomyMarket(buyer.token, {}, now);
  const bought = trade(buyer, "buy_listing", { targetId: listing.id, totalPrice: listing.totalPrice }).state;
  assert.deepEqual(bought.inventory, { fish_epic: 1 });
  assert.deepEqual(bought.fishing.stock, { fish_sturgeon: 1 });
  assert.deepEqual(bought.fishing.catches, catches);
  assert.deepEqual(read(seller).fishing.stock, { fish_mirror_koi: 2 });
});

test("a listing purchase or cancellation cannot submit a seller fish selection", () => {
  const seller = player("Seller"), buyer = player("Buyer");
  const listing = trade(seller, "create_listing", { totalPrice: listingPrice(1), fishSelection: { fish_sturgeon: 1 } }).listing;
  economy.getDevEconomyMarket(buyer.token, {}, now);
  const beforeSeller = read(seller), beforeBuyer = read(buyer);
  for (const fishSelection of [{}, { fish_sturgeon: 1 }]) {
    assert.throws(() => trade(seller, "cancel_listing", { targetId: listing.id, fishSelection }), { code: "INVALID_ECONOMY_COMMAND" });
    assert.throws(() => trade(buyer, "buy_listing", { targetId: listing.id, totalPrice: listing.totalPrice, fishSelection }), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(read(seller), beforeSeller); assert.deepEqual(read(buyer), beforeBuyer);
  }
  assert.equal(trade(seller, "cancel_listing", { targetId: listing.id, fishSelection: null }).state.inventory.fish_epic, 3);
});

test("absent and null sale or listing selections retain the old unknown-first policy", () => {
  for (const action of ["sell", "sell_fish", "create_listing"]) for (const selection of [undefined, null]) {
    const p = player("Legacy"); stored(p).inventory.fish_epic = 4;
    const extra = { quantity: 2, ...(action === "create_listing" ? { totalPrice: listingPrice(2) } : {}),
      ...(selection === undefined ? {} : { fishSelection: selection }) };
    const result = action === "create_listing" ? trade(p, action, extra) : issue(p, action, extra);
    assert.equal(result.state.inventory.fish_epic, 2);
    assert.deepEqual(result.state.fishing.stock, { fish_sturgeon: 1, fish_mirror_koi: 1 });
    if (action === "create_listing") assert.deepEqual(result.state.fishing.escrow[result.listing.id], { fish_mirror_koi: 1 });
  }
});

test("nonfish commerce rejects selected fish while an empty choice keeps shared cost semantics", () => {
  for (const action of ["sell", "create_listing"]) {
    const p = player("Seller"), extra = { targetId: "wood", ...(action === "create_listing" ? { totalPrice: 30 } : {}) };
    const before = read(p), call = action === "create_listing" ? trade : issue;
    assert.throws(() => call(p, action, { ...extra, fishSelection: { fish_sturgeon: 1 } }), { code: "ECONOMY_FISH_SELECTION_CHANGED" });
    assert.deepEqual(read(p), before);
    const result = call(p, action, { ...extra, fishSelection: {} }).state;
    assert.equal(result.inventory.wood ?? 0, 0);
    assert.deepEqual(result.fishing.stock, before.fishing.stock);
  }
});
