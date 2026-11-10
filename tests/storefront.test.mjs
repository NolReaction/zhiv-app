import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const shop = await vite.ssrLoadModule("/features/economy/domain/storefront.ts");
const { economyCatalog, economyCommandSchema, marketCommandSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { premiumCostumes } = await vite.ssrLoadModule("/features/world/domain/premium-costumes.ts");
const { formatPearls } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const snapshot = home => ({ catalog: economyCatalog, buildings: { home }, jobs: [] });

test("starter supplies stay within ten percent of their fixed pearl exchange value", () => {
  const prices = new Map(economyCatalog.items.map(item => [item.id, item.baseSellPrice]));
  for (const offer of shop.storefrontCatalog.starterPacks) {
    const supplies = offer.rewards.coins + Object.entries(offer.rewards.items)
      .reduce((total, [itemId, quantity]) => total + prices.get(itemId) * quantity, 0);
    assert.ok(supplies <= offer.rewards.pearls / 2 * 50 / 10, `${offer.id}: excessive free supplies ${supplies}`);
    assert.equal(offer.rewards.items.ancient_core, undefined);
  }
});

test("storefront has three ruble-priced pearl packs with the current stored-to-visible scale", () => {
  assert.equal(shop.storefrontCatalog.version, 1);
  assert.equal(shop.storefrontCatalog.currency, "RUB");
  assert.equal(shop.storefrontCatalog.paymentsEnabled, false);
  assert.deepEqual(shop.storefrontCatalog.pearlPacks.map(pack => [pack.pearls, pack.priceRub]), [[200, 99], [700, 299], [1600, 599]]);
  assert.deepEqual(shop.storefrontCatalog.pearlPacks.map(pack => formatPearls(pack.pearls)), ["100", "350", "800"]);
  assert.deepEqual(shop.storefrontCatalog.pearlPacks.map(pack => pack.id), ["pearls_100_v1", "pearls_350_v1", "pearls_800_v1"]);
});

test("every completed house level selects exactly its own one-account starter with stable terms", () => {
  const packs = [1, 2, 3, 4, 5].map(level => shop.storefrontStarterOffer(snapshot(level)));
  assert.deepEqual(packs.map(pack => pack.homeLevel), [1, 2, 3, 4, 5]);
  assert.deepEqual(packs.map(pack => pack.id), [1, 2, 3, 4, 5].map(level => `starter_home_${level}_v1`));
  assert.deepEqual(packs.map(pack => pack.priceRub), [149, 299, 399, 499, 599]);
  assert.deepEqual(packs.map(pack => pack.rewards.pearls), [300, 700, 1000, 1300, 1600]);
  assert.deepEqual(packs.map(pack => pack.rewards.coins), [150, 300, 500, 750, 1000]);
  for (const pack of packs) {
    assert.equal(pack.purchaseLimit, 1);
    assert.ok(Object.values(pack.rewards.items).reduce((sum, count) => sum + count, 0) <= 20);
    assert.ok(Object.keys(pack.rewards.items).some(itemId => economyCatalog.food.meals.some(meal => meal.itemId === itemId)));
    assert.deepEqual(Object.keys(pack.rewards).sort(), ["coins", "items", "pearls"]);
  }
});

test("ready and pending house jobs do not advance a starter until the completed building changes", () => {
  const state = snapshot(2);
  for (const finishesAt of ["2020-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
    state.jobs = [{ kind: "construction", targetId: "home", targetLevel: 3, finishesAt }];
    const before = structuredClone(state);
    assert.equal(shop.storefrontStarterOffer(state).homeLevel, 2);
    assert.deepEqual(state, before);
  }
  state.buildings.home = 3;
  assert.equal(shop.storefrontStarterOffer(state).id, "starter_home_3_v1");
  assert.equal(shop.storefrontStarterOffer(snapshot(2)).id, "starter_home_2_v1", "another owner snapshot is independent");
});

test("loading, forged and uncatalogued house levels never fabricate a starter", () => {
  for (const state of [null, undefined, snapshot(undefined), ...[0, -1, NaN, Infinity, 2.5, 6, 100].map(snapshot)])
    assert.equal(shop.storefrontStarterOffer(state), null);
  const state = snapshot(2);
  state.catalog = structuredClone(economyCatalog);
  state.catalog.buildings.find(building => building.id === "home").levels = state.catalog.buildings.find(building => building.id === "home").levels.filter(level => level.level !== 2);
  assert.equal(shop.storefrontStarterOffer(state), null);
  state.catalog.buildings = [];
  assert.equal(shop.storefrontStarterOffer(state), null);
});

test("a starter preview consults only completed owner development and never wallet, inventory or jobs", () => {
  const state = snapshot(4);
  for (const property of ["wallet", "inventory", "jobs", "ownedItems", "ownerPublicId"]) Object.defineProperty(state, property, {
    get() { throw new Error(`Starter preview must not read ${property}`); },
    set() { throw new Error(`Starter preview must not write ${property}`); },
  });
  assert.equal(shop.storefrontStarterOffer(state).homeLevel, 4);
});

test("costumes reference all three real outfits and carry no gameplay rewards or ownership flags", () => {
  const offers = shop.storefrontCostumes();
  assert.deepEqual(offers.map(offer => [offer.outfitId, offer.priceRub]), [["premium_explorer", 199], ["premium_stargazer", 299], ["premium_ember", 299]]);
  assert.deepEqual(new Set(offers.map(offer => offer.outfitId)), new Set(premiumCostumes.map(outfit => outfit.id)));
  for (const offer of offers) {
    assert.equal(offer.purchaseLimit, 1);
    assert.deepEqual(Object.keys(offer).sort(), ["description", "id", "name", "outfitId", "priceRub", "purchaseLimit"]);
  }
});

test("catalog shape rejects live-payment flags, duplicate IDs, partial pearls and excessive stock", () => {
  const mutate = change => { const next = structuredClone(shop.storefrontCatalog); change(next); return next; };
  assert.equal(shop.storefrontCatalogSchema.safeParse(mutate(next => { next.pearlPacks[0].pearls = 2; })).success, true,
    "one visible pearl is two raw units, independent of the historical fiftyfold migration scale");
  for (const invalid of [
    mutate(next => { next.paymentsEnabled = true; }),
    mutate(next => { next.pearlPacks[0].pearls = 201; }),
    mutate(next => { next.pearlPacks[0].pearls = 1; }),
    mutate(next => { next.pearlPacks[0].priceRub = 0; }),
    mutate(next => { next.pearlPacks[0].priceRub = NaN; }),
    mutate(next => { next.pearlPacks[0].priceRub = Number.MAX_SAFE_INTEGER + 1; }),
    mutate(next => { next.starterPacks[0].purchaseLimit = 2; }),
    mutate(next => { next.starterPacks[0].rewards.items.wood = 20; }),
    mutate(next => { next.starterPacks[0].rewards.items.wood = -1; }),
    mutate(next => { next.starterPacks[0].rewards.freeUpgrade = true; }),
    mutate(next => { next.starterPacks[1].id = next.starterPacks[0].id; }),
    mutate(next => { next.starterPacks[1].homeLevel = 1; }),
    mutate(next => { next.costumeOffers[1].outfitId = next.costumeOffers[0].outfitId; }),
  ]) assert.equal(shop.storefrontCatalogSchema.safeParse(invalid).success, false);
});

test("cross-catalog validation rejects unknown rewards, relics, locked stations and higher-stage items", () => {
  const mutate = change => { const next = structuredClone(shop.storefrontCatalog); change(next); return next; };
  assert.doesNotThrow(() => shop.validateStorefrontCatalog(shop.storefrontCatalog));
  for (const invalid of [
    mutate(next => { next.costumeOffers[0].outfitId = "missing_outfit"; }),
    mutate(next => { next.starterPacks[0].rewards.items.missing_item = 1; }),
    mutate(next => { next.starterPacks[0].rewards.items.ancient_core = 1; }),
    mutate(next => { next.starterPacks[0].rewards.items.premium_explorer_hat = 1; }),
    mutate(next => { next.starterPacks[0].rewards.items.reinforced_parts = 1; }),
    mutate(next => { next.starterPacks[1].rewards.items.bricks = 1; }),
    mutate(next => { next.starterPacks[2].rewards.items.metal_parts = 1; }),
  ]) assert.throws(() => shop.validateStorefrontCatalog(invalid));
});

test("preview terms do not introduce payment or entitlement commands into either economy protocol", () => {
  for (const kind of ["buy_starter", "buy_costume", "buy_pearl_pack", "purchase_storefront", "claim_storefront"]) {
    const command = { requestId: "00000000-0000-4000-8000-000000000001", kind, targetId: "starter_home_1_v1" };
    assert.equal(economyCommandSchema.safeParse(command).success, false);
    assert.equal(marketCommandSchema.safeParse(command).success, false);
  }
});
