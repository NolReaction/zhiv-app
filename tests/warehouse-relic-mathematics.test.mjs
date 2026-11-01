import assert from "node:assert/strict";
import test from "node:test";
import { readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";
import { expectedUniformTwoTypeDraws, reviewWarehouseRelics } from "../scripts/review-warehouse-relics.mjs";

test("two-type expectation counts wrong types and duplicates rather than adding independent means", () => {
  assert.equal(expectedUniformTwoTypeDraws(0, 0), 0);
  assert.equal(expectedUniformTwoTypeDraws(1, 0), 3);
  assert.equal(expectedUniformTwoTypeDraws(0, 2), 6);
  assert.equal(expectedUniformTwoTypeDraws(1, 1), 4.5);
  assert.equal(expectedUniformTwoTypeDraws(2, 2), 8.25);
  assert.equal(expectedUniformTwoTypeDraws(1, 1, 2), 3);
  assert.equal(expectedUniformTwoTypeDraws(2, 3), expectedUniformTwoTypeDraws(3, 2));
  assert.throws(() => expectedUniformTwoTypeDraws(-1, 1), /Invalid relic targets/);
  assert.throws(() => expectedUniformTwoTypeDraws(1, 0, 1), /Invalid relic type count/);
});

test("storage reaches 500 ordinary places before its five relic-only expansions to 750", () => {
  const catalog = readEconomyCatalog(), report = reviewWarehouseRelics(catalog);
  assert.equal(report.warehouseMaximumLevel, 15);
  assert.equal(report.warehouseMaximumCapacity, 750);
  assert.equal(report.ordinaryExpansionMaximumLevel, 10);
  assert.equal(report.ordinaryExpansionMaximumCapacity, 500);
  assert.equal(report.firstRelicExpansionLevel, 11);
  assert.equal(report.totalWarehouseCoins, 274700);
  assert.deepEqual(report.totalWarehouseRelics, { ancient_core: 6, moon_crystal: 3, living_resin: 3 });
  assert.equal(report.totalWarehouseRelicCount, 12);
  assert.deepEqual(report.levels.map(level => level.capacity), Array.from({ length: 15 }, (_, index) => (index + 1) * 50));
  assert.deepEqual(report.levels.map(level => level.capacityGain), Array(15).fill(50));
  assert.deepEqual(report.levels.map(level => level.cost.coins), [0, 200, 1500, 8000, 12000, 18000, 30000, 45000, 65000, 95000, 0, 0, 0, 0, 0],
    "ordinary storage retains its authored coin prices; only the five final tiers spend relics");
  assert.equal(report.levels[1].requiredHomeLevel, 2);
  assert(report.levels.slice(0, 10).every(level => Object.values(level.relicCost).every(quantity => quantity === 0)));
  assert(report.levels.slice(3, 10).every(level => level.requiredHomeLevel === (level.level <= 6 ? 4 : 5)
    && Object.keys(level.requiredBuildings).length));
  assert(report.levels.slice(10).every(level => Object.values(level.relicCost).some(quantity => quantity > 0)
    && level.requiredHomeLevel === 5 && !Object.keys(level.requiredBuildings).length
    && Object.keys(level.cost.items).every(id => catalog.rareDrops.itemIds.includes(id))));
  assert(catalog.buildings.filter(building => building.id !== "warehouse")
    .every(building => building.levels.every(level => !level.requiredBuildings.warehouse)), "earned storage is optional for every other building");
  assert(report.levels.every(level => Object.values(level.cost.items).reduce((sum, quantity) => sum + quantity, 0) <= 42),
    "each paid storage expansion can hold its own materials in the starter warehouse");
});

test("storage work time separates the full builder sum from partial random acquisition", () => {
  const report = reviewWarehouseRelics(readEconomyCatalog()), last = report.levels.at(-1);
  assert.deepEqual(report.levels.map(level => level.constructionHours), [0, 1 / 6, 1, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
  const constructionSeconds = 600 + 47 * 3600;
  assert(Math.abs(report.totalWarehouseConstructionHours - constructionSeconds / 3600) < 1e-9);
  assert(Math.abs(report.totalWarehouseConstructionDays - constructionSeconds / 86400) < 1e-9);
  assert.equal(report.levels[9].partialNonCoreAcquisition.expectedDraws, 0);
  assert.equal(report.levels[9].partialNonCoreAcquisition.expectedWorkHours, 0);
  assert.equal(last.partialNonCoreAcquisition.cumulativeCrystals, 3);
  assert.equal(last.partialNonCoreAcquisition.cumulativeResin, 3);
  assert.equal(last.partialNonCoreAcquisition.expectedDraws, 11.8125);
  assert.equal(last.partialNonCoreAcquisition.expectedWorkHours, 1134);
  assert.equal(report.method.meanIntervalHours, 96);
  assert.equal(report.method.requiredHomeLevelForExplorationDrops, 3);
  assert(report.method.excludes.some(value => value.includes("no assumption that gifts cover")));
});

test("the report reflects authored intervals and quota changes instead of fixed old totals", () => {
  const catalog = readEconomyCatalog();
  catalog.rareDrops.minSeconds *= 2; catalog.rareDrops.maxSeconds *= 2;
  const lastCost = catalog.buildings.find(building => building.id === "warehouse").levels.at(-1).cost.items;
  lastCost.moon_crystal = (lastCost.moon_crystal ?? 0) + 1;
  const report = reviewWarehouseRelics(catalog), last = report.levels.at(-1);
  assert.equal(report.totalWarehouseRelics.moon_crystal, 4);
  assert.equal(report.totalWarehouseRelicCount, 13);
  assert.equal(report.method.meanIntervalHours, 192);
  assert(last.partialNonCoreAcquisition.expectedWorkHours > 1134 * 2);
});
