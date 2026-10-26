import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { auditConstructionEconomy } from "../scripts/lib/construction-economy.mjs";
import { repriceTimeEconomy } from "../scripts/reprice-time-economy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, logLevel: "silent",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
after(() => vite.close());
const now = Date.parse("2026-10-26T12:00:00Z");
const command = (action, targetId) => ({ action, targetId, requestId: crypto.randomUUID(), ownerPublicId: "0000-0000-0001", expectedRevision: 0, quantity: 1, totalPrice: 0 });
const apply = (state, action, targetId, time = now) => rules.applyEconomyCommand(state, command(action, targetId), time, () => crypto.randomUUID());

test("permanent investment grows mostly after the affordable tutorial without bigger material or storage gates", () => {
  const audit = auditConstructionEconomy(catalog);
  assert(audit.coins >= 400_000 && audit.coins <= 700_000, "whole-settlement investment must be meaningful but bounded");
  const starter = ["woodlot", "dryer", "workshop"].reduce((sum, id) => sum + catalog.buildings.find(row => row.id === id).levels[0].cost.coins, 0);
  const homeTwo = catalog.buildings.find(row => row.id === "home").levels[1].cost.coins;
  assert.equal(starter + homeTwo, 400, "the first working settlement retains the funded tutorial cost");
  const late = catalog.buildings.reduce((sum, building) => sum + building.levels.filter(level =>
    building.id === "warehouse" ? level.level >= 4 : level.level === 5).reduce((cost, level) => cost + level.cost.coins, 0), 0);
  assert(late > audit.coins * 0.7, "the main investment belongs to optional storage and final upgrades");
  for (const building of catalog.buildings) for (const level of building.levels) {
    assert(Object.values(level.cost.items).reduce((sum, count) => sum + count, 0) <= 50);
    if (building.id !== "warehouse") assert.equal(level.requiredBuildings?.warehouse, undefined);
  }
});

test("repricing goods preserves authored v15 construction fees and rejects broken price progressions", () => {
  const changed = structuredClone(catalog), level = changed.buildings.find(row => row.id === "workshop").levels[3];
  level.cost.coins += 100;
  assert.deepEqual(repriceTimeEconomy(changed).buildings, changed.buildings);
  const invalid = structuredClone(catalog);
  invalid.buildings.find(row => row.id === "workshop").levels[3].cost.coins = 1;
  assert.throws(() => repriceTimeEconomy(invalid), /later construction must not cost less|permanent construction price/);
});

test("a newly started late upgrade pays its full new price atomically", () => {
  const target = catalog.buildings.find(row => row.id === "workshop").levels[3];
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = Object.fromEntries(catalog.buildings.map(row => [row.id, row.levels.at(-1).level]));
  state.buildings.workshop = 3;
  state.inventory = { ...target.cost.items };
  state.wallet.coins = 2400;
  const before = structuredClone(state);
  assert.throws(() => apply(state, "start_construction", "workshop"), { code: "ECONOMY_RESOURCES" });
  assert.deepEqual(state, before, "a price shortfall cannot consume materials or occupy the builder");
  state.wallet.coins = target.cost.coins;
  apply(state, "start_construction", "workshop");
  assert.equal(state.wallet.coins, 0);
  assert.equal(state.buildings.workshop, 3);
  assert.equal(state.jobs[0].cost.coins, target.cost.coins);
  assert.deepEqual(state.inventory, {});
});

test("an already paid v14 construction finishes with an empty wallet and keeps its saved price", () => {
  const target = catalog.buildings.find(row => row.id === "workshop").levels[3];
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = Object.fromEntries(catalog.buildings.map(row => [row.id, row.levels.at(-1).level]));
  state.buildings.workshop = 3; state.inventory = { ...target.cost.items }; state.wallet.coins = target.cost.coins;
  apply(state, "start_construction", "workshop");
  const job = state.jobs[0];
  // Saved-job fixture: the previous catalogue already debited this old fee.
  job.catalogVersion = 14; job.cost.coins = 2400;
  const savedCost = structuredClone(job.cost);
  apply(state, "claim_job", job.id, Date.parse(job.finishesAt));
  assert.equal(state.wallet.coins, 0);
  assert.equal(state.buildings.workshop, 4);
  assert.equal(state.jobs.length, 0);
  assert.equal(savedCost.coins, 2400);
});
