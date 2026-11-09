import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { economicMath } from "./lib/economy-math.mjs";

const rounded = value => Number(value.toFixed(6));
const exchange = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/currency-exchange-catalog.json", import.meta.url), "utf8"));

// Apply an independent, assumed landing probability to each available attempt.
// The final bucket is absorbing: the player stops once the hold is full.
function expectedCatches(capacity, attempts, probability) {
  const counts = new Array(capacity + 1).fill(0);
  counts[0] = 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (let caught = capacity; caught > 0; caught--)
      counts[caught] = counts[caught] * (caught === capacity ? 1 : 1 - probability) + counts[caught - 1] * probability;
    counts[0] *= (1 - probability);
  }
  return counts.reduce((sum, frequency, caught) => sum + frequency * caught, 0);
}

/** Long-run free supply and finite outing budgets, independently of rendering and player timing. */
export function auditBoatFishingBalance(catalog) {
  const boat = catalog.boat, fishing = catalog.fishing, math = economicMath(catalog);
  assert(boat && fishing, "Boat and fishing catalogs are required");
  const shore = catalog.explorations.find(route => route.id === "shore");
  assert(shore?.seconds > 0 && shore.rewards.fish > 0, "The historical baseline for comparing fish supply must be defined");
  const { storage, tank } = boat.moduleEffects;
  assert.deepEqual(boat.upgrades.filter(row => !row.module).map(row => row.id).sort(), ["landing_net", "telescope"]);
  for (const moduleId of ["engine", "tank", "hull", "storage"]) {
    const tiers = boat.upgrades.filter(row => row.module === moduleId).map(row => row.tier).sort((a, b) => a - b);
    assert.deepEqual(tiers, [1, 2, 3, 4, 5], `${moduleId}: each tier must exist exactly once`);
  }
  for (const capacities of [storage, tank])
    assert(capacities.length === 6 && capacities.every((n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n > capacities[i - 1])));
  const repair = boat.upgrades.find(row => row.id === "repair");
  assert.deepEqual([repair?.seconds, repair?.cost], [0, { coins: 0, items: {} }],
    "Starter fishing must require no currency or locked source");
  assert.equal(boat.fuel.baseCapacity, tank[0]);
  assert.deepEqual(Object.keys(boat.weights).sort(), fishing.fish.map(fish => fish.itemId).sort(), "Every collectible species has exactly one mass profile");
  for (const [id, weight] of Object.entries(boat.weights))
    assert(Number.isSafeInteger(weight.minGrams) && Number.isSafeInteger(weight.maxGrams) && weight.minGrams > 0 && weight.maxGrams > weight.minGrams,
      `${id}: integer mass bounds are ordered`);
  assert.deepEqual([boat.outboundSeconds, boat.inboundSeconds, boat.oarsTravelSeconds], [0, 0, 0]);
  assert.equal(boat.maxCasts, storage[0]);
  assert(Number.isSafeInteger(boat.spareCasts) && boat.spareCasts >= 0 && storage.at(-1) + boat.spareCasts <= 11);
  assert(boat.netZoneWidth > boat.zoneWidth && boat.netZoneWidth < 10000, "The net widens a bounded holding zone");

  const upgrades = boat.upgrades.map(upgrade => {
    assert.equal(upgrade.requiredHomeLevel, 1, `${upgrade.id}: available in a starter household`);
    assert.deepEqual(upgrade.requiredBuildings, {}, `${upgrade.id}: boat work does not require buildings`);
    assert.deepEqual(upgrade.cost.items, {}, `${upgrade.id}: coin-only price`);
    assert(upgrade.id === "repair" || (upgrade.seconds > 0 && upgrade.cost.coins > 0));
    return { id: upgrade.id, module: upgrade.module, tier: upgrade.tier, seconds: upgrade.seconds, coins: upgrade.cost.coins };
  });
  assert.deepEqual(boat.blueprints.map(blueprint => blueprint.id).sort(), ["landing_net", "telescope"]);
  const blueprints = boat.blueprints.map(blueprint => {
    assert.equal(blueprint.milestones.length, 3, `${blueprint.id}: retain the three legacy page thresholds`);
    assert(blueprint.milestones.every((value, index) => Number.isSafeInteger(value) && value > 0
      && (!index || value > blueprint.milestones[index - 1])), `${blueprint.id}: legacy thresholds strictly increase`);
    return { id: blueprint.id, legacyMilestones: blueprint.milestones, awardedByBoat: false };
  });

  const loadouts = [];
  for (const rod of fishing.rods) for (const hook of fishing.hooks) for (const bait of [null, ...fishing.baits]) {
    const portfolio = math.catchPortfolio(rod.id, bait?.itemId ?? null, "shore", hook.id);
    if (bait && !portfolio.classProbabilities[`fish_${bait.rarity}`]) continue;
    assert.equal(portfolio.speciesDrawsPerJob, shore.rewards.fish, "Every shore fish retains an independent species draw");
    const expectedValuePerFish = portfolio.expectedFishRevenue / portfolio.speciesDrawsPerJob;
    const baitCost = portfolio.baitPurchaseCoins;
    assert.equal(baitCost, bait?.price ?? 0, "The entire trip pays for exactly one bait portion");
    loadouts.push({ rodId: rod.id, hookId: hook.id, baitId: bait?.itemId ?? null, expectedValuePerFish, baitCost,
      shoreNetCoinsPerHour: (portfolio.expectedFishRevenue - baitCost) * 3600 / shore.seconds });
  }
  assert(loadouts.length > 0, "At least one owned loadout must remain usable");
  const tripsPerHour = 3600 / boat.fuel.regenSeconds;
  const oldShoreRate = shore.rewards.fish * 3600 / shore.seconds;
  const referenceCoinsPerRawPearl = Math.min(...exchange.offers.map(offer => offer.coins / offer.pearls));
  const topFishPrice = Math.max(...fishing.classes.map(item => math.liquidation({ [item.itemId]: 1 })));
  const refillAlternativeCoins = referenceCoinsPerRawPearl * boat.fuel.refillPricePearls;
  assert(tripsPerHour > 0 && Number.isFinite(tripsPerHour));
  assert(refillAlternativeCoins >= topFishPrice * storage.at(-1), "One emergency refill should not beat normal coin exchange even at maximum raw-fish sale");
  const starter = loadouts.find(row => row.rodId === "reed_rod" && row.hookId === "bare_hook" && !row.baitId);
  assert(starter, "A starter must be able to fish with no bait purchase");
  const holds = storage.map((capacity, tier) => {
    const attempts = capacity + boat.spareCasts;
    const maxFishPerHour = tripsPerHour * capacity;
    assert(maxFishPerHour <= oldShoreRate, "Free long-run supply exceeds the old shore route");
    const best = Math.max(...loadouts.map(row => capacity * row.expectedValuePerFish - row.baitCost));
    const sensitivity = [0.5, 0.75, 0.9].map(probability => {
      const catches = expectedCatches(capacity, attempts, probability);
      return { probability, expectedCatches: rounded(catches), expectedStarterSale: rounded(catches * starter.expectedValuePerFish) };
    });
    return { tier, capacity, attempts, maxFishPerHour, starterFullSale: rounded(capacity * starter.expectedValuePerFish),
      bestExpectedFullNetSale: rounded(best), luckyFullSaleCeiling: capacity * topFishPrice, sensitivity };
  });
  const tanks = tank.map((cells, tier) => ({ tier, cells, emptyToFullMinutes: cells * boat.fuel.regenSeconds / 60,
    // Equal, short visits draining the stock, in steady state after the initial fill.
    tripsAtDailyVisits: [1, 3, 6].map(visits => ({ visits, trips: visits * Math.min(cells, Math.floor(24 * tripsPerHour / visits)) })) }));
  return { kind: "fuel-limited-boat", catalogVersion: catalog.version, boatVersion: boat.version,
    legalLoadouts: loadouts.length, economicComparisons: loadouts.length * storage.length,
    fuel: { regenSeconds: boat.fuel.regenSeconds, tripsPerHour, refillRawPearls: boat.fuel.refillPricePearls, refillAlternativeCoins },
    historicalShore: { seconds: shore.seconds, catches: shore.rewards.fish, fishPerHour: oldShoreRate },
    starterExpectedValuePerFish: rounded(starter.expectedValuePerFish), holds, tanks, upgrades, blueprints };
}

