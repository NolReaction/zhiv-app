import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { applyEconomyCommand } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
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
const quarryRoutes = economyCatalog.explorations.filter(route => route.id.startsWith("quarry_"));
const miningRoutes = economyCatalog.explorations.filter(route => route.activity === "mining");
function legacyMine(p, routeId = "quarry_stone") {
  const route = quarryRoutes.find(route => route.id === routeId);
  const job = { id: crypto.randomUUID(), kind: "production", targetId: "quarry", recipeId: routeId, targetLevel: null,
    startedAt: new Date(now).toISOString(), finishesAt: new Date(now + route.seconds * 1000).toISOString(),
    rewards: { ...route.rewards }, cost: { ...route.cost }, catalogVersion: 3 };
  p.row.state.jobs.push(job);
  return job;
}

test("every mining route rejects an unbuilt quarry before IDs randomness costs or revisions change", () => {
  const p = player();
  p.row.state.buildings.quarry = 0;
  p.row.state.rareDropState = { version: 1, remainingSeconds: 1800, itemId: "moon_crystal" };
  for (const route of miningRoutes) for (const action of ["start_exploration", "start_fishing"]) {
    const request = command(p, action, route.id), before = structuredClone(p.row.state);
    const state = structuredClone(before);
    assert.throws(() => applyEconomyCommand(state, request, now,
      () => assert.fail("locked mining generated a job ID"), {}, () => assert.fail("locked mining rolled a reward")),
    { code: "ECONOMY_BUILDING_REQUIRED" }, route.id);
    assert.deepEqual(state, before, route.id);
    assert.throws(() => economy.commandDevEconomy(p.token, request, now), { code: "ECONOMY_BUILDING_REQUIRED" }, route.id);
    assert.deepEqual(p.row.state, before, "rejected mining cannot change saved balances, jobs, clocks or revision");
  }
});

test("cave routes open with the first completed quarry at their existing home levels", () => {
  for (const id of ["cave", "deep_cave"]) {
    const p = player(), route = miningRoutes.find(route => route.id === id);
    p.row.state.buildings.home = route.requiredHomeLevel;
    p.row.state.buildings.quarry = 1;
    const before = structuredClone(p.row.state);
    const started = issue(p, "start_exploration", id).state, job = started.jobs[0];
    assert.equal(job.targetId, id);
    assert.equal(Date.parse(job.finishesAt) - now, route.seconds * 1000);
    assert.deepEqual(job.cost, route.cost);
    for (const [item, amount] of Object.entries(route.rewards)) assert.equal(job.rewards[item], amount);
    for (const [item, amount] of Object.entries(route.cost.items)) assert.equal(started.inventory[item] ?? 0, before.inventory[item] - amount);
    assert.equal(started.buildings.quarry, 1);
  }
});

test("cave trips and quarry construction exclude one another through the unclaimed deadline", () => {
  const upgrade = economyCatalog.buildings.find(building => building.id === "quarry").levels.find(level => level.level === 2);
  for (const id of ["cave", "deep_cave"]) {
    const p = player(), route = miningRoutes.find(route => route.id === id);
    p.row.state.buildings.quarry = 1;
    p.row.state.inventory = { ...p.row.state.inventory, ...upgrade.cost.items };
    const trip = issue(p, "start_exploration", id).state.jobs[0];
    for (const at of [now, Date.parse(trip.finishesAt)]) {
      read(p, at);
      const before = structuredClone(p.row.state);
      assert.throws(() => issue(p, "start_construction", "quarry", at), { code: "ECONOMY_BUILDING_BUSY" });
      assert.deepEqual(p.row.state, before);
    }
    const tripFinish = Date.parse(trip.finishesAt);
    issue(p, "cancel_exploration", trip.id, tripFinish);
    const construction = issue(p, "start_construction", "quarry", tripFinish).state.jobs[0];
    for (const at of [tripFinish, Date.parse(construction.finishesAt)]) {
      read(p, at);
      const before = structuredClone(p.row.state);
      assert.throws(() => issue(p, "start_exploration", id, at), { code: "ECONOMY_BUILDING_BUSY" });
      assert.deepEqual(p.row.state, before);
    }
    const constructionFinish = Date.parse(construction.finishesAt);
    issue(p, "claim_job", construction.id, constructionFinish);
    assert.equal(issue(p, "start_exploration", route.id, constructionFinish).state.jobs[0].targetId, route.id);
  }
});

