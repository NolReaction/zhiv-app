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

test("current storage starts at 50 places and consumes 62 varied relics across its later tiers", () => {
  const catalog = readEconomyCatalog(), report = reviewWarehouseRelics(catalog);
  assert.equal(report.warehouseMaximumLevel, 10);
  assert.deepEqual(report.totalWarehouseRelics, { ancient_core: 38, moon_crystal: 12, living_resin: 12 });
  assert.equal(report.totalWarehouseRelicCount, 62);
  assert.deepEqual(report.levels.map(level => level.capacity), [50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);
  assert.deepEqual(report.levels.map(level => level.capacityGain), Array(10).fill(50));
  assert.equal(report.levels[1].requiredHomeLevel, 2);
  assert(report.levels.slice(0, 3).every(level => Object.values(level.relicCost).every(quantity => quantity === 0)));
  assert(report.levels.slice(3).every(level => Object.values(level.relicCost).every(quantity => quantity > 0)
    && level.cost.coins === 0 && level.requiredHomeLevel === 1 && !Object.keys(level.requiredBuildings).length));
  assert(catalog.buildings.filter(building => building.id !== "warehouse")
    .every(building => building.levels.every(level => !level.requiredBuildings.warehouse)), "earned storage is optional for every other building");
  assert(report.levels.every(level => Object.values(level.cost.items).reduce((sum, quantity) => sum + quantity, 0) <= 42),
    "each paid storage expansion can hold its own materials in the starter warehouse");
});

test("storage work time separates the full builder sum from partial random acquisition", () => {
  const report = reviewWarehouseRelics(readEconomyCatalog()), last = report.levels.at(-1);
  assert.deepEqual(report.levels.map(level => level.constructionHours), [0, 1 / 6, 4, 2, 4, 6, 8, 12, 16, 24]);
  const constructionSeconds = 600 + 76 * 3600;
  assert(Math.abs(report.totalWarehouseConstructionHours - constructionSeconds / 3600) < 1e-9);
  assert(Math.abs(report.totalWarehouseConstructionDays - constructionSeconds / 86400) < 1e-9);
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
