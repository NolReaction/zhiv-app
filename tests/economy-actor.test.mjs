import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");
const { applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/rules.ts");
const now = Date.UTC(2026, 9, 5, 10);
beforeEach(() => identities.resetDevStoreForTests());
const read = (p, at = now) => economy.getDevEconomy(p.token, at);
const command = (p, action, targetId, at = now) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, at).revision, action, targetId, quantity: 1, totalPrice: 0 });
const issue = (p, action, targetId, at = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, at), at);
function player() {
  const p = identities.createDevIdentity("Шахтёр", crypto.randomUUID()); read(p);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.buildings = Object.fromEntries(economyCatalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  row.state.wallet.coins = 500_000;
  row.state.inventory = { wood: 20, fiber: 20, dried_berries: 20, smoked_fish: 20, tools: 20, rope: 20 };
  return { ...p, row };
}
const quarryRecipes = economyCatalog.recipes.filter(recipe => recipe.buildingId === "quarry");

test("every quarry order excludes every route and equipped fishing before costs, IDs or randomness change", () => {
  const p = player(), mine = issue(p, "start_production", "quarry_stone").state.jobs[0];
  for (const at of [now, Date.parse(mine.finishesAt)]) {
    for (const route of economyCatalog.explorations) {
      const actions = economyCatalog.fishing.routeIds.includes(route.id) ? ["start_exploration", "start_fishing"] : ["start_exploration"];
      for (const action of actions) {
        const state = structuredClone(p.row.state), before = structuredClone(state);
        assert.throws(() => applyEconomyCommand(state, command(p, action, route.id, at), at,
          () => assert.fail("busy start generated a job ID"), {}, () => assert.fail("busy start rolled a reward")), { code: "ECONOMY_QUARRY_BUSY" });
        assert.deepEqual(state, before);
      }
    }
  }
  const traveller = player(), trip = issue(traveller, "start_exploration", "cave").state.jobs[0];
  for (const at of [now, Date.parse(trip.finishesAt)]) for (const recipe of quarryRecipes) {
    const before = structuredClone(traveller.row.state);
    assert.throws(() => issue(traveller, "start_production", recipe.id, at), { code: "ECONOMY_EXPLORER_BUSY" });
    assert.deepEqual(traveller.row.state, before);
  }
});

test("harvesting waits for the quarry deadline and retains the hero until delivery while passive jobs continue", () => {
  const p = player(), berries = issue(p, "start_production", "grow_berries").state.jobs[0];
  const mine = issue(p, "start_production", "quarry_stone_overnight").state.jobs.find(job => job.targetId === "quarry");
  const finish = Date.parse(mine.finishesAt);
  assert.throws(() => issue(p, "start_collection", berries.id, finish - 1), { code: "ECONOMY_QUARRY_BUSY" });
  assert.equal(issue(p, "start_production", "gather_wood").state.jobs.length, 3);
  // A construction slot is independent of the hero; leave one warehouse upgrade available.
  p.row.state.buildings.warehouse = 4;
  const upgrade = economyCatalog.buildings.find(building => building.id === "warehouse").levels.find(level => level.level === 5);
  p.row.state.inventory = { ...p.row.state.inventory, ...upgrade.cost.items };
  issue(p, "start_construction", "warehouse");
  const collecting = issue(p, "start_collection", berries.id, finish).state.jobs.find(job => job.id === berries.id);
  const deliveredAt = Date.parse(collecting.collection.finishesAt);
  issue(p, "claim_job", mine.id, deliveredAt);
  for (const recipe of quarryRecipes)
    assert.throws(() => issue(p, "start_production", recipe.id, deliveredAt), { code: "ECONOMY_COLLECTOR_BUSY" });
  assert.throws(() => issue(p, "start_exploration", "forest", deliveredAt), { code: "ECONOMY_COLLECTOR_BUSY" });
  issue(p, "claim_job", berries.id, deliveredAt);
  assert.ok(issue(p, "start_production", "quarry_stone", deliveredAt).state.jobs.some(job => job.targetId === "quarry"));
});

test("quarry claims retain the slot on warehouse failure and release it only after successful delivery", () => {
  const p = player(), mine = issue(p, "start_production", "quarry_stone").state.jobs[0], finish = Date.parse(mine.finishesAt);
  p.row.state.inventory = { wood: read(p, finish).storage.capacity };
  const before = structuredClone(p.row.state);
  assert.throws(() => issue(p, "claim_job", mine.id, finish), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(p.row.state, before);
  assert.throws(() => issue(p, "start_exploration", "forest", finish), { code: "ECONOMY_QUARRY_BUSY" });
  p.row.state.inventory = {};
  const claim = command(p, "claim_job", mine.id, finish);
  const accepted = economy.commandDevEconomy(p.token, claim, finish);
  assert.deepEqual(accepted.state.inventory, mine.rewards);
  assert.equal(accepted.state.completedExplorations, 0, "mining remains a recipe, not a route completion");
  const trip = issue(p, "start_exploration", "forest", finish).state.jobs[0];
  const replay = economy.commandDevEconomy(p.token, claim, finish);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.jobs, [trip]);
});

test("competing quarry and cave starts accept one request in either order and replays never recreate work", () => {
  for (const miningFirst of [true, false]) {
    const p = player();
    const mine = command(p, "start_production", "quarry_stone"), cave = command(p, "start_exploration", "cave");
    const [winner, loser] = miningFirst ? [mine, cave] : [cave, mine];
    const accepted = economy.commandDevEconomy(p.token, winner, now);
    assert.throws(() => economy.commandDevEconomy(p.token, loser, now), { code: "ECONOMY_REVISION_CONFLICT" });
    assert.throws(() => issue(p, loser.action, loser.targetId), { code: miningFirst ? "ECONOMY_QUARRY_BUSY" : "ECONOMY_EXPLORER_BUSY" });
    assert.equal(economy.commandDevEconomy(p.token, winner, now).replayed, true);
    const job = accepted.state.jobs[0], finish = Date.parse(job.finishesAt);
    issue(p, "claim_job", job.id, finish);
    const replacement = issue(p, loser.action, loser.targetId, finish).state.jobs[0];
    const replay = economy.commandDevEconomy(p.token, winner, finish);
    assert.equal(replay.replayed, true); assert.deepEqual(replay.state.jobs, [replacement]);
  }
});

test("already overlapping saved jobs keep locked rewards and collection progress in either claim order", () => {
  for (const miningFirst of [true, false]) {
    const p = player(), other = player();
    const mine = issue(p, "start_production", "quarry_stone").state.jobs[0];
    const trip = issue(other, "start_exploration", "cave").state.jobs[0];
    const savedMine = { ...mine, recipeId: "retired-quarry-order", rewards: { stone: 13 }, catalogVersion: 1 };
    const savedTrip = { ...trip, rewards: { ore: 9 }, rareDrop: null, catalogVersion: 1 };
    p.row.state.jobs = [savedMine, savedTrip]; p.row.state.inventory = {};
    const finish = Math.max(Date.parse(mine.finishesAt), Date.parse(trip.finishesAt));
    const jobs = miningFirst ? [savedMine, savedTrip] : [savedTrip, savedMine];
    for (const job of jobs) issue(p, "claim_job", job.id, finish);
    const result = read(p, finish);
    assert.deepEqual(result.inventory, { stone: 13, ore: 9 });
    assert.equal(result.completedExplorations, 1);
    assert.equal(result.progression.recipes["retired-quarry-order"], 1);
    assert.equal(result.progression.routes.cave, 1);
    assert.equal(result.progression.collections.quarrySeconds, 5400);
    assert.throws(() => issue(p, "claim_job", savedMine.id, finish), { code: "ECONOMY_JOB_GONE" });
  }
});

test("legacy journeys block quarry without spending while passive production stays available", () => {
  for (const finished of [false, true]) {
    const p = player(), before = structuredClone(p.row.state);
    globalThis.__zhivDevWorldStore.get(p.me.user.publicId).state.journeys = [{ id: crypto.randomUUID(), routeId: "first_path",
      startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + (finished ? -1 : 600_000)).toISOString(),
      rewards: { sparks: 0, wood: 0, stone: 0 }, finds: [], introductory: true, catalogVersion: 3 }];
    assert.throws(() => issue(p, "start_production", "quarry_stone"), { code: "ECONOMY_EXPLORER_BUSY" });
    assert.deepEqual(p.row.state, before);
    assert.equal(issue(p, "start_production", "grow_berries").state.jobs[0].targetId, "garden");
  }
});
