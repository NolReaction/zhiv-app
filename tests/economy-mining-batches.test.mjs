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
