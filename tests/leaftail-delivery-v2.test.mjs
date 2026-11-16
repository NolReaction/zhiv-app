import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const shop = await vite.ssrLoadModule("/features/economy/domain/leaftail-shop.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { localLeaftailPurchaseFromReceipt } = await vite.ssrLoadModule("/features/economy/domain/local-leaftail-purchase.ts");
const { inventoryGainFromReceipt } = await vite.ssrLoadModule("/features/economy/domain/inventory-gain.ts");
const { formatPearls } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const now = Date.parse("2026-10-19T12:00:00Z"), tomorrow = now + 86400_000;
const cycle = Math.floor(now / 86400_000), catalog = model.economyCatalog;
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const saved = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state;
const shelf = (p, at = now) => { const state = read(p, at); return shop.leaftailShopView(state, at, state.catalog); };
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
function player(home = 3) {
  const p = identities.createDevIdentity("Тест поставки", crypto.randomUUID());
  read(p); Object.assign(saved(p), { inventory: {}, wallet: { coins: 1_000_000, pearls: 3000 } });
  saved(p).buildings.home = home;
  return p;
}
function command(p, offer, quantity = 1, at = now, extra = {}) {
  const state = read(p, at);
  return { requestId: crypto.randomUUID(), ownerPublicId: state.ownerPublicId, expectedRevision: state.revision,
    action: "buy_leaftail_item", targetId: offer.targetId, quantity, totalPrice: offer.unitPrice * quantity, ...extra };
}
const buy = (p, offer, quantity = 1, at = now) => economy.commandDevEconomy(p.token, command(p, offer, quantity, at), at);
const bySection = (p, section) => shelf(p).offers.find(offer => offer.section === section);

test("v14 keeps positive legacy coin bundles while pearl finds live in an independent safe catalog array", () => {
  const spec = catalog.leaftailShop;
  assert.equal(catalog.version, 15);
  assert.equal(spec.offers.length, 3); assert.ok(spec.offers.every(offer => offer.priceCoins > 0));
  assert.equal(spec.supplyOffers.length, 8); assert.equal(spec.pearlOffers.length, 3);
  assert.ok(spec.pearlOffers.every(offer => offer.pricePearls === 300 && offer.stock === 1 && !("priceCoins" in offer)));
  assert.equal(formatPearls(spec.pearlOffers[0].pricePearls), "150");
  const legacy = structuredClone(spec); delete legacy.supplyOffers; delete legacy.pearlOffers;
  assert.equal(model.economyCatalogSchema.safeParse({ ...catalog, version: 11, leaftailShop: legacy }).success, true);
  assert.equal(shop.leaftailShopUsesUnits({ ...catalog, leaftailShop: legacy }), false);
});

test("catalog refuses currency ambiguity, cheap resale supplies, duplicate sources and invalid stock", () => {
  const invalid = mutate => {
    const clone = structuredClone(catalog); mutate(clone.leaftailShop);
    assert.equal(model.economyCatalogSchema.safeParse(clone).success, false);
  };
  invalid(spec => { spec.supplyOffers[0].unitPriceCoins = 1; });
  invalid(spec => { spec.supplyOffers[0].itemId = "ancient_core"; });
  invalid(spec => { spec.supplyOffers[0].itemId = "fish_common"; });
  invalid(spec => { spec.supplyOffers[0].stock = 101; });
  invalid(spec => { spec.supplyOffers[0].id = spec.offers[0].id; });
  invalid(spec => { spec.pearlOffers[0].itemId = "wood"; });
  invalid(spec => { spec.pearlOffers[0].pricePearls = 0; });
  invalid(spec => { spec.pearlOffers[0].pricePearls = model.ECONOMY_MAX_BALANCE + 1; });
  invalid(spec => { spec.pearlOffers[0].stock = 2; });
  invalid(spec => { spec.pearlOffers[0].itemId = spec.pearlOffers[1].itemId; });
});

test("personal rings match native vectors and vary adjacent daily deliveries without a full permanent catalog", () => {
  for (const [owner, day, home, expected] of [
    ["AAAA-0000-0001", 20742, 3, ["rain_hood", "dune_moss", "traveller_rod", "spice_bait", "moth_hook", "fiber_each", "planks_each", "grilled_fish_each", "moon_crystal_pearl"]],
    ["AAAA-0000-0001", 20743, 3, ["trail_hat", "sunset_scarf", "spice_bait", "mirror_rod", "weedless_hook", "wood_each", "stone_each", "dried_berries_each", "ancient_core_pearl"]],
    ["Мохлик", 20743, 4, ["sunset_scarf", "dune_moss", "traveller_rod", "spice_bait", "weedless_hook", "planks_each", "rope_each", "charcoal_each", "moon_crystal_pearl"]],
  ]) assert.deepEqual(shop.leaftailShopOffers(catalog, day, owner, home).map(offer => offer.id), expected);
  for (let day = cycle; day < cycle + 30; day++) {
    const offers = shop.leaftailShopOffers(catalog, day, "AAAA-0000-0001", 3);
    assert.equal(offers.filter(offer => offer.kind === "wardrobe").length, 2);
    for (const kind of ["rod", "hook", "bait"]) assert.equal(offers.filter(offer => offer.kind === kind).length, 1);
    assert.equal(offers.filter(offer => offer.id.endsWith("_each")).length, 3);
    assert.ok([1, 2].includes(offers.filter(offer => offer.currency === "pearls").length));
    assert.notDeepEqual(offers.map(offer => offer.id), shop.leaftailShopOffers(catalog, day + 1, "AAAA-0000-0001", 3).map(offer => offer.id));
    assert.ok(offers.every(offer => offer.quantity === 1));
    const next = shop.leaftailShopOffers(catalog, day + 1, "AAAA-0000-0001", 3);
    for (const group of [offers.filter(offer => offer.kind === "wardrobe"), offers.filter(offer => offer.id.endsWith("_each"))])
      assert.ok(group.every(offer => !next.some(item => item.id === offer.id)), "a new delivery brings an entirely different pair/triple when the pool permits");
  }
});

test("catalog order, an open window and buying never provide random entropy or replace owned goods", () => {
  const p = player(), before = shelf(p), reversed = structuredClone(catalog);
  for (const field of ["offers", "travelOffers", "supplyOffers", "pearlOffers"]) reversed.leaftailShop[field].reverse();
  assert.deepEqual(shop.leaftailShopOffers(reversed, before.cycle, p.me.user.publicId, 3).map(offer => offer.id).sort(),
    before.offers.map(offer => offer.id).sort());
  assert.deepEqual(shelf(p), before);
  const clothing = before.offers.find(offer => offer.kind === "wardrobe");
  buy(p, clothing);
  const after = shelf(p);
  assert.deepEqual(after.offers.map(offer => offer.id), before.offers.map(offer => offer.id));
  assert.equal(after.offers.find(offer => offer.id === clothing.id).owned, true);
  assert.equal(after.offers.find(offer => offer.id === clothing.id).remaining, 0);
});

test("the personal delivery filters level requirements before drawing and has no anonymous quote", () => {
  assert.deepEqual(shop.leaftailShopOffers(catalog, cycle, undefined, 5), []);
  assert.deepEqual(shop.leaftailShopOffers(catalog, cycle, "ME", 2), []);
  const p = player(), offers = shelf(p).offers;
  assert.ok(offers.every(offer => offer.requiredHomeLevel <= 3 && offer.unlocked));
  assert.ok(offers.every(offer => offer.targetId.startsWith(`v2:${cycle}:`)));
  assert.ok(offers.every(offer => offer.currency === "coins" ? offer.pricePearls === 0 && offer.priceCoins === offer.unitPrice
    : offer.priceCoins === 0 && offer.pricePearls === offer.unitPrice));
});

test("partial supply purchases debit exact units, retain daily leftovers and prove true quantities", () => {
  const p = player(), offer = bySection(p, "supplies"), before = read(p), q = command(p, offer, 3);
  const result = economy.commandDevEconomy(p.token, q, now), after = result.state;
  assert.equal(after.inventory[offer.itemId], 3);
  assert.equal(after.wallet.coins, before.wallet.coins - offer.unitPrice * 3);
  assert.equal(after.wallet.pearls, before.wallet.pearls);
  assert.equal(after.leaftailShop.purchased[offer.id], 3);
  assert.equal(shelf(p).offers.find(item => item.id === offer.id).remaining, offer.stock - 3);
  const receipt = localLeaftailPurchaseFromReceipt(before, result, q);
  assert.equal(receipt.quantity, 3); assert.equal(receipt.currency, "coins"); assert.equal(receipt.pearls, 0);
  assert.equal(receipt.items[0].quantity, 3);
  assert.deepEqual(inventoryGainFromReceipt(before, result, q).items, [{ itemId: offer.itemId, quantity: 3 }]);
  buy(p, offer, 2);
  assert.equal(read(p).inventory[offer.itemId], 5);
  assert.equal(shelf(p).offers.find(item => item.id === offer.id).remaining, offer.stock - 5);
});

test("a pearl relic debits only pearls and an accepted local receipt records the actual currency", () => {
  const p = player(), offer = bySection(p, "finds"), before = read(p), q = command(p, offer);
  const result = economy.commandDevEconomy(p.token, q, now);
  assert.equal(result.state.wallet.pearls, before.wallet.pearls - 300);
  assert.equal(result.state.wallet.coins, before.wallet.coins);
  assert.equal(result.state.inventory[offer.itemId], 1);
  const receipt = localLeaftailPurchaseFromReceipt(before, result, q);
  assert.equal(receipt.currency, "pearls"); assert.equal(receipt.pearls, 300); assert.equal(receipt.coins, 0);
  assert.equal(receipt.items[0].quantity, 1);
  assert.ok(Object.isFrozen(receipt));
  assert.equal(shelf(p).offers.find(item => item.id === offer.id).remaining, 0);
});

test("old coin targets, absent personal stock and another owner's commands cannot buy a pearl item", () => {
  const p = player(), before = read(p), offer = bySection(p, "finds"), q = command(p, offer);
  for (const targetId of [`${cycle}:${offer.itemId}`, `${cycle}:${offer.id}`, `${cycle}:wood_bundle`, `v2:${cycle}:wood_bundle`]) {
    assert.throws(() => economy.commandDevEconomy(p.token, { ...q, requestId: crypto.randomUUID(), targetId, totalPrice: 2400 }, now),
      { code: "ECONOMY_LEAFTAIL_SHOP_CHANGED" });
  }
  const selected = new Set(shelf(p).offers.map(item => item.id));
  const absent = catalog.leaftailShop.pearlOffers.find(item => !selected.has(item.id));
  assert.throws(() => economy.commandDevEconomy(p.token, { ...q, targetId: `v2:${cycle}:${absent.id}` }, now), { code: "ECONOMY_LEAFTAIL_SHOP_CHANGED" });
  const stranger = player();
  assert.throws(() => economy.commandDevEconomy(stranger.token, q, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.deepEqual(read(p), before);
});

test("exact prices, daily limits and permanent quantities validate before any debit", () => {
  const p = player(), offer = bySection(p, "supplies"), before = read(p), q = command(p, offer, 2);
  for (const totalPrice of [0, q.totalPrice - 1, q.totalPrice + 1])
    assert.throws(() => economy.commandDevEconomy(p.token, { ...q, totalPrice }, now), { code: "ECONOMY_LEAFTAIL_PRICE_CHANGED" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...q, quantity: 21, totalPrice: offer.unitPrice * 21 }, now), { code: "INVALID_ECONOMY_COMMAND" });
  const clothing = shelf(p).offers.find(item => item.kind === "wardrobe");
  assert.throws(() => buy(p, clothing, 2), { code: "INVALID_ECONOMY_COMMAND" });
  assert.deepEqual(read(p), before);
  buy(p, offer, offer.stock);
  assert.throws(() => buy(p, offer), { code: "ECONOMY_LEAFTAIL_STOCK" });
});

test("relics require a single positive unit even with an exact multi-unit quote and reject before either wallet changes", () => {
  const p = player(), offer = bySection(p, "finds"), before = read(p);
  for (const quantity of [-1, 0, 2]) {
    const q = command(p, offer, quantity, now, { totalPrice: offer.unitPrice * Math.max(1, quantity) });
    assert.throws(() => economy.commandDevEconomy(p.token, q, now), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(read(p), before, "invalid quantity must leave inventory, stock, coins, pearls and revision intact");
  }
});

test("money and inventory failures preserve stock and both wallets including nontradable pearl purchases", () => {
  for (const section of ["supplies", "finds"]) {
    const p = player(), offer = bySection(p, section);
    saved(p).wallet[offer.currency] = offer.unitPrice - 1;
    let before = read(p);
    assert.throws(() => buy(p, offer), { code: section === "finds" ? "ECONOMY_PEARLS" : "ECONOMY_RESOURCES" });
    assert.deepEqual(read(p), before);
    saved(p).wallet[offer.currency] = 1_000_000;
    saved(p).inventory = { wood: read(p).storage.capacity };
    before = read(p);
    assert.throws(() => buy(p, offer), { code: "ECONOMY_STORAGE_FULL" });
    assert.deepEqual(read(p), before);
  }
});

test("lost ACK replay is exactly once, racing requests conflict and stale delivery quotes cannot spend", () => {
  const p = player(), offer = bySection(p, "supplies"), q = command(p, offer, 2);
  const first = economy.commandDevEconomy(p.token, q, now), replay = economy.commandDevEconomy(p.token, q, now);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.wallet, first.state.wallet);
  assert.deepEqual(replay.state.inventory, first.state.inventory);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...q, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  const before = read(p, tomorrow);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...q, requestId: crypto.randomUUID(), expectedRevision: before.revision }, tomorrow),
    { code: "ECONOMY_LEAFTAIL_SHOP_CHANGED" });
  assert.deepEqual(read(p, tomorrow), before);
});

test("rollback does not reopen stock and historical whole-bundle IDs never count as bought new units", () => {
  const p = player(), offer = bySection(p, "supplies");
  saved(p).leaftailShop = { cycle, purchased: { wood_bundle: 1, stone_bundle: 1, fiber_bundle: 1 } };
  assert.equal(shelf(p).offers.find(item => item.id === offer.id).remaining, offer.stock);
  buy(p, offer, 2);
  const stock = shop.leaftailShopStock(read(p), now - 86400_000);
  assert.equal(stock.cycle, cycle); assert.equal(stock.purchased[offer.id], 2); assert.equal(stock.purchased.wood_bundle, 1);
  assert.equal(shop.leaftailShopView(read(p), now - 86400_000).offers.find(item => item.id === offer.id).remaining, offer.stock - 2);
});
