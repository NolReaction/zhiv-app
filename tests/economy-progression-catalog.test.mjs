import assert from "node:assert/strict";
import test from "node:test";
import { auditEconomyProgression, readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";

test("economy catalog has useful chains, reachable upgrades, sufficient storage and a market-proof pacing floor", () => {
  const report = auditEconomyProgression(readEconomyCatalog());
  assert.equal(report.itemCount, 24);
  assert.equal(report.buildingCount, 8);
  assert.equal(report.constructionOrder.length, 37);
});

test("the quarry and workshop furnace follow home two without blocking the starter route", () => {
  const catalog = readEconomyCatalog(), report = auditEconomyProgression(catalog);
  const order = key => report.constructionOrder.indexOf(key);
  assert.ok(order("woodlot:1") < order("home:2"));
  assert.ok(order("workshop:1") < order("home:2"));
  assert.ok(order("home:2") < order("quarry:1"));
  assert.ok(order("quarry:1") < order("kiln:1"));
  assert.ok(order("workshop:1") < order("kiln:1"));
});

test("the catalog cannot accidentally require the closed quarry to unlock home two", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "home").levels[1].requiredBuildings.quarry = 1;
  assert.throws(() => auditEconomyProgression(catalog), /Construction dependency cycle/);
});

test("starter exploration stone is required to reach home two without market purchases", () => {
  const catalog = readEconomyCatalog();
  for (const route of catalog.explorations.filter(route => route.requiredHomeLevel === 1)) delete route.rewards.stone;
  assert.throws(() => auditEconomyProgression(catalog), /Resources cannot be produced|dependency blocks/);
});

test("catalog audit catches a resource-source cycle even when the explicit construction graph is acyclic", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "workshop").levels[0].cost.items.reinforced_parts = 1;
  assert.throws(() => auditEconomyProgression(catalog), /Resources cannot be produced|dependency blocks/);
});

test("catalog audit rejects building prerequisites that route back through the target home", () => {
  const catalog = readEconomyCatalog();
  catalog.buildings.find(building => building.id === "workshop").levels[1].requiredHomeLevel = 3;
  assert.throws(() => auditEconomyProgression(catalog), /Construction dependency cycle/);
});

test("catalog audit rejects compression of the long-term construction floor", () => {
  const catalog = readEconomyCatalog();
  for (const building of catalog.buildings) for (const level of building.levels) level.seconds = Math.floor(level.seconds / 10);
  assert.throws(() => auditEconomyProgression(catalog), /four weeks|seven weeks/);
});
