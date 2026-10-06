import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadJourneyRules, simulateJourney, DEFAULT_JOURNEY_RARE_SEED } from "./simulate-player-journey.mjs";
import { jointPlanningPolicy } from "./simulate-player-joint.mjs";
import { auditEconomicMath, economicMath } from "./lib/economy-math.mjs";
import { auditEconomyProgression } from "./audit-economy-progression.mjs";

const rounded = value => Number(value.toFixed(6));

/** Deterministic examples, not a population forecast or a balance optimum. */
export function reviewMiningFishing(loaded, onScenario = () => {}) {
  const { catalog } = loaded, math = economicMath(catalog), audit = auditEconomicMath(catalog);
  const hash = file => createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex");
  const cases = [["visits3", DEFAULT_JOURNEY_RARE_SEED], ["visits2", DEFAULT_JOURNEY_RARE_SEED],
    ["active16h", DEFAULT_JOURNEY_RARE_SEED], ["visits3", 123456789], ["visits3", 987654321]];
  const samples = cases.map(([mode, rareSeed]) => {
    const result = simulateJourney(loaded, mode, 1600, { ...jointPlanningPolicy, rareSeed });
    onScenario({ mode, rareSeed, complete: result.complete, home5Days: result.homeDays[5], allBuildings5Days: result.elapsedDays });
    const { finds, ...rareMaterials } = result.rareMaterials;
    return { ...result, rareMaterials: { ...rareMaterials, firstFindByType: Object.fromEntries(catalog.rareDrops.itemIds.map(id =>
      [id, finds.find(find => find.itemId === id) ?? null])), firstTenFinds: finds.slice(0, 10), lastFind: finds.at(-1) ?? null } };
  });
  const rarityShare = (loadout, rarity) => catalog.fishing.fish.filter(fish => fish.rarity === rarity)
    .reduce((sum, fish) => sum + loadout.probabilities[fish.itemId], 0);
  const fishingRoles = ["common", "uncommon", "rare", "epic", "legendary"].map(rarity => {
    const best = [...audit.fishingLoadouts].sort((a, b) => rarityShare(b, rarity) - rarityShare(a, rarity))[0];
    const camp = math.catchPortfolio(best.rodId, best.baitId, "shore_camp", best.hookId);
    return { rarity, rodId: best.rodId, hookId: best.hookId, baitId: best.baitId,
      probabilityPerDraw: rarityShare(best, rarity), expectedCatchesPerCamp: rarityShare(best, rarity) * camp.speciesDrawsPerJob,
      expectedShortTripsPerTargetCatch: 1 / rarityShare(best, rarity), steadyStateCampsPerTargetCatch: 1 / (rarityShare(best, rarity) * camp.speciesDrawsPerJob),
      finiteGuarantee: false };
  });
  const fishingRoutes = catalog.fishing.routeIds.map(routeId => {
    const route = catalog.explorations.find(route => route.id === routeId), portfolio = math.catchPortfolio("reed_rod", null, routeId);
    return { routeId, hours: route.seconds / 3600, totalCatch: route.rewards.fish, speciesDraws: portfolio.speciesDrawsPerJob,
      catchesPerHour: route.rewards.fish * 3600 / route.seconds, speciesDrawsPerHour: portfolio.speciesDrawsPerJob * 3600 / route.seconds,
      expectedStarterRevenue: portfolio.expectedFishRevenue, expectedStarterOrdinaryFish: portfolio.output.fish };
  });
  const baitMargins = catalog.fishing.routeIds.map(routeId => {
    const comparisons = audit.fishingLoadouts.filter(loadout => loadout.baitId).map(loadout => {
      const withBait = math.catchPortfolio(loadout.rodId, loadout.baitId, routeId, loadout.hookId);
      const withoutBait = math.catchPortfolio(loadout.rodId, null, routeId, loadout.hookId);
      return { rodId: loadout.rodId, hookId: loadout.hookId, baitId: loadout.baitId,
        incrementalExpectedSaleProfit: withBait.expectedFishRevenue - withoutBait.expectedFishRevenue - withBait.baitPurchaseCoins };
    }).sort((a, b) => b.incrementalExpectedSaleProfit - a.incrementalExpectedSaleProfit);
    return { routeId, testedCombinations: comparisons.length, maximum: comparisons[0] };
  });
  const resourceRoutes = catalog.explorations.filter(route => route.activity === "mining" || route.id === "coastal_deposits").map(route => {
    const batch = math.batch(route), actorMinutes = batch.slotMinutes.mochlik;
    return { routeId: route.id, homeLevel: route.requiredHomeLevel, buildingRequirements: route.requiredBuildings,
      rewards: route.rewards, inputs: route.cost.items, durationMinutes: batch.processMinutes,
      actorMinutesWithFoodAndTools: rounded(actorMinutes), outputEquivalentFocusedActorMinutes: rounded(batch.elementaryOutputMinutes.mochlik ?? 0),
      equivalentFocusedWorkPerOccupiedActorMinute: rounded((batch.elementaryOutputMinutes.mochlik ?? 0) / actorMinutes),
      netDirectSaleCoins: batch.incrementalMargin };
  });
  return {
    title: "Mining expeditions, fishing specializations and player progression",
    reviewDate: "2026-10-06", catalogVersion: catalog.version,
    sourceHashes: Object.fromEntries([
      "../apps/api/src/main/resources/world/economy-catalog.json", "../features/economy/rules.ts", "../features/economy/fishing.ts",
      "./simulate-player-journey.mjs", "./simulate-player-joint.mjs", "./lib/economy-math.mjs",
    ].map(file => [file, hash(file)])),
    method: {
      rules: "Real TypeScript commands, costs, claims, storage capacity and actor/building locks via Vite SSR; no gameplay grants",
      policy: "Prepare next construction, preserve future crafted stock, joint output planning; choose free material routes and idle income; no attempt to optimize player-market demand",
      visits3: "07:00,15:00,23:00 UTC; sessions at most ten minutes",
      visits2: "07:00,19:00 UTC; sessions at most ten minutes",
      active16h: "07:00–23:00 UTC, return at each ready event; jobs continue overnight",
      limitations: ["Five deterministic examples, not quantiles or a representative player sample", "No daily/achievement rewards, pearl purchases/speedups, market or tap income",
        "Uses starter fishing gear; premium loadouts are analysed separately", "Pending fishing species and relic types are not used for planning; only guaranteed pending output is reserved",
        "The planner does not provision paid food routes; those are analytic comparisons only",
        "Occupied slot-minutes are simultaneous resource reservations, not additive calendar duration", "Every mining claim now contributes to the existing shared rare-material clock; specific types have no finite guarantee",
        "Rare supply and market prices are not validated by progression reachability alone"],
    },
    progressionAudit: auditEconomyProgression(catalog), fishingRoles, fishingRoutes, baitMargins, resourceRoutes,
    craftExamples: ["make_planks", "make_rope", "make_tools"].map(id => math.batch(catalog.recipes.find(recipe => recipe.id === id))),
    samples,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loaded = await loadJourneyRules();
  try { console.log(JSON.stringify(reviewMiningFishing(loaded, result => process.stderr.write(`${JSON.stringify(result)}\n`)), null, 2)); }
  finally { await loaded.close(); }
}
