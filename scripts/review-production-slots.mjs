import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadJourneyRules, simulateJourney, DEFAULT_JOURNEY_RARE_SEED } from "./simulate-player-journey.mjs";
import { jointPlanningPolicy } from "./simulate-player-joint.mjs";

/** Gift count, not an assumed average income: payouts arrive on steps 3, 6, 7. */
export function dailyPearlThreshold(rewards, targetPearls) {
  assert(Number.isSafeInteger(targetPearls) && targetPearls > 0);
  assert(rewards.daily.some(reward => reward.pearls > 0));
  let claims = 0, pearls = 0;
  while (pearls < targetPearls) pearls += rewards.daily[claims++ % rewards.daily.length].pearls;
  return { targetPearls, giftClaims: claims, elapsedDaysWithFirstGiftToday: claims - 1, pearlsReceived: pearls };
}

export function reviewProductionSlots(loaded, onScenario = () => {}) {
  const { catalog, progressionRewards } = loaded;
  const stations = [...new Set(catalog.recipes.map(recipe => recipe.buildingId))].filter(id => id !== "quarry");
  const upgrades = catalog.productionSlots.upgrades;
  const totalPearls = upgrades.reduce((sum, upgrade) => sum + upgrade.pricePearls, 0) * stations.length;
  const rewards = progressionRewards.progressionRewardsCatalog;
  const policies = [
    { id: "one_slot", pearlBudget: 0, buyProductionSlots: false },
    { id: "slots_from_daily_pearls", pearlBudget: 0, buyProductionSlots: true, dailyPearlsOnly: true },
    { id: "slots_prepaid", pearlBudget: totalPearls, buyProductionSlots: true },
  ];
  const scenarios = [
    ["visits3", DEFAULT_JOURNEY_RARE_SEED], ["active16h", DEFAULT_JOURNEY_RARE_SEED],
    ["visits3", 123456789], ["visits3", 987654321],
  ].flatMap(([mode, rareSeed]) => policies.map(({ id, ...policy }) => {
    const result = simulateJourney(loaded, mode, 1600, { ...jointPlanningPolicy,
      parallelProductionPlanning: true, constructionSpeedups: false, ...policy, rareSeed });
    assert(result.complete, `${mode}/${id}/${rareSeed} did not complete: ${result.stoppedAt}`);
    assert.equal(result.actions.speedup_construction, undefined);
    for (const failure of ["ECONOMY_BUILDING_BUSY", "ECONOMY_BUILDING_REQUIRED", "ECONOMY_PEARLS", "ECONOMY_QUARRY_BUSY", "ECONOMY_EXPLORER_BUSY", "ECONOMY_COLLECTOR_BUSY"])
      assert.equal(result.failures[failure], undefined, `${mode}/${id}: planner violated ${failure}`);
    for (const purchase of result.productionSlots.purchases) {
      const tier = upgrades.find(upgrade => upgrade.slots === purchase.slots);
      assert(tier && purchase.houseLevel >= tier.requiredHomeLevel);
      assert.equal(purchase.pricePearls, tier.pricePearls);
    }
    if (id === "slots_prepaid") {
      assert.equal(result.pearlsSpent, totalPearls);
      assert.equal(result.pearlsRemaining, 0);
      assert.equal(result.productionSlots.purchases.length, stations.length * upgrades.length);
    }
    const { finds, ...rareMaterials } = result.rareMaterials;
    const sample = { policy: id, ...result, rareMaterials: { ...rareMaterials, findCount: finds.length } };
    onScenario({ mode, policy: id, rareSeed, home5Days: result.homeDays[5], allBuildings5Days: result.elapsedDays,
      pearlsSpent: result.pearlsSpent ?? 0, finalCapacity: result.productionSlots.finalCapacity });
    return sample;
  }));
  const summary = scenarios.map(sample => {
    const baseline = scenarios.find(other => other.policy === "one_slot" && other.mode === sample.mode && other.rareMaterials.seed === sample.rareMaterials.seed);
    return { mode: sample.mode, policy: sample.policy, rareSeed: sample.rareMaterials.seed,
      home5Days: sample.homeDays[5], allBuildings5Days: sample.elapsedDays,
      home5DaysSaved: Number((baseline.homeDays[5] - sample.homeDays[5]).toFixed(3)),
      allBuildings5DaysSaved: Number((baseline.elapsedDays - sample.elapsedDays).toFixed(3)),
      pearlsSpent: sample.pearlsSpent ?? 0, productionSlotPurchases: sample.productionSlots.purchases.length };
  });
  return {
    title: "Production slots: actual command progression and pearl acquisition scenarios", reviewDate: "2026-10-06",
    catalogVersion: catalog.version, stations, upgrades, allSlotsPricePearls: totalPearls,
    sourceHashes: Object.fromEntries([
      "../apps/api/src/main/resources/world/economy-catalog.json", "../apps/api/src/main/resources/world/progression-rewards-catalog.json",
      "../features/economy/rules.ts", "../features/economy/production-slots.ts", "../features/economy/fishing.ts",
      "../features/game/progression-rewards.ts", "./simulate-player-journey.mjs", "./simulate-player-joint.mjs", "./review-production-slots.mjs",
    ].map(file => [file, createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex")])),
    method: {
      rules: "Real TypeScript production, buy_production_slot, claims, construction, actor locks, stock and coin accounting through Vite SSR",
      completion: "Home level 5 and separately all eight progression buildings level 5; not all collections, legendary fishing, social goals or a final game ending",
      policies: {
        one_slot: "Same parallel-aware planning policy, no slot purchases and no initial pearls",
        slots_from_daily_pearls: "Start with zero pearls. Project only daily gifts' pearl component using real dailyRewardView/afterDailyClaim UTC and minimum-hours rules; purchases use ordinary commands",
        slots_prepaid: "Hypothetical already-owned initial pearl budget; acquire slots for each built station immediately after its house gate and any station construction finish",
      },
      planner: "Prepare next construction, preserve future crafted stock, reserve only publicly guaranteed pending output, fill affordable available capacity, pause a station's fresh jobs when an affordable upgrade needs it to become idle",
      purchaseOrder: stations,
      visits3: "07:00,15:00,23:00 UTC; each session at most ten minutes",
      active16h: "07:00–23:00 UTC, return at each ready event; jobs continue overnight; theoretical intensive play, not ordinary daily use",
      limitations: ["Three deterministic relic seeds for three daily visits; one for active play. Examples, not population quantiles or an optimized speedrun",
        "No construction speedups, markets, tap income, achievement pearls, gift coins/items/relics or purchased gold in any comparison",
        "Daily projection is not an integration test of reward endpoints or a complete reward-using player. Ignoring its other rewards can overstate real durations",
        "Prepaid scenario excludes the time needed to earn its initial pearls; no shop payment capability is implied",
        "Starter fishing gear; pending species and private relic state cannot inform planning",
        "Quarry and expeditions still compete for one actor, harvest collections serialize, storage and construction remain constrained",
        "Recipes, item prices, output amounts, production durations and construction costs are unchanged",
        "The same planner is used for all variants here; earlier reports without parallel-aware planning are historical, not the comparison baseline"],
    },
    pearlSupply: {
      pearlsPerGiftCycle: rewards.daily.reduce((sum, reward) => sum + reward.pearls, 0), cycleClaims: rewards.daily.length,
      allAchievementPearlsOnce: Object.values(rewards.achievementPearls).flat().reduce((sum, amount) => sum + amount, 0),
      thresholds: [...new Set([upgrades[0].pricePearls, upgrades[1].pricePearls,
        upgrades[0].pricePearls * stations.length, totalPearls])].map(target => dailyPearlThreshold(rewards, target)),
      assumption: "One claim every day, first gift today, no other pearl income or spending. Level/building gates are additional; achievements are finite and are not assumed earned at start",
    },
    summary, scenarios,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loaded = await loadJourneyRules();
  try { console.log(JSON.stringify(reviewProductionSlots(loaded, result => process.stderr.write(`${JSON.stringify(result)}\n`)), null, 2)); }
  finally { await loaded.close(); }
}
