import assert from "node:assert/strict";
import { economicMath } from "./economy-math.mjs";

const BPS = 10_000;
const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];
const number = (value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  assert(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum, `${name}: invalid number`);
  return value;
};
const integer = (value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  number(value, name, minimum, maximum); assert(Number.isSafeInteger(value), `${name}: expected integer`); return value;
};
function unique(rows, field, name) {
  assert(Array.isArray(rows) && rows.length > 0, `${name}: expected nonempty list`);
  assert(new Set(rows.map(row => row[field])).size === rows.length, `${name}: duplicate ${field}`);
}

/** The guarantee is on the OFFERED fish branch, never on landing a fish. */
export function realizedLootProbabilities(loot) {
  const fish = integer(loot?.fishBps, "fishBps", 1, BPS) / BPS;
  const weed = integer(loot.weedBps, "weedBps", 0, BPS) / BPS;
  const blueprint = integer(loot.blueprintBps, "blueprintBps", 0, BPS) / BPS;
  assert(Math.abs(fish + weed + blueprint - 1) < 1e-12, "Loot weights must sum to 10000 bps");
  const maximum = integer(loot.maxConsecutiveNonFish, "maxConsecutiveNonFish", 0, 20);
  const powers = Array.from({ length: maximum + 1 }, (_, index) => (1 - fish) ** index);
  const total = powers.reduce((sum, value) => sum + value, 0);
  const offeredFish = 1 / total;
  const nonFish = 1 - offeredFish;
  return {
    fish: offeredFish,
    weed: weed + blueprint > 0 ? nonFish * weed / (weed + blueprint) : 0,
    blueprint: weed + blueprint > 0 ? nonFish * blueprint / (weed + blueprint) : 0,
    stationaryStates: powers.map(value => value / total),
    resetOn: "offered-fish",
  };
}

/** Preserve catalog class odds, then renormalize only the region's species
 * within each surviving class. A region with ten common species does not get
 * ten times the common-class probability of a region with one common species. */
export function regionalFishingPortfolio(catalog, tank, loadout) {
  const fishing = catalog.fishing;
  assert(fishing, "Fishing catalog is missing");
  assert(fishing.rods.some(row => row.id === loadout.rodId), "Unknown rod");
  assert(fishing.hooks.some(row => row.id === loadout.hookId), "Unknown hook");
  assert(loadout.baitId === null || fishing.baits.some(row => row.itemId === loadout.baitId), "Unknown bait");
  assert(Array.isArray(tank?.allowedSpecies) && tank.allowedSpecies.length > 0, "Region needs allowedSpecies");
  assert(new Set(tank.allowedSpecies).size === tank.allowedSpecies.length, "Duplicate regional species");
  const known = new Map(fishing.fish.map(row => [row.itemId, row]));
  for (const id of tank.allowedSpecies) assert(known.has(id), `Unknown regional species ${id}`);
  const allowed = new Set(tank.allowedSpecies);
  const routeId = fishing.routeIds.find(id => catalog.explorations.some(row => row.id === id && !row.retired));
  assert(routeId, "A live shore baseline is required");
  const original = economicMath(catalog).catchPortfolio(loadout.rodId, loadout.baitId, routeId, loadout.hookId);
  const groups = fishing.classes.map(group => {
    const species = fishing.fish.filter(row => row.rarity === group.rarity && allowed.has(row.itemId)
      && (original.probabilities[row.itemId] ?? 0) > 0);
    return { ...group, species, weight: species.length ? original.classProbabilities[group.itemId] : 0 };
  });
  const total = groups.reduce((sum, group) => sum + group.weight, 0);
  assert(total > 0, "Rod and region have no eligible fish class");
  const classes = groups.filter(group => group.weight > 0).map(group => {
    const speciesTotal = group.species.reduce((sum, fish) => sum + original.probabilities[fish.itemId], 0);
    const item = catalog.items.find(row => row.id === group.itemId);
    assert(item && item.tradable, `Missing fish sale class ${group.itemId}`);
    return { rarity: group.rarity, itemId: group.itemId, probability: group.weight / total, price: item.baseSellPrice,
      species: group.species.map(fish => ({ itemId: fish.itemId,
        conditionalProbability: original.probabilities[fish.itemId] / speciesTotal,
        probability: group.weight / total * original.probabilities[fish.itemId] / speciesTotal })) };
  });
  return { classes, unavailableClasses: groups.filter(group => group.weight === 0).map(group => group.rarity),
    rarityPricePolicy: "actual-catalog-class-baseSellPrice", selectionOrder: "loot-then-class-then-regional-species" };
}

