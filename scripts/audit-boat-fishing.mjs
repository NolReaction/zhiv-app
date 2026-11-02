import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { economicMath } from "./lib/economy-math.mjs";

const rounded = value => Number(value.toFixed(6));
const modes = [[], ["crate"], ["oars"], ["crate", "oars"]];

/** Economic ceiling: instant successful casts, no visits, input mistakes or latency.
 * This deliberately gives active fishing every advantage; it is not a playthrough.
 */
export function auditBoatFishingBalance(catalog) {
  const boat = catalog.boat, fishing = catalog.fishing, math = economicMath(catalog);
  assert(boat && fishing, "Boat and fishing catalogs are required");
  const shore = catalog.explorations.find(route => route.id === "shore");
  assert(shore?.seconds > 0 && shore.rewards.fish > 0, "The existing shore comparator must remain available");
  assert.deepEqual([...boat.upgrades.map(upgrade => upgrade.id)].sort(), ["crate", "landing_net", "oars", "repair", "telescope"]);
  assert.deepEqual(Object.keys(boat.weights).sort(), fishing.fish.map(fish => fish.itemId).sort(), "Every collectible species has exactly one mass profile");
  for (const [id, weight] of Object.entries(boat.weights))
    assert(Number.isSafeInteger(weight.minGrams) && Number.isSafeInteger(weight.maxGrams) && weight.minGrams > 0 && weight.maxGrams > weight.minGrams,
      `${id}: integer mass bounds are ordered`);
  assert(boat.outboundSeconds > 0 && boat.inboundSeconds > 0 && boat.oarsTravelSeconds > 0, "Both road legs remain positive");
  assert(boat.maxCasts >= 1 && boat.maxCasts + 1 <= 10, "The crate adds one bounded attempt");
  assert(boat.netZoneWidth > boat.zoneWidth && boat.netZoneWidth < 10000, "The net widens a bounded holding zone");

  const upgrades = boat.upgrades.map(upgrade => {
    const sourceHome = Math.max(1, ...Object.keys(upgrade.cost.items).map(id => math.sourceHome(id)));
    assert(upgrade.requiredHomeLevel >= sourceHome, `${upgrade.id}: material sources must exist by its advertised house`);
    assert(upgrade.seconds > 0 && upgrade.cost.coins >= 0);
    return { id: upgrade.id, home: upgrade.requiredHomeLevel, seconds: upgrade.seconds, coins: upgrade.cost.coins,
      inputs: upgrade.cost.items, inputSaleValue: math.liquidation(upgrade.cost.items),
      totalForegoneSaleValue: upgrade.cost.coins + math.liquidation(upgrade.cost.items) };
  });
  assert.deepEqual(boat.blueprints.map(blueprint => blueprint.id).sort(), ["landing_net", "telescope"]);
  const blueprints = boat.blueprints.map(blueprint => {
    assert.equal(blueprint.milestones.length, 3, `${blueprint.id}: exactly three distinct pages`);
    assert(blueprint.milestones.every((value, index) => Number.isSafeInteger(value) && value > 0
      && (!index || value > blueprint.milestones[index - 1])), `${blueprint.id}: milestones strictly increase`);
    return { id: blueprint.id, milestones: blueprint.milestones, guaranteedAtQualifiedVoyage: blueprint.milestones.at(-1) };
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
  const reports = modes.map(upgrades => {
    const casts = boat.maxCasts + Number(upgrades.includes("crate"));
    const travelSeconds = upgrades.includes("oars") ? boat.oarsTravelSeconds * 2 : boat.outboundSeconds + boat.inboundSeconds;
    const fishPerHour = casts * 3600 / travelSeconds;
    assert(fishPerHour <= shore.rewards.fish * 3600 / shore.seconds, "Boat attempt ceiling must not exceed the existing shore catch rate");
    const rows = loadouts.map(loadout => {
      const netCoinsPerHour = (casts * loadout.expectedValuePerFish - loadout.baitCost) * 3600 / travelSeconds;
      assert(netCoinsPerHour <= loadout.shoreNetCoinsPerHour + 1e-9,
        `${upgrades.join("+") || "base"}/${loadout.rodId}/${loadout.hookId}/${loadout.baitId}: boat exceeds the same shore loadout`);
      return { ...loadout, netCoinsPerHour };
    });
    const sorted = rows.toSorted((first, second) => first.netCoinsPerHour - second.netCoinsPerHour);
    return { upgrades, casts, travelSeconds, maxFishPerHour: rounded(fishPerHour),
      minNetCoinsPerHour: rounded(sorted[0].netCoinsPerHour), maxNetCoinsPerHour: rounded(sorted.at(-1).netCoinsPerHour),
      bestLoadout: { rodId: sorted.at(-1).rodId, hookId: sorted.at(-1).hookId, baitId: sorted.at(-1).baitId },
      maximumRatioToSameShoreLoadout: rounded(Math.max(...rows.map(row => row.netCoinsPerHour / row.shoreNetCoinsPerHour))) };
  });
  return { kind: "boat-economic-upper-bound", catalogVersion: catalog.version, boatVersion: boat.version,
    legalLoadouts: loadouts.length, economicComparisons: loadouts.length * modes.length,
    assumptions: ["Every fixed attempt succeeds instantly; active play adds no time in this upper bound.",
      "One existing bait portion is consumed per voyage; no extra rarity or fish-sale bonus is assumed.",
      "The same owned rod, hook and bait are compared with the existing short shore route.",
      "Roads are not accelerated by food, skill, taps or pearls. Those runtime invariants are checked separately.",
      "Repair, materials, failed casts, travel scheduling, full storage and player absence can only lower realized returns.",
      "This audit does not simulate progression or certify a fair human-only leaderboard."],
    shore: { seconds: shore.seconds, catches: shore.rewards.fish, maxFishPerHour: shore.rewards.fish * 3600 / shore.seconds,
      minNetCoinsPerHour: rounded(Math.min(...loadouts.map(row => row.shoreNetCoinsPerHour))),
      maxNetCoinsPerHour: rounded(Math.max(...loadouts.map(row => row.shoreNetCoinsPerHour))) },
    modes: reports, upgrades, blueprints };
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
