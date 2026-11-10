import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-mining-batches-vite",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { applyEconomyCommand, newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog, economyJobSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { miningBatchLimit, miningBatchProgress } = await vite.ssrLoadModule("/features/economy/domain/mining-batch.ts");
after(() => vite.close());
const now = Date.parse("2026-11-01T10:00:00Z");
function player(home = 2) {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = { ...state.buildings, home, quarry: home, warehouse: 1 };
  state.inventory = {}; state.tutorialOrder.completed = true;
  return state;
}
function act(state, action, targetId, quantity = 1, at = now) {
  return applyEconomyCommand(state, { requestId: crypto.randomUUID(), action, targetId, quantity, totalPrice: 0 }, at,
    () => crypto.randomUUID(), {}, () => 0);
}

test("a quarry batch continues offline and partial collection does not restart its clock", () => {
  const state = player(); act(state, "start_exploration", "quarry_stone", 8);
  const job = state.jobs[0]; economyJobSchema.parse(job);
  assert.equal(Date.parse(job.finishesAt) - now, 1440_000);
  const progress = miningBatchProgress(job, now + 600_000);
  assert.deepEqual({ ...progress, ratio: 0, unitRatio: 0 }, { quantity: 8, claimed: 0, completed: 3, ready: 3, remaining: 5, nextAt: now + 720_000, ratio: 0, unitRatio: 0 });
  assert.ok(Math.abs(progress.ratio - 600 / 1440) < .0001);
  assert.ok(Math.abs(progress.unitRatio - 1 / 3) < .0001);
  act(state, "claim_job", job.id, 1, now + 600_000);
  assert.equal(state.inventory.stone, 3); assert.equal(state.jobs[0].miningBatch.claimed, 3);
  assert.equal(state.jobs[0].finishesAt, job.finishesAt); assert.equal(state.progression.routes.quarry_stone, 3);
  assert.equal(state.progression.collections.quarrySeconds, 540);
  assert.throws(() => act(state, "claim_job", job.id, 1, now + 600_000), { code: "ECONOMY_JOB_NOT_READY" });
  act(state, "claim_job", job.id, 1, now + 1440_000);
  assert.equal(state.inventory.stone, 8); assert.equal(state.jobs.length, 0); assert.equal(state.progression.routes.quarry_stone, 8);
  assert.throws(() => act(state, "claim_job", job.id, 1, now + 1440_000), { code: "ECONOMY_JOB_GONE" });
});

test("capacity permits a prefix of completed units and preserves the rest", () => {
  const state = player(); state.inventory = { wood: 49 };
  act(state, "start_exploration", "quarry_stone", 5);
  const id = state.jobs[0].id;
  act(state, "claim_job", id, 1, now + 540_000);
  assert.equal(state.inventory.stone, 1); assert.equal(state.jobs[0].miningBatch.claimed, 1);
  const saved = structuredClone(state);
  assert.throws(() => act(state, "claim_job", id, 1, now + 540_000), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, saved);
  delete state.inventory.wood;
  act(state, "claim_job", id, 1, now + 540_000);
  assert.equal(state.inventory.stone, 3); assert.equal(state.jobs[0].miningBatch.claimed, 3);
});

test("stopping a queue preserves completed work even when the warehouse is full", () => {
  const state = player(); state.inventory = { wood: 50 };
  act(state, "start_exploration", "quarry_stone", 8);
  const id = state.jobs[0].id;
  act(state, "cancel_exploration", id, 1, now + 600_000);
  assert.equal(state.jobs[0].miningBatch.quantity, 3); assert.equal(state.jobs[0].miningBatch.claimed, 0);
  assert.equal(state.progression.routes.quarry_stone ?? 0, 0);
  assert.throws(() => act(state, "cancel_exploration", id, 1, now + 600_000), { code: "ECONOMY_CANCEL_READY" });
  state.inventory = {};
  act(state, "claim_job", id, 1, now + 600_000);
  assert.equal(state.inventory.stone, 3); assert.equal(state.jobs.length, 0);
});

test("batch limits cannot enable multiple ordinary trips or oversized mining queues", () => {
  const state = player();
  assert.throws(() => act(state, "start_exploration", "forest", 2), { code: "INVALID_ECONOMY_COMMAND" });
  assert.throws(() => act(state, "start_exploration", "quarry_stone", 101), { code: "INVALID_ECONOMY_COMMAND" });
  assert.throws(() => act(state, "start_exploration", "quarry_stone", 9), { code: "INVALID_ECONOMY_COMMAND" });
  assert.equal(state.jobs.length, 0);
});

