import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { PLESK, pleskResidentFrame } = await vite.ssrLoadModule("/features/world/plesk-resident.ts");
const { createWorldNavigation, isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { isForestWater } = await vite.ssrLoadModule("/features/world/forest-water.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const rectangle = (id, x, y, width, height) => ({ id, points: [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
] });
const destination = (id, x, y) => ({ id, position: { x, y }, pauseSeconds: 4 });
const scene = () => ({ schemaVersion: 1, id: "plesk-test", width: 500, height: 200,
  terrain: [], focus: { x: 0, y: 0, width: 500, height: 200 }, actor: { spawn: { x: 40, y: 100 }, size: 50 },
  sites: [], paths: [], destinations: [destination("home", 40, 100), destination("fishing", 320, 100)],
  water: { surfaces: [rectangle("river", 360, 0, 140, 200)], exclusions: [] },
  navigation: { version: 1, cellSize: 5, interests: [], areas: [rectangle("shore", 0, 0, 360, 180)],
    obstacles: [rectangle("trunk", 170, 20, 20, 110)] },
});
function sample(world, duration = 1000, step = .25) {
  return Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => pleskResidentFrame(world, i * step, false));
}

test("Плёск prepares, casts, waits for a bite and reels before showing a catch and visiting home", () => {
  const world = scene(), frames = sample(world), first = action => frames.findIndex(frame => frame.action === action);
  for (const action of ["pack", "cast", "fish", "bite", "reel", "catch", "rest", "greet", "walk", "trade", "idle"]) {
    assert.ok(first(action) >= 0, `${action} is visible`);
  }
  for (const [before, after] of [["pack", "cast"], ["cast", "fish"], ["fish", "bite"], ["bite", "reel"],
    ["reel", "catch"], ["catch", "walk"], ["walk", "trade"]]) assert.ok(first(before) < first(after));
  assert.ok(frames.filter(frame => frame.destinationId === "fishing" && frame.action !== "walk").length > frames.length / 2,
    "his primary occupation remains at the shore");
  assert.ok(frames.some(frame => frame.action === "walk" && frame.carryingFish && frame.destinationId === "home"));
  assert.ok(frames.some(frame => frame.action === "walk" && !frame.carryingFish && frame.destinationId === "fishing"));
  assert.ok(frames.filter(frame => frame.action === "trade").every(frame => frame.carryingFish));
});

test("round trips respect obstacles, waiting positions and maximum speed, including the complete cycle wrap", () => {
  const world = scene(), nav = createWorldNavigation(world), frames = sample(world, 1200, .1);
  const atHome = frames.find(frame => frame.action === "trade");
  assert.equal(canTraverse(nav, world.destinations[0].position, world.destinations[1].position), false);
  let previous, walks = 0, wraps = 0;
  for (const frame of frames) {
    assert.equal(frame.id, "plesk"); assert.equal(frame.size, PLESK.size); assert.ok(isWalkable(nav, frame));
    assert.ok(frame.phase >= 0 && frame.phase <= 1); assert.ok(Number.isInteger(frame.frame) && frame.frame >= 0 && frame.frame < 4);
    if (previous) {
      assert.ok(Math.hypot(frame.x - previous.x, frame.y - previous.y) <= PLESK.speed * .1 + 1e-7, "no jump at an action or route boundary");
      if (previous.action === "rest" && frame.action === "pack") wraps++;
    }
    if (frame.action === "walk") walks++;
    else assert.deepEqual({ x: frame.x, y: frame.y }, frame.destinationId === "home"
      ? { x: atHome.x, y: atHome.y } : world.destinations.find(point => point.id === frame.destinationId).position);
    previous = frame;
  }
  assert.ok(walks > 0); assert.ok(wraps >= 2);
});

