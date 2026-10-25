import assert from "node:assert/strict";
import test from "node:test";
import { readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { economicMath, auditEconomicMath } from "../scripts/lib/economy-math.mjs";

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("elementary materials retain recursive occupied-slot minutes without treating parallel slots as a wall clock", () => {
  const math = economicMath(readEconomyCatalog());
  assert.deepEqual(math.profile("planks").slotMinutes, { workshop: 2, woodlot: 3 });
  near(math.profile("rope").totalSlotMinutes, 4.5);
  const brick = math.profile("bricks");
  near(brick.slotMinutes.kiln, 5); near(brick.slotMinutes.quarry, 3); near(brick.slotMinutes.woodlot, 3);
  near(brick.slotMinutes.miner, 3);
  near(math.profile("tools").totalSlotMinutes, 127.5);
  near(math.profile("reinforced_parts").totalSlotMinutes, 248.5);
  assert.equal(math.profile("fiber").sourceHome, 1, "Forest output exists before the dedicated fiber station");
  assert.equal(math.profile("fiber").referenceHome, 3);
  const berry = math.profile("berries");
  near(berry.slotMinutes.garden, (60 + 8) / 60);
  near(berry.slotMinutes.mochlik, 8 / 60);
  const catalog = readEconomyCatalog();
  near(math.batch(catalog.recipes.find(r => r.id === "grow_berries")).slotMinutes.garden, (60 + 8) / 60);
  const dry = math.batch(catalog.recipes.find(r => r.id === "dry_berries"));
  assert.equal(dry.directHome, 3); assert.equal(dry.referenceHome, 3);
});

test("focused mining reserves the independent miner and mine while hero occupancy stays separate", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  const routes = catalog.explorations.filter(r => r.id.startsWith("quarry_") && !r.retired);
  assert.equal(routes.length, 6);
  for (const recipe of routes) {
    const batch = math.batch(recipe);
    near(batch.slotMinutes.quarry, recipe.seconds / 60);
    near(batch.slotMinutes.miner, recipe.seconds / 60);
    assert.equal(batch.slotMinutes.mochlik, undefined);
    near(batch.processMinutes, recipe.seconds / 60);
  }
  near(math.profile("stone").slotMinutes.miner, 3);
  near(math.profile("ore").slotMinutes.miner, 10);
  near(math.profile("tools").slotMinutes.miner, 30);
  near(math.profile("reinforced_parts").slotMinutes.miner, 60);
  assert.equal(math.profile("wood").slotMinutes.mochlik, undefined, "Passive gathering remains independent");
});

test("a saved legacy joint job is costed once and exposes its portfolio without charging the whole recipe per product", () => {
  const c = readEconomyCatalog(), math = economicMath(c);
  assert.equal(c.recipes.some(r => r.id === "workshop_structures"), false, "Retired bulk jobs cannot be started again");
  const paidTerms = { id: "workshop_structures", buildingId: "workshop", buildingLevel: 4, requiredHomeLevel: 4,
    requiredBuildings: {}, seconds: 28800, cost: { coins: 0, items: { hardwood: 8, rope: 2, stone: 6, iron_ingot: 2, wood: 2 } },
    rewards: { beams: 2, cut_stone: 2, metal_parts: 2 }, maxBatch: 1 };
  const batch = math.batch(paidTerms);
  assert.deepEqual(batch.output, { beams: 2, cut_stone: 2, metal_parts: 2 });
  near(batch.slotMinutes.workshop, 486); near(batch.elementaryOutputMinutes.workshop, 90);
  for (const id of ["woodlot", "quarry", "kiln", "miner"]) near(batch.slotMinutes[id], batch.elementaryOutputMinutes[id]);
  assert.equal(batch.coins, 0);
  const cycle = structuredClone(c); cycle.recipes.find(r => r.id === "make_planks").cost.items.planks = 1;
  assert.throws(() => economicMath(cycle).profile("planks"), /Production cycle/);
});