export function validateProposal(config, catalog) {
  assert(config?.schemaVersion === 1 && config.status === "proposal-not-runtime", "Expected versioned offline proposal");
  realizedLootProbabilities(config.loot); realizedLootProbabilities(config.futureBlueprintLoot);
  integer(config.futureBlueprint?.piecesPerBlueprint, "futureBlueprint.piecesPerBlueprint", 1, 1000);
  if (config.legacyLandingNet) {
    integer(config.legacyLandingNet.zoneWidthBps, "legacyLandingNet.zoneWidthBps", 1, BPS);
    integer(config.legacyLandingNet.assumedSuccessBonusBps, "legacyLandingNet.assumedSuccessBonusBps", 0, BPS);
  }
  for (const field of ["castAndResultSeconds", "weedPullSeconds", "blueprintPullSeconds", "tripPresentationSeconds"])
    number(config.timing?.[field], `timing.${field}`);
  for (const rarity of RARITIES) for (const field of ["successSeconds", "failureSeconds"])
    number(config.fightByRarity?.[rarity]?.[field], `fight.${rarity}.${field}`, .001);
  unique(config.hulls, "level", "hulls"); unique(config.crates, "level", "crates");
  unique(config.tanks, "id", "tanks"); unique(config.profiles, "id", "profiles"); unique(config.scenarios, "id", "scenarios");
  for (const hull of config.hulls) {
    integer(hull.level, "hull.level", 1); integer(hull.zoneWidthBps, "hull.zoneWidthBps", 1, BPS);
    integer(hull.assumedSuccessBonusBps, "hull.assumedSuccessBonusBps", 0, BPS);
  }
  for (const crate of config.crates) { integer(crate.level, "crate.level", 1); integer(crate.capacity, "crate.capacity", 1, 100); }
  for (const profile of config.profiles) {
    number(profile.timeMultiplier, "profile.timeMultiplier", .01, 20);
    for (const rarity of RARITIES) integer(profile.successBpsByRarity?.[rarity], `profile.${rarity}`, 0, BPS);
  }
  for (const tank of config.tanks) {
    integer(tank.requiredHomeLevel, "tank.requiredHomeLevel", 1, 100);
    assert(Array.isArray(tank.allowedSpecies) && tank.allowedSpecies.length > 0, "Tank needs species");
    assert(new Set(tank.allowedSpecies).size === tank.allowedSpecies.length, "Duplicate regional species");
    for (const id of tank.allowedSpecies) assert(catalog.fishing.fish.some(row => row.itemId === id), `Unknown regional species ${id}`);
  }
  for (const scenario of config.scenarios) {
    const tank = config.tanks.find(row => row.id === scenario.tankId);
    assert(tank, `Unknown tank ${scenario.tankId}`);
    const hull = config.hulls.find(row => row.level === scenario.hullLevel), crate = config.crates.find(row => row.level === scenario.crateLevel);
    assert(hull, "Unknown hull level"); assert(crate, "Unknown crate level");
    regionalFishingPortfolio(catalog, tank, scenario);
    if (scenario.homeLevel !== undefined) {
      integer(scenario.homeLevel, "scenario.homeLevel", 1, 100);
      const gear = [catalog.fishing.rods.find(row => row.id === scenario.rodId),
        catalog.fishing.hooks.find(row => row.id === scenario.hookId), catalog.fishing.baits.find(row => row.itemId === scenario.baitId)];
      for (const part of [tank, hull, crate, ...gear].filter(Boolean))
        assert(scenario.homeLevel >= (part.requiredHomeLevel ?? 1), `${scenario.id}: upgrade or tackle is unavailable at this home level`);
    }
  }
  return config;
}

