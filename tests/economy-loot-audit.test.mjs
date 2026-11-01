import assert from "node:assert/strict";
import test from "node:test";
import { explorationLootSummary } from "../scripts/lib/exploration-loot.mjs";
import { auditProductionBalance } from "../scripts/lib/economy-balance.mjs";
import { auditTimeEconomy } from "../scripts/audit-time-economy.mjs";
import { readEconomyCatalog } from "../scripts/audit-economy-progression.mjs";

test("audit separates mean range yield from maximum load and one mutually exclusive bonus", () => {
  const route = { id: "ranges", rewards: { wood: 2 }, loot: [{ itemId: "wood", min: 1, max: 3 }, { itemId: "stone", min: 0, max: 2 }],
    finds: { emptyWeight: 1, entries: [{ itemId: "planks", quantity: 2, weight: 1 }, { itemId: "stone", quantity: 4, weight: 1 }] } };
  const before = structuredClone(route);
  assert.deepEqual(explorationLootSummary(route), { expectedRewards: { wood: 4, stone: 1 }, maximumBaseCount: 7, maximumOutputCount: 11 });
  assert.deepEqual(route, before);
  assert.deepEqual(explorationLootSummary({ rewards: { stone: 1 } }), { expectedRewards: { stone: 1 }, maximumBaseCount: 1, maximumOutputCount: 1 });
  assert.throws(() => explorationLootSummary({ ...route, loot: [{ itemId: "wood", min: 2, max: 1 }] }), /invalid ordinary loot range/);
});

test("supply audits value the preserved mean and reject a wider same-mean bag that exceeds storage", () => {
  const catalog = readEconomyCatalog(), report = auditTimeEconomy(catalog);
  const uplands = report.expeditionFinds.find(row => row.routeId === "uplands");
  assert.equal(uplands.expectedBaseNetCoins, 330);
  assert.equal(uplands.expectedBonusCoins, 47.5);
  assert(uplands.guaranteedNetCoins < 0, "the minimum bag cannot stand in for the route mean");
  assert.doesNotThrow(() => auditProductionBalance(catalog));
  const ruins = catalog.explorations.find(route => route.id === "ancient_ruins");
  const mean = explorationLootSummary(ruins).expectedRewards;
  ruins.rewards.hardwood = 1;
  ruins.loot.find(entry => entry.itemId === "hardwood").max = 18;
  assert.deepEqual(explorationLootSummary(ruins).expectedRewards, mean);
  assert.throws(() => auditTimeEconomy(catalog), /full trip and one possible relic|maximum find and relic/);
});
