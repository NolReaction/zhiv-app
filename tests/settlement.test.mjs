import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const world = await vite.ssrLoadModule("/lib/dev/world-store.ts");
const model = await vite.ssrLoadModule("/features/world/model.ts");
const settlement = await vite.ssrLoadModule("/features/settlement/model.ts");
const geometry = await vite.ssrLoadModule("/features/settlement/geometry.ts");
const now = Date.parse("2026-09-09T10:00:00Z");
beforeEach(() => { identities.resetDevStoreForTests(); world.resetDevWorldStoreForTests(); });
after(() => vite.close());
const player = () => identities.createDevIdentity("Builder", crypto.randomUUID());
function command(p, action, target = "", time = now) {
  const snapshot = world.getDevWorld(p.token, time);
  return { requestId: crypto.randomUUID(), ownerPublicId: snapshot.ownerPublicId, expectedRevision: snapshot.revision, action, target };
}
const issue = (p, action, target = "", time = now) => world.commandDevWorld(p.token, command(p, action, target, time), time);

test("old saves and Ktor null decode; failed placement cannot initialize or spend starter materials", () => {
  const p = player(), before = world.getDevWorld(p.token, now);
  assert.equal(before.state.settlement, undefined);
  assert.ok(model.worldStateSchema.safeParse({ ...before.state, settlement: null }).success);
  for (const target of ["workshop:0:0", "workshop:7:7", "house:2:2", "workshop:2.5:2", "workshop:22:2", "workshop:2:2:extra"]) {
    assert.throws(() => issue(p, "settlement_build", target), { code: "SETTLEMENT_PLACEMENT" });
  }
  assert.deepEqual(world.getDevWorld(p.token, now), before);
});

test("build charges once and persists independently of check-ins, clicks and the home", () => {
  const p = player(), before = world.getDevWorld(p.token, now).state;
  const request = command(p, "settlement_build", "workshop:2:2");
  const result = world.commandDevWorld(p.token, request, now);
  assert.ok(model.worldSnapshotSchema.safeParse(result.snapshot).success);
  const saved = result.snapshot.state.settlement;
  assert.deepEqual(saved.resources, { wood: 110, stone: 85 });
  assert.deepEqual(saved.buildings, [{ kind: "workshop", level: 1, x: 2, y: 2 }]);
  assert.equal(world.commandDevWorld(p.token, request, now).replayed, true);
  assert.deepEqual(world.getDevWorld(p.token, now).state.settlement, saved);
  assert.throws(() => issue(p, "settlement_build", "workshop:4:4"), { code: "SETTLEMENT_BUILDING" });
  const legacy = { ...result.snapshot.state }; delete legacy.settlement;
  assert.deepEqual(legacy, before);
  world.creditDevWorldTaps(p.me.user.publicId, "settlement-click-isolation", 50, now);
  assert.deepEqual(world.getDevWorld(p.token, now).state.settlement, saved);
  assert.equal(identities.getDevIdentity(p.token).checkInCount, 0);
});

test("footprints cannot intersect; moving is free and preserves a building's independent level", () => {
  const p = player(); issue(p, "settlement_build", "workshop:2:2");
  assert.throws(() => issue(p, "settlement_build", "storehouse:3:3"), { code: "SETTLEMENT_PLACEMENT" });
  issue(p, "settlement_build", "storehouse:4:2");
  const upgraded = issue(p, "settlement_upgrade", "workshop").snapshot.state.settlement;
  assert.deepEqual(upgraded.resources, { wood: 25, stone: 40 });
  assert.deepEqual(upgraded.buildings.map(b => b.level), [2, 1]);
  assert.throws(() => issue(p, "settlement_move", "workshop:3:2"), { code: "SETTLEMENT_PLACEMENT" });
  const moved = issue(p, "settlement_move", "workshop:5:5").snapshot.state.settlement;
  assert.deepEqual(moved.resources, upgraded.resources);
  assert.deepEqual(moved.buildings[0], { kind: "workshop", x: 5, y: 5, level: 2 });
  assert.throws(() => issue(p, "settlement_upgrade", "workshop"), { code: "SETTLEMENT_MAX_LEVEL" });
  assert.throws(() => issue(p, "settlement_upgrade", "storehouse"), { code: "SETTLEMENT_RESOURCES" });
  assert.deepEqual(world.getDevWorld(p.token, now).state.settlement, moved);
});

