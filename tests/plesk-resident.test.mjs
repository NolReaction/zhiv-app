import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { PLESK, pleskResidentFrame, pleskRoutineDuration } = await vite.ssrLoadModule("/features/world/plesk-resident.ts");
const { createWorldNavigation, isWalkable, canTraverse } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { fishingWaterTarget } = await vite.ssrLoadModule("/features/world/forest-fishing.ts");
const { isForestWater } = await vite.ssrLoadModule("/features/world/forest-water.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const rectangle = (id, x, y, width, height) => ({ id, points: [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
] });
const destination = (id, x, y) => ({ id, position: { x, y }, pauseSeconds: 4 });
const scene = () => ({ schemaVersion: 1, id: "plesk-test", width: 500, height: 200,
  terrain: [], focus: { x: 0, y: 0, width: 500, height: 200 }, actor: { spawn: { x: 40, y: 100 }, size: 50 },
  sites: [], paths: [], destinations: [destination("home", 40, 100), destination("fishing", 240, 150),
    destination("plesk-fishing", 320, 100), destination("plesk-trade", 40, 145), destination("plesk-rest", 290, 145)],
  water: { surfaces: [rectangle("river", 360, 0, 140, 200)], exclusions: [] },
  navigation: { version: 1, cellSize: 5, interests: [], areas: [rectangle("shore", 0, 0, 360, 180)],
    obstacles: [rectangle("trunk", 170, 20, 20, 110)] },
});
function sample(world, duration = pleskRoutineDuration(world), step = .25) {
  return Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => pleskResidentFrame(world, i * step, false));
}

test("Плёск catches fish, takes it to his own trading place, checks tackle and rests by the pier", () => {
  const world = scene(), frames = sample(world), first = action => frames.findIndex(frame => frame.action === action);
  for (const action of ["pack", "cast", "fish", "bite", "reel", "catch", "rest", "greet", "walk", "trade", "idle"]) {
    assert.ok(first(action) >= 0, `${action} is visible`);
  }
  for (const [before, after] of [["pack", "cast"], ["cast", "fish"], ["fish", "bite"], ["bite", "reel"],
    ["reel", "catch"], ["catch", "walk"], ["walk", "trade"]]) assert.ok(first(before) < first(after));
  assert.ok(frames.filter(frame => frame.action === "fish").length > frames.filter(frame => frame.action === "trade").length * 1.5);
  assert.ok(frames.some(frame => frame.action === "walk" && frame.carryingFish && frame.destinationId === "plesk-trade"));
  assert.ok(frames.some(frame => frame.action === "walk" && !frame.carryingFish && frame.destinationId === "plesk-fishing"));
  assert.ok(frames.some(frame => frame.action === "rest" && frame.destinationId === "plesk-rest"));
  assert.ok(frames.some(frame => frame.action === "pack" && frame.destinationId === "plesk-rest"));
  assert.ok(frames.filter(frame => frame.action === "trade").every(frame => frame.carryingFish));
  assert.ok(frames.every(frame => frame.destinationId.startsWith("plesk-")), "the hero's home and fishing place are never NPC stops");
});

test("a first catch enters the basket only after packing while the next catch preserves the stored fish", () => {
  const frames = sample(scene(), 90, .1);
  const firstCatch = frames.findIndex(frame => frame.action === "catch");
  const firstPack = frames.findIndex((frame, index) => index > firstCatch && frame.action === "pack");
  const secondCatch = frames.findIndex((frame, index) => index > firstPack && frame.action === "catch");
  const secondPack = frames.findIndex((frame, index) => index > secondCatch && frame.action === "pack");
  assert.ok(firstCatch >= 0 && firstPack > firstCatch && secondCatch > firstPack && secondPack > secondCatch);
  assert.equal(frames[firstCatch].carryingFish, true);
  assert.equal(frames[firstCatch].basketFilled, false, "the fish in his paws is not duplicated in an empty basket");
  assert.equal(frames[firstPack].basketFilled, false, "lowering the first fish into the basket takes time");
  const packed = frames.slice(firstPack, secondCatch).find(frame => frame.action === "pack" && frame.phase > .7);
  assert.equal(packed.basketFilled, true);
  assert.equal(frames[secondCatch].carryingFish, true);
  assert.equal(frames[secondCatch].basketFilled, true, "the previous catch remains stored while another fish is shown");
  assert.equal(frames[secondPack].basketFilled, true, "packing another fish never erases earlier catches");
});

