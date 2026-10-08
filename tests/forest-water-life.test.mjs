import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestWaterFrame, isForestWater, FOREST_WATER_LIMITS } = await vite.ssrLoadModule("/features/world/environment/water/forest-water.ts");
const { drawWaterBreeze } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-life.ts");
const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url)));
const options = { elapsed: 10, rain: 0, dusk: 0, reducedMotion: false };
const rectangle = (id, x, y, width, height) => ({ id, points: [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
] });

test("the real river has bounded fish schools and breeze without rain, with no camera state", () => {
  const frame = forestWaterFrame(scene, options);
  assert.ok(frame.fish.length >= 10 && frame.fish.length <= FOREST_WATER_LIMITS.fish);
  assert.ok(frame.breeze.length >= 10 && frame.breeze.length <= FOREST_WATER_LIMITS.breeze);
  assert.equal(new Set(frame.fish.map(fish => fish.id)).size, frame.fish.length);
  assert.equal(new Set(frame.fish.map(fish => fish.species)).size, 3);
  assert.deepEqual(frame, forestWaterFrame(scene, options));
  assert.deepEqual(frame, forestWaterFrame({ ...scene, focus: { x: 0, y: 0, width: 50, height: 50 } }, options));
  assert.deepEqual(frame.impacts, []);
});

test("fish, leaps and their rings stay inside the real water and every Tiled exclusion", () => {
  let leaps = 0, rings = 0;
  for (let elapsed = 0; elapsed < 90; elapsed += .4) {
    const frame = forestWaterFrame(scene, { ...options, elapsed });
    assert.ok(frame.splashes.length <= FOREST_WATER_LIMITS.splashes);
    for (let i = 0; i < frame.fish.length; i++) for (let j = i + 1; j < frame.fish.length; j++) {
      const a = frame.fish[i], b = frame.fish[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 6 * (a.size + b.size), "swimming bodies do not overlap");
    }
    for (const fish of frame.fish) {
      if (fish.jump > 0) leaps++;
      for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 12) {
        const point = { x: fish.x + Math.cos(angle) * 6 * fish.size,
          y: fish.y - fish.jump * 5 * fish.size + Math.sin(angle) * 6 * fish.size };
        assert.ok(isForestWater(scene, point), `${fish.id}: body stays wet at ${elapsed}`);
      }
    }
    for (const splash of frame.splashes) {
      rings++;
      for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 12) {
        assert.ok(isForestWater(scene, { x: splash.x + Math.cos(angle) * 8.7 * splash.scale,
          y: splash.y + Math.sin(angle) * 3 * splash.scale }), "complete largest ring fits");
      }
      assert.ok(isForestWater(scene, { x: splash.x, y: splash.y - 6.2 * splash.scale }), "drops fit too");
    }
  }
  assert.ok(leaps > 10 && rings > 50, "geometry is exercised during actual events");
});

test("painted breeze curves and stroke widths remain on water through a complete drift", () => {
  const points = [];
  let start;
  const ctx = { save() {}, restore() {}, beginPath() {}, stroke() {},
    moveTo(x, y) { start = { x, y }; },
    bezierCurveTo(x1, y1, x2, y2, x3, y3) {
      for (let t = 0; t <= 1; t += .05) {
        const u = 1 - t;
        points.push({ x: u ** 3 * start.x + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3,
          y: u ** 3 * start.y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3, radius: this.lineWidth / 2 });
      }
      start = { x: x3, y: y3 };
    },
    quadraticCurveTo(x1, y1, x2, y2) {
      this.bezierCurveTo(start.x + (x1 - start.x) * 2 / 3, start.y + (y1 - start.y) * 2 / 3,
        x2 + (x1 - x2) * 2 / 3, y2 + (y1 - y2) * 2 / 3, x2, y2);
    },
  };
  for (let elapsed = 0; elapsed < 15; elapsed += 1.1) {
    points.length = 0;
    for (const wave of forestWaterFrame(scene, { ...options, elapsed }).breeze) drawWaterBreeze(ctx, wave);
    for (const point of points) for (const sign of [-1, 1]) {
      assert.ok(isForestWater(scene, { x: point.x + sign * point.radius, y: point.y + sign * point.radius }));
    }
  }
});

test("swimming is continuous through cycle boundaries and splashes keep their birth position", () => {
  const origins = new Map();
  let previous;
  for (let elapsed = 0; elapsed < 65; elapsed += .2) {
    const frame = forestWaterFrame(scene, { ...options, elapsed });
    if (previous) for (let i = 0; i < frame.fish.length; i++) {
      const a = previous.fish[i], b = frame.fish[i];
      assert.equal(a.id, b.id);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1.5, "fish never teleports on a loop or leap");
    }
    for (const splash of frame.splashes) {
      const before = origins.get(splash.id);
      if (before) assert.ok(Math.hypot(before.x - splash.x, before.y - splash.y) < 1e-9);
      origins.set(splash.id, splash);
    }
    previous = frame;
  }
  assert.ok(origins.size > 10);
});

test("rain and night soften submerged fish, reduced motion freezes them, DEV toggles remain independent", () => {
  const day = forestWaterFrame(scene, options), rain = forestWaterFrame(scene, { ...options, rain: 1 });
  const night = forestWaterFrame(scene, { ...options, dusk: 1 });
  assert.deepEqual(rain.splashes, []); assert.deepEqual(night.splashes, []);
  assert.ok(rain.fish.every(fish => fish.opacity < day.fish.find(item => item.id === fish.id).opacity));
  assert.ok(night.fish.every(fish => fish.opacity < day.fish.find(item => item.id === fish.id).opacity));
  const still = forestWaterFrame(scene, { ...options, reducedMotion: true });
  assert.deepEqual(still, forestWaterFrame(scene, { ...options, elapsed: 600, reducedMotion: true }));
  assert.deepEqual(still.splashes, []); assert.ok(still.fish.every(fish => fish.jump === 0));
  const noFish = forestWaterFrame(scene, { ...options, waterFish: "off" });
  assert.deepEqual(noFish.fish, []); assert.deepEqual(noFish.splashes, []);
  assert.deepEqual(noFish.breeze, day.breeze);
  const noBreeze = forestWaterFrame(scene, { ...options, waterBreeze: false });
  assert.deepEqual(noBreeze.breeze, []); assert.deepEqual(noBreeze.fish, day.fish);
});

test("tiny exclusions inside the entire habitat invalidate its path, and missing water has no life", () => {
  const pond = { ...scene, water: { surfaces: [rectangle("pond", 0, 0, 200, 200)], exclusions: [] } };
  const first = forestWaterFrame(pond, options).fish[0];
  const edited = { ...pond, water: { ...pond.water,
    exclusions: [rectangle("small-leaf", first.x - .02, first.y - .02, .04, .04)] } };
  for (let elapsed = 0; elapsed < 35; elapsed += .5) for (const fish of forestWaterFrame(edited, { ...options, elapsed }).fish) {
    assert.ok(Math.hypot(fish.x - first.x, fish.y - first.y) > 6 * fish.size,
      "even a hole smaller than path samples is kept outside the fish footprint");
  }
  for (const water of [undefined, { surfaces: [], exclusions: [] }]) {
    const frame = forestWaterFrame({ ...scene, water }, options);
    assert.deepEqual(frame.fish, []); assert.deepEqual(frame.splashes, []); assert.deepEqual(frame.breeze, []);
  }
});
