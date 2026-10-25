import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const actors = await vite.ssrLoadModule("/features/economy/domain/actor-availability.ts");
const now = Date.parse("2026-10-14T09:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = (p, seconds = 0) => economy.getDevEconomy(p.token, now + seconds * 1000);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
const player = (home = 2) => {
  const p = identities.createDevIdentity("Очереди леса и шахты", crypto.randomUUID()); read(p);
  Object.assign(row(p).state.buildings, { home, garden: 1, woodlot: 1, workshop: 1, quarry: 2, kiln: 1, warehouse: 1 });
  row(p).state.inventory = {}; row(p).state.tutorialOrder = { version: 2, step: 4, completed: true, ingredientsClaimed: true, terms: null };
  return p;
};
const request = (p, action, targetId, seconds = 0) => ({ requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId,
  expectedRevision: read(p, seconds).revision, action, targetId, quantity: 1, totalPrice: 0 });
const send = (p, action, targetId, seconds = 0) => economy.commandDevEconomy(p.token, request(p, action, targetId, seconds), now + seconds * 1000);

test("mining and a fed hero depart simultaneously while only Mochlik consumes his food and speed bonus", () => {
  const p = player(); row(p).state.food.heroMeal = "grilled_fish";
  const mining = send(p, "start_exploration", "quarry_stone").state.jobs[0];
  assert.equal(mining.actorId, "miner"); assert.equal(Date.parse(mining.finishesAt) - now, 180000); assert.equal(mining.meal, undefined);
  assert.equal(read(p).food.heroMeal, "grilled_fish"); assert.equal(actors.economyCommandUsesActor({ action: "start_exploration", targetId: "quarry_stone" }), false);
  const departed = send(p, "start_exploration", "forest").state, hero = departed.jobs.find(job => job.targetId === "forest");
  assert.equal(hero.actorId, "mochlik"); assert.equal(hero.meal.itemId, "grilled_fish"); assert.equal(departed.food.heroMeal, null);
  assert.equal(Date.parse(hero.finishesAt) - now, Math.ceil(1680 / 1.1) * 1000);
  assert.throws(() => send(p, "start_exploration", "quarry_clay", 180), { code: "ECONOMY_MINER_BUSY" });
  send(p, "claim_job", mining.id, 180);
  assert.equal(send(p, "start_exploration", "quarry_clay", 180).state.jobs.length, 2);
});

test("an active collector blocks only hero trips while mining can cancel and restart independently", () => {
  const p = player(), crop = send(p, "start_production", "grow_berries").state.jobs[0];
  const mine = send(p, "start_exploration", "quarry_stone").state.jobs.find(job => job.actorId === "miner");
  send(p, "start_collection", crop.id, 60);
  assert.throws(() => send(p, "start_exploration", "forest", 60), { code: "ECONOMY_COLLECTOR_BUSY" });
  send(p, "cancel_exploration", mine.id, 60);
  const mining = send(p, "start_exploration", "quarry_clay", 60).state.jobs.find(job => job.actorId === "miner");
  assert.ok(mining); assert.throws(() => send(p, "start_exploration", "quarry_stone", 68), { code: "ECONOMY_MINER_BUSY" });
  send(p, "claim_job", crop.id, 68);
  assert.equal(send(p, "start_exploration", "forest", 68).state.jobs.length, 2);
});

test("missing and explicit null legacy owners still reserve Mochlik without stealing the new miner queue", () => {
  for (const actorId of [undefined, null]) {
    const p = player(), state = row(p).state;
    const old = model.economyJobSchema.parse({ id: crypto.randomUUID(), kind: "exploration", targetId: "quarry_stone", recipeId: null,
      targetLevel: null, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 1800000).toISOString(),
      rewards: { stone: 8 }, cost: { coins: 70, items: { wood: 3 } }, catalogVersion: 5, ...(actorId === null ? { actorId } : {}) });
    state.jobs = [old]; assert.equal(actors.jobActorId(old), "mochlik");
    assert.throws(() => send(p, "start_exploration", "forest"), { code: "ECONOMY_EXPLORER_BUSY" });
    const modern = send(p, "start_exploration", "quarry_clay").state.jobs.find(job => job.actorId === "miner"); assert.ok(modern);
    const before = read(p); send(p, "claim_job", old.id, 1800);
    assert.equal(read(p, 1800).inventory.stone, 8); assert.deepEqual(read(p, 1800).wallet, before.wallet);
    assert.deepEqual(read(p, 1800).jobs, [modern]);
  }
});

test("parallel rare-material claims settle independent private clocks in either order without exposing them", () => {
  for (const miningFirst of [true, false]) {
    const p = player(3), state = row(p).state;
    state.rareDropState = { version: 1, remainingSeconds: 1680, itemId: "ancient_core" };
    state.minerRareDropState = { version: 1, remainingSeconds: 180, itemId: "moon_crystal" };
    const mine = send(p, "start_exploration", "quarry_stone").state.jobs[0];
    const hero = send(p, "start_exploration", "forest").state.jobs.find(job => job.actorId === "mochlik");
    assert.equal(mine.rewards.moon_crystal, 1); assert.equal(hero.rewards.ancient_core, 1);
    const before = structuredClone(row(p).state), snapshot = read(p);
    for (const field of ["rareDropState", "minerRareDropState", "fishingCastSeed"]) assert.equal(Object.hasOwn(snapshot, field), false);
    assert.equal(model.economyViewSchema.safeParse(snapshot).success, true);
    const [first, second] = miningFirst ? [mine, hero] : [hero, mine];
    const firstRequest = request(p, "claim_job", first.id, 1800);
    const accepted = economy.commandDevEconomy(p.token, firstRequest, now + 1800000);
    const untouched = miningFirst ? "rareDropState" : "minerRareDropState";
    assert.deepEqual(row(p).state[untouched], before[untouched]);
    const settled = structuredClone(row(p).state[miningFirst ? "minerRareDropState" : "rareDropState"]);
    send(p, "claim_job", second.id, 1800);
    assert.deepEqual(row(p).state[miningFirst ? "minerRareDropState" : "rareDropState"], settled);
    const after = read(p, 1800); assert.equal(after.inventory.ancient_core, 1); assert.equal(after.inventory.moon_crystal, 1);
    const replay = economy.commandDevEconomy(p.token, firstRequest, now + 1800000);
    assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, accepted.acceptedRevision); assert.deepEqual(replay.state, after);
    assert.throws(() => send(p, "claim_job", second.id, 1800), { code: "ECONOMY_JOB_GONE" });
  }
});

