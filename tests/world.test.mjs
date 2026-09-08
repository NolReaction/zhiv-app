import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev-api-store.ts");
const game = await vite.ssrLoadModule("/lib/dev-game-store.ts");
const world = await vite.ssrLoadModule("/lib/dev-world-store.ts");
const model = await vite.ssrLoadModule("/features/world/model.ts");
const now = Date.parse("2026-09-08T10:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); game.resetDevGameStoreForTests(); world.resetDevWorldStoreForTests(); });
after(() => vite.close());
function player() { return identities.createDevIdentity("Explorer", crypto.randomUUID()); }
function command(p, action, target = "", time = now) {
  const s = world.getDevWorld(p.token, time);
  return { requestId: crypto.randomUUID(), ownerPublicId: s.ownerPublicId, expectedRevision: s.revision, action, target };
}
const issue = (p, action, target = "", time = now) => world.commandDevWorld(p.token, command(p, action, target, time), time);
test("first journey funds a house upgrade, persists a find, and cannot pay twice", () => {
  const p = player(); assert.deepEqual(world.getDevWorld(p.token, now).state.resources, { sparks: 0, wood: 0, stone: 0 });
  assert.throws(() => issue(p, "upgrade_house"), { code: "WORLD_RESOURCES" });
  const start = command(p, "start_journey", "first_path");
  const started = world.commandDevWorld(p.token, start, now);
  assert.ok(model.worldSnapshotSchema.safeParse(started.snapshot).success);
  const trip = started.snapshot.state.journeys[0];
  assert.equal(Date.parse(trip.finishesAt) - now, 60000);
  assert.equal(world.commandDevWorld(p.token, start, now).replayed, true);
  assert.throws(() => world.commandDevWorld(p.token, { ...start, target: "forest_path" }, now), { code: "WORLD_COMMAND_CONFLICT" });
  const claim = command(p, "claim_journey", trip.id);
  assert.throws(() => world.commandDevWorld(p.token, claim, now + 59999), { code: "WORLD_JOURNEY_NOT_READY" });
  const reward = world.commandDevWorld(p.token, claim, now + 60000);
  assert.deepEqual(reward.snapshot.state.resources, { sparks: 12, wood: 8, stone: 4 });
  assert.deepEqual(reward.snapshot.state.collection, ["acorn"]);
  assert.equal(world.commandDevWorld(p.token, claim, now + 60001).replayed, true);
  assert.throws(() => issue(p, "claim_journey", trip.id, now + 60002), { code: "WORLD_JOURNEY_GONE" });
  const upgraded = issue(p, "upgrade_house").snapshot.state;
  assert.equal(upgraded.houseLevel, 2); assert.deepEqual(upgraded.resources, { sparks: 2, wood: 2, stone: 2 });
  assert.throws(() => issue(p, "start_journey", "first_path"), { code: "WORLD_ROUTE_COMPLETED" });
  assert.equal(identities.getDevIdentity(p.token).checkInCount, 0);
});
test("foreign owners and stale revisions cannot spend resources or change equipment", () => {
  const p = player(), stranger = player();
  const equip = command(p, "equip", "amber_scarf");
  assert.throws(() => world.commandDevWorld(stranger.token, equip, now), { code: "WORLD_OWNER_CHANGED" });
  issue(p, "equip", "moss");
  assert.throws(() => world.commandDevWorld(p.token, equip, now), { code: "WORLD_REVISION_CONFLICT" });
  assert.throws(() => issue(p, "equip", "explorer_cap"), { code: "WORLD_ITEM_NOT_OWNED" });
  assert.throws(() => world.getDevWorld(undefined), { code: "UNAUTHORIZED" });
});
test("spark cap uses accepted new game batches, survives replay and resets by UTC", () => {
  const p = player(), owner = p.me.user.publicId;
  const s = game.createDevGameSession(p.token, owner, crypto.randomUUID(), now).value;
  game.submitDevGameBatch(p.token, { sessionId: s.sessionId, sequence: 1, tapCount: 5, runId: crypto.randomUUID() }, now);
  assert.equal(world.getDevWorld(p.token, now).state.resources.sparks, 0);
  for (let i = 0; i < 6; i++) {
    const payload = { sessionId: s.sessionId, sequence: i + 2, tapCount: 60, runId: crypto.randomUUID() };
    const time = now + (i + 1) * 3000;
    const response = game.submitDevGameBatch(p.token, payload, time).value;
    assert.equal(response.acceptedTaps, 60);
    const before = world.getDevWorld(p.token, time).state.resources.sparks;
    assert.equal(game.submitDevGameBatch(p.token, payload, time).value.replayed, true);
    assert.equal(world.getDevWorld(p.token, time).state.resources.sparks, before);
  }
  assert.equal(world.getDevWorld(p.token, now + 30000).dailySparksEarned, 60);
  assert.equal(world.getDevWorld(p.token, now + 30000).state.resources.sparks, 60);
  world.creditDevWorldTaps(owner, "next-day", 5, now + 86400000);
  assert.equal(world.getDevWorld(p.token, now + 86400000).dailySparksEarned, 1);
  assert.equal(world.getDevWorld(p.token, now + 86400000).state.resources.sparks, 61);
});
test("route finds fill the collection without duplicates and unlock a wearable", () => {
  const p = player(); let time = now;
  function travel(route) {
    const trip = issue(p, "start_journey", route, time).snapshot.state.journeys[0];
    time = Date.parse(trip.finishesAt); return issue(p, "claim_journey", trip.id, time).snapshot.state;
  }
  travel("first_path"); issue(p, "upgrade_house", "", time);
  for (let i = 0; i < 3; i++) travel("forest_path");
  travel("brook_path"); const complete = travel("brook_path");
  assert.equal(complete.collection.length, 6); assert.ok(complete.inventory.includes("explorer_cap"));
  assert.equal(travel("brook_path").collection.length, 6);
  issue(p, "equip", "explorer_cap", time); assert.equal(world.getDevWorld(p.token, time).state.equipment.head, "explorer_cap");
  issue(p, "build_workshop", "", time); issue(p, "craft", "berry_scarf", time);
  assert.throws(() => issue(p, "craft", "berry_scarf", time), { code: "WORLD_ITEM_OWNED" });
});
test("recalling a trip grants nothing and inventory commands reject malformed input", () => {
  const p = player(); const trip = issue(p, "start_journey", "first_path").snapshot.state.journeys[0];
  issue(p, "recall_journey", trip.id); assert.equal(world.getDevWorld(p.token, now).state.resources.sparks, 0);
  assert.equal(model.worldCommandSchema.safeParse({ ...command(p, "equip", "moss"), expectedRevision: -1 }).success, false);
  assert.equal(model.worldCommandSchema.safeParse({ ...command(p, "equip", "moss"), resources: { sparks: 9999 } }).success, false);
});

test("local grants use receipts and never enable production grants or competitive earnings", () => {
  const before = process.env.NODE_ENV, enabled = process.env.ENABLE_DEV_API;
  try {
    process.env.NODE_ENV = "development";
    const p = player(), stranger = player();
    assert.equal(world.getDevWorld(p.token, now).devTools, true);
    const grant = command(p, "dev_grant_resources");
    assert.throws(() => world.commandDevWorld(stranger.token, grant, now), { code: "WORLD_OWNER_CHANGED" });
    const result = world.commandDevWorld(p.token, grant, now);
    assert.deepEqual(result.snapshot.state.resources, { sparks: 50, wood: 50, stone: 50 });
    assert.equal(world.commandDevWorld(p.token, grant, now).replayed, true);
    assert.deepEqual(world.getDevWorld(p.token, now).state.resources, result.snapshot.state.resources);
    assert.throws(() => world.commandDevWorld(p.token, { ...grant, requestId: crypto.randomUUID() }, now), { code: "WORLD_REVISION_CONFLICT" });
    assert.equal(issue(p, "dev_grant_resources").snapshot.state.resources.sparks, 100);
    assert.equal(world.getDevWorld(p.token, now).dailySparksEarned, 0);
    assert.throws(() => issue(p, "dev_grant_resources", "9999"), { code: "DEV_TOOLS_DISABLED" });
    process.env.NODE_ENV = "production"; process.env.ENABLE_DEV_API = "true";
    assert.equal(world.getDevWorld(p.token, now).devTools, false);
    assert.throws(() => world.commandDevWorld(p.token, grant, now), { code: "DEV_TOOLS_DISABLED" });
    assert.throws(() => issue(p, "dev_grant_resources"), { code: "DEV_TOOLS_DISABLED" });
  } finally {
    if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before;
    if (enabled === undefined) delete process.env.ENABLE_DEV_API; else process.env.ENABLE_DEV_API = enabled;
  }
});

test("local world supports all five house levels and preserves state when the maximum is reached", () => {
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const p = player();
    for (let i = 0; i < 5; i++) issue(p, "dev_grant_resources");
    for (let level = 2; level <= 5; level++) {
      const result = issue(p, "upgrade_house");
      assert.equal(result.snapshot.state.houseLevel, level);
      assert.equal(model.worldSnapshotSchema.safeParse(result.snapshot).success, true);
    }
    const finalState = world.getDevWorld(p.token, now);
    assert.throws(() => issue(p, "upgrade_house"), { code: "WORLD_MAX_LEVEL" });
    assert.deepEqual(world.getDevWorld(p.token, now), finalState);
  } finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
});
