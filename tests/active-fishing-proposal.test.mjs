import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProposal, analyzeScenario, baselineFishingRates, realizedLootProbabilities,
  regionalFishingPortfolio, validateProposal } from "../scripts/lib/active-fishing-proposal.mjs";

const rarities = ["common", "uncommon", "rare", "epic", "legendary"];
function fixture() {
  const catalog = { currencyScale: 10, recipes: [], buildings: [],
    items: [{ id: "fish_common", baseSellPrice: 15, tradable: true }, { id: "fish_uncommon", baseSellPrice: 20, tradable: true }],
    explorations: [
      { id: "shore", seconds: 180, cost: { coins: 0, items: {} }, rewards: { fish: 2 } },
      { id: "shore_camp", seconds: 900, cost: { coins: 0, items: {} }, rewards: { fish: 8 } },
    ],
    fishing: { routeIds: ["shore", "shore_camp"], collectionDrawsByRoute: { shore: 2, shore_camp: 8 },
      fish: [{ itemId: "a", rarity: "common" }, { itemId: "b", rarity: "common" }, { itemId: "c", rarity: "uncommon" }],
      classes: [{ itemId: "fish_common", rarity: "common", weight: 5000 }, { itemId: "fish_uncommon", rarity: "uncommon", weight: 5000 }],
      rods: [{ id: "reed_rod", rarity: "uncommon", price: 0, classOddsBps: { common: 5000, uncommon: 5000 }, speciesWeights: { a: 200 } }],
      hooks: [{ id: "bare_hook", rarityWeights: { common: 100, uncommon: 100 } }],
      baits: [{ itemId: "bait", price: 2, rarityWeights: { common: 100, uncommon: 100 } }],
    } };
  const config = { schemaVersion: 1, status: "proposal-not-runtime",
    loot: { fishBps: 6500, weedBps: 3500, blueprintBps: 0, maxConsecutiveNonFish: 2 },
    futureBlueprintLoot: { fishBps: 6500, weedBps: 3400, blueprintBps: 100, maxConsecutiveNonFish: 2 },
    futureBlueprint: { enabled: false, piecesPerBlueprint: 6 },
    legacyLandingNet: { zoneWidthBps: 4000, assumedSuccessBonusBps: 800 },
    timing: { castAndResultSeconds: 5, weedPullSeconds: 3, blueprintPullSeconds: 5, tripPresentationSeconds: 2 },
    fightByRarity: Object.fromEntries(rarities.map(rarity => [rarity, { successSeconds: 32, failureSeconds: 20 }])),
    hulls: [{ level: 1, zoneWidthBps: 3200, assumedSuccessBonusBps: 0, cost: { coins: 0, items: {} } },
      { level: 2, zoneWidthBps: 3600, assumedSuccessBonusBps: 300, cost: { coins: 100, items: {} } }],
    crates: [{ level: 1, capacity: 3, cost: { coins: 0, items: {} } }, { level: 2, capacity: 8, cost: { coins: 100, items: {} } }],
    tanks: [{ id: "mixed", allowedSpecies: ["a", "b", "c"], requiredHomeLevel: 1, cost: { coins: 0, items: {} } }],
    profiles: [{ id: "regular", timeMultiplier: 1, successBpsByRarity: Object.fromEntries(rarities.map(rarity => [rarity, 5000])) }],
    scenarios: [{ id: "start", tankId: "mixed", rodId: "reed_rod", hookId: "bare_hook", baitId: null, hullLevel: 1, crateLevel: 1 }],
  };
  return { config, catalog, scenario: config.scenarios[0], profile: config.profiles[0] };
}
const close = (actual, expected, tolerance = 1e-10) => assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test("65% base fish with a two-nonfish guarantee becomes 1/(1+.35+.35²), reset on offered fish", () => {
  const { config } = fixture();
  const result = realizedLootProbabilities(config.loot);
  close(result.fish, .6791171477079796);
  close(result.weed, 1 - result.fish);
  close(result.stationaryStates[1], .35 / 1.4725);
  close(result.stationaryStates[2], .1225 / 1.4725);
  assert.equal(result.resetOn, "offered-fish");
  const future = realizedLootProbabilities(config.futureBlueprintLoot);
  close(future.fish, result.fish);
  close(future.blueprint / future.weed, 1 / 34);
  close(future.fish + future.weed + future.blueprint, 1);
});