test("expansion unlocks the outer ring while the fence and existing placements stay fixed", () => {
  const p = player(); issue(p, "settlement_build", "workshop:2:2");
  assert.throws(() => issue(p, "settlement_move", "workshop:1:1"), { code: "SETTLEMENT_PLACEMENT" });
  const expanded = issue(p, "settlement_expand").snapshot.state.settlement;
  assert.equal(expanded.areaLevel, 2);
  assert.deepEqual(expanded.resources, { wood: 50, stone: 50 });
  assert.deepEqual(expanded.buildings[0], { kind: "workshop", x: 2, y: 2, level: 1 });
  issue(p, "settlement_move", "workshop:1:1");
  assert.throws(() => issue(p, "settlement_move", "workshop:0:0"), { code: "SETTLEMENT_PLACEMENT" });
  assert.throws(() => issue(p, "settlement_expand", "free"), { code: "SETTLEMENT_TARGET" });
});

test("server time controls collection, rewards snapshot at departure and receipts prevent double payment", () => {
  const p = player(); issue(p, "settlement_build", "workshop:2:2");
  const start = command(p, "settlement_gather");
  const trip = world.commandDevWorld(p.token, start, now).snapshot.state.settlement.gathering;
  assert.equal(world.commandDevWorld(p.token, start, now).replayed, true);
  assert.equal(Date.parse(trip.finishesAt), now + 60000);
  assert.throws(() => issue(p, "settlement_gather"), { code: "SETTLEMENT_GATHERING" });
  issue(p, "settlement_upgrade", "workshop");
  const claim = command(p, "settlement_claim", trip.id);
  assert.throws(() => world.commandDevWorld(p.token, claim, now + 59999), { code: "SETTLEMENT_NOT_READY" });
  const collected = world.commandDevWorld(p.token, claim, now + 60000);
  assert.deepEqual(collected.snapshot.state.settlement.resources, { wood: 70, stone: 62 });
  assert.equal(world.commandDevWorld(p.token, claim, now + 60001).replayed, true);
  assert.throws(() => issue(p, "settlement_claim", trip.id, now + 60001), { code: "SETTLEMENT_GATHERING_GONE" });
  const improvedTrip = issue(p, "settlement_gather", "", now + 60001).snapshot.state.settlement.gathering;
  assert.deepEqual(improvedTrip.rewards, { wood: 30, stone: 18 });
});

test("storage caps materials and upgrades increase capacity without retroactive grants", () => {
  const apply = (state, action, target = "", time = now) => settlement.applySettlement(state, action, target, crypto.randomUUID(), time).state;
  let state = { ...settlement.newSettlement(), resources: { wood: 195, stone: 197 } };
  state = apply(state, "settlement_gather");
  state = apply(state, "settlement_claim", state.gathering.id, now + 60000);
  assert.deepEqual(state.resources, { wood: 200, stone: 200 });
  assert.throws(() => apply(state, "settlement_gather"), { code: "SETTLEMENT_STORAGE_FULL" });
  state = apply(state, "settlement_build", "storehouse:2:2");
  assert.equal(settlement.storageCapacity(state), 400);
  state = apply(state, "settlement_upgrade", "storehouse");
  assert.equal(settlement.storageCapacity(state), 800);
  assert.deepEqual(state.resources, { wood: 125, stone: 165 });
  state = { ...state, areaLevel: 3 };
  assert.throws(() => apply(state, "settlement_expand"), { code: "SETTLEMENT_MAX_LEVEL" });
});

test("foreign owners, altered replays and stale revisions cannot change a settlement", () => {
  const p = player(), other = player(), request = command(p, "settlement_build", "workshop:2:2");
  assert.throws(() => world.commandDevWorld(other.token, request, now), { code: "WORLD_OWNER_CHANGED" });
  issue(p, "settlement_gather");
  assert.throws(() => world.commandDevWorld(p.token, request, now), { code: "WORLD_REVISION_CONFLICT" });
  const valid = command(p, "settlement_build", "workshop:2:2");
  world.commandDevWorld(p.token, valid, now);
  assert.throws(() => world.commandDevWorld(p.token, { ...valid, target: "storehouse:4:4" }, now), { code: "WORLD_COMMAND_CONFLICT" });
  assert.equal(world.getDevWorld(other.token, now).state.settlement, undefined);
});

test("isometric pointer coordinates round-trip at interior and fence corners", () => {
  for (const [x, y] of [[0, 0], [10, 0], [0, 10], [10, 10], [2.25, 6.75], [5, 5]]) {
    const projected = geometry.project(x, y), restored = geometry.unproject(projected.x, projected.y);
    assert.ok(Math.abs(restored.x - x) < 1e-9);
    assert.ok(Math.abs(restored.y - y) < 1e-9);
  }
});
