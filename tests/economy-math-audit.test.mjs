import assert from "node:assert/strict";
import test from "node:test";
import { readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { economicMath, auditEconomicMath } from "../scripts/lib/economy-math.mjs";

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("elementary materials retain recursive occupied-slot minutes without treating parallel slots as a wall clock", () => {
  const math = economicMath(readEconomyCatalog());
  assert.deepEqual(math.profile("planks").slotMinutes, { workshop: 15, woodlot: 8 });
  near(math.profile("rope").totalSlotMinutes, 17.5);
  const brick = math.profile("bricks");
  near(brick.slotMinutes.kiln, 30); near(brick.slotMinutes.quarry, 8.4375); near(brick.slotMinutes.woodlot, 4);
  near(brick.slotMinutes.mochlik, 8.4375);
  near(math.profile("tools").totalSlotMinutes, 309.5);
  near(math.profile("reinforced_parts").totalSlotMinutes, 504);
  assert.equal(math.profile("fiber").sourceHome, 1, "Forest output exists before the dedicated fiber station");
  assert.equal(math.profile("fiber").referenceHome, 2);
  const berry = math.profile("berries");
  near(berry.slotMinutes.garden, (1800 + 8) / 60 / 10);
  near(berry.slotMinutes.mochlik, 8 / 60 / 10);
  const catalog = readEconomyCatalog();
  const dry = math.batch(catalog.recipes.find(r => r.id === "dry_berries"));
  assert.equal(dry.directHome, 1); assert.equal(dry.referenceHome, 2);
});

test("focused mining routes reserve the same intrinsic minutes of both Mochlik and the mine", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  const routes = catalog.explorations.filter(r => r.id.startsWith("quarry_"));
  assert.equal(routes.length, 8);
  for (const recipe of routes) {
    const batch = math.batch(recipe);
    near(batch.slotMinutes.quarry, recipe.seconds / 60);
    near(batch.slotMinutes.mochlik, recipe.seconds / 60);
    near(batch.processMinutes, recipe.seconds / 60);
  }
  near(math.profile("stone").slotMinutes.mochlik, 3.75);
  near(math.profile("ore").slotMinutes.mochlik, 9);
  near(math.profile("tools").slotMinutes.mochlik, 27);
  near(math.profile("reinforced_parts").slotMinutes.mochlik, 54);
  assert.equal(math.profile("wood").slotMinutes.mochlik, undefined, "Passive gathering remains independent");
});

test("a joint long order is costed once and exposes its output portfolio rather than charging the entire recipe per product", () => {
  const c = readEconomyCatalog(), math = economicMath(c);
  const batch = math.batch(c.recipes.find(r => r.id === "workshop_structures"));
  assert.deepEqual(batch.output, { beams: 2, cut_stone: 2, metal_parts: 2 });
  near(batch.slotMinutes.workshop, 500); near(batch.elementaryOutputMinutes.workshop, 290);
  for (const id of ["woodlot", "quarry", "kiln", "mochlik"]) near(batch.slotMinutes[id], batch.elementaryOutputMinutes[id]);
  assert.equal(batch.coins, 0);
  const cycle = structuredClone(c); cycle.recipes.find(r => r.id === "make_planks").cost.items.planks = 1;
  assert.throws(() => economicMath(cycle).profile("planks"), /Production cycle/);
});

test("catch expectation changes exactly one fish and keeps bait spending distinct from its fractional species portfolio", () => {
  const math = economicMath(readEconomyCatalog()), initial = math.catchPortfolio();
  near(Object.values(initial.output).reduce((a, b) => a + b, 0), 4);
  near(initial.output.fish, (3 + 10010 / 16955)); near(initial.expectedFishRevenue, 342.0713653789443);
  near(math.catchPortfolio("river_rod").expectedFishRevenue, 350.62731247897744);
  const bait = math.catchPortfolio("reed_rod", "crumb_bait");
  assert(bait.expectedFishRevenue - initial.expectedFishRevenue < bait.baitPurchaseCoins);
  assert.equal(math.sourceHome("charcoal"), 2); assert.equal(math.sourceHome("resin"), 3); assert.equal(math.sourceHome("tools"), 4);
  assert.equal(auditEconomicMath(readEconomyCatalog()).profiles.length, 42);
  const chargedRoute = readEconomyCatalog();
  chargedRoute.explorations.find(r => r.id === "shore").cost = { coins: 7, items: { wood: 2 } };
  const charged = economicMath(chargedRoute).profile("fish");
  near(charged.coins, 7 / (3 + 10010 / 16955)); near(charged.slotMinutes.woodlot, 8 / (3 + 10010 / 16955));
});