test("regional filtering preserves class odds independently of species counts and honors species preference", () => {
  const { catalog, config, scenario } = fixture();
  const all = regionalFishingPortfolio(catalog, config.tanks[0], scenario);
  const fewer = regionalFishingPortfolio(catalog, { allowedSpecies: ["a", "c"] }, scenario);
  close(all.classes[0].probability, .5); close(fewer.classes[0].probability, .5);
  close(all.classes[0].species[0].conditionalProbability, 2 / 3);
  close(fewer.classes[0].species[0].conditionalProbability, 1);
  const commonOnly = regionalFishingPortfolio(catalog, { allowedSpecies: ["b"] }, scenario);
  close(commonOnly.classes[0].probability, 1);
  assert.deepEqual(commonOnly.unavailableClasses, ["uncommon"]);
});

test("expected attempt duration weights short weeds and successful and failed fish separately", () => {
  const { catalog, config, scenario, profile } = fixture();
  const row = analyzeScenario(config, catalog, scenario, profile);
  const p = 1 / 1.4725, landed = p / 2;
  const expectedSeconds = 5 + p * (32 / 2 + 20 / 2) + (1 - p) * 3 + landed / 3 * 2;
  close(row.averageSecondsPerAttempt, expectedSeconds);
  close(row.fishPerHour, landed * 3600 / expectedSeconds);
  close(row.rawFishCoinsPerHour, row.fishPerHour * 17.5);
  close(row.classFishPerHour.common, row.fishPerHour / 2);
  close(row.speciesFishPerHour.a, row.classFishPerHour.common * 2 / 3);
  assert.equal(row.assumptions.additionalRandomFailureAfterReelWin, false);
});

test("crate changes only amortized full-trip presentation overhead and has no effect when it is zero", () => {
  const { catalog, config, scenario, profile } = fixture();
  const small = analyzeScenario(config, catalog, scenario, profile);
  const big = analyzeScenario(config, catalog, { ...scenario, crateLevel: 2 }, profile);
  assert(big.fishPerHour > small.fishPerHour);
  close(big.expectedLandedFishPerAttempt, small.expectedLandedFishPerAttempt);
  config.timing.tripPresentationSeconds = 0;
  close(analyzeScenario(config, catalog, scenario, profile).fishPerHour,
    analyzeScenario(config, catalog, { ...scenario, crateLevel: 2 }, profile).fishPerHour);
});

test("bait is charged on every attempt including weeds and failures, while old baseline pays once per trip", () => {
  const { catalog, config, scenario, profile } = fixture();
  const row = analyzeScenario(config, catalog, { ...scenario, baitId: "bait" }, profile);
  close(row.baitCoinsPerHour, 2 * row.attemptsPerHour);
  close(row.rawFishCoinsPerHour - row.netCoinsPerHour, row.baitCoinsPerHour);
  const baseline = baselineFishingRates(catalog, { ...scenario, baitId: "bait" });
  close(baseline[0].fishPerHour, 40); close(baseline[1].fishPerHour, 32);
  close(baseline[0].grossFishCoinsPerHour - baseline[0].netCoinsPerHour, 40);
  close(baseline[1].grossFishCoinsPerHour - baseline[1].netCoinsPerHour, 8);
});

