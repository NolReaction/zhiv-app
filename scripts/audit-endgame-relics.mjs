import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const sum = values => values.reduce((total, value) => total + value, 0);

/** Exact number of independent uniform draws needed for every specified quota.
 * Saturated types are self-loops: E(t) = (types + sum(E(t-e_i))) / positiveTypes.
 * This includes surplus duplicates; it is not a calendar-day promise. */
export function expectedUniformQuotaDraws(targets) {
  assert(targets.length > 0 && targets.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100));
  const cache = new Map();
  function visit(remaining) {
    const positive = remaining.flatMap((value, index) => value ? [index] : []);
    if (!positive.length) return 0;
    const key = remaining.join(",");
    if (!cache.has(key)) cache.set(key, (targets.length + sum(positive.map(index =>
      visit(remaining.map((value, i) => value - Number(index === i)))))) / positive.length);
    return cache.get(key);
  }
  return visit(targets);
}

function random(seed) {
  let state = seed >>> 0;
  return exclusiveMaximum => {
    const limit = Math.floor(0xffffffff / exclusiveMaximum) * exclusiveMaximum;
    for (;;) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
      const sample = state - 1;
      if (sample < limit) return sample % exclusiveMaximum;
    }
  };
}

/** Conditional daily acquisition only. Two continuously utilized independent
 * completed-work clocks, daily settlement of their accrued work, no unlock or
 * recipe scheduling. Full lifetime awards are deliberately frontloaded, so pearl
 * scenarios describe optimistic budget sensitivity, never a real playthrough. */
export function simulateConditionalAcquisition({ needs, hoursPerActor, budget, weeklyPearls,
  minSeconds, maxSeconds, relicPrice, samples, seed }) {
  const next = random(seed), interval = () => minSeconds + next(maxSeconds - minSeconds + 1);
  const days = [];
  for (let trial = 0; trial < samples; trial++) {
    const remaining = [...needs], clocks = [interval(), interval()];
    let pearls = budget;
    for (let day = 1; day <= 5000; day++) {
      if (day % 7 === 0) pearls += weeklyPearls;
      // Conservative availability: one type/day, one unit, each type once/3 days.
      // Actual personalized Leaftail rings can offer a second type on a day.
      const offer = (day - 1) % remaining.length;
      if (pearls >= relicPrice && remaining[offer] > 0 && remaining[offer] === Math.max(...remaining)) {
        remaining[offer]--; pearls -= relicPrice;
      }
      for (let actor = 0; actor < clocks.length; actor++) {
        clocks[actor] -= hoursPerActor * 3600;
        while (clocks[actor] <= 0) {
          const type = next(remaining.length);
          remaining[type] = Math.max(0, remaining[type] - 1);
          clocks[actor] += interval();
        }
      }
      if (!remaining.some(Boolean)) { days.push(day); break; }
      assert(day < 5000, "Acquisition horizon exceeded");
    }
  }
  days.sort((a, b) => a - b);
  const quantile = p => days[Math.floor((days.length - 1) * p)];
  return { samples, seed, hoursPerActor, frontloadedPearls: budget, weeklyPearls,
    meanDays: sum(days) / days.length, p10Days: quantile(.1), medianDays: quantile(.5), p90Days: quantile(.9) };
}