test("paid cave snapshots without a quarry remain claimable or cancellable without new unlocks or refunds", () => {
  for (const id of ["cave", "deep_cave"]) for (const cancel of [false, true]) {
    const p = player(), route = miningRoutes.find(route => route.id === id);
    const job = { id: crypto.randomUUID(), kind: "exploration", targetId: id, targetLevel: null,
      startedAt: new Date(now).toISOString(), finishesAt: new Date(now + route.seconds * 1000).toISOString(),
      rewards: { stone: 13, ore: 9 }, cost: { coins: 250, items: { dried_berries: 2, smoked_fish: 2 } }, catalogVersion: 1 };
    p.row.state.buildings.quarry = 0;
    p.row.state.inventory = {};
    p.row.state.jobs = [job];
    const before = read(p), at = Date.parse(job.finishesAt);
    const result = issue(p, cancel ? "cancel_exploration" : "claim_job", job.id, at).state;
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.wallet, before.wallet, "historic coin costs are never recomputed or refunded");
    assert.deepEqual(result.inventory, cancel ? {} : job.rewards);
    assert.equal(result.buildings.quarry, 0);
    assert.equal(result.completedExplorations, cancel ? 0 : 1);
    assert.equal(result.progression.routes[id] ?? 0, cancel ? 0 : 1);
    assert.equal(result.progression.collections.quarrySeconds, cancel ? 0 : route.seconds);
    assert.throws(() => issue(p, "claim_job", job.id, at), { code: "ECONOMY_JOB_GONE" });
    assert.throws(() => issue(p, "start_exploration", id, at), { code: "ECONOMY_BUILDING_REQUIRED" });
  }
});

test("every quarry order excludes every route and equipped fishing before costs, IDs or randomness change", () => {
  const p = player(), mine = legacyMine(p);
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
  for (const at of [now, Date.parse(trip.finishesAt)]) for (const recipe of quarryRoutes) {
    const before = structuredClone(traveller.row.state);
    assert.throws(() => issue(traveller, "start_exploration", recipe.id, at), { code: "ECONOMY_EXPLORER_BUSY" });
    assert.deepEqual(traveller.row.state, before);
  }
});

test("harvesting waits for the quarry deadline and retains the hero until delivery while passive jobs continue", () => {
  const p = player(), berries = issue(p, "start_production", "grow_berries").state.jobs[0];
  const mine = legacyMine(p, "quarry_stone_overnight");
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
  for (const recipe of quarryRoutes)
    assert.throws(() => issue(p, "start_exploration", recipe.id, deliveredAt), { code: "ECONOMY_COLLECTOR_BUSY" });
  assert.throws(() => issue(p, "start_exploration", "forest", deliveredAt), { code: "ECONOMY_COLLECTOR_BUSY" });
  issue(p, "claim_job", berries.id, deliveredAt);
  assert.ok(issue(p, "start_exploration", "quarry_stone", deliveredAt).state.jobs.some(job => job.targetId === "quarry_stone"));
});