test("hull q bonus is an explicit forecast capped at .99; stress perfect play can reach 1", () => {
  const { catalog, config, scenario, profile } = fixture();
  for (const rarity of rarities) profile.successBpsByRarity[rarity] = 9900;
  const regular = analyzeScenario(config, catalog, { ...scenario, hullLevel: 2 }, profile);
  assert(regular.classes.every(row => row.assumedLandingProbability === .99));
  const perfect = analyzeScenario(config, catalog, scenario, profile, { perfect: true, timeMultiplier: .5 });
  assert(perfect.classes.every(row => row.assumedLandingProbability === 1));
  close(perfect.expectedLandedFishPerAttempt, perfect.loot.fish);
});

test("instant nonfish cancellation raises throughput without changing draws or pity and yields no weed", () => {
  const { catalog, config, scenario, profile } = fixture();
  const normal = analyzeScenario(config, catalog, scenario, profile);
  const skip = analyzeScenario(config, catalog, scenario, profile, { skipNonFishInstantly: true });
  assert.deepEqual(skip.loot, normal.loot);
  close(skip.offeredFishPerAttempt, normal.offeredFishPerAttempt);
  close(skip.expectedLandedFishPerAttempt, normal.expectedLandedFishPerAttempt);
  close(normal.expectedProcessSeconds - skip.expectedProcessSeconds, normal.loot.weed * 8);
  assert(skip.fishPerHour > normal.fishPerHour);
  assert.equal(skip.weedsPerHour, 0); assert(skip.offeredWeedsPerHour > 0);
});

test("selective cancellation keeps rejected class probability and charges bait for every draw", () => {
  const { catalog, config, scenario, profile } = fixture();
  const row = analyzeScenario(config, catalog, { ...scenario, baitId: "bait" }, profile,
    { perfect: true, skipNonFishInstantly: true, acceptOnlyRarities: ["uncommon"] });
  const p = 1 / 1.4725, landed = p * .5;
  close(row.offeredFishPerAttempt, p); close(row.expectedLandedFishPerAttempt, landed);
  close(row.acceptedFishOfferedPerAttempt, landed);
  close(row.classes[0].probability, .5); close(row.classes[0].landedPerAttempt, 0);
  close(row.expectedProcessSeconds, landed * (5 + 32));
  close(row.averageSecondsPerAttempt, landed * (37 + 2 / 3));
  close(row.baitCoinsPerHour, row.attemptsPerHour * 2);
  close(row.netCoinsPerHour, row.fishPerHour * 20 - row.attemptsPerHour * 2);
  assert.equal(row.classFishPerHour.common, 0);
  assert.equal(row.policy.drawProbabilitiesRenormalized, false);
  assert.throws(() => analyzeScenario(config, catalog, scenario, profile,
    { skipNonFishInstantly: true, acceptOnlyRarities: ["rare"] }), /duration must be positive/);
});

test("cancel stress enumerates available subsets and legacy net changes only the forecast q input", () => {
  const { catalog, config, scenario, profile } = fixture(), originalHulls = structuredClone(fixture().config.hulls);
  const regular = analyzeScenario(config, catalog, scenario, profile);
  const report = analyzeProposal(config, catalog), stress = report.selectiveCancelStress[0];
  assert.equal(stress.evaluatedPolicyCount, 3);
  assert.match(stress.interpretation, /theoretical-omniscient/);
  assert.deepEqual(stress.bestNetCoinsPolicy.policy.acceptOnlyRarities, ["uncommon"]);
  assert.equal(stress.bestNetCoinsPolicy.classFishPerHour.common, 0);
  assert(stress.bestNetCoinsPolicy.netCoinsPerHour > stress.allFishSkipNonFish.netCoinsPerHour);
  const legacy = report.legacyLandingNetForecast[0];
  close(legacy.classes[0].assumedLandingProbability, .58);
  close(regular.classes[0].assumedLandingProbability, .5);
  assert.deepEqual(legacy.loot, regular.loot);
  assert.deepEqual(legacy.classes.map(row => row.probability), regular.classes.map(row => row.probability));
  assert.equal(legacy.assumptions.successBonusOverrideIsForecastOnly, true);
  assert.deepEqual(config.hulls, originalHulls);
});

