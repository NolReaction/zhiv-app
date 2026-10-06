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

test("current storage consumes 62 varied relics while retaining the first five capacities", () => {
  const report = reviewWarehouseRelics(readEconomyCatalog());
  assert.equal(report.warehouseMaximumLevel, 10);
  assert.deepEqual(report.totalWarehouseRelics, { ancient_core: 38, moon_crystal: 12, living_resin: 12 });
  assert.equal(report.totalWarehouseRelicCount, 62);
  assert.deepEqual(report.levels.map(level => level.capacity), [200, 500, 1000, 1800, 3000, 4000, 5200, 6600, 8200, 10000]);
  assert.deepEqual(report.levels.map(level => level.capacityGain), [200, 300, 500, 800, 1200, 1000, 1200, 1400, 1600, 1800]);
  assert(report.levels.slice(0, 3).every(level => Object.values(level.relicCost).every(quantity => quantity === 0)));
  assert(report.levels.slice(3).every(level => Object.values(level.relicCost).every(quantity => quantity > 0)
    && level.cost.coins === 0 && level.requiredHomeLevel === 1 && !Object.keys(level.requiredBuildings).length));
});

test("storage work time separates the full builder sum from partial random acquisition", () => {
  const report = reviewWarehouseRelics(readEconomyCatalog()), last = report.levels.at(-1);
  assert.equal(report.totalWarehouseConstructionHours, 872);
  assert.equal(report.totalWarehouseConstructionDays, 872 / 24);
  assert.equal(report.levels[3].partialNonCoreAcquisition.expectedDraws, 4.5);
  assert.equal(report.levels[3].partialNonCoreAcquisition.expectedWorkHours, 432);
  assert.equal(last.partialNonCoreAcquisition.cumulativeCrystals, 12);
  assert.equal(last.partialNonCoreAcquisition.cumulativeResin, 12);
  assert(Math.abs(last.partialNonCoreAcquisition.expectedDraws - 41.802489280700684) < 1e-9);
  assert(Math.abs(last.partialNonCoreAcquisition.expectedWorkHours - 4013.0389709472656) < 1e-9);
  assert.equal(report.method.meanIntervalHours, 96);
  assert.equal(report.method.requiredHomeLevelForExplorationDrops, 3);
  assert(report.method.excludes.some(value => value.includes("no assumption that gifts cover")));
});

test("the report reflects authored intervals and quota changes instead of fixed old totals", () => {
  const catalog = readEconomyCatalog();
  catalog.rareDrops.minSeconds *= 2; catalog.rareDrops.maxSeconds *= 2;
  catalog.buildings.find(building => building.id === "warehouse").levels[9].cost.items.moon_crystal++;
  const report = reviewWarehouseRelics(catalog), last = report.levels.at(-1);
  assert.equal(report.totalWarehouseRelics.moon_crystal, 13);
  assert.equal(report.totalWarehouseRelicCount, 63);
  assert.equal(report.method.meanIntervalHours, 192);
  assert(last.partialNonCoreAcquisition.expectedWorkHours > 4013.0389709472656 * 2);
});