test("overnight catch has six species draws within a fixed catch volume and consumes one bait", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  const best = math.catchPortfolio('starfall_rod', 'firefly_bait', 'shore', 'leviathan_hook');
  const camp = math.catchPortfolio('starfall_rod', 'firefly_bait', 'shore_camp', 'leviathan_hook');
  assert.equal(best.speciesDrawsPerJob, 1); assert.equal(camp.speciesDrawsPerJob, 6);
  near(best.probabilities.fish_shark, 18 / 4572);
  near(best.expectedFishRevenue, 355.99300087489064);
  near(camp.expectedFishRevenue, 6 * best.expectedFishRevenue);
  near(Object.values(camp.output).reduce((a, b) => a + b, 0), 24);
  assert.equal(camp.output.wood, undefined);
  assert(camp.speciesDrawsPerJob / camp.slotMinutes.mochlik < best.speciesDrawsPerJob / best.slotMinutes.mochlik, 'Repeated short trips remain faster at collection discovery');
  assert.equal(best.baitPurchaseCoins, 260); assert.equal(camp.baitPurchaseCoins, 260);
  const report = auditEconomicMath(catalog);
  assert.equal(report.fishingLoadouts.length, 180);
  for (const loadout of report.fishingLoadouts.filter(row => row.baitId)) {
    const noBait = report.fishingLoadouts.find(row => row.rodId === loadout.rodId && row.hookId === loadout.hookId && !row.baitId);
    assert.ok(loadout.expectedFishRevenue - noBait.expectedFishRevenue < loadout.baitPurchaseCoins);
  }
});

test("rare materials have one shared earned-time clock and no invented NPC price or additive production work", () => {
  const report = auditEconomicMath(readEconomyCatalog());
  for (const p of report.profiles.filter(profile => profile.acquisition)) {
    assert.equal(p.sourceHome, 3); assert.equal(p.referenceHome, 3);
    assert.deepEqual(p.slotMinutes, {});
    assert.equal(p.oneUnitNpcRevenue, 0); assert.equal(p.slotOpportunityCoins, null);
    assert.equal(p.acquisition.coinPurchasePrice, null);
    assert.equal(p.acquisition.meanAnySeconds / 3600, 96);
    assert.equal(p.acquisition.expectedSpecificSeconds / 3600, 288);
    assert.equal(p.acquisition.expectedCompleteSetSeconds / 3600, 528);
    assert.equal(p.acquisition.finiteSpecificGuarantee, false);
  }
  assert.equal(report.profiles.filter(profile => profile.acquisition).length, 3);
});

test("fish references disclose both legendary tackle startup costs and use the eligible catch portfolio", () => {
  const math = economicMath(readEconomyCatalog()), shark = math.profile("fish_shark");
  assert.equal(shark.sourceHome, 4); assert.equal(shark.referenceHome, 4);
  assert.equal(shark.catchReference.hookId, "leviathan_hook");
  assert.equal(shark.catchReference.rodId, "starfall_rod");
  near(shark.catchReference.probability, 8 / 3838);
  near(shark.slotMinutes.mochlik, 45 * 3838 / 8);
  assert.equal(shark.coins, 0, "the permanent hook startup price is disclosed separately from every catch");
  assert.equal(shark.catchReference.hookPurchaseCoins, 260000);
  assert.equal(shark.catchReference.rodPurchaseCoins, 360000);
  assert.equal(shark.catchReference.finiteGuarantee, false);
  assert.equal(math.profile("glow_bait").sourceHome, 2);
  assert.equal(math.profile("firefly_bait").sourceHome, 3);
});


test("each specialist rod and hook can lead a distinct rarity objective instead of universally dominating cheaper gear", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  const roles = ["common", "uncommon", "rare", "epic", "legendary"];
  const share = (portfolio, rarity) => catalog.fishing.fish.filter(fish => fish.rarity === rarity)
    .reduce((sum, fish) => sum + portfolio.probabilities[fish.itemId], 0);
  for (const [index, rarity] of roles.entries()) {
    const rod = catalog.fishing.rods.find(item => item.id === ["reed_rod", "river_rod", "willow_rod", "tide_rod", "starfall_rod"][index]),
      hook = catalog.fishing.hooks.find(item => item.id === ["bare_hook", "barbed_hook", "silver_hook", "tide_hook", "leviathan_hook"][index]);
    const own = math.catchPortfolio(rod.id, null, "shore", hook.id);
    assert(catalog.fishing.rods.every(other => share(own, rarity) >= share(math.catchPortfolio(other.id, null, "shore", hook.id), rarity)), `${rod.id}: missing intended ${rarity} role`);
    assert(catalog.fishing.hooks.every(other => share(own, rarity) >= share(math.catchPortfolio(rod.id, null, "shore", other.id), rarity)), `${hook.id}: missing intended ${rarity} role`);
  }
});