test("future recipe equivalent is forecast-only stationary throughput using configured piece count", () => {
  const { catalog, config } = fixture();
  config.futureBlueprint.piecesPerBlueprint = 9;
  const report = analyzeProposal(config, catalog), row = report.forecasts[0];
  assert.equal(row.fragmentsPerHour, 0); assert.equal(row.steadyStateActiveMinutesPerBlueprintEquivalent, null);
  assert.equal(row.futureBlueprintForecast.enabledInRuntime, false);
  assert.equal(row.futureBlueprintForecast.blueprintEquivalentFragmentCount, 9);
  close(row.futureBlueprintForecast.steadyStateActiveMinutesPerBlueprintEquivalent, 540 / row.futureBlueprintForecast.fragmentsPerHour);
  assert.match(row.futureBlueprintForecast.timeInterpretation, /not-first-recipe-hitting-time/);
  assert.equal(report.model.postWinRandomFailure, false);
  assert.match(report.scope, /not-full-month/);
});

test("invalid weights, gear, empty overlap, missing species, and duplicate definitions fail explicitly", () => {
  for (const mutate of [c => { c.loot.weedBps--; }, c => { c.loot.fishBps = NaN; }, c => { c.loot.maxConsecutiveNonFish = -1; },
    c => { c.futureBlueprint.piecesPerBlueprint = 0; },
    c => { c.scenarios[0].hookId = "unknown"; }, c => { c.scenarios[0].baitId = "unknown"; },
    c => { c.scenarios[0].rodId = "unknown"; }, c => { c.tanks[0].allowedSpecies = ["unknown"]; },
    c => { c.tanks[0].requiredHomeLevel = 3; c.scenarios[0].homeLevel = 1; },
    c => { c.profiles.push(c.profiles[0]); }, c => { c.profiles[0].timeMultiplier = 0; }]) {
    const { config, catalog } = fixture(); mutate(config); assert.throws(() => validateProposal(config, catalog));
  }
  const { config, catalog, scenario } = fixture();
  catalog.fishing.rods[0].classOddsBps.common = 0;
  assert.throws(() => regionalFishingPortfolio(catalog, { allowedSpecies: ["a"] }, scenario), /no eligible fish class/);
  assert.throws(() => realizedLootProbabilities({ ...config.loot, blueprintBps: 100 }), /sum/);
});

test("seeded 100k-attempt renewal simulation cross-checks pity, skill failures and heterogeneous times", () => {
  const { catalog, config, scenario, profile } = fixture();
  config.fightByRarity.uncommon = { successSeconds: 48, failureSeconds: 29 };
  profile.successBpsByRarity.common = 6000; profile.successBpsByRarity.uncommon = 7000;
  const expected = analyzeScenario(config, catalog, scenario, profile, { loot: config.futureBlueprintLoot });
  let seed = 0x1234abcd, nonFish = 0, landed = 0, seconds = 0, coins = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let attempt = 0; attempt < 100_000; attempt++) {
    seconds += 5;
    const roll = random();
    if (nonFish === 2 || roll < .65) {
      nonFish = 0;
      const uncommon = random() >= .5, win = random() < (uncommon ? .7 : .6);
      seconds += uncommon ? win ? 48 : 29 : win ? 32 : 20;
      if (win) { landed++; coins += uncommon ? 20 : 15; if (landed % 3 === 0) seconds += 2; }
    } else { nonFish++; seconds += roll < .99 ? 3 : 5; }
  }
  const actualFish = landed * 3600 / seconds, actualCoins = coins * 3600 / seconds;
  assert(Math.abs(actualFish / expected.fishPerHour - 1) < .01);
  assert(Math.abs(actualCoins / expected.rawFishCoinsPerHour - 1) < .01);
});