test("generic home visits leave room for the main hero without moving shared or personal markers", () => {
  const world = scene(), nav = createWorldNavigation(world), original = structuredClone(world.destinations);
  const merchant = sample(world).find(frame => frame.action === "trade");
  assert.equal(merchant.destinationId, "home");
  assert.ok(Math.hypot(merchant.x - world.actor.spawn.x, merchant.y - world.actor.spawn.y) >= (PLESK.size + world.actor.size) * .6 - 1e-7);
  assert.ok(canTraverse(nav, world.destinations[0].position, merchant));
  assert.ok(isWalkable(nav, merchant));
  assert.deepEqual(world.destinations, original, "the authored shared home does not change");
  const explicit = { ...world, destinations: [...world.destinations,
    destination("plesk-trade", world.actor.spawn.x, world.actor.spawn.y)] };
  const personal = sample(explicit).find(frame => frame.action === "trade");
  assert.equal(personal.destinationId, "plesk-trade");
  assert.deepEqual({ x: personal.x, y: personal.y }, world.actor.spawn, "personal markers remain exact even at spawn");
  const openHome = { ...world, actor: { ...world.actor, spawn: { x: 40, y: 20 } } };
  const separate = sample(openHome).find(frame => frame.action === "trade");
  assert.deepEqual({ x: separate.x, y: separate.y }, world.destinations[0].position,
    "generic home also stays exact when it already leaves room for the hero");
});

test("a cramped home waiting area falls back to the workshop rather than bypassing obstacles", () => {
  const world = scene();
  world.destinations.push(destination("workshop", 280, 140));
  world.navigation.obstacles = [rectangle("closed-porch", 20, 70, 40, 5), rectangle("closed-porch-left", 15, 70, 5, 60),
    rectangle("closed-porch-right", 60, 70, 5, 60), rectangle("closed-porch-bottom", 20, 125, 40, 5)];
  const frames = sample(world), merchant = frames.find(frame => frame.action === "trade");
  assert.ok(merchant); assert.equal(merchant.destinationId, "workshop");
  assert.deepEqual({ x: merchant.x, y: merchant.y }, { x: 280, y: 140 });
  assert.ok(frames.every(frame => frame.destinationId !== "home"));
});

test("render clocks are deterministic, bounded and do not repeat the cached searches", () => {
  const world = scene(), nav = createWorldNavigation(world), first = pleskResidentFrame(world, 0, false);
  const search = nav.stats.lastSearch;
  for (let t = 0; t < 100_000; t += 37.7) {
    const frame = pleskResidentFrame(world, t, false);
    assert.deepEqual(pleskResidentFrame(world, t, false), frame, "both cameras see the same resident");
  }
  assert.strictEqual(nav.stats.lastSearch, search);
  for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -10]) {
    assert.deepEqual(pleskResidentFrame(world, clock, false), first);
  }
});

test("bobber stays in real water outside exclusions; removed water leaves a resting resident", () => {
  const world = scene(), fish = pleskResidentFrame(world, 7, false);
  assert.equal(fish.action, "fish"); assert.ok(isForestWater(world, fish.waterTarget));
  assert.ok(Math.hypot(fish.waterTarget.x - fish.x, fish.waterTarget.y - fish.y) < PLESK.size * 2.3);
  const tinyHole = rectangle("leaf-under-ripple", fish.waterTarget.x + 1, fish.waterTarget.y + 1, .2, .2);
  const pinhole = { ...world, water: { ...world.water, exclusions: [tinyHole] } };
  assert.equal(isForestWater(pinhole, fish.waterTarget), true, "the float center alone misses this tiny exclusion");
  assert.notDeepEqual(pleskResidentFrame(pinhole, 7, false).waterTarget, fish.waterTarget,
    "a whole ripple footprint cannot contain even a tiny exclusion between sample points");
  const excluded = { ...world, water: { ...world.water, exclusions: world.water.surfaces } };
  for (const dry of [{ ...world, water: undefined }, excluded]) {
    const frames = sample(dry, 200);
    assert.ok(frames.every(frame => ["idle", "pack", "rest", "greet"].includes(frame.action)));
    assert.ok(frames.every(frame => !frame.waterTarget && !frame.carryingFish));
  }
});