export function auditEndgameRelics(samples = 10000) {
  assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 100000);
  const catalog = read("apps/api/src/main/resources/world/economy-catalog.json");
  const rewards = read("apps/api/src/main/resources/world/progression-rewards-catalog.json");
  const ids = catalog.rareDrops.itemIds, spec = catalog.rareDrops;
  const total = buildings => ids.map(id => sum(buildings.flatMap(b => b.levels.map(l => l.cost.items[id] ?? 0))));
  const warehouse = catalog.buildings.find(b => b.id === "warehouse"), warehouseCosts = total([warehouse]);
  const otherCosts = total(catalog.buildings.filter(b => b.id !== "warehouse"));
  const gifts = ids.map(id => sum(rewards.daily.map(d => d.items[id] ?? 0)) +
    sum(catalog.stageOrders.map(s => s.completionRewards?.[id] ?? 0)));
  const rawDivisor = Number(readFileSync(new URL("features/economy/domain/money.ts", root), "utf8")
    .match(/PEARL_DISPLAY_DIVISOR\s*=\s*(\d+)/)?.[1]);
  assert(rawDivisor > 0, "Cannot read current pearl display divisor");
  const visible = raw => raw / rawDivisor;
  const welcome = Number(readFileSync(new URL("features/mailbox/welcome.ts", root), "utf8")
    .match(/WELCOME_MAIL_PEARLS\s*=\s*(\d+)/)?.[1]);
  const starter = visible(rewards.onboarding.pearls + sum(rewards.daily.map(d => d.pearls))) + welcome;
  const achievementTotal = visible(sum(Object.values(rewards.achievementPearls).flat()));
  const outsideEconomy = ["seven_day_streak", "thousand_taps", "ten_thousand_series", "linked_email",
    "saved_recovery_code", "five_friends", "first_sale"];
  const outsideTotal = visible(sum(outsideEconomy.flatMap(id => rewards.achievementPearls[id])));
  const productionStations = new Set(catalog.recipes.filter(recipe => !recipe.retired && recipe.buildingId !== "quarry")
    .map(recipe => recipe.buildingId));
  // Mirror productionStationSupported; quarry is one actor, not a purchased slot.
  const stationSource = readFileSync(new URL("features/economy/domain/production-slots.ts", root), "utf8");
  assert(stationSource.includes('stationId !== "quarry"'), "Revisit slot budget if supported stations change");
  const stations = productionStations.size;
  const allSlots = stations * visible(sum(catalog.productionSlots.upgrades.map(u => u.pricePearls)));
  const secondSlots = stations * visible(catalog.productionSlots.upgrades.find(u => u.slots === 2).pricePearls);
  const weeklyValues = [...new Set(catalog.tradeRelations.weekly.templates.map(t => visible(sum(t.stages.map(s => s.pearls ?? 0)))))];
  assert.equal(weeklyValues.length, 1, "Weekly rewards require separate budget scenarios");
  const prices = [...new Set(catalog.leaftailShop.pearlOffers.map(o => visible(o.pricePearls)))];
  assert.equal(prices.length, 1, "Relic-specific prices require a different buying policy");
  const lifetime = starter + achievementTotal, pureEconomy = lifetime - outsideTotal;
  const budgets = [
    { id: "natural_no_shop", budget: 0, weeklyPearls: 0 },
    { id: "all_slots_economy_achievements", budget: Math.max(0, pureEconomy - allSlots), weeklyPearls: weeklyValues[0] },
    { id: "all_slots_all_achievements", budget: Math.max(0, lifetime - allSlots), weeklyPearls: weeklyValues[0] },
    { id: "second_slots_all_achievements", budget: Math.max(0, lifetime - secondSlots), weeklyPearls: weeklyValues[0] },
    { id: "all_pearls_to_relics", budget: lifetime, weeklyPearls: weeklyValues[0] },
  ];
  const meanIntervalHours = (spec.minSeconds + spec.maxSeconds) / 7200;
  const variants = [
    { id: "handoff_32a39382", warehouseRelics: [38, 12, 12] },
    { id: "current_catalog", warehouseRelics: warehouseCosts },
  ].map(variant => {
    const needs = variant.warehouseRelics.map((count, i) => Math.max(0, count + otherCosts[i] - gifts[i]));
    const expectedDraws = expectedUniformQuotaDraws(needs), expectedActorHours = expectedDraws * meanIntervalHours;
    return { ...variant, allBuildingRelics: variant.warehouseRelics.map((count, i) => count + otherCosts[i]),
      guaranteedGifts: gifts, needsAfterGuaranteedGifts: needs, expectedDraws, expectedActorHours,
      throughputApproxDays: Object.fromEntries([8, 16, 24].map(h => [h, expectedActorHours / (2 * h)])),
      conditionalMonteCarlo: [8, 16].flatMap(hoursPerActor => budgets.map(({ id, ...budget }) => ({ id,
        ...simulateConditionalAcquisition({ needs, hoursPerActor, ...budget, minSeconds: spec.minSeconds,
          maxSeconds: spec.maxSeconds, relicPrice: prices[0], samples, seed: 726014 + hoursPerActor }) }))) };
  });
  return { catalogVersion: catalog.version, rewardVersion: rewards.version, relicIds: ids,
    baselineSource: "32a39382f311faabf203621374ba878ede57f0cc:apps/api/src/main/resources/world/economy-catalog.json",
    method: { scope: "Conditional relic acquisition after home3, not a complete-game playthrough or a guaranteed date.",
      exactPart: "Finite-state expected independent uniform item draws, including duplicate types.",
      approximation: "Expected draws times mean96 actor-hours divided by two perfectly utilized actors; concurrent clock phase and final work boundaries make this a throughput approximation.",
      simulation: "Two independent uniform integer-second clocks; complete exactly h hours per actor/day, settle once daily. No paid acceleration or barter.",
      shop: "Conservative one-type/day rotating ring, stock1/type/day. Buy only the current largest deficit. Real personal ring may offer1–2types/day.",
      budget: "All lifetime awards available at rare unlock, weekly award received every7days without modeling its work. Optimistic sensitivity only; not the actual availability of achievements or a proven lower bound.",
      excludes: ["Time before home3", "Construction, source unlocks and ordinary recipes", "Job-boundary overshoot and manual gaps",
        "Fishing/atlas/recipe/reputation completion", "Weekly task inputs and active time", "Other pearl spending and player barter"],
      noFiniteGuarantee: "A particular random relic type has no finite guaranteed date; the48–144work-hour bound applies to any next find per actor." },
    meanIntervalHours, budgetsVisible: { starter, allAchievements: achievementTotal, pureEconomyAchievements: achievementTotal - outsideTotal,
      outsideEconomyAchievements: outsideTotal, outsideEconomyAchievementIds: outsideEconomy, lifetimeAll: lifetime,
      lifetimePureEconomy: pureEconomy, productionStations: [...productionStations], allProductionSlots: allSlots,
      allSecondSlots: secondSlots, relicPrice: prices[0], weekly: weeklyValues[0] },
    currentWarehouseLevels: warehouse.levels.map(l => ({ level: l.level, requiredHomeLevel: l.requiredHomeLevel,
      requiredBuildings: l.requiredBuildings, seconds: l.seconds, cost: l.cost })), variants,
    sourceHashes: Object.fromEntries(["scripts/audit-endgame-relics.mjs", "apps/api/src/main/resources/world/economy-catalog.json",
      "apps/api/src/main/resources/world/progression-rewards-catalog.json", "features/economy/domain/money.ts",
      "features/mailbox/welcome.ts", "features/economy/domain/production-slots.ts"].map(path =>
      [path, createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex")])) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  console.log(JSON.stringify(auditEndgameRelics(Number(process.argv[2] ?? 10000)), null, 2));
