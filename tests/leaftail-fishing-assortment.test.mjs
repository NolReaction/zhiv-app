import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { auditFishingBalance } from "../scripts/audit-fishing-balance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { fishingClassOdds, fishingBaitCompatible, selectFishingCatch } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const fishing = economyCatalog.fishing;
const odds = (rodId, hookId = "bare_hook", baitId = null) =>
  Object.fromEntries(fishingClassOdds({}, fishing, { rodId, hookId, baitId }).map(row => [row.rarity, row.probability]));

test("Leaftail rods offer two useful directions without replacing the class specialists", () => {
  const targets = { traveller_rod: ["uncommon", "rare"], marsh_rod: ["common", "epic"], dusk_rod: ["epic", "legendary"] };
  const specialists = { common: "reed_rod", uncommon: "river_rod", rare: "willow_rod", epic: "tide_rod", legendary: "starfall_rod" };
  for (const [rodId, directions] of Object.entries(targets)) {
    const rod = fishing.rods.find(rod => rod.id === rodId), chances = odds(rodId);
    assert.equal(rod.shop, "leaftail");
    assert.ok(rod.requiredHomeLevel >= economyCatalog.leaftailShop.requiredHomeLevel);
    for (const rarity of directions) {
      assert.ok(chances[rarity] >= .3, `${rodId} has a meaningful ${rarity} share`);
      assert.ok(chances[rarity] < odds(specialists[rarity])[rarity], `${rodId} cannot displace the ${rarity} specialist`);
    }
  }
  assert.equal(odds("traveller_rod").legendary, 0);
  assert.equal(odds("marsh_rod").legendary, 0);
  assert.equal(odds("dusk_rod").legendary, .3);
  const boosted = odds("dusk_rod", "dusk_hook", "dusk_bait"), plain = odds("dusk_rod");
  assert.ok(boosted.epic > plain.epic && boosted.legendary > plain.legendary);
});

test("new tackle keeps class specialists and starter income while cheap mixed bait has a bounded net benefit", () => {
  const report = auditFishingBalance(economyCatalog);
  assert.deepEqual(report.targets.map(({ rarity, rodId, hookId, baitId }) => [rarity, rodId, hookId, baitId]), [
    ["common", "reed_rod", "bare_hook", "crumb_bait"],
    ["uncommon", "river_rod", "barbed_hook", "worm_bait"],
    ["rare", "willow_rod", "silver_hook", "glow_bait"],
    ["epic", "tide_rod", "tide_hook", "firefly_bait"],
    ["legendary", "starfall_rod", "leviathan_hook", "star_bait"],
  ]);
  const old = structuredClone(economyCatalog);
  for (const kind of ["rods", "hooks", "baits"]) old.fishing[kind] = old.fishing[kind].filter(item => item.shop !== "leaftail");
  const previous = auditFishingBalance(old);
  for (const [index, row] of report.incomeRanges.entries()) {
    assert.ok(row.minimumNetSaleCoinsPerHour > 0);
    const route = economyCatalog.explorations.find(route => route.id === row.routeId);
    const oldMaximum = previous.incomeRanges[index].maximumNetSaleCoinsPerHour;
    assert.ok(row.maximumNetSaleCoinsPerHour >= oldMaximum, "adding choices cannot remove an existing loadout");
    // V14's mixed bait costs one coin less than the specialist's top bait.
    // Keep any resulting maximum-income gain below one coin per actual cast.
    assert.ok(row.maximumNetSaleCoinsPerHour <= oldMaximum + 3600 / route.seconds);
    assert.equal(row.starterNetSaleCoinsPerHour, previous.incomeRanges[index].starterNetSaleCoinsPerHour);
  }
});

test("mixed baits cannot create missing rod classes and every new cast uses the existing species rules", () => {
  assert.equal(fishingBaitCompatible("reed_rod", "dusk_bait", fishing), false);
  assert.equal(fishingBaitCompatible("traveller_rod", "spice_bait", fishing), true);
  for (const rod of fishing.rods.filter(rod => rod.shop === "leaftail")) {
    for (let index = 0; index < 100; index++) {
      const itemId = selectFishingCatch(`travelling-loadout-${index}`, rod.id, "dusk_bait", fishing, "dusk_hook");
      const species = fishing.fish.find(species => species.itemId === itemId);
      assert.ok(species);
      assert.ok(rod.classOddsBps[species.rarity] > 0);
    }
  }
});


test("a mixed epic hook is permanent 1800-coin equipment with bounded marginal returns rather than 25 extra probability points", async () => {
  const { fishingOfferUnitPrice } = await vite.ssrLoadModule("/features/economy/domain/fishing-shop.ts");
  const { tradePurchaseUnitPrice } = await vite.ssrLoadModule("/features/economy/domain/trade-pricing.ts");
  const now = Date.parse("2026-11-02T12:00:00Z");
  const friends = { tradeRelations: { reputation: { plesk: 1600, leaftail: 1600 }, activity: Object.fromEntries(
    ["plesk", "leaftail"].map(id => [id, { pointsBps: 10000, updatedAt: new Date(now).toISOString() }])) } };
  const report = auditFishingBalance(economyCatalog);
  for (const hookId of ["dusk_hook", "deep_hook"]) {
    const hook = fishing.hooks.find(item => item.id === hookId);
    const offer = economyCatalog.leaftailShop.travelOffers.find(item => item.itemId === hookId);
    assert.equal(hook.price, 1800);
    assert.equal(offer.priceCoins, hook.price);
    assert.equal(offer.quantity, 1);
    assert.equal(tradePurchaseUnitPrice(friends, "leaftail", "hook", hook.price, "coins", economyCatalog, now), 1620);
    assert.equal(fishingOfferUnitPrice(friends, { kind: "hook", unitPrice: hook.price }, economyCatalog, now), 1620);
    const before = odds("dusk_rod"), after = odds("dusk_rod", hookId);
    assert.ok(Math.abs(after.epic + after.legendary - 0.6989247311827957) < 1e-12);
    assert.ok(after.epic + after.legendary - before.epic - before.legendary < .05);
    const row = report.gearEconomics.hooks.find(entry => entry.hookId === hookId);
    const paired = row.rods.find(entry => entry.rodId === "dusk_rod");
    assert.ok(Math.abs(paired.hours.shore - 72.845953003) < 1e-8);
    assert.ok(row.fastestHours.shore > 50, "even the best plain loadout does not repay the hook through a few quick catches");
  }
});