test("quarry claims retain the slot on warehouse failure and release it only after successful delivery", () => {
  const p = player(), mine = legacyMine(p), finish = Date.parse(mine.finishesAt);
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
    const mine = command(p, "start_exploration", "quarry_stone"), cave = command(p, "start_exploration", "cave");
    const [winner, loser] = miningFirst ? [mine, cave] : [cave, mine];
    const accepted = economy.commandDevEconomy(p.token, winner, now);
    assert.throws(() => economy.commandDevEconomy(p.token, loser, now), { code: "ECONOMY_REVISION_CONFLICT" });
    assert.throws(() => issue(p, loser.action, loser.targetId), { code: "ECONOMY_EXPLORER_BUSY" });
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
    const mine = legacyMine(p);
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
    assert.throws(() => issue(p, "start_exploration", "quarry_stone"), { code: "ECONOMY_EXPLORER_BUSY" });
    assert.deepEqual(p.row.state, before);
    assert.equal(issue(p, "start_production", "grow_berries").state.jobs[0].targetId, "garden");
  }
});


test("retired quarry production is rejected before IDs, randomness or spending; focused trips retain the raw throughput", () => {
  const p = player();
  assert.equal(economyCatalog.recipes.some(recipe => recipe.buildingId === "quarry"), false);
  for (const route of quarryRoutes) {
    const state = structuredClone(p.row.state), before = structuredClone(state);
    assert.throws(() => applyEconomyCommand(state, command(p, "start_production", route.id), now,
      () => assert.fail("retired production minted an ID"), {}, () => assert.fail("retired production rolled rewards")), { code: "ECONOMY_MINING_ACTIVITY" });
    assert.deepEqual(state, before);
    const started = issue(p, "start_exploration", route.id).state.jobs[0];
    for (const [id, quantity] of Object.entries(route.rewards)) assert.equal(started.rewards[id], quantity);
    assert.equal(Date.parse(started.finishesAt) - now, route.seconds * 1000);
    issue(p, "cancel_exploration", started.id);
  }
});

test("mining claims advance the mineral book and relic clock without minting crafting or travel completions", () => {
  const p = player(); p.row.state.inventory = {};
  p.row.state.rareDropState = { version: 1, remainingSeconds: 1800, itemId: "moon_crystal" };
  const mining = issue(p, "start_exploration", "quarry_stone").state.jobs[0];
  assert.equal(mining.rewards.moon_crystal, 1);
  assert.equal(p.row.state.rareDropState.remainingSeconds, 1800);
  const result = issue(p, "claim_job", mining.id, Date.parse(mining.finishesAt)).state;
  assert.equal(result.inventory.moon_crystal, 1);
  assert.equal(result.completedExplorations, 0);
  assert.equal(result.progression.collections.quarrySeconds, 1800);
  assert.equal(result.progression.collections.travelSeconds, 0);
  assert.equal(result.progression.routes.quarry_stone, 1);
  assert.deepEqual(result.progression.recipes, {});
  assert.ok(p.row.state.rareDropState.remainingSeconds > 0);
});

test("focused mining keeps home and site gates and cannot overlap its upgrade", () => {
  const p = player(); p.row.state.buildings.home = 1;
  assert.throws(() => issue(p, "start_exploration", "quarry_stone"), { code: "ECONOMY_HOME_REQUIRED" });
  p.row.state.buildings.home = 2; p.row.state.buildings.quarry = 1;
  assert.throws(() => issue(p, "start_exploration", "quarry_clay"), { code: "ECONOMY_BUILDING_REQUIRED" });
  p.row.state.buildings.quarry = 2;
  const mining = issue(p, "start_exploration", "quarry_clay").state.jobs[0];
  p.row.state.buildings.home = 5;
  assert.throws(() => issue(p, "start_construction", "quarry"), { code: "ECONOMY_BUILDING_BUSY" });
  issue(p, "cancel_exploration", mining.id);
  const upgrade = economyCatalog.buildings.find(b => b.id === "quarry").levels.find(level => level.level === 3);
  p.row.state.inventory = { ...upgrade.cost.items };
  issue(p, "start_construction", "quarry");
  assert.throws(() => issue(p, "start_exploration", "quarry_clay"), { code: "ECONOMY_BUILDING_BUSY" });
  assert.throws(() => issue(p, "start_exploration", "cave"), { code: "ECONOMY_BUILDING_BUSY" });
});