/** Deterministic two-dimensional integration of the real runtime mass sampler.
 * Separate uniform axes avoid RNG seeds, flaky confidence intervals and timing.
 */
export function auditBoatFishWeights(catalog, sampleWeight, gridSize = 128) {
  assert(Number.isInteger(gridSize) && gridSize >= 64 && gridSize <= 256);
  const expectedTopTenth = 1 - .9 + .9 * Math.log(.9);
  return Object.entries(catalog.boat.weights).map(([fishId, { minGrams, maxGrams }]) => {
    const span = maxGrams - minGrams;
    assert.equal(sampleWeight(minGrams, maxGrams, 0, 9999), minGrams);
    assert.equal(sampleWeight(minGrams, maxGrams, 9999, 0), minGrams);
    let total = 0, upperTenth = 0;
    for (let first = 0; first < gridSize; first++) for (let second = 0; second < gridSize; second++) {
      const a = Math.floor((first + .5) * 10000 / gridSize), b = Math.floor((second + .5) * 10000 / gridSize);
      const grams = sampleWeight(minGrams, maxGrams, a, b);
      assert(Number.isSafeInteger(grams) && grams >= minGrams && grams < maxGrams, `${fishId}: every sample is a bounded integer`);
      const normalized = (grams - minGrams) / span;
      total += normalized;
      if (normalized >= .9) upperTenth++;
    }
    const count = gridSize ** 2, mean = total / count, tail = upperTenth / count;
    assert(Math.abs(mean - .25) < .003, `${fishId}: mass is concentrated below the midpoint, not uniformly spread`);
    assert(Math.abs(tail - expectedTopTenth) < .0015, `${fishId}: the upper tenth remains a rare positive tail`);
    return { fishId, minGrams, maxGrams, samples: count, meanPositionInRange: rounded(mean), probabilityUpperTenth: rounded(tail) };
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
  const vite = await createServer({ appType: "custom", configFile: false, root,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { boatFishWeight } = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
    console.log(JSON.stringify({ ...auditBoatFishingBalance(catalog), weights: auditBoatFishWeights(catalog, boatFishWeight) }, null, 2));
  } finally { await vite.close(); }
}