export function baselineFishingRates(catalog, loadout) {
  const math = economicMath(catalog);
  return catalog.fishing.routeIds.map(id => catalog.explorations.find(route => route.id === id && !route.retired)).filter(Boolean).map(route => {
    const portfolio = math.catchPortfolio(loadout.rodId, loadout.baitId, route.id, loadout.hookId);
    const cost = portfolio.baitPurchaseCoins + portfolio.routeCoins + math.liquidation(portfolio.routeInputs);
    return { routeId: route.id, seconds: route.seconds, fishPerHour: route.rewards.fish * 3600 / route.seconds,
      grossFishCoinsPerHour: portfolio.expectedFishRevenue * 3600 / route.seconds,
      baitPortionsPerHour: loadout.baitId === null ? 0 : 3600 / route.seconds,
      netCoinsPerHour: (portfolio.expectedFishRevenue - cost) * 3600 / route.seconds,
      assumptions: "continuous-claims-no-food-no-skill-no-rare-drops; one-bait-per-trip" };
  });
}

/** Success is a forecast frequency over human performance, not a second random
 * loss after winning the reel. options.perfect evaluates actual perfect play. */
export function analyzeScenario(config, catalog, scenarioInput, profileInput, options = {}) {
  const scenario = typeof scenarioInput === "string" ? config.scenarios.find(row => row.id === scenarioInput) : scenarioInput;
  const profile = typeof profileInput === "string" ? config.profiles.find(row => row.id === profileInput) : profileInput;
  assert(scenario && profile, "Unknown scenario or profile");
  const hull = config.hulls.find(row => row.level === scenario.hullLevel), crate = config.crates.find(row => row.level === scenario.crateLevel);
  const tank = config.tanks.find(row => row.id === scenario.tankId);
  assert(hull && crate && tank, "Unknown scenario upgrade");
  const timeMultiplier = number(options.timeMultiplier ?? profile.timeMultiplier, "timeMultiplier", .01, 20);
  const loot = realizedLootProbabilities(options.loot ?? config.loot);
  const regional = regionalFishingPortfolio(catalog, tank, scenario);
  const assumedSuccessBonusBps = integer(options.assumedSuccessBonusBpsOverride ?? hull.assumedSuccessBonusBps,
    "assumedSuccessBonusBps", 0, BPS);
  if (options.acceptOnlyRarities !== undefined) {
    assert(Array.isArray(options.acceptOnlyRarities) && options.acceptOnlyRarities.length > 0, "Accept policy needs nonempty rarities");
    assert(new Set(options.acceptOnlyRarities).size === options.acceptOnlyRarities.length, "Duplicate accepted rarity");
    for (const rarity of options.acceptOnlyRarities) assert(RARITIES.includes(rarity), `Unknown accepted rarity ${rarity}`);
  }
  const acceptedRarities = options.acceptOnlyRarities ?? regional.classes.map(row => row.rarity);
  const skipNonFish = options.skipNonFishInstantly === true;
  const classes = regional.classes.map(group => {
    const assumed = integer(profile.successBpsByRarity[group.rarity], "assumed success", 0, BPS);
    const success = options.perfect ? 1 : Math.min(.99, (assumed + assumedSuccessBonusBps) / BPS);
    const times = config.fightByRarity[group.rarity];
    const fightSeconds = timeMultiplier * (success * times.successSeconds + (1 - success) * times.failureSeconds);
    const accepted = acceptedRarities.includes(group.rarity);
    return { ...group, accepted, assumedLandingProbability: success, expectedFightSeconds: accepted ? fightSeconds : 0,
      landedPerAttempt: accepted ? loot.fish * group.probability * success : 0 };
  });
  const landed = classes.reduce((sum, row) => sum + row.landedPerAttempt, 0);
  const expectedFishSeconds = classes.reduce((sum, row) => sum + (row.accepted
    ? row.probability * (config.timing.castAndResultSeconds + row.expectedFightSeconds) : 0), 0);
  const processSeconds = loot.fish * expectedFishSeconds + (skipNonFish ? 0
    : loot.weed * (config.timing.castAndResultSeconds + config.timing.weedPullSeconds)
      + loot.blueprint * (config.timing.castAndResultSeconds + config.timing.blueprintPullSeconds));
  const tripSeconds = landed / crate.capacity * config.timing.tripPresentationSeconds;
  const seconds = processSeconds + tripSeconds;
  assert(seconds > 0, "Expected attempt duration must be positive");
  const attemptsPerHour = 3600 / seconds;
  const bait = scenario.baitId === null ? null : catalog.fishing.baits.find(row => row.itemId === scenario.baitId);
  const baitCost = config.baitCostPerAttempt === false ? 0 : bait?.price ?? 0;
  const grossPerAttempt = classes.reduce((sum, row) => sum + row.landedPerAttempt * row.price, 0);
  const fishPerHour = landed * attemptsPerHour;
  return {
    scenarioId: scenario.id, profileId: profile.id, tankId: tank.id, hullLevel: hull.level, crateCapacity: crate.capacity,
    perfectPerformance: options.perfect === true, timeMultiplier, assumedSuccessBonusBps,
    policy: { acceptOnlyRarities: acceptedRarities, skipNonFishInstantly: skipNonFish,
      rejectedFishRewardAndTime: 0, drawProbabilitiesRenormalized: false },
    assumptions: { measuredHumanPerformance: false, additionalRandomFailureAfterReelWin: false,
      payoutOnlyForConfirmedLanding: true, lootValueOutsideFish: 0, fullCrateCycles: true, baitPerAttempt: config.baitCostPerAttempt !== false,
      fragmentsUseStationaryThroughputNotFiniteSessionGuarantee: true,
      successBonusOverrideIsForecastOnly: options.assumedSuccessBonusBpsOverride !== undefined },
    loot, offeredFishPerAttempt: loot.fish, expectedLandedFishPerAttempt: landed,
    acceptedFishOfferedPerAttempt: loot.fish * classes.filter(row => row.accepted).reduce((sum, row) => sum + row.probability, 0),
    expectedProcessSeconds: processSeconds, amortizedTripSecondsPerAttempt: tripSeconds,
    averageSecondsPerAttempt: seconds, attemptsPerHour, fishPerHour,
    classFishPerHour: Object.fromEntries(catalog.fishing.classes.map(group => [group.rarity,
      (classes.find(row => row.rarity === group.rarity)?.landedPerAttempt ?? 0) * attemptsPerHour])),
    speciesFishPerHour: Object.fromEntries(classes.flatMap(row => row.species.map(fish => [fish.itemId,
      row.landedPerAttempt * fish.conditionalProbability * attemptsPerHour]))),
    foodIngredientSupplyByClassPerHour: Object.fromEntries(catalog.fishing.classes.map(group => [group.itemId,
      (classes.find(row => row.itemId === group.itemId)?.landedPerAttempt ?? 0) * attemptsPerHour])),
    rawFishCoinsPerHour: grossPerAttempt * attemptsPerHour, baitCoinsPerAttempt: baitCost,
    baitCoinsPerHour: baitCost * attemptsPerHour, netCoinsPerHour: (grossPerAttempt - baitCost) * attemptsPerHour,
    offeredWeedsPerHour: loot.weed * attemptsPerHour, offeredFragmentsPerHour: loot.blueprint * attemptsPerHour,
    weedsPerHour: skipNonFish ? 0 : loot.weed * attemptsPerHour, fragmentsPerHour: skipNonFish ? 0 : loot.blueprint * attemptsPerHour,
    blueprintEquivalentFragmentCount: config.futureBlueprint.piecesPerBlueprint,
    steadyStateActiveMinutesPerBlueprintEquivalent: loot.blueprint > 0 && !skipNonFish
      ? config.futureBlueprint.piecesPerBlueprint / (loot.blueprint * attemptsPerHour) * 60 : null,
    secondsToFillCrate: fishPerHour > 0 ? crate.capacity / fishPerHour * 3600 : null,
    classes,
  };
}

