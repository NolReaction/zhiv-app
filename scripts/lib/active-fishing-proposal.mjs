import assert from "node:assert/strict";
import { economicMath } from "./economy-math.mjs";

const BPS = 10_000;
const locationFor = (config, scenario) => (config.locations ?? config.tanks).find(row => row.id === (scenario.locationId ?? scenario.tankId));
const tankFor = (config, scenario) => config.tanks.find(row => scenario.tankLevel !== undefined ? row.level === scenario.tankLevel : row.id === scenario.tankId);
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
  unique(config.tanks, config.locations ? "level" : "id", "tanks");
  if (config.locations) unique(config.locations, "id", "locations");
  if (config.motors) {
    unique(config.motors, "level", "motors");
    for (const motor of config.motors) {
      integer(motor.level, "motor.level", 1); integer(motor.assumedSuccessBonusBps, "motor.assumedSuccessBonusBps", 0, BPS);
      number(motor.responseTimeConstantMilliseconds, "motor.responseTimeConstantMilliseconds", 1);
      number(motor.speedCeilingMultiplier, "motor.speedCeilingMultiplier", .01);
    }
  }
  if (config.fuel) {
    integer(config.fuel.costPerTrip, "fuel.costPerTrip", 1);
    number(config.fuel.regenerationSecondsPerUnit, "fuel.regenerationSecondsPerUnit", 1);
    for (const tank of config.tanks) integer(tank.fuelCapacity, "tank.fuelCapacity", config.fuel.costPerTrip, 100);
    for (const crate of config.crates) integer(crate.attemptBudget, "crate.attemptBudget", crate.capacity, 100);
  } unique(config.profiles, "id", "profiles"); unique(config.scenarios, "id", "scenarios");
  for (const hull of config.hulls) {
    integer(hull.level, "hull.level", 1); integer(hull.zoneWidthBps, "hull.zoneWidthBps", 1, BPS);
    integer(hull.assumedSuccessBonusBps, "hull.assumedSuccessBonusBps", 0, BPS);
  }
  for (const crate of config.crates) { integer(crate.level, "crate.level", 1); integer(crate.capacity, "crate.capacity", 1, 100); }
  for (const profile of config.profiles) {
    number(profile.timeMultiplier, "profile.timeMultiplier", .01, 20);
    for (const rarity of RARITIES) integer(profile.successBpsByRarity?.[rarity], `profile.${rarity}`, 0, BPS);
  }
  for (const tank of config.locations ?? config.tanks) {
    integer(tank.requiredHomeLevel, "tank.requiredHomeLevel", 1, 100);
    assert(Array.isArray(tank.allowedSpecies) && tank.allowedSpecies.length > 0, "Tank needs species");
    assert(new Set(tank.allowedSpecies).size === tank.allowedSpecies.length, "Duplicate regional species");
    for (const id of tank.allowedSpecies) assert(catalog.fishing.fish.some(row => row.itemId === id), `Unknown regional species ${id}`);
  }
  for (const scenario of config.scenarios) {
    const tank = locationFor(config, scenario);
    assert(tank, `Unknown location ${scenario.locationId ?? scenario.tankId}`);
    const fuelTank = tankFor(config, scenario);
    assert(fuelTank, "Unknown fuel tank");
    const motor = config.motors?.find(row => row.level === scenario.motorLevel);
    if (config.motors) assert(motor, "Unknown motor");
    const hull = config.hulls.find(row => row.level === scenario.hullLevel), crate = config.crates.find(row => row.level === scenario.crateLevel);
    assert(hull, "Unknown hull level"); assert(crate, "Unknown crate level");
    regionalFishingPortfolio(catalog, tank, scenario);
    if (scenario.homeLevel !== undefined) {
      integer(scenario.homeLevel, "scenario.homeLevel", 1, 100);
      const gear = [catalog.fishing.rods.find(row => row.id === scenario.rodId),
        catalog.fishing.hooks.find(row => row.id === scenario.hookId), catalog.fishing.baits.find(row => row.itemId === scenario.baitId)];
      for (const part of [tank, fuelTank, motor, hull, crate, ...gear].filter(Boolean))
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
  const tank = locationFor(config, scenario);
  assert(hull && crate && tank, "Unknown scenario upgrade");
  const timeMultiplier = number(options.timeMultiplier ?? profile.timeMultiplier, "timeMultiplier", .01, 20);
  const loot = realizedLootProbabilities(options.loot ?? config.loot);
  const regional = regionalFishingPortfolio(catalog, tank, scenario);
  const motor = config.motors?.find(row => row.level === scenario.motorLevel);
  const assumedSuccessBonusBps = integer(options.assumedSuccessBonusBpsOverride ?? (hull.assumedSuccessBonusBps + (motor?.assumedSuccessBonusBps ?? 0)),
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
    scenarioId: scenario.id, profileId: profile.id, locationId: tank.id, tankLevel: tankFor(config, scenario)?.level, motorLevel: motor?.level, hullLevel: hull.level, crateCapacity: crate.capacity,
    perfectPerformance: options.perfect === true, timeMultiplier, assumedSuccessBonusBps,
    policy: { acceptOnlyRarities: acceptedRarities, skipNonFishInstantly: skipNonFish,
      rejectedFishRewardAndTime: 0, drawProbabilitiesRenormalized: false },
    assumptions: { measuredHumanPerformance: false, additionalRandomFailureAfterReelWin: false,
      unlimitedActiveRateIsTimingDiagnosticOnly: Boolean(config.fuel),
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
    const finiteTrip = config.fuel ? analyzeFiniteTrip(config, catalog, scenario, profile) : undefined;
    const futureFiniteTrip = config.fuel ? analyzeFiniteTrip(config, catalog, scenario, profile, { loot: config.futureBlueprintLoot }) : undefined;
    return { ...current, finiteTrip, baseline: baselineFishingRates(catalog, scenario), futureBlueprintForecast: {
      finiteTrip: futureFiniteTrip,
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
    const tank = locationFor(config, scenario);
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
  const fuelBoundedSelectiveCancelStress = config.fuel ? config.scenarios.map(scenario => {
    const available = regionalFishingPortfolio(catalog, locationFor(config, scenario), scenario).classes.map(row => row.rarity);
    const policies = Array.from({ length: 2 ** available.length - 1 }, (_, index) => {
      const acceptOnlyRarities = available.filter((_rarity, bit) => ((index + 1) & (1 << bit)) !== 0);
      return { acceptOnlyRarities, ...analyzeFiniteTrip(config, catalog, scenario, expert,
        { perfect: true, timeMultiplier: .5, skipNonFishInstantly: true, acceptOnlyRarities }) };
    });
    return { scenarioId: scenario.id, interpretation: "theoretical-omniscient-instant-cancel; every-skipped-draw-still-spends-cast-budget-and-bait",
      evaluatedPolicyCount: policies.length,
      bestNetCoinsPerFuelPolicy: policies.reduce((best, row) => row.stationaryTrip.expectedNetCoins > best.stationaryTrip.expectedNetCoins ? row : best) };
  }) : [];
  const regular = config.profiles.find(row => row.id === "regular") ?? config.profiles[0];
  const legacyLandingNetForecast = config.legacyLandingNet ? config.scenarios.map(scenario => ({
    ...analyzeScenario(config, catalog, scenario, regular, {
      assumedSuccessBonusBpsOverride: config.legacyLandingNet.assumedSuccessBonusBps }),
    legacyLandingNet: config.legacyLandingNet,
    interpretation: "legacy-installed-net-q-assumption-separate-from-hull-burst-smoothing-not-measured-control-simulation",
  })) : [];
  const moduleControlSensitivity = config.motors ? config.profiles.flatMap(profile => {
    const base = config.scenarios[0];
    return [[1, 1], [2, 1], [1, 2], [2, 2]].map(([hullLevel, motorLevel]) => {
      const scenario = { ...base, id: `control-h${hullLevel}-m${motorLevel}`, homeLevel: 2, hullLevel, motorLevel };
      const hull = config.hulls.find(row => row.level === hullLevel), motor = config.motors.find(row => row.level === motorLevel);
      return { profileId: profile.id, hullLevel, motorLevel, interpretation: "independent-control-forecast-only; same-region-tackle-crate-tank; no-physical-control-simulation",
        hullBurstAmplitudeMultiplier: hull.fishBurstAmplitudeMultiplier,
        motorResponseTimeConstantMilliseconds: motor.responseTimeConstantMilliseconds,
        zoneWidthBps: hull.zoneWidthBps, assumedHumanSuccessBonusBps: hull.assumedSuccessBonusBps + motor.assumedSuccessBonusBps,
        trip: analyzeFiniteTrip(config, catalog, scenario, profile).stationaryTrip };
    });
  }) : [];
  return { schemaVersion: 1, status: "proposal-not-runtime", scope: "isolated-active-fishing-forecast-not-full-month-economy-validation",
    model: { lootGuaranteeResetsOn: "offered-fish", humanSkillSuccessIsForecastNotRng: true,
      postWinRandomFailure: false, hardDailyIncomeCap: Boolean(config.fuel),
      fuelRegeneratesOutsideGameplay: Boolean(config.fuel), unlimitedHourlyRatesAreDiagnosticOnly: Boolean(config.fuel), conditionalHourlyTimeIsActiveGameplayOrPresentation: true,
      stressIsAssumedFastPerfectPlayerNotMeasuredRuntimeUpperBound: true },
    forecasts, fastPerfectStress, selectiveCancelStress, fuelBoundedSelectiveCancelStress, legacyLandingNetForecast, moduleControlSensitivity,
    fuelBoundedPerfectStress: config.fuel ? config.scenarios.map(scenario => analyzeFiniteTrip(config, catalog, scenario, expert, { perfect: true, timeMultiplier: .5 })) : [],
    fuelPolicy: config.fuel ? { ...config.fuel, sustainableTripsPer24Hours: 86400 / config.fuel.regenerationSecondsPerUnit / config.fuel.costPerTrip,
      interpretation: "long-run-resource-budget-not-a-calendar-day-grant; full-tank-stock-is-not-added-every-day" } : null,
  };
}

/** Continuous fractional regeneration, saturated at capacity. The timestamp is
 * settled even while full, so past overflow cannot refill an upgraded tank. */
export function settleOutingFuel(state, nowSeconds, capacity, regenerationSecondsPerUnit) {
  number(capacity, "capacity", 1); number(regenerationSecondsPerUnit, "regenerationSecondsPerUnit", 1);
  number(state.fuel, "fuel", 0, capacity); number(state.updatedAtSeconds, "updatedAtSeconds");
  number(nowSeconds, "nowSeconds", state.updatedAtSeconds);
  return { fuel: Math.min(capacity, state.fuel + (nowSeconds - state.updatedAtSeconds) / regenerationSecondsPerUnit), updatedAtSeconds: nowSeconds };
}
export function spendOutingFuel(state, nowSeconds, capacity, regenerationSecondsPerUnit, cost = 1) {
  number(cost, "cost", .001, capacity);
  const settled = settleOutingFuel(state, nowSeconds, capacity, regenerationSecondsPerUnit);
  assert(settled.fuel >= cost, "Insufficient outing fuel");
  return { ...settled, fuel: settled.fuel - cost };
}
export function upgradeOutingFuel(state, nowSeconds, previousCapacity, nextCapacity, regenerationSecondsPerUnit) {
  number(nextCapacity, "nextCapacity", previousCapacity);
  return settleOutingFuel(state, nowSeconds, previousCapacity, regenerationSecondsPerUnit);
}

const TRIP_FIELDS = ["expectedFish", "expectedAttempts", "expectedActiveSeconds", "expectedGrossCoins", "expectedBaitCoins",
  "expectedNetCoins", "expectedWeeds", "expectedFragments", "fullCrateProbability", "emptyTripProbability"];
function emptyTripMetrics() {
  return { ...Object.fromEntries(TRIP_FIELDS.map(key => [key, 0])), classFish: Object.fromEntries(RARITIES.map(key => [key, 0])) };
}
function mixTripMetrics(rows, weights) {
  const result = emptyTripMetrics();
  rows.forEach((row, index) => {
    for (const key of TRIP_FIELDS) result[key] += row[key] * weights[index];
    for (const rarity of RARITIES) result.classFish[rarity] += row.classFish[rarity] * weights[index];
  });
  return result;
}

/** Exact finite outing, not stationary-per-cast odds multiplied by a cast cap.
 * Every started attempt advances both the finite allowance and global pity,
 * even if cancelled or failed. A landed fish alone occupies the crate. */
export function analyzeFiniteTrip(config, catalog, scenarioInput, profileInput, options = {}) {
  assert(config.fuel, "Finite outing needs fuel policy");
  const scenario = typeof scenarioInput === "string" ? config.scenarios.find(row => row.id === scenarioInput) : scenarioInput;
  const profile = typeof profileInput === "string" ? config.profiles.find(row => row.id === profileInput) : profileInput;
  const diagnostic = analyzeScenario(config, catalog, scenario, profile, options);
  const crate = config.crates.find(row => row.level === scenario.crateLevel), tank = tankFor(config, scenario);
  const capacity = integer(crate.capacity, "crate.capacity", 1, 100), budget = integer(crate.attemptBudget, "crate.attemptBudget", capacity, 100);
  const loot = options.loot ?? config.loot;
  realizedLootProbabilities(loot);
  const maximum = loot.maxConsecutiveNonFish, baseFish = loot.fishBps / BPS;
  const nonFishTotal = loot.weedBps + loot.blueprintBps;
  const resolveFrom = initialPity => {
    const result = emptyTripMetrics(), terminalPity = Array(maximum + 1).fill(0);
    let states = new Map([[`${0}:${initialPity}`, 1]]);
    result.expectedActiveSeconds = config.timing.tripPresentationSeconds;
    for (let attempt = 0; attempt < budget; attempt++) {
      const next = new Map();
      for (const [key, mass] of states) {
        const [fish, pity] = key.split(":").map(Number);
        result.expectedAttempts += mass;
        result.expectedBaitCoins += mass * diagnostic.baitCoinsPerAttempt;
        const offered = pity === maximum ? 1 : baseFish;
        const transition = (nextFish, nextPity, probability, seconds, rarity, found) => {
          const p = mass * probability;
          if (p === 0) return;
          result.expectedActiveSeconds += p * seconds;
          if (rarity) {
            result.expectedFish += p; result.classFish[rarity.rarity] += p;
            result.expectedGrossCoins += p * rarity.price;
          }
          if (found === "weed") result.expectedWeeds += p;
          if (found === "blueprint") result.expectedFragments += p;
          if (nextFish === capacity || attempt + 1 === budget) {
            terminalPity[nextPity] += p;
            if (nextFish === capacity) result.fullCrateProbability += p;
            if (nextFish === 0) result.emptyTripProbability += p;
          } else {
            const nextKey = `${nextFish}:${nextPity}`;
            next.set(nextKey, (next.get(nextKey) ?? 0) + p);
          }
        };
        for (const group of diagnostic.classes) {
          const p = offered * group.probability;
          if (!group.accepted) transition(fish, 0, p, 0);
          else {
            const timing = config.fightByRarity[group.rarity], q = group.assumedLandingProbability;
            transition(fish + 1, 0, p * q, config.timing.castAndResultSeconds + diagnostic.timeMultiplier * timing.successSeconds, group);
            transition(fish, 0, p * (1 - q), config.timing.castAndResultSeconds + diagnostic.timeMultiplier * timing.failureSeconds);
          }
        }
        for (const [kind, weight, pullSeconds] of [["weed", loot.weedBps, config.timing.weedPullSeconds], ["blueprint", loot.blueprintBps, config.timing.blueprintPullSeconds]]) {
          const p = nonFishTotal > 0 ? (1 - offered) * weight / nonFishTotal : 0;
          const skip = options.skipNonFishInstantly === true;
          transition(fish, Math.min(maximum, pity + 1), p, skip ? 0 : config.timing.castAndResultSeconds + pullSeconds, undefined, skip ? undefined : kind);
        }
      }
      states = next;
    }
    result.expectedNetCoins = result.expectedGrossCoins - result.expectedBaitCoins;
    assert(Math.abs(terminalPity.reduce((sum, p) => sum + p, 0) - 1) < 1e-9, "Finite-trip terminal mass lost");
    return { ...result, terminalPity };
  };
  const fromPity = Array.from({ length: maximum + 1 }, (_, pity) => resolveFrom(pity));
  let distribution = fromPity.map((_row, index) => index === 0 ? 1 : 0);
  let converged = false;
  for (let step = 0; step < 10_000; step++) {
    const next = fromPity.map((_row, ending) => fromPity.reduce((sum, row, initial) => sum + distribution[initial] * row.terminalPity[ending], 0));
    const delta = Math.max(...next.map((p, index) => Math.abs(p - distribution[index])));
    distribution = next;
    if (delta < 1e-13) { converged = true; break; }
  }
  assert(converged, "Finite-trip pity distribution did not converge");
  const stationaryTrip = mixTripMetrics(fromPity, distribution);
  const bankedTrips = Math.floor(tank.fuelCapacity / config.fuel.costPerTrip);
  let bankDistribution = fromPity.map((_row, index) => index === 0 ? 1 : 0);
  const fullTankSession = emptyTripMetrics();
  for (let trip = 0; trip < bankedTrips; trip++) {
    const row = mixTripMetrics(fromPity, bankDistribution);
    for (const key of TRIP_FIELDS.filter(key => !key.endsWith("Probability"))) fullTankSession[key] += row[key];
    for (const rarity of RARITIES) fullTankSession.classFish[rarity] += row.classFish[rarity];
    bankDistribution = fromPity.map((_row, ending) => fromPity.reduce((sum, item, initial) => sum + bankDistribution[initial] * item.terminalPity[ending], 0));
  }
  delete fullTankSession.emptyTripProbability; delete fullTankSession.fullCrateProbability;
  const sustainableTripsPerDay = 86400 / config.fuel.regenerationSecondsPerUnit / config.fuel.costPerTrip;
  const dailyVisitSchedules = [1, 2, 3].map(visitsPerDay => {
    const tripsPerDay = Math.min(sustainableTripsPerDay, bankedTrips * visitsPerDay), tripsPerVisit = tripsPerDay / visitsPerDay;
    return { visitsPerDay, spacingHours: 24 / visitsPerDay, tripsPerVisit, tripsPerDay,
      interpretation: "steady-evenly-spaced-visits-using-all-available-fuel-instantly-at-arrival; ignores-small-within-visit-regen",
      fuelLostToCapacityPerDay: (sustainableTripsPerDay - tripsPerDay) * config.fuel.costPerTrip,
      expectedFishPerDay: stationaryTrip.expectedFish * tripsPerDay,
      expectedCommonFishPerDay: stationaryTrip.classFish.common * tripsPerDay,
      expectedNetCoinsPerDay: stationaryTrip.expectedNetCoins * tripsPerDay,
      requiredActiveMinutesPerDay: stationaryTrip.expectedActiveSeconds / 60 * tripsPerDay,
      classFishPerDay: Object.fromEntries(RARITIES.map(rarity => [rarity, stationaryTrip.classFish[rarity] * tripsPerDay])) };
  });
  return { scenarioId: scenario.id, profileId: profile.id, locationId: scenario.locationId ?? scenario.tankId,
    crateCapacity: capacity, attemptBudget: budget, fuelCapacity: tank.fuelCapacity, costPerTrip: config.fuel.costPerTrip,
    freshAccountFirstTrip: fromPity[0], stationaryTrip, stationaryTripStartingPity: distribution,
    fullTankSessionFromPity0: { trips: bankedTrips, ...fullTankSession },
    sustainableTripsPerDay, hardFishCapacityPerSteadyDay: sustainableTripsPerDay * capacity,
    fuelLimitedExpectedFishPerSteadyDay: sustainableTripsPerDay * stationaryTrip.expectedFish,
    fuelLimitedExpectedNetCoinsPerSteadyDay: sustainableTripsPerDay * stationaryTrip.expectedNetCoins,
    dailyVisitSchedules, assumptions: { humanSuccessIsHypothesis: true, pityPersistsAcrossTrips: true,
      transientFirstTripSeparateFromStationaryTrip: true, abortConsumesAttemptAndFuelNotFishSlot: true,
      noMidTripUnloading: true, tutorialExcluded: true, finiteTripProbabilitiesComputedExactly: true,
      dailyBoundRequiresEnoughVisitsAndActivePlay: true, futureBlueprintLootDisabled: config.futureBlueprint.enabled === false }, fromPity };
}