test("local trips respect obstacles, exact authored stops and maximum speed through every action and cycle boundary", () => {
  const world = scene(), nav = createWorldNavigation(world), duration = pleskRoutineDuration(world), frames = sample(world, duration * 2 + .2, .1);
  assert.equal(canTraverse(nav, world.destinations[2].position, world.destinations[3].position), false);
  let previous, walks = 0;
  for (const frame of frames) {
    assert.equal(frame.id, "plesk"); assert.equal(frame.size, PLESK.size); assert.ok(isWalkable(nav, frame));
    assert.ok(frame.phase >= 0 && frame.phase <= 1);
    assert.ok(Number.isInteger(frame.frame) && frame.frame >= 0 && frame.frame < (frame.action === "walk" ? 8 : 32));
    if (previous) {
      assert.ok(Math.hypot(frame.x - previous.x, frame.y - previous.y) <= PLESK.speed * .1 + 1e-7, "no jump at an action or route boundary");
      assert.ok(canTraverse(nav, previous, frame), "the swept foot remains on safe ground");
    }
    if (frame.action === "walk") walks++;
    else assert.deepEqual({ x: frame.x, y: frame.y }, world.destinations.find(point => point.id === frame.destinationId).position);
    previous = frame;
  }
  assert.ok(walks > 0);
  assert.deepEqual(pleskResidentFrame(world, duration, false), pleskResidentFrame(world, 0, false));
});

test("the personal routine varies wait times and failed bites while keeping both cameras deterministic", () => {
  const world = scene(), frames = sample(world, undefined, .1), waits = [];
  let length = 0;
  for (const frame of frames) {
    if (frame.action === "fish") length++;
    else if (length) { waits.push(length); length = 0; }
  }
  assert.ok(new Set(waits.map(wait => Math.round(wait / 10))).size >= 3, "several distinct fishing waits");
  assert.ok(frames.some((frame, index) => frame.action === "fish" && frames[index - 1]?.action === "bite"), "a nibble can escape without producing fish");
  const nav = createWorldNavigation(world), search = nav.stats.lastSearch;
  for (let t = 0; t < 100_000; t += 37.7) {
    assert.deepEqual(pleskResidentFrame(world, t, false), pleskResidentFrame(world, t, false));
  }
  assert.strictEqual(nav.stats.lastSearch, search, "no repeated path searches while sampling either camera");
  for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -10]) {
    assert.deepEqual(pleskResidentFrame(world, clock, false), pleskResidentFrame(world, 0, false));
  }
});

test("disconnected or missing trade and rest markers keep the NPC safely at his personal fishing spot", () => {
  const world = scene();
  world.navigation.obstacles = [rectangle("closed-cut", 300, 0, 10, 180)];
  const frames = sample(world);
  assert.ok(frames.some(frame => frame.action === "catch"));
  assert.ok(frames.every(frame => frame.destinationId === "plesk-fishing" && frame.action !== "walk" && frame.action !== "trade"));
  assert.ok(frames.every(frame => frame.x === 320 && frame.y === 100));
  const alone = { ...scene(), destinations: [destination("plesk-fishing", 320, 100)] };
  assert.ok(sample(alone).every(frame => frame.destinationId === "plesk-fishing"));
});

test("a blocked trading place does not prevent a safe local rest walk", () => {
  const world = scene();
  world.navigation.obstacles = [rectangle("closed-cut", 170, 0, 20, 180)];
  const frames = sample(world);
  assert.ok(frames.some(frame => frame.action === "rest" && frame.destinationId === "plesk-rest"));
  assert.ok(frames.some(frame => frame.action === "walk"));
  assert.ok(frames.every(frame => frame.action !== "trade" && frame.destinationId !== "plesk-trade"));
});

test("bobber stays in real water outside exclusions; removed water leaves honest shore activities", () => {
  const world = scene(), fish = pleskResidentFrame(world, 7, false);
  assert.equal(fish.action, "fish"); assert.ok(isForestWater(world, fish.waterTarget));
  assert.ok(Math.hypot(fish.waterTarget.x - fish.x, fish.waterTarget.y - fish.y) < PLESK.size * 2.3);
  const tinyHole = rectangle("leaf-under-ripple", fish.waterTarget.x + 1, fish.waterTarget.y + 1, .2, .2);
  const pinhole = { ...world, water: { ...world.water, exclusions: [tinyHole] } };
  assert.equal(isForestWater(pinhole, fish.waterTarget), true, "the float center alone misses this tiny exclusion");
  assert.notDeepEqual(pleskResidentFrame(pinhole, 7, false).waterTarget, fish.waterTarget);
  const excluded = { ...world, water: { ...world.water, exclusions: world.water.surfaces } };
  for (const dry of [{ ...world, water: undefined }, excluded]) {
    const frames = sample(dry);
    assert.ok(frames.every(frame => !["cast", "fish", "bite", "reel", "catch"].includes(frame.action)));
    assert.ok(frames.every(frame => !frame.waterTarget && !frame.carryingFish));
  }
});

