import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadJourneyRules, simulateJourney, DEFAULT_JOURNEY_RARE_SEED } from "./simulate-player-journey.mjs";
import { jointPlanningPolicy } from "./simulate-player-joint.mjs";

export const BASELINE_GIFT_COMMIT = "56de26dad03985400a7775563a47e43436ed0574";
const catalogFile = "apps/api/src/main/resources/world/progression-rewards-catalog.json";
const sha = contents => createHash("sha256").update(contents).digest("hex");

/** Keep the previous full daily cycle, including its coins/items/relic, in the
 * comparison. Comparing new full gifts with old pearl-only projections would
 * misleadingly attribute existing benefits to this update. */
export function baselineGiftRules(loaded, baseline) {
  assert.equal(baseline.dailyMinimumHours, loaded.progressionRewards.progressionRewardsCatalog.dailyMinimumHours);
  assert.equal(baseline.daily.length, loaded.progressionRewards.progressionRewardsCatalog.daily.length);
  return { ...loaded, progressionRewards: { ...loaded.progressionRewards,
    dailyRewardView(state, now, homeLevel) {
      const view = loaded.progressionRewards.dailyRewardView(state, now, homeLevel);
      return { ...view, reward: structuredClone(baseline.daily[state.step - 1]),
        cycle: baseline.daily.map((reward, index) => ({ step: index + 1, reward: structuredClone(reward) })) };
    } } };
}

