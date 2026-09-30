import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
const world = await vite.ssrLoadModule("/lib/dev/world-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
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
// Persisted trips remain supported, but new journeys are created by the economy API.
function savedTrip(p, routeId = "first_path", time = now) {
  world.getDevWorld(p.token, time);
  const route = model.worldCatalog.routes.find(item => item.id === routeId);
  const trip = { id: crypto.randomUUID(), routeId, startedAt: new Date(time).toISOString(),
    finishesAt: new Date(time + route.seconds * 1000).toISOString(),
    rewards: { sparks: route.sparks, wood: route.wood, stone: route.stone },
    finds: [...route.finds], introductory: route.once, catalogVersion: 3 };
  const profile = globalThis.__zhivDevWorldStore.get(p.me.user.publicId);
  profile.state.journeys.push(trip); profile.revision++;
  return trip;
}
function seedLegacyWorld(p, patch) {
  world.consumeDevLegacyEconomy(p.token, now);
  Object.assign(globalThis.__zhivDevWorldStore.get(p.me.user.publicId).state, patch);
  return world.getDevWorld(p.token, now);
}
test("decorations keep ownership, persist disabled state and reject unearned or stale changes", context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const p = player();
  assert.throws(() => issue(p, "set_decoration", "hide_flower"), { code: "WORLD_ITEM_NOT_OWNED" });
  for (let day = 0; day < 3; day++) {
    context.mock.timers.setTime(now + day * 86400000);
    assert.equal(identities.createDevCheckIn(p.token, crypto.randomUUID()).kind, "accepted");
  }
  const time = Date.now(), before = world.getDevWorld(p.token, time);
  const hide = command(p, "set_decoration", "hide_flower", time);
  const after = world.commandDevWorld(p.token, hide, time);
  assert.deepEqual(after.snapshot.state.hiddenGifts, ["flower"]);
  assert.deepEqual(after.snapshot.gifts, before.gifts);
  assert.deepEqual(after.snapshot.state.resources, before.state.resources);
  assert.equal(world.commandDevWorld(p.token, hide, time).replayed, true);
  assert.throws(() => world.commandDevWorld(p.token, { ...hide, requestId: crypto.randomUUID(), target: "show_flower" }, time), { code: "WORLD_REVISION_CONFLICT" });
  assert.deepEqual(issue(p, "set_decoration", "show_flower", time).snapshot.state.hiddenGifts, []);
  assert.throws(() => issue(p, "set_decoration", "hide_unknown", time), { code: "WORLD_ITEM" });
});
test("saved journey converts once and the legacy API cannot bypass timed construction", () => {
  const p = player();
  for (const action of ["upgrade_house", "build_workshop", "upgrade_workshop", "craft", "start_journey"])
    assert.throws(() => issue(p, action), { code: "WORLD_ECONOMY_MOVED" });
  const trip = savedTrip(p);
  const claim = command(p, "claim_journey", trip.id);
  assert.throws(() => world.commandDevWorld(p.token, claim, now + 59999), { code: "WORLD_JOURNEY_NOT_READY" });
  const reward = world.commandDevWorld(p.token, claim, now + 60000);
  assert.ok(model.worldSnapshotSchema.safeParse(reward.snapshot).success);
  assert.deepEqual(reward.snapshot.state.resources, { sparks: 0, wood: 0, stone: 0 });
  assert.deepEqual(reward.snapshot.state.collection, ["acorn"]);
  const earned = economy.getDevEconomy(p.token, now + 60000);
  assert.ok(earned.wallet.coins > 0);
  assert.ok(earned.inventory.wood > 0);
  assert.equal(world.commandDevWorld(p.token, claim, now + 60001).replayed, true);
  assert.deepEqual(economy.getDevEconomy(p.token, now + 60001).wallet, earned.wallet);
  assert.throws(() => issue(p, "claim_journey", trip.id, now + 60002), { code: "WORLD_JOURNEY_GONE" });
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
test("accepted game batches preserve tap records without minting retired currencies", () => {
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
  assert.equal(world.getDevWorld(p.token, now + 30000).dailySparksEarned, 0);
  assert.equal(world.getDevWorld(p.token, now + 30000).state.resources.sparks, 0);
  world.creditDevWorldTaps(owner, "next-day", 5, now + 86400000);
  assert.equal(world.getDevWorld(p.token, now + 86400000).dailySparksEarned, 0);
  assert.equal(world.getDevWorld(p.token, now + 86400000).state.resources.sparks, 0);
});
test("both albums unlock their own equipment and all twelve finds award the collection medal", () => {
  const p = player(); let time = now;
  function travel(route) {
    const trip = savedTrip(p, route, time);
    time = Date.parse(trip.finishesAt); return issue(p, "claim_journey", trip.id, time).snapshot.state;
  }
  travel("first_path");
  for (let i = 0; i < 3; i++) travel("forest_path");
  travel("fishing_30"); const complete = travel("fishing_30");
  assert.equal(complete.collection.length, 6); assert.ok(complete.inventory.includes("explorer_cap"));
  assert.equal(complete.inventory.includes("willow_rod"), false, "the original album still awards the cap before all twelve finds");
  for (let i = 0; i < 6; i++) travel("fishing_5");
  const full = world.getDevWorld(p.token, time).state;
  assert.equal(full.collection.length, 12);
  assert.ok(full.inventory.includes("willow_rod"));
  assert.equal(travel("fishing_5").collection.length, 12);
  assert.equal(world.getDevWorld(p.token, time).state.inventory.filter(id => id === "willow_rod").length, 1);
  issue(p, "equip", "willow_rod", time);
  assert.equal(world.getDevWorld(p.token, time).state.equipment.rod, "willow_rod");
  issue(p, "equip", "remove_rod", time);
  assert.equal(world.getDevWorld(p.token, time).state.equipment.rod, null);
  assert.throws(() => issue(p, "craft", "willow_rod", time), { code: "WORLD_ECONOMY_MOVED" });
  const medal = game.getDevGameAchievements(p.token, time).value.achievements.find(item => item.id === "full_collection");
  assert.deepEqual(medal, { id: "full_collection", progress: 12, target: 12, unlockedAt: new Date(time).toISOString() });
  assert.equal(game.getDevGameAchievements(p.token, time + 60_000).value.achievements.find(item => item.id === "full_collection").unlockedAt, medal.unlockedAt);
  issue(p, "equip", "explorer_cap", time); assert.equal(world.getDevWorld(p.token, time).state.equipment.head, "explorer_cap");
  assert.throws(() => issue(p, "craft", "berry_scarf", time), { code: "WORLD_ECONOMY_MOVED" });
});
test("recalling a trip grants nothing and inventory commands reject malformed input", () => {
  const p = player(); const trip = savedTrip(p);
  issue(p, "recall_journey", trip.id); assert.equal(world.getDevWorld(p.token, now).state.resources.sparks, 0);
  assert.equal(model.worldCommandSchema.safeParse({ ...command(p, "equip", "moss"), expectedRevision: -1 }).success, false);
  assert.equal(model.worldCommandSchema.safeParse({ ...command(p, "equip", "moss"), resources: { sparks: 9999 } }).success, false);
});

test("retired local grants are rejected and cannot recreate converted balances", () => {
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "development";
    const p = player(), stranger = player();
    const grant = command(p, "dev_grant_resources");
    assert.throws(() => world.commandDevWorld(stranger.token, grant, now), { code: "WORLD_OWNER_CHANGED" });
    assert.throws(() => world.commandDevWorld(p.token, grant, now), { code: "WORLD_ECONOMY_MOVED" });
    assert.deepEqual(world.getDevWorld(p.token, now).state.resources, { sparks: 0, wood: 0, stone: 0 });
    process.env.NODE_ENV = "production";
    assert.throws(() => world.commandDevWorld(p.token, grant, now), { code: "DEV_TOOLS_DISABLED" });
  } finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
});

test("legacy savings convert once and all five homes plus workshops remain readable", () => {
  for (const level of [1, 2, 3, 4, 5]) {
    const p = player();
    const migrated = seedLegacyWorld(p, { resources: { sparks: 1000000, wood: 100000, stone: 100000 }, houseLevel: level, workshop: true, workshopLevel: 3 });
    assert.equal(migrated.state.houseLevel, level);
    assert.equal(migrated.state.workshopLevel, 3);
    assert.deepEqual(migrated.state.resources, { sparks: 0, wood: 0, stone: 0 });
    const converted = economy.getDevEconomy(p.token, now);
    assert.equal(converted.wallet.coins, 500);
    assert.deepEqual(converted.inventory, { wood: 30, stone: 30 });
    assert.equal(converted.buildings.home, level);
    assert.equal(converted.buildings.workshop, 3);
    world.getDevWorld(p.token, now + 1);
    assert.deepEqual(economy.getDevEconomy(p.token, now + 1).wallet, converted.wallet);
    assert.equal(model.worldStateSchema.parse(migrated.state).houseLevel, level);
  }
  assert.equal(model.workshopLevel({ workshop: true }), 1);
  assert.equal(model.worldStateSchema.safeParse({ ...model.newWorldState(), workshop: true, workshopLevel: 5 }).success, true);
  assert.equal(model.workshopLevel({ workshop: true, workshopLevel: 5 }), 5);
  assert.equal(model.worldStateSchema.safeParse({ ...model.newWorldState(), workshopLevel: 6 }).success, false);
});

test("economy workshop levels four and five round-trip through the world without revision churn", () => {
  const p = player();
  economy.getDevEconomy(p.token, now);
  const profile = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  for (const level of [4, 5]) {
    profile.state.buildings.workshop = level;
    const snapshot = world.getDevWorld(p.token, now);
    assert.equal(model.worldSnapshotSchema.parse(snapshot).state.workshopLevel, level);
    assert.equal(model.workshopLevel(snapshot.state), level);
    assert.equal(world.getDevWorld(p.token, now + 1).revision, snapshot.revision);
  }
});

test("every saved fishing duration needs an explicit idempotent converted claim", () => {
  for (const minutes of [5, 15, 30, 60]) {
    const p = player();
    const start = now + 60_000;
    const before = world.getDevWorld(p.token, start).state.resources;
    const trip = savedTrip(p, `fishing_${minutes}`, start), finish = start + minutes * 60_000;
    assert.equal(Date.parse(trip.finishesAt), finish);
    assert.equal(trip.catalogVersion, 3);
    assert.deepEqual(world.getDevWorld(p.token, start).state.resources, before);
    const claim = command(p, "claim_journey", trip.id, finish - 1);
    assert.throws(() => world.commandDevWorld(p.token, claim, finish - 1), { code: "WORLD_JOURNEY_NOT_READY" });
    assert.deepEqual(world.getDevWorld(p.token, finish).state.resources, before);
    assert.equal(world.getDevWorld(p.token, finish).state.journeys.length, 1);
    const paid = world.commandDevWorld(p.token, claim, finish);
    assert.deepEqual(paid.snapshot.state.resources, before);
    assert.ok(economy.getDevEconomy(p.token, finish).wallet.coins > 0);
    assert.equal(paid.snapshot.state.journeys.length, 0);
    assert.equal(world.commandDevWorld(p.token, claim, finish + 1).replayed, true);
    assert.deepEqual(world.getDevWorld(p.token, finish + 1).state.resources, paid.snapshot.state.resources);
  }
  assert.equal(model.worldCatalog.routes.some(route => route.id === "brook_path"), false);
});


test("forest five and ten minute outings and all fishing durations give equal materials per minute", () => {
  const routes = model.worldCatalog.routes;
  const forest = routes.filter(route => route.id === "forest_path" || route.id === "forest_10");
  const fishing = routes.filter(route => route.id.startsWith("fishing_"));
  assert.deepEqual(forest.map(route => route.seconds), [300, 600]);
  assert.deepEqual(fishing.map(route => route.seconds), [300, 900, 1800, 3600]);
  for (const family of [forest, fishing]) {
    const first = family[0];
    for (const route of family) {
      for (const key of ["sparks", "wood", "stone"]) {
        assert.equal(route[key] * first.seconds, first[key] * route.seconds, `${route.id} must not penalize longer trips`);
      }
      assert.deepEqual(route.finds, first.finds, "every duration keeps access to the same finds");
    }
  }
  assert.ok(forest[0].wood > forest[0].stone);
  assert.ok(fishing[0].stone > fishing[0].wood);
  for (const routeId of ["forest_path", "forest_10"]) {
    const p = player();
    const trip = savedTrip(p, routeId);
    const route = routes.find(value => value.id === routeId);
    assert.equal(Date.parse(trip.finishesAt) - now, route.seconds * 1_000);
    const saved = world.getDevWorld(p.token, now);
    assert.throws(() => issue(p, "claim_journey", trip.id, Date.parse(trip.finishesAt) - 1), { code: "WORLD_JOURNEY_NOT_READY" });
    assert.deepEqual(world.getDevWorld(p.token, now), saved);
    const claimed = issue(p, "claim_journey", trip.id, Date.parse(trip.finishesAt));
    assert.deepEqual(claimed.snapshot.state.resources, { sparks: 0, wood: 0, stone: 0 });
  }
});

test("saved trips recover missing finds without random duplicates", () => {
  const p = player();
  let time = now;
  const schedule = ["first_path", ...Array(3).fill("forest_path"), ...Array(8).fill("fishing_5")];
  for (let index = 0; index < schedule.length; index++) {
    const trip = savedTrip(p, schedule[index], time);
    time = Date.parse(trip.finishesAt);
    const state = issue(p, "claim_journey", trip.id, time).snapshot.state;
    assert.equal(state.collection.length, index + 1, "every planned trip adds exactly one missing find");
  }
  assert.equal(time - now, 56 * 60_000);
  assert.deepEqual(world.getDevWorld(p.token, time).state.collection, model.worldCatalog.finds.map(find => find.id).sort());
});

test("collection groups award independently and unknown or repeated IDs never inflate medal progress", () => {
  const forest = model.worldCatalog.finds.filter(find => find.group === "forest").map(find => find.id);
  const fishing = model.worldCatalog.finds.filter(find => find.group === "fishing").map(find => find.id);
  assert.equal(forest.length, 6); assert.equal(fishing.length, 6);
  assert.deepEqual(model.collectionRewards(forest), ["explorer_cap"]);
  assert.deepEqual(model.collectionRewards(fishing), ["willow_rod"]);
  assert.deepEqual(model.collectionRewards([...forest.slice(1), ...fishing.slice(1), ...Array(10).fill("unknown")]), []);
  assert.equal(model.collectionCount([...forest, ...forest, "unknown"]), 6);

  const p = player(), owner = p.me.user.publicId;
  world.getDevWorld(p.token, now);
  const profile = globalThis.__zhivDevWorldStore.get(owner);
  const known = model.worldCatalog.finds.map(find => find.id);
  profile.state.collection = [...known.slice(0, 11), known[0], "unknown"];
  const partial = game.getDevGameAchievements(p.token, now).value.achievements.find(item => item.id === "full_collection");
  assert.deepEqual(partial, { id: "full_collection", progress: 11, target: 12, unlockedAt: null });
  profile.state.collection.push(known[11]);
  const complete = game.getDevGameAchievements(p.token, now + 1).value.achievements.find(item => item.id === "full_collection");
  assert.equal(complete.progress, 12); assert.equal(complete.unlockedAt, new Date(now + 1).toISOString());
});

test("legacy completed introductions can recover a missing acorn on either forest duration", () => {
  for (const routeId of ["forest_path", "forest_10"]) {
    const p = player();
    world.getDevWorld(p.token, now);
    const profile = globalThis.__zhivDevWorldStore.get(p.me.user.publicId);
    profile.state.firstJourneyCompleted = true;
    profile.state.collection = ["feather", "fern_leaf", "winged_seed"];
    const trip = savedTrip(p, routeId);
    const completed = issue(p, "claim_journey", trip.id, Date.parse(trip.finishesAt)).snapshot.state;
    assert.ok(completed.collection.includes("acorn"));
  }
});
