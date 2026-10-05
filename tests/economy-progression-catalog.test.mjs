import assert from "node:assert/strict";
import test from "node:test";
import { auditEconomyProgression, readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";

test("economy catalog has useful chains, reachable upgrades, sufficient storage and a market-proof pacing floor", () => {
  const report = auditEconomyProgression(readEconomyCatalog());
  assert.equal(report.itemCount, 42);
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


test("fishing shop cannot introduce buy-sell arbitrage or reverse tackle progression", () => {
  const catalog = readEconomyCatalog();
  catalog.fishing.fish.find(fish => fish.itemId === "fish_mooncarp").buyPrice = 1;
  assert.throws(() => auditEconomyProgression(catalog), /arbitrage/);
  const invalid = readEconomyCatalog();
  invalid.fishing.fish[0].affinity = 100;
  assert.throws(() => auditEconomyProgression(invalid), /Stronger tackle/);
});


test("local-sale audit protects processing margins and rejects a zero recovery payout", () => {
  const lowSmokedPrice = readEconomyCatalog();
  lowSmokedPrice.items.find(item => item.id === "smoked_fish").baseSellPrice = 240;
  assert.throws(() => auditEconomyProgression(lowSmokedPrice), /actual sale proceeds/);
  const unavailableRecovery = readEconomyCatalog();
  unavailableRecovery.localBuyer.payoutBps = 0;
  assert.throws(() => auditEconomyProgression(unavailableRecovery), /Invalid local buyer payout/);
});

test("bulk limits, overnight yield and ingredient conservation cannot silently regress", () => {
  for (const [id, mutate, pattern] of [
    ["grow_berries", r => r.maxBatch = 10, /cannot be bulk queued/],
    ["grow_berries_overnight", r => r.rewards.berries = 160, /unattended output|quarter of storage/],
    ["quarry_stone_overnight", r => r.rewards.stone = 110, /unattended output|quarter of storage/],
    ["workshop_overnight", r => r.cost.items.wood = 1, /bulk order invents wood/],
  ]) {
    const catalog = readEconomyCatalog(); mutate(catalog.recipes.find(r => r.id === id));
    assert.throws(() => auditEconomyProgression(catalog), pattern, id);
  }
});

test("rare source audit rejects ordinary prices NPC stock deterministic recipes and early upgrade gates", () => {
  for (const mutate of [
    c => c.items.find(item => item.id === "living_resin").baseSellPrice = 1,
    c => c.items.find(item => item.id === "living_resin").tradable = true,
    c => c.fishing.baits.push({ itemId: "living_resin", price: 20, rareBonus: 0 }),
    c => c.recipes[0].rewards.living_resin = 1,
    c => c.buildings.find(building => building.id === "home").levels[1].cost.items.living_resin = 1,
    c => c.explorations[0].seconds = c.rareDrops.minSeconds,
  ]) {
    const catalog = readEconomyCatalog(); mutate(catalog);
    assert.throws(() => auditEconomyProgression(catalog), /Special|Early homes|One trip/);
  }
});