export function reviewDailyGiftProgression(loaded, baselineBytes, onScenario = () => {}) {
  const baseline = JSON.parse(baselineBytes), before = baselineGiftRules(loaded, baseline);
  const stations = [...new Set(loaded.catalog.recipes.map(recipe => recipe.buildingId))].filter(id => id !== "quarry");
  const allSlotsPricePearls = stations.length * loaded.catalog.productionSlots.upgrades.reduce((sum, upgrade) => sum + upgrade.pricePearls, 0);
  const policies = [{ id: "one_slot", buyProductionSlots: false, pearlBudget: 0 },
    { id: "slots_from_daily_pearls", buyProductionSlots: true, pearlBudget: 0 },
    { id: "slots_prepaid", buyProductionSlots: true, pearlBudget: allSlotsPricePearls }];
  const samples = [];
  for (const rareSeed of [DEFAULT_JOURNEY_RARE_SEED, 123456789, 987654321]) for (const { id, ...policy } of policies)
    for (const [giftVersion, rules] of [["before", before], ["after", loaded]]) {
      const result = simulateJourney(rules, "visits3", 1600, { ...jointPlanningPolicy, parallelProductionPlanning: true,
        constructionSpeedups: false, dailyRewards: true, ...policy, rareSeed });
      assert(result.complete, `${giftVersion}/${id}/${rareSeed} stalled at ${result.stoppedAt}`);
      assert.equal(result.actions.speedup_construction, undefined);
      for (const failure of ["ECONOMY_BUILDING_BUSY", "ECONOMY_BUILDING_REQUIRED", "ECONOMY_PEARLS", "ECONOMY_QUARRY_BUSY", "ECONOMY_EXPLORER_BUSY", "ECONOMY_COLLECTOR_BUSY"])
        assert.equal(result.failures[failure], undefined, `${giftVersion}/${id} violated ${failure}`);
      for (const purchase of result.productionSlots.purchases) {
        const tier = loaded.catalog.productionSlots.upgrades.find(tier => tier.slots === purchase.slots);
        assert(purchase.houseLevel >= tier.requiredHomeLevel);
        assert.equal(purchase.pricePearls, tier.pricePearls);
      }
      const { finds, ...rareMaterials } = result.rareMaterials;
      const { claimRows, ...dailyRewards } = result.dailyRewards;
      const grantsByHome = Object.fromEntries([1, 2, 3, 4, 5].map(home => [home,
        claimRows.filter(row => row.homeLevel === home).reduce((value, row) => {
          value.claims++; value.coins += row.reward.coins; value.pearls += row.reward.pearls;
          for (const [id, quantity] of Object.entries(row.reward.items)) value.items[id] = (value.items[id] ?? 0) + quantity;
          return value;
        }, { claims: 0, coins: 0, pearls: 0, items: {} })]));
      samples.push({ giftVersion, policy: id, ...result, dailyRewards: { ...dailyRewards, grantsByHome },
        rareMaterials: { ...rareMaterials, findCount: finds.length } });
      onScenario({ giftVersion, policy: id, rareSeed, home5Days: result.homeDays[5], allBuildings5Days: result.elapsedDays,
        giftsClaimed: result.dailyRewards.claims, giftStorageDeferrals: result.dailyRewards.storageDeferrals });
    }
  const summary = policies.map(({ id }) => {
    const phases = Object.fromEntries(["before", "after"].map(phase => {
      const selected = samples.filter(sample => sample.policy === id && sample.giftVersion === phase);
      const range = pick => ({ min: Math.min(...selected.map(pick)), max: Math.max(...selected.map(pick)) });
      return [phase, { home5Days: range(sample => sample.homeDays[5]), allBuildings5Days: range(sample => sample.elapsedDays),
        totalGiftCoins: range(sample => sample.dailyRewards.coinsReceived), giftsClaimed: range(sample => sample.dailyRewards.claims) }];
    }));
    return { policy: id, ...phases };
  });
  return { title: "Complete daily gifts: same player policies before and after home-scaled bundles", reviewDate: "2026-10-06",
    baseline: { commit: BASELINE_GIFT_COMMIT, file: catalogFile, sha256: sha(baselineBytes), daily: baseline.daily },
    catalogVersion: loaded.catalog.version, allSlotsPricePearls,
    method: { visits: "07:00,15:00,23:00 UTC; at most ten minutes per session; three deterministic relic seeds, not population quantiles",
      comparison: "Both phases claim complete real daily bundles: coins, pearls, ordinary items and the weekly relic. Only the selected daily cycle changes; calendar, planner, recipes and commands stay identical.",
      grants: "dailyRewardView chooses the completed home at claim time. Inventory credit and storage checks use actual TS rules, matching the DEV grant adapter; rejected capacity leaves the whole gift/calendar untouched. Calendar advances only after successful credit. No escrow exists in these no-market policies.",
      accounting: "Raw catalog currency units; pearls displayed in game at raw/2. All item flows and pearls reconcile; gift relics and exploration relics are tracked separately.",
      completion: "Home level5 and all eight progression buildings level5, not every collection or all future content",
      limitations: ["Research grant projection, not HTTP, transaction, receipt or PostgreSQL integration testing.",
        "No market, gifts from friends, tap income, achievement rewards, purchased gold or construction speedups.",
        "Prepaid slots assume their entire budget already exists; earning or paying for that budget is outside the clock.",
        "Fixed order and deterministic starter fishing policy are not optimal speedruns. Three seeds do not estimate median or tail probabilities.",
        "Item-full gift failures are retried after ordinary stock management; real players can choose a different time to claim.",
        "The old production-slots report excluded gift coins/items/relics; its numbers are not the before column in this comparison."] },
    sourceHashes: Object.fromEntries(["../apps/api/src/main/resources/world/economy-catalog.json", `../${catalogFile}`,
      "../features/economy/rules.ts", "../features/game/progression-rewards.ts", "./simulate-player-journey.mjs",
      "./simulate-player-joint.mjs", "./review-daily-gift-progression.mjs"].map(file => [file, sha(readFileSync(new URL(file, import.meta.url)))])),
    summary, scenarios: samples };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // An explicit pinned Git object makes the comparison reproducible after the
  // live catalog changes again; fetch this commit if using a shallow clone.
  const baselineBytes = execFileSync("git", ["show", `${BASELINE_GIFT_COMMIT}:${catalogFile}`], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  const loaded = await loadJourneyRules();
  try { console.log(JSON.stringify(reviewDailyGiftProgression(loaded, baselineBytes, row => process.stderr.write(`${JSON.stringify(row)}\n`)), null, 2)); }
  finally { await loaded.close(); }
}