test("quarry level and one hour of base work independently limit new orders", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(level => miningBatchLimit(level, 180)), [5, 8, 10, 12, 15]);
  assert.deepEqual([300, 600, 900, 1200].map(seconds => miningBatchLimit(5, seconds)), [12, 6, 4, 3]);
  for (const [route, cap] of [["quarry_ore", 6], ["quarry_quartz", 4], ["quarry_limestone", 3]]) {
    const state = player(5);
    assert.throws(() => act(state, "start_exploration", route, cap + 1), { code: "INVALID_ECONOMY_COMMAND" });
    act(state, "start_exploration", route, cap);
    assert.equal(state.jobs[0].miningBatch.quantity, cap);
  }
});

test("saved old hundred-unit queues remain readable and drain without applying the new launch cap", () => {
  const state = player(); act(state, "start_exploration", "quarry_stone", 5);
  const job = state.jobs[0]; job.miningBatch.quantity = 100; job.finishesAt = new Date(now + 18_000_000).toISOString();
  economyJobSchema.parse(job);
  act(state, "claim_job", job.id, 1, now + 18_000_000);
  assert.equal(state.inventory.stone, 50); assert.equal(state.jobs[0].miningBatch.claimed, 50);
  state.inventory = {};
  act(state, "claim_job", job.id, 1, now + 18_000_000);
  assert.equal(state.inventory.stone, 50); assert.equal(state.jobs.length, 0);
  assert.equal(state.progression.routes.quarry_stone, 100);
});

test("a batch earns the same rare-clock work and collections as identical individual jobs", () => {
  const batch = player(5), single = player(5);
  const clock = { version: 1, remainingSeconds: 180, itemId: economyCatalog.rareDrops.itemIds[0] };
  batch.minerRareDropState = { ...clock }; single.minerRareDropState = { ...clock };
  act(batch, "start_exploration", "quarry_stone", 10);
  act(batch, "claim_job", batch.jobs[0].id, 1, now + 1800_000);
  for (let index = 0; index < 10; index++) {
    act(single, "start_exploration", "quarry_stone", 1, now + index * 180_000);
    act(single, "claim_job", single.jobs[0].id, 1, now + (index + 1) * 180_000);
  }
  assert.deepEqual(batch.inventory, single.inventory);
  assert.deepEqual(batch.minerRareDropState, single.minerRareDropState);
  assert.deepEqual(batch.progression.routes, single.progression.routes);
  assert.deepEqual(batch.progression.collections, single.progression.collections);
  assert.equal(batch.progression.player?.xp, single.progression.player?.xp);
});

test("explicit collection takes one ready unit, keeps the original deadline and gives XP only for that unit", () => {
  const state = player(3); act(state, "start_exploration", "quarry_stone", 10);
  const job = structuredClone(state.jobs[0]);
  act(state, "claim_mining_batch", job.id, 1, now + 1800_000);
  assert.equal(state.inventory.stone, 1); assert.equal(state.jobs[0].miningBatch.claimed, 1);
  assert.equal(state.jobs[0].startedAt, job.startedAt); assert.equal(state.jobs[0].finishesAt, job.finishesAt);
  assert.equal(state.progression.routes.quarry_stone, 1); assert.equal(state.progression.player.workSeconds, 180);
  assert.equal(state.progression.player.xp, 44);
  act(state, "claim_mining_batch", job.id, 1, now + 1800_000);
  assert.equal(state.inventory.stone, 2); assert.equal(state.progression.player.xp, 48);
  act(state, "claim_job", job.id, 1, now + 1800_000);
  assert.equal(state.inventory.stone, 10); assert.equal(state.progression.player.xp, 80); assert.equal(state.jobs.length, 0);
});