test("disconnected trading markers cannot teleport Плёск away from his own shore", () => {
  const world = scene();
  world.navigation.obstacles = [rectangle("closed-cut", 170, 0, 20, 180)];
  const frames = sample(world, 500);
  assert.ok(frames.some(frame => frame.action === "catch"));
  assert.ok(frames.every(frame => frame.destinationId === "fishing" && frame.action !== "walk" && frame.action !== "trade"));
  assert.ok(frames.every(frame => frame.x === 320 && frame.y === 100));
});

test("missing, duplicate or blocked fishing markers fail closed, including a bad personal override", () => {
  const base = scene();
  for (const destinations of [[], [base.destinations[0]], [destination("fishing", 175, 100)],
    [base.destinations[1], destination("fishing", 310, 100)],
    [...base.destinations, destination("plesk-fishing", 175, 100)]]) {
    assert.equal(pleskResidentFrame({ ...base, destinations }, 10, false), null);
  }
  assert.equal(pleskResidentFrame({ ...base, navigation: undefined }, 10, false), null);
  assert.equal(pleskResidentFrame({ ...base, destinations: undefined }, 10, false), null);
});

test("personal destination markers are adopted on a new scene without mutating the shared map", () => {
  const base = scene(), first = pleskResidentFrame(base, 0, true);
  const changed = { ...base, destinations: [...base.destinations,
    destination("plesk-fishing", 310, 140), destination("plesk-trade", 80, 145)] };
  const moved = pleskResidentFrame(changed, 0, true);
  assert.equal(moved.destinationId, "plesk-fishing"); assert.equal(moved.x, 310); assert.equal(moved.y, 140);
  assert.notDeepEqual(moved.waterTarget, first.waterTarget);
  assert.ok(sample(changed).some(frame => frame.action === "trade" && frame.destinationId === "plesk-trade"));
  assert.deepEqual(pleskResidentFrame(base, 0, true), first);
  moved.waterTarget.x = -100; moved.x = -100;
  assert.equal(pleskResidentFrame(changed, 0, true).x, 310, "returned frames do not expose cached positions");
  assert.ok(isForestWater(changed, pleskResidentFrame(changed, 0, true).waterTarget));
});

test("reduced motion stays at a fixed shore pose at every clock value", () => {
  const world = scene(), still = pleskResidentFrame(world, 0, true);
  assert.equal(still.action, "fish"); assert.equal(still.frame, 0);
  for (const time of [1, 30, 100, 10000, Number.POSITIVE_INFINITY]) assert.deepEqual(pleskResidentFrame(world, time, true), still);
  assert.equal(pleskResidentFrame({ ...world, water: undefined }, 200, true).action, "rest");
});

test("the authored island gives Плёск real water and a connected home visit at all building levels", () => {
  for (let level = 0; level <= 5; level++) {
    const world = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: Math.max(1, level), workshop: level, quarry: level });
    const nav = createWorldNavigation(world), frames = sample(world, 800, 2);
    assert.ok(frames.every(Boolean));
    assert.ok(frames.some(frame => frame.action === "trade"), `trade route at level ${level}`);
    assert.ok(frames.some(frame => frame.action === "fish" && isForestWater(world, frame.waterTarget)), `real water at level ${level}`);
    assert.ok(frames.every(frame => isWalkable(nav, frame)), `safe feet at level ${level}`);
    const merchant = frames.find(frame => frame.action === "trade");
    assert.ok(Math.hypot(merchant.x - world.actor.spawn.x, merchant.y - world.actor.spawn.y) >= (PLESK.size + world.actor.size) * .6 - 1e-7,
      `the trader leaves room for the main hero at level ${level}`);
    const bobber = frames.find(frame => frame.waterTarget).waterTarget;
    for (let sample = 0; sample < 64; sample++) {
      const angle = sample * Math.PI / 32;
      assert.ok(isForestWater(world, { x: bobber.x + Math.cos(angle) * PLESK.size * .225,
        y: bobber.y + PLESK.size * .025 + Math.sin(angle) * PLESK.size * .09 }),
      `widest rendered ripple stays on water at level ${level}`);
    }
  }
});
