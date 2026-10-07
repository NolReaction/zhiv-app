import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readEconomyCatalog } from "./audit-economy-progression.mjs";

/** Exact expectation for collecting two specified types from independent,
 * uniform draws, counting every other type and surplus duplicate as a draw.
 * E(i,j) = [typeCount + E(i+1,j) + E(i,j+1)] / progressingTypes;
 * saturated types self-loop and are therefore removed from the denominator.
 */
export function expectedUniformTwoTypeDraws(firstTarget, secondTarget, typeCount = 3) {
  assert([firstTarget, secondTarget].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100), "Invalid relic targets");
  assert(Number.isSafeInteger(typeCount) && typeCount >= 2 && typeCount <= 100, "Invalid relic type count");
  const means = Array.from({ length: firstTarget + 1 }, () => Array(secondTarget + 1).fill(0));
  for (let first = firstTarget; first >= 0; first--) for (let second = secondTarget; second >= 0; second--) {
    const progressingTypes = Number(first < firstTarget) + Number(second < secondTarget);
    if (!progressingTypes) continue;
    means[first][second] = (typeCount + (first < firstTarget ? means[first + 1][second] : 0)
      + (second < secondTarget ? means[first][second + 1] : 0)) / progressingTypes;
  }
  return means[0][0];
}

/** Partial acquisition mathematics, not a full player progression simulation. */
export function reviewWarehouseRelics(catalog) {
  const warehouse = catalog.buildings.find(building => building.id === "warehouse"), spec = catalog.rareDrops;
  assert(warehouse && spec && spec.itemIds.includes("moon_crystal") && spec.itemIds.includes("living_resin"), "Missing warehouse relic source");
  const meanIntervalHours = (spec.minSeconds + spec.maxSeconds) / 7200;
  const cumulativeRelics = Object.fromEntries(spec.itemIds.map(id => [id, 0]));
  let previousCapacity = 0, cumulativeConstructionHours = 0;
  const levels = warehouse.levels.map(level => {
    const relicCost = Object.fromEntries(spec.itemIds.map(id => [id, level.cost.items[id] ?? 0]));
    for (const id of spec.itemIds) cumulativeRelics[id] += relicCost[id];
    cumulativeConstructionHours += level.seconds / 3600;
    const expectedDraws = expectedUniformTwoTypeDraws(cumulativeRelics.moon_crystal, cumulativeRelics.living_resin, spec.itemIds.length);
    const expectedWorkHours = expectedDraws * meanIntervalHours;
    const row = { level: level.level, capacity: level.warehouseCapacity, capacityGain: level.warehouseCapacity - previousCapacity,
      cost: level.cost, requiredHomeLevel: level.requiredHomeLevel, requiredBuildings: level.requiredBuildings,
      relicCost, cumulativeRelicCost: { ...cumulativeRelics }, constructionHours: level.seconds / 3600, cumulativeConstructionHours,
      partialNonCoreAcquisition: { cumulativeCrystals: cumulativeRelics.moon_crystal, cumulativeResin: cumulativeRelics.living_resin,
        expectedDraws, expectedWorkHours, illustrativeDaysAt16WorkHoursPerDay: expectedWorkHours / 16,
        illustrativeDaysAt8WorkHoursPerDay: expectedWorkHours / 8 } };
    previousCapacity = level.warehouseCapacity;
    return row;
  });
  return { catalogVersion: catalog.version, warehouseMaximumLevel: warehouse.levels.at(-1).level,
    totalWarehouseRelics: { ...cumulativeRelics }, totalWarehouseRelicCount: Object.values(cumulativeRelics).reduce((sum, count) => sum + count, 0),
    totalWarehouseConstructionHours: cumulativeConstructionHours, totalWarehouseConstructionDays: cumulativeConstructionHours / 24,
    method: { source: "Shared authenticated completed-exploration clock; independent uniform interval and relic type draws.",
      requiredHomeLevelForExplorationDrops: spec.requiredHomeLevel, minimumIntervalHours: spec.minSeconds / 3600,
      maximumIntervalHours: spec.maxSeconds / 3600, meanIntervalHours, typeProbability: 1 / spec.itemIds.length,
      expectation: "Finite-state recurrence for both cumulative moon_crystal and living_resin quotas. Counts cores and excess duplicate types as draws. Independent mean intervals multiply that expected draw count.",
      scope: "Only the warehouse's cumulative crystal and resin collection, starting with no relic stock at the exploration-drop unlock. This is a partial acquisition expectation, not a promised date or a complete-game simulation.",
      excludes: ["Required ancient_core stock and timing of seven-claim daily gifts; no assumption that gifts cover the core requirement",
        "Additional relics spent on homes or other buildings", "Time before unlocking expedition drops", "Construction, other prerequisites and materials",
        "Completed-job boundary overshoot and time lost between visits", "Player barter, future merchant and premium acceleration"],
      limitations: ["The 16h and 8h day conversions assume that much eligible work is completed every day; they are illustrative divisions, not measured play schedules.",
        "A specific relic type has no finite guaranteed completion time. Averages include duplicate draws.",
        "Higher warehouse capacity leaves house-based market quotas and exchange limits unchanged."] }, levels };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const sourceHashes = Object.fromEntries(["../apps/api/src/main/resources/world/economy-catalog.json", "./review-warehouse-relics.mjs"]
    .map(path => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
  console.log(JSON.stringify({ ...reviewWarehouseRelics(readEconomyCatalog()), sourceHashes }, null, 2));
}