test("requested collection is bounded by readiness, storage and the saved queue, including stopped work", () => {
  const state = player(); act(state, "start_exploration", "quarry_stone", 8);
  const id = state.jobs[0].id;
  assert.throws(() => act(state, "claim_mining_batch", id, 1, now + 179_000), { code: "ECONOMY_JOB_NOT_READY" });
  act(state, "claim_mining_batch", id, 1, now + 600_000);
  act(state, "cancel_exploration", id, 1, now + 600_000);
  assert.equal(state.jobs[0].miningBatch.quantity, 3); assert.equal(state.jobs[0].miningBatch.claimed, 1);
  state.inventory.wood = 48;
  act(state, "claim_mining_batch", id, 100, now + 600_000);
  assert.equal(state.inventory.stone, 2); assert.equal(state.jobs[0].miningBatch.claimed, 2);
  const saved = structuredClone(state);
  assert.throws(() => act(state, "claim_mining_batch", id, 1, now + 600_000), { code: "ECONOMY_STORAGE_FULL" });
  assert.deepEqual(state, saved);
  delete state.inventory.wood;
  act(state, "claim_mining_batch", id, 100, now + 600_000);
  assert.equal(state.inventory.stone, 3); assert.equal(state.jobs.length, 0);
});

test("a selected claim cannot claim a different job kind or an invalid quantity", () => {
  const state = player(); act(state, "start_exploration", "quarry_stone", 3);
  for (const quantity of [0, -1, 1.5, 101, NaN]) {
    const saved = structuredClone(state);
    assert.throws(() => act(state, "claim_mining_batch", state.jobs[0].id, quantity, now + 600_000), { code: "INVALID_ECONOMY_COMMAND", status: 400 });
    assert.deepEqual(state, saved);
  }
  for (const patch of [{ actorId: "mochlik" }, { miningBatch: null }, { kind: "construction" }]) {
    const other = { ...state, jobs: [{ ...state.jobs[0], ...patch }] }, saved = structuredClone(other);
    assert.throws(() => act(other, "claim_mining_batch", other.jobs[0].id, 1, now + 600_000), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(other, saved);
  }
});

test("one-by-one collection preserves rare finds, rare work, collections and XP compared with collect-all", () => {
  const all = player(5), each = player(5);
  const clock = { version: 1, remainingSeconds: 180, itemId: economyCatalog.rareDrops.itemIds[0] };
  all.minerRareDropState = { ...clock }; each.minerRareDropState = { ...clock };
  act(all, "start_exploration", "quarry_stone", 10); act(each, "start_exploration", "quarry_stone", 10);
  act(all, "claim_job", all.jobs[0].id, 1, now + 1800_000);
  for (let i = 0; i < 10; i++) act(each, "claim_mining_batch", each.jobs[0].id, 1, now + 1800_000);
  assert.deepEqual(each.inventory, all.inventory); assert.deepEqual(each.minerRareDropState, all.minerRareDropState);
  assert.deepEqual(each.progression.routes, all.progression.routes); assert.deepEqual(each.progression.collections, all.progression.collections);
  assert.equal(each.progression.player.xp, all.progression.player.xp);
  assert.equal(each.progression.player.workSeconds, all.progression.player.workSeconds); assert.equal(each.jobs.length, 0);
});

test("DEV partial receipt is owner-bound and replay-safe, with quantity in its signature", async () => {
  const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
  const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
  const { economyCommandSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
  identities.resetDevStoreForTests(); economy.resetDevEconomyStoreForTests();
  const p = identities.createDevIdentity("Шахтёр", crypto.randomUUID());
  economy.getDevEconomy(p.token, now);
  const initial = player(); act(initial, "start_exploration", "quarry_stone", 5);
  globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId).state = initial;
  const before = economy.getDevEconomy(p.token, now + 900_000);
  const request = economyCommandSchema.parse({ requestId: crypto.randomUUID(), ownerPublicId: before.ownerPublicId,
    expectedRevision: before.revision, action: "claim_mining_batch", targetId: before.jobs[0].id, quantity: 1, totalPrice: 0 });
  const done = economy.commandDevEconomy(p.token, request, now + 900_000);
  assert.equal(done.state.inventory.stone, 1); assert.equal(done.state.jobs[0].miningBatch.claimed, 1);
  assert.equal(done.state.progression.player.xp, 44);
  const replay = economy.commandDevEconomy(p.token, request, now + 901_000);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.inventory, done.state.inventory);
  assert.deepEqual(replay.state.progression, done.state.progression);
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, quantity: 2 }, now + 902_000), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => economy.commandDevEconomy(p.token, { ...request, requestId: crypto.randomUUID() }, now + 902_000), { code: "ECONOMY_REVISION_CONFLICT" });
  const other = identities.createDevIdentity("Другой шахтёр", crypto.randomUUID()); economy.getDevEconomy(other.token, now);
  assert.throws(() => economy.commandDevEconomy(other.token, request, now + 902_000), { code: "ECONOMY_OWNER_CHANGED" });
});
