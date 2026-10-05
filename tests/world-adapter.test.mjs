import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economySceneJourney, economySceneActivity } = await vite.ssrLoadModule("/features/economy/world-adapter.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/model.ts");

const trip = (overrides = {}) => ({ id: "saved-fishing", kind: "exploration", targetId: "shore",
  startedAt: "2026-10-04T12:00:00.000Z", finishesAt: "2026-10-04T12:45:00.000Z", rewards: { fish: 3, fish_mooncarp: 1 },
  fishing: { rodId: "river_rod", baitId: "worm_bait", fishId: "fish_mooncarp" }, ...overrides });
const account = (job = trip()) => ({ jobs: [job], catalog: economyCatalog, inventory: { worm_bait: 4 },
  fishing: { ownedRods: ["reed_rod", "river_rod", "willow_rod"], equippedRodId: "willow_rod", equippedBaitId: "crumb_bait", catches: {} } });

test("scene adapters use saved trip tackle and species instead of the subsequently equipped profile gear", () => {
  const state = account();
  const before = structuredClone(state), original = economySceneJourney(state);
  assert.deepEqual(original.fishing, { rodId: "river_rod", fishId: "fish_mooncarp" });
  assert.notEqual(original.fishing, state.jobs[0].fishing, "the renderer receives a detached record");
  assert.equal(original.routeId, "shore"); assert.equal(original.label, economyCatalog.explorations.find(route => route.id === "shore").name);
  assert.deepEqual(economySceneActivity(state), { ...original, kind: "exploration" });
  assert.deepEqual(state, before, "reading an adapter cannot spend bait or change the saved result");
  state.fishing.equippedRodId = "reed_rod"; state.fishing.equippedBaitId = null;
  assert.deepEqual(economySceneJourney(state), original, "changing tackle is for the next trip only");
  original.fishing.rodId = "willow_rod";
  assert.equal(state.jobs[0].fishing.rodId, "river_rod", "a mutable presentation cannot rewrite server-owned equipment");
  assert.deepEqual(original.rewards, state.jobs[0].rewards);
  assert.notStrictEqual(original.rewards, state.jobs[0].rewards, "visual catch quantities are a detached authoritative projection");
  original.rewards.fish = 100;
  assert.equal(state.jobs[0].rewards.fish, 3, "the scene cannot rewrite job rewards");
  assert.equal("inventory" in original, false);
});

test("legacy explorations never borrow new equipment metadata and ready trips stay visible until removed", () => {
  for (const fishing of [undefined, null]) {
    const state = account(trip({ fishing }));
    const journey = economySceneJourney(state);
    assert.equal("fishing" in journey, false);
    assert.equal("fishing" in economySceneActivity(state), false);
    assert.equal(journey.finishesAt, state.jobs[0].finishesAt, "the adapter leaves the completed-job policy to the scene clock");
    state.jobs = [];
    assert.equal(economySceneJourney(state), null); assert.equal(economySceneActivity(state), null);
  }
  assert.equal(economySceneJourney(undefined), null); assert.equal(economySceneJourney(null), null);
});

test("production sorting leaves the account order and fishing collection untouched", () => {
  const first = { id: "later", kind: "production", targetId: "dryer", recipeId: "smoke_fish", rewards: { smoked_fish: 2 },
    startedAt: "2026-10-04T12:00:00.000Z", finishesAt: "2026-10-04T14:00:00.000Z" };
  const state = account();
  state.jobs = [first, { ...first, id: "earlier", finishesAt: "2026-10-04T13:00:00.000Z" }];
  const before = structuredClone(state);
  assert.equal(economySceneJourney(state), null);
  const activity = economySceneActivity(state);
  assert.equal(activity.id, "earlier"); assert.equal(activity.kind, "production");
  assert.equal("fishing" in activity, false);
  assert.deepEqual(state, before);
});