export function analyzeProposal(config, catalog) {
  validateProposal(config, catalog);
  const forecasts = config.scenarios.flatMap(scenario => config.profiles.map(profile => {
    const current = analyzeScenario(config, catalog, scenario, profile);
    const future = analyzeScenario(config, catalog, scenario, profile, { loot: config.futureBlueprintLoot });
    return { ...current, baseline: baselineFishingRates(catalog, scenario), futureBlueprintForecast: {
      enabledInRuntime: false, fragmentsPerHour: future.fragmentsPerHour,
      blueprintEquivalentFragmentCount: future.blueprintEquivalentFragmentCount,
      steadyStateActiveMinutesPerBlueprintEquivalent: future.steadyStateActiveMinutesPerBlueprintEquivalent,
      timeInterpretation: "recipe-piece-count-divided-by-stationary-throughput-not-first-recipe-hitting-time-from-empty-state",
      fishPerHour: future.fishPerHour, netCoinsPerHour: future.netCoinsPerHour,
    } };
  }));
  const expert = config.profiles.find(row => row.id === "expert") ?? config.profiles.at(-1);
  const fastPerfectStress = config.scenarios.map(scenario => analyzeScenario(config, catalog, scenario, expert, { perfect: true, timeMultiplier: .5 }));
  const selectiveCancelStress = config.scenarios.map(scenario => {
    const tank = config.tanks.find(row => row.id === scenario.tankId);
    const available = regionalFishingPortfolio(catalog, tank, scenario).classes.map(row => row.rarity);
    const policies = Array.from({ length: 2 ** available.length - 1 }, (_, index) => {
      const acceptOnlyRarities = available.filter((_rarity, bit) => ((index + 1) & (1 << bit)) !== 0);
      return analyzeScenario(config, catalog, scenario, expert, { perfect: true, timeMultiplier: .5,
        skipNonFishInstantly: true, acceptOnlyRarities });
    });
    return { scenarioId: scenario.id, interpretation: "theoretical-omniscient-instant-cancel-bound-not-observed-live-exploit",
      evaluatedPolicyCount: policies.length, availableRarities: available,
      allFishSkipNonFish: policies.at(-1),
      bestNetCoinsPolicy: policies.reduce((best, row) => row.netCoinsPerHour > best.netCoinsPerHour ? row : best),
    };
  });
  const regular = config.profiles.find(row => row.id === "regular") ?? config.profiles[0];
  const legacyLandingNetForecast = config.legacyLandingNet ? config.scenarios.map(scenario => ({
    ...analyzeScenario(config, catalog, scenario, regular, {
      assumedSuccessBonusBpsOverride: config.legacyLandingNet.assumedSuccessBonusBps }),
    legacyLandingNet: config.legacyLandingNet,
    interpretation: "legacy-installed-net-q-assumption-separate-from-new-hull-maximum-not-measured-control-simulation",
  })) : [];
  return { schemaVersion: 1, status: "proposal-not-runtime", scope: "isolated-active-fishing-forecast-not-full-month-economy-validation",
    model: { lootGuaranteeResetsOn: "offered-fish", humanSkillSuccessIsForecastNotRng: true,
      postWinRandomFailure: false, hardDailyIncomeCap: false, allTimeIsActiveGameplayOrPresentation: true,
      stressIsAssumedFastPerfectPlayerNotMeasuredRuntimeUpperBound: true },
    forecasts, fastPerfectStress, selectiveCancelStress, legacyLandingNetForecast,
  };
}
