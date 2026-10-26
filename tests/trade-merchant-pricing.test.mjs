import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { tradePurchaseUnitPrice } = await vite.ssrLoadModule("/features/economy/domain/trade-pricing.ts");
const { createFishingShop, fishingOfferUnitPrice } = await vite.ssrLoadModule("/features/economy/domain/fishing-shop.ts");
const { leaftailShopOffers, leaftailShopView } = await vite.ssrLoadModule("/features/economy/domain/leaftail-shop.ts");
const { localLeaftailPurchaseFromReceipt } = await vite.ssrLoadModule("/features/economy/domain/local-leaftail-purchase.ts");
const { reserveProduction } = await vite.ssrLoadModule("/features/economy/sync/production-journal.ts");
const now = Date.parse("2026-10-23T12:00:00Z"), owner = "AAAA-0000-0001";
function state(reputation = {}) {
  const value = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 5, workshopLevel: 3 });
  value.wallet.coins = 1_000_000;
  value.inventory = {};
  value.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  value.serverTime = new Date(now).toISOString();
  value.tradeRelations = { version: 1, reputation, activity: Object.fromEntries(Object.keys(reputation).map(id => [id, { pointsBps: 10000, updatedAt: new Date(now).toISOString() }])), dailyCycle: -1, dailyOrderXp: {}, dailyPurchaseXp: {}, weekly: null, weeklyAvailableAt: null, completedWeekly: 0 };
  return value;
}
const snapshot = (value, revision) => ({ ...structuredClone(value), ownerPublicId: owner, revision, serverTime: new Date(now).toISOString(), catalog: structuredClone(catalog), storage: rules.economyStorage(value) });
const command = (action, targetId, price = 0, quantity = 1) => ({ action, targetId, quantity, totalPrice: price, requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 4 });

test("merchant ranks discount only coin equipment and clothes with a ten percent ceiling", () => {
  for (const residentId of ["plesk", "leaftail"]) for (const rank of catalog.tradeRelations.ranks) {
    const value = state({ [residentId]: rank.requiredXp });
    for (const kind of ["rod", "hook", "bait", "wardrobe"]) {
      assert.equal(tradePurchaseUnitPrice(value, residentId, kind, 101), Math.ceil(101 * (10000 - rank.bonusBps) / 10000));
      assert.equal(tradePurchaseUnitPrice(value, residentId, kind, 101, "pearls"), 101);
    }
    for (const kind of ["fish", "item", "supplies", "refresh"]) assert.equal(tradePurchaseUnitPrice(value, residentId, kind, 101), 101);
  }
  assert.equal(tradePurchaseUnitPrice(state({ plesk: 1_000_000 }), "plesk", "rod", 100), 90);
  assert.equal(tradePurchaseUnitPrice(state({ plesk: 4200 }), "plesk", "rod", 0), 0);
});

test("Pleska debits the displayed pre-purchase rank once and crossing a rank affects the next purchase", () => {
  const value = state({ plesk: 99 });
  value.fishingShop = createFishingShop(value, now, () => 0);
  const offer = value.fishingShop.offers.find(item => item.kind === "rod");
  const nextOffer = value.fishingShop.offers.find(item => item.kind === "hook");
  const fishOffer = value.fishingShop.offers.find(item => item.kind === "fish");
  assert.ok(offer && nextOffer && fishOffer);
  const base = offer.unitPrice, before = value.wallet.coins;
  rules.applyEconomyCommand(value, command("buy_fishing_item", offer.id, base), now);
  assert.equal(value.wallet.coins, before - base);
  assert.equal(value.tradeRelations.reputation.plesk, 100);
  assert.equal(offer.unitPrice, base, "saved shop terms keep the base price");
  assert.ok(value.fishing.ownedRods.includes(offer.itemId));
  const discounted = fishingOfferUnitPrice(value, nextOffer, catalog);
  assert.equal(discounted, Math.ceil(nextOffer.unitPrice * .98));
  assert.ok(discounted < nextOffer.unitPrice, "the next eligible purchase uses the newly earned rank");
  rules.applyEconomyCommand(value, command("buy_fishing_item", nextOffer.id, discounted), now);
  assert.equal(value.wallet.coins, before - base - discounted);
  assert.ok(value.fishing.ownedHooks.includes(nextOffer.itemId));
  assert.equal(value.tradeRelations.reputation.plesk, 101);
  assert.ok(fishOffer.unitPrice > catalog.items.find(item => item.id === fishOffer.itemId).baseSellPrice,
    "the third purchase has a real coin cost after resale, so only the daily XP cap blocks its XP");
  rules.applyEconomyCommand(value, command("buy_fishing_item", fishOffer.id, fishOffer.unitPrice), now);
  assert.equal(value.wallet.coins, before - base - discounted - fishOffer.unitPrice);
  assert.equal(value.tradeRelations.reputation.plesk, 101, "the daily purchase XP allowance is exhausted");
});

test("Leaftail receipt uses before-rank price while the response may already show a better rank", () => {
  const value = state({ leaftail: 99 }), view = snapshot(value, 4);
  const offer = leaftailShopView(view, now, catalog).offers.find(item => item.kind === "rod" && !item.owned);
  assert.ok(offer);
  const sent = command("buy_leaftail_item", offer.targetId, offer.unitPrice);
  rules.applyEconomyCommand(value, sent, now);
  const after = snapshot(value, 5), result = { state: after, acceptedRevision: 5, replayed: false, message: "Покупка" };
  const receipt = localLeaftailPurchaseFromReceipt(view, result, sent);
  assert.ok(receipt);
  assert.equal(receipt.coins, offer.unitPrice);
  assert.equal(receipt.kind, "rod");
  assert.ok(after.fishing.ownedRods.includes(offer.itemId));
  assert.equal(after.tradeRelations.reputation.leaftail, 100);
  const current = leaftailShopView(after, now, catalog).offers.find(item => item.id === offer.id);
  assert.equal(current.unitPrice, Math.ceil(offer.unitPrice * .98));
  assert.ok(current.unitPrice < receipt.coins);
  assert.equal(current.baseUnitPrice, offer.baseUnitPrice);
});

test("daily supplies and pearl finds keep original prices at maximum merchant friendship", () => {
  const value = snapshot(state({ leaftail: 4200, plesk: 4200 }), 4), shop = leaftailShopView(value, now, catalog);
  const raw = leaftailShopOffers(catalog, shop.cycle, owner, 5);
  for (const offer of shop.offers) {
    const original = raw.find(item => item.id === offer.id);
    assert.equal(offer.baseUnitPrice, original.unitPrice);
    if (offer.kind === "item" || offer.currency === "pearls") assert.equal(offer.unitPrice, original.unitPrice);
  }
});

test("offline woodlot reservation predicts the same frozen friendship duration without awarding XP", () => {
  const value = state({ lopukh: 4200 }), view = snapshot(value, 4);
  const recipe = catalog.recipes.find(item => item.buildingId === "woodlot" && Object.keys(item.cost.items).length === 0);
  assert.ok(recipe);
  const sent = command("start_production", recipe.id), projected = reserveProduction(view, { requestId: sent.requestId, targetId: recipe.id });
  assert.ok(projected);
  rules.applyEconomyCommand(value, sent, now, () => sent.requestId);
  assert.equal(projected.jobs.at(-1).finishesAt, value.jobs.at(-1).finishesAt);
  assert.equal(projected.jobs.at(-1).tradeSpeedBps, 1000);
  assert.deepEqual(projected.tradeRelations, view.tradeRelations);
  assert.equal(projected.revision, view.revision);
});