test("catch expectation accounts for every fish as class stock and separately prices bait", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog), initial = math.catchPortfolio();
  near(Object.values(initial.output).reduce((a, b) => a + b, 0), 2);
  near(initial.output.fish_common, 2 * initial.classProbabilities.fish_common);
  assert.equal(initial.output.fish, undefined);
  near(initial.expectedFishRevenue, catalog.fishing.classes.reduce((sum, group) =>
    sum + initial.output[group.itemId] * catalog.items.find(item => item.id === group.itemId).baseSellPrice, 0));
  const bait = math.catchPortfolio("reed_rod", "crumb_bait");
  assert.equal(bait.baitPurchaseCoins, catalog.fishing.baits.find(b => b.itemId === "crumb_bait").price);
  assert.equal(math.sourceHome("charcoal"), 2); assert.equal(math.sourceHome("resin"), 3); assert.equal(math.sourceHome("tools"), 4);
  assert.equal(auditEconomicMath(catalog).profiles.length, catalog.items.length);
  const chargedRoute = readEconomyCatalog();
  chargedRoute.explorations.find(r => r.id === "shore").cost = { coins: 7, items: { wood: 2 } };
  const charged = economicMath(chargedRoute).profile("fish_common");
  near(charged.coins, 7 / initial.output.fish_common);
  near(charged.slotMinutes.woodlot, 6 / initial.output.fish_common);
});

test("first-stage fixed NPC prices are exact and strawberry profiles retain their recipe unlock", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  for (const [id, price] of Object.entries(catalog.localBuyer.unitPrices)) {
    assert.equal(math.liquidation({ [id]: 1 }), price);
    assert.equal(math.liquidation({ [id]: 3 }), price * 3);
  }
  const strawberry = math.profile("strawberries");
  assert.deepEqual(strawberry.unlockRecipes, { cook_compote: 1 });
  assert.equal(strawberry.producerLevels.dryer, 1);
  near(strawberry.slotMinutes.garden, 308 / 60);
  near(math.batch(catalog.recipes.find(recipe => recipe.id === "grow_strawberries")).slotMinutes.garden, 308 / 60);
  const locked = structuredClone(catalog); locked.recipes.find(recipe => recipe.id === "cook_compote").requiredHomeLevel = 2;
  assert.equal(economicMath(locked).sourceHome("strawberries"), 2);
  locked.recipes.find(recipe => recipe.id === "cook_compote").requiredRecipes = { grow_strawberries: 1 };
  assert.throws(() => economicMath(locked).sourceHome("strawberries"), /Recipe unlock cycle/);
});

test("new berry processing includes all crop collection and upstream station work", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  for (const [home, crop, product, seconds] of [
    [2, "blueberries", "blueberry_compote", 180],
    [3, "currants", "currant_jelly", 720],
    [4, "blackberries", "blackberry_preserve", 1800],
    [5, "cranberries", "cranberry_glaze", 3600],
  ]) {
    const cropProfile = math.profile(crop), productProfile = math.profile(product);
    near(cropProfile.slotMinutes.garden, (seconds + 8) / 60);
    near(cropProfile.slotMinutes.mochlik, 8 / 60);
    assert.equal(cropProfile.sourceHome, home); assert.equal(productProfile.referenceHome, home);
    assert(productProfile.slotMinutes.garden >= 2 * cropProfile.slotMinutes.garden);
    const recipe = catalog.recipes.find(row => row.rewards[product] > 0);
    assert.equal(math.liquidation(recipe.rewards) - math.liquidation(recipe.cost.items), recipe.seconds / 60 * 10);
    assert.equal(productProfile.producerLevels.garden, home);
  }
  const dessert = math.profile("cranberry_glaze");
  assert.equal(dessert.producerLevels.dryer, 4);
  assert.equal(dessert.rawInputs.cranberries, 2);
  assert.equal(dessert.rawInputs.currants, 2);
  assert.equal(dessert.rawInputs.berries, 2);
  const jam = math.profile("blackberry_preserve");
  assert.equal(jam.rawInputs.quartz, 1);
  assert(jam.slotMinutes.kiln > 0 && jam.slotMinutes.miner > 0, "A jar must include real glass and its mining inputs");
});

test("the longer catch gives eight class draws and consumes one bait per trip", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  const best = math.catchPortfolio("starfall_rod", "star_bait", "shore", "leviathan_hook");
  const camp = math.catchPortfolio("starfall_rod", "star_bait", "shore_camp", "leviathan_hook");
  assert.equal(best.speciesDrawsPerJob, 2); assert.equal(camp.speciesDrawsPerJob, 8);
  near(best.probabilities.fish_shark, 27 / 35);
  near(camp.expectedFishRevenue, 4 * best.expectedFishRevenue);
  near(Object.values(camp.output).reduce((a, b) => a + b, 0), 8);
  assert.equal(camp.output.wood, undefined);
  assert(camp.speciesDrawsPerJob / camp.slotMinutes.mochlik < best.speciesDrawsPerJob / best.slotMinutes.mochlik);
  assert.equal(best.baitPurchaseCoins, catalog.fishing.baits.find(b => b.itemId === "star_bait").price);
  assert.equal(camp.baitPurchaseCoins, best.baitPurchaseCoins);
  const loadouts = auditEconomicMath(catalog).fishingLoadouts;
  const combinations = catalog.fishing.rods.length * catalog.fishing.hooks.length * (catalog.fishing.baits.length + 1);
  assert.equal(loadouts.length, combinations);
  assert.equal(new Set(loadouts.map(row => `${row.rodId}:${row.hookId}:${row.baitId}`)).size, combinations,
    "the audit covers each distinct rod, hook and bait combination exactly once");
});