test("failed mineral delivery and cancelled work cannot advance or refund either clock and receipts cannot recreate it", () => {
  const p = player(3), state = row(p).state;
  state.rareDropState = { version: 1, remainingSeconds: 1700, itemId: "ancient_core" };
  state.minerRareDropState = { version: 1, remainingSeconds: 180, itemId: "moon_crystal" };
  const mine = send(p, "start_exploration", "quarry_stone").state.jobs[0], clocks = structuredClone({ hero: state.rareDropState, miner: state.minerRareDropState });
  row(p).state.inventory = { wood: 50 }; const before = read(p, 180), rawBefore = structuredClone(row(p).state);
  const claim = request(p, "claim_job", mine.id, 180);
  assert.throws(() => economy.commandDevEconomy(p.token, claim, now + 180000), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(read(p, 180), before); assert.deepEqual(row(p).state, rawBefore); assert.equal(row(p).receipts.has(claim.requestId), false);
  const cancel = request(p, "cancel_exploration", mine.id, 180), canceled = economy.commandDevEconomy(p.token, cancel, now + 180000).state;
  assert.deepEqual(row(p).state.rareDropState, clocks.hero); assert.deepEqual(row(p).state.minerRareDropState, clocks.miner);
  assert.deepEqual(canceled.inventory, { wood: 50 }); assert.equal(canceled.progression.routes.quarry_stone, undefined);
  row(p).state.inventory = {};
  const restarted = send(p, "start_exploration", "quarry_stone", 180).state.jobs[0]; assert.equal(restarted.rewards.moon_crystal, 1);
  const replay = economy.commandDevEconomy(p.token, cancel, now + 180000); assert.equal(replay.replayed, true); assert.deepEqual(replay.state.jobs, [restarted]);
  const paid = send(p, "claim_job", restarted.id, 360).state; assert.equal(paid.inventory.moon_crystal, 1); assert.equal(paid.inventory.stone, 1);
  assert.deepEqual(row(p).state.rareDropState, clocks.hero); assert.notDeepEqual(row(p).state.minerRareDropState, clocks.miner);
});

test("cancelling a supplied miner job returns only its saved inputs once and full storage keeps the refund pending", () => {
  const p = player(3), route = model.economyCatalog.explorations.find(entry => entry.id === "deep_cave");
  Object.assign(row(p).state.buildings, route.requiredBuildings); row(p).state.buildings.home = route.requiredHomeLevel;
  // These provisions were paid before the bulk route was retired. Seed the
  // persisted job, never use a new retired-route start to manufacture a refund.
  const paidJob = () => model.economyJobSchema.parse({ id: crypto.randomUUID(), kind: "exploration", actorId: "miner",
    targetId: route.id, recipeId: null, targetLevel: null, startedAt: new Date(now).toISOString(),
    finishesAt: new Date(now + route.seconds * 1000).toISOString(), rewards: { ...route.rewards },
    cost: structuredClone(route.cost), catalogVersion: 12 });
  row(p).state.inventory = {}; row(p).state.wallet.coins = 730; row(p).state.jobs = [paidJob()];
  const started = read(p), first = started.jobs[0];
  assert.equal(first.actorId, "miner"); assert.deepEqual(started.inventory, {}); assert.deepEqual(first.cost, route.cost);
  const cancel = request(p, "cancel_exploration", first.id), returned = economy.commandDevEconomy(p.token, cancel, now).state;
  assert.deepEqual(returned.inventory, first.cost.items); assert.equal(returned.wallet.coins, started.wallet.coins + first.cost.coins);
  assert.equal(returned.completedExplorations, 0); assert.equal(returned.progression.routes[route.id], undefined);
  const replacement = paidJob();
  row(p).state.jobs = [replacement]; row(p).state.inventory = {};
  const replay = economy.commandDevEconomy(p.token, cancel, now); assert.equal(replay.replayed, true);
  assert.deepEqual(replay.state.inventory, {}); assert.deepEqual(replay.state.jobs, [replacement]);
  row(p).state.inventory = { wood: read(p).storage.capacity };
  const before = read(p), failed = request(p, "cancel_exploration", replacement.id);
  assert.throws(() => economy.commandDevEconomy(p.token, failed, now), { code: "ECONOMY_STORAGE_FULL" }); assert.deepEqual(read(p), before);
  assert.equal(row(p).receipts.has(failed.requestId), false);
  row(p).state.inventory = {};
  const completed = send(p, "cancel_exploration", replacement.id).state;
  assert.deepEqual(completed.inventory, replacement.cost.items); assert.equal(completed.jobs.length, 0);
  assert.throws(() => send(p, "claim_job", replacement.id, (Date.parse(replacement.finishesAt) - now) / 1000), { code: "ECONOMY_JOB_GONE" });
});