test("missing, duplicate or blocked personal fishing markers never fall back to the hero's fishing point", () => {
  const base = scene(), shared = base.destinations.filter(marker => !marker.id.startsWith("plesk-"));
  for (const destinations of [[], shared, [...shared, destination("plesk-fishing", 175, 100)],
    [...base.destinations, destination("plesk-fishing", 310, 100)]]) {
    const world = { ...base, destinations };
    assert.equal(pleskResidentFrame(world, 10, false), null);
    assert.equal(pleskRoutineDuration(world), 0);
  }
  assert.equal(pleskResidentFrame({ ...base, navigation: undefined }, 10, false), null);
  assert.equal(pleskResidentFrame({ ...base, destinations: undefined }, 10, false), null);
});

test("personal marker edits are adopted without mutating or relocating shared destinations", () => {
  const base = scene(), original = structuredClone(base), first = pleskResidentFrame(base, 0, true);
  const changed = { ...base, destinations: base.destinations.map(marker => marker.id === "plesk-fishing"
    ? destination("plesk-fishing", 310, 140) : marker.id === "plesk-trade" ? destination("plesk-trade", 80, 145) : marker) };
  const moved = pleskResidentFrame(changed, 0, true);
  assert.equal(moved.destinationId, "plesk-fishing"); assert.equal(moved.x, 310); assert.equal(moved.y, 140);
  assert.notDeepEqual(moved.waterTarget, first.waterTarget);
  assert.ok(sample(changed).some(frame => frame.action === "trade" && frame.x === 80 && frame.y === 145));
  assert.deepEqual(pleskResidentFrame(base, 0, true), first);
  assert.deepEqual(base, original);
  moved.waterTarget.x = -100; moved.x = -100;
  assert.equal(pleskResidentFrame(changed, 0, true).x, 310, "frames do not expose cached positions");
  assert.ok(isForestWater(changed, pleskResidentFrame(changed, 0, true).waterTarget));
});

test("reduced motion stays at the personal pier at every clock value", () => {
  const world = scene(), still = pleskResidentFrame(world, 0, true);
  assert.equal(still.action, "fish"); assert.equal(still.frame, 0);
  for (const time of [1, 30, 100, 10000, Number.POSITIVE_INFINITY]) assert.deepEqual(pleskResidentFrame(world, time, true), still);
  assert.equal(pleskResidentFrame({ ...world, water: undefined }, 200, true).action, "rest");
});

test("the authored island keeps Плёск at the upper wooden pier, separate from the hero, at every building level", () => {
  for (let level = 0; level <= 5; level++) {
    const world = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), home: Math.max(1, level), workshop: level, quarry: level });
    const nav = createWorldNavigation(world), frames = sample(world, undefined, 2);
    const base = world.destinations.find(marker => marker.id === "plesk-fishing").position;
    const heroFishing = world.destinations.find(marker => marker.id === "fishing").position;
    assert.deepEqual(base, { x: 1214, y: 744 });
    assert.deepEqual(heroFishing, { x: 986.955311049695, y: 935.111122699067 });
    assert.ok(frames.every(Boolean));
    assert.ok(frames.some(frame => frame.action === "trade" && frame.destinationId === "plesk-trade"), `local trade at level ${level}`);
    assert.ok(frames.some(frame => frame.action === "rest" && frame.destinationId === "plesk-rest"), `local rest at level ${level}`);
    assert.ok(frames.some(frame => frame.action === "fish" && isForestWater(world, frame.waterTarget)), `real water at level ${level}`);
    assert.ok(frames.every(frame => isWalkable(nav, frame)), `safe feet at level ${level}`);
    assert.ok(frames.every(frame => Math.hypot(frame.x - base.x, frame.y - base.y) < 90), "all regular activities belong to the pier area");
    assert.ok(frames.every(frame => Math.hypot(frame.x - heroFishing.x, frame.y - heroFishing.y) > 200), "the main hero keeps his lower fishing clearing");
    const bobber = frames.find(frame => frame.waterTarget).waterTarget;
    assert.deepEqual(bobber, fishingWaterTarget(world, base, PLESK.size), "facing changes never relocate the real water anchor");
    const fishing = frames.filter(frame => ["cast", "fish", "bite", "reel", "catch"].includes(frame.action));
    assert.ok(fishing.every(frame => frame.direction === "front"), "her face stays visible throughout fishing at the upper pier");
    assert.equal(pleskResidentFrame(world, 42, true).direction, "front");
    for (let sample = 0; sample < 64; sample++) {
      const angle = sample * Math.PI / 32;
      assert.ok(isForestWater(world, { x: bobber.x + Math.cos(angle) * PLESK.size * .225,
        y: bobber.y + PLESK.size * .025 + Math.sin(angle) * PLESK.size * .09 }), `the complete ripple stays in water at level ${level}`);
    }
  }
});
