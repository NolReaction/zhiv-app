import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { worldNotificationDestination } = await vite.ssrLoadModule("/features/world/notification-destination.ts");
const now = Date.parse("2026-10-12T12:00:00Z");
const job = (id, kind, targetId, offset, recipeId = null) => ({ id, kind, targetId, recipeId, finishesAt: new Date(now + offset).toISOString() });

test("notification navigation selects ready work of its category without changing or claiming state", () => {
  const state = { jobs: [job("future", "production", "garden", 1000), job("build", "construction", "home", -5000),
    job("later", "production", "sawmill", -1000, "planks"), job("first", "production", "workshop", -2000, "rope")] };
  const before = structuredClone(state);
  assert.deepEqual(worldNotificationDestination("production", state, now), { kind: "station", stationId: "workshop", recipeId: "rope" });
  assert.deepEqual(worldNotificationDestination("construction", state, now), { kind: "station", stationId: "home" });
  assert.deepEqual(worldNotificationDestination("activities", state, now), { kind: "activities" });
  assert.deepEqual(state, before);
});

test("stale notification falls back when another device already collected the result", () => {
  const state = { jobs: [job("new", "production", "garden", 1000)] };
  assert.deepEqual(worldNotificationDestination("production", state, now), { kind: "pantry" });
  assert.deepEqual(worldNotificationDestination("construction", state, now), { kind: "builder" });
});

test("explicit mine notifications open quarry even after a claim while mixed activities retain their original destination", () => {
  const miner = { ...job("mine", "exploration", "quarry_shift", -1000), actorId: "miner" };
  const hero = job("hero", "exploration", "forest_gathering", -1000);
  for (const jobs of [[], [miner], [miner, hero], [hero]]) {
    const state = { jobs };
    const before = structuredClone(state);
    assert.deepEqual(worldNotificationDestination("mine", state, now), { kind: "station", stationId: "quarry" });
    assert.deepEqual(worldNotificationDestination("activities", state, now), { kind: "activities" }, "generic notifications never guess an actor from remaining jobs");
    assert.deepEqual(state, before, "notification navigation does not claim or mutate any work");
  }
});

test("production notification ignores ripe berries until Mochlik finishes gathering", () => {
  const berries = job("berries", "production", "garden", -20_000, "grow_berries");
  const workshop = job("workshop", "production", "workshop", -1000, "rope");
  const state = { jobs: [berries, workshop] };
  const destination = { kind: "station", stationId: "workshop", recipeId: "rope" };
  assert.deepEqual(worldNotificationDestination("production", state, now), destination);
  berries.collection = { finishesAt: new Date(now + 1000).toISOString() };
  assert.deepEqual(worldNotificationDestination("production", state, now), destination);
  berries.collection.finishesAt = new Date(now - 500).toISOString();
  assert.deepEqual(worldNotificationDestination("production", state, now), destination, "use gathering completion, not the earlier ripening date");
  state.jobs = [berries];
  assert.deepEqual(worldNotificationDestination("production", state, now), { kind: "station", stationId: "garden", recipeId: "grow_berries" });
});