test("rare-material expectations describe each independent actor clock without invented NPC price or additive ingredient work", () => {
  const report = auditEconomicMath(readEconomyCatalog());
  for (const p of report.profiles.filter(profile => profile.acquisition)) {
    assert.equal(p.sourceHome, 3); assert.equal(p.referenceHome, 3);
    assert.deepEqual(p.slotMinutes, {});
    assert.equal(p.oneUnitNpcRevenue, 0); assert.equal(p.slotOpportunityCoins, null);
    assert.equal(p.acquisition.coinPurchasePrice, null);
    assert.equal(p.acquisition.clock, "per_actor_exploration");
    assert.deepEqual(p.acquisition.actors, ["mochlik", "miner"]);
    assert.equal(p.acquisition.meanAnySeconds / 3600, 96);
    assert.equal(p.acquisition.expectedSpecificSeconds / 3600, 288);
    assert.equal(p.acquisition.expectedCompleteSetSeconds / 3600, 528);
    assert.equal(p.acquisition.finiteSpecificGuarantee, false);
  }
  assert.equal(report.profiles.filter(profile => profile.acquisition).length, 3);
});

test("fish references use the least expensive eligible rod and allow legendary fish with the free hook", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog), shark = math.profile("fish_shark");
  assert.equal(shark.sourceHome, 4); assert.equal(shark.referenceHome, 4);
  assert.equal(shark.catchReference.hookId, "bare_hook");
  assert.equal(shark.catchReference.rodId, "dusk_rod");
  const eligible = catalog.fishing.rods.filter(rod => rod.rarity === "legendary" && rod.classOddsBps.legendary > 0);
  const reference = eligible.find(rod => rod.id === shark.catchReference.rodId);
  assert.equal(reference.price, Math.min(...eligible.map(rod => rod.price)));
  for (const rod of eligible) assert(math.catchPortfolio(rod.id, null, "shore", "bare_hook").classProbabilities.fish_legendary > 0,
    `${rod.id}: legendary fish must remain available with the free hook`);
  const portfolio = math.catchPortfolio(reference.id, null, "shore", "bare_hook");
  near(shark.catchReference.probability, portfolio.classProbabilities.fish_legendary);
  near(shark.slotMinutes.mochlik, 3 / portfolio.output.fish_legendary);
  assert.equal(shark.coins, 0, "the permanent hook startup price is disclosed separately from every catch");
  assert.equal(shark.catchReference.hookPurchaseCoins, 0);
  assert.equal(shark.catchReference.rodPurchaseCoins, reference.price);
  assert.equal(shark.catchReference.finiteGuarantee, false);
  assert.equal(math.profile("glow_bait").sourceHome, 2);
  assert.equal(math.profile("firefly_bait").sourceHome, 3);
  assert.equal(math.profile("star_bait").sourceHome, 4);
});


test("each specialist rod and hook can lead a distinct rarity objective instead of universally dominating cheaper gear", () => {
  const catalog = readEconomyCatalog(), math = economicMath(catalog);
  const roles = ["common", "uncommon", "rare", "epic", "legendary"];
  // Rarity objectives use economic class tickets, independent of roundoff when
  // their probability is distributed among preferred collection species.
  const share = (portfolio, rarity) => portfolio.classProbabilities[`fish_${rarity}`];
  for (const [index, rarity] of roles.entries()) {
    const rod = catalog.fishing.rods.find(item => item.id === ["reed_rod", "river_rod", "willow_rod", "tide_rod", "starfall_rod"][index]),
      hook = catalog.fishing.hooks.find(item => item.id === ["bare_hook", "barbed_hook", "silver_hook", "tide_hook", "leviathan_hook"][index]);
    const own = math.catchPortfolio(rod.id, null, "shore", hook.id);
    assert(catalog.fishing.rods.every(other => share(own, rarity) >= share(math.catchPortfolio(other.id, null, "shore", hook.id), rarity)), `${rod.id}: missing intended ${rarity} role`);
    assert(catalog.fishing.hooks.every(other => share(own, rarity) >= share(math.catchPortfolio(rod.id, null, "shore", other.id), rarity)), `${hook.id}: missing intended ${rarity} role`);
  }
});
