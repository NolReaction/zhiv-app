import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestWaterFrame, isForestWater, FOREST_WATER_LIMITS } = await vite.ssrLoadModule("/features/world/forest-water.ts");
const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url)));
const options = { elapsed: 12, rain: .7, dusk: 0, reducedMotion: false };

test("water follows both river arms and excludes the actual island, stone and jetty", () => {
  for (const [x, y] of [[1200, 900], [639, 1050], [575, 937], [1000, 1240]]) {
    assert.ok(isForestWater(scene, { x, y }), `river point ${x},${y}`);
  }
  for (const [x, y] of [[812, 1120], [1203, 746], [1067, 1031], [598, 690]]) {
    assert.equal(isForestWater(scene, { x, y }), false, `landmark ${x},${y} stays dry`);
  }
  const frame = forestWaterFrame(scene, options);
  assert.ok(frame.currents.length > 0 && frame.impacts.length > 0);
  for (const point of [...frame.currents, ...frame.impacts]) assert.ok(isForestWater(scene, point));
  assert.ok(frame.impacts.some(p => p.x < 680), "narrow tributary receives impacts too");
});

test("river particles share a deterministic clock, stop in reduced motion, and scale with rain", () => {
  const first = forestWaterFrame(scene, options);
  assert.deepEqual(first, forestWaterFrame(scene, options));
  assert.notDeepEqual(first, forestWaterFrame(scene, { ...options, elapsed: 12.3 }));
  let previous = 0;
  for (const rain of [.2, .5, 1]) {
    const frame = forestWaterFrame(scene, { ...options, rain });
    assert.ok(frame.impacts.length > previous && frame.impacts.length <= FOREST_WATER_LIMITS.impacts);
    previous = frame.impacts.length;
  }
  assert.deepEqual(forestWaterFrame(scene, { ...options, rain: 0 }).impacts, []);
  const reduced = forestWaterFrame(scene, { ...options, reducedMotion: true });
  assert.deepEqual(reduced.impacts, []);
  assert.deepEqual(reduced, forestWaterFrame(scene, { ...options, reducedMotion: true, elapsed: 91 }));
});

test("water belongs to Tiled coordinates rather than the artwork revision or terrain placement", () => {
  const changed = { ...scene, terrain: scene.terrain.map(t => ({ ...t, image: t.image + "-edited" })) };
  assert.deepEqual(forestWaterFrame(changed, options), forestWaterFrame(scene, options));
  const movedTerrain = { ...scene,
    terrain: scene.terrain.map(t => ({ ...t, bounds: { ...t.bounds, x: 70, y: 130 } })) };
  assert.deepEqual(forestWaterFrame(movedTerrain, options), forestWaterFrame(scene, options));
  const transform = polygons => polygons.map(polygon => ({ ...polygon,
    points: polygon.points.map(p => ({ x: p.x * 2 + 70, y: p.y * 2 + 130 })) }));
  const moved = { ...scene, width: 3000, height: 3000,
    water: { surfaces: transform(scene.water.surfaces), exclusions: transform(scene.water.exclusions) } };
  assert.ok(isForestWater(moved, { x: 1200 * 2 + 70, y: 900 * 2 + 130 }));
  assert.equal(isForestWater(moved, { x: 812 * 2 + 70, y: 1120 * 2 + 130 }), false);
});

const rectangle = (id, x, y, width, height) => ({ id, points: [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
] });

test("Tiled can place water anywhere in the world and saving new geometry replaces the previous mask", () => {
  const first = { ...scene, water: { surfaces: [rectangle("pond", 20, 20, 240, 200)], exclusions: [] } };
  const next = { ...first, water: { surfaces: [rectangle("pond", 400, 200, 240, 200)], exclusions: [] } };
  for (const edited of [first, next]) {
    const frame = forestWaterFrame(edited, options);
    assert.ok(frame.impacts.length > 10 && frame.impacts.length <= FOREST_WATER_LIMITS.impacts);
    for (const point of [...frame.impacts, ...frame.currents]) assert.ok(isForestWater(edited, point));
  }
  assert.ok(isForestWater(first, { x: 120, y: 100 }));
  assert.equal(isForestWater(next, { x: 120, y: 100 }), false);
  assert.ok(isForestWater(next, { x: 500, y: 300 }));
  assert.equal(isForestWater(first, { x: 1200, y: 900 }), false, "no old river fallback");
});

test("surfaces form a union and exclusions subtract even when reversed, overlapping or crossing shore", () => {
  const second = rectangle("river-b", 200, 100, 300, 300);
  second.points.reverse();
  const edited = { ...scene, water: {
    surfaces: [rectangle("river-a", 100, 100, 300, 300), second],
    exclusions: [rectangle("rock-a", 150, 180, 140, 80), rectangle("rock-b", 240, 200, 100, 80),
      rectangle("reeds", 450, 300, 100, 100)],
  } };
  for (const point of [{ x: 120, y: 120 }, { x: 250, y: 120 }, { x: 450, y: 120 }]) {
    assert.ok(isForestWater(edited, point), "overlapping surfaces stay wet");
  }
  for (const point of [{ x: 180, y: 220 }, { x: 260, y: 220 }, { x: 320, y: 220 },
    { x: 480, y: 340 }, { x: 525, y: 340 }, { x: 150, y: 180 }]) {
    assert.equal(isForestWater(edited, point), false, "exclusion union and its boundaries stay dry");
  }
  for (const point of forestWaterFrame(edited, options).impacts) assert.ok(isForestWater(edited, point));
});

test("maps with no authored water or empty surfaces do not inherit the forest mask", () => {
  const { water: omitted, ...withoutWater } = scene;
  assert.ok(omitted);
  for (const edited of [withoutWater, { ...scene, water: { surfaces: [], exclusions: scene.water.exclusions } }]) {
    assert.equal(isForestWater(edited, { x: 1200, y: 900 }), false);
    assert.deepEqual(forestWaterFrame(edited, options), { currents: [], impacts: [] });
  }
});

test("the narrow upper tributary has local coverage and new positions after each ripple", () => {
  const positions = new Set(), events = new Map();
  const inArm = point => point.x >= 525 && point.x <= 665 && point.y >= 860 && point.y <= 1040;
  let minCount = Infinity, maxCount = 0;
  for (let elapsed = 0; elapsed < 30; elapsed += .25) {
    const hits = forestWaterFrame(scene, { ...options, elapsed, rain: 1 }).impacts.filter(inArm);
    minCount = Math.min(minCount, hits.length); maxCount = Math.max(maxCount, hits.length);
    for (const hit of hits) {
      const position = `${hit.x},${hit.y}`;
      positions.add(position);
      if (events.has(hit.eventId)) assert.equal(position, events.get(hit.eventId), "an expanding ripple stays anchored");
      events.set(hit.eventId, position);
    }
  }
  assert.ok(minCount >= 3, `the upper arm remains active (${minCount} minimum)`);
  assert.ok(maxCount > minCount, "births are staggered rather than one synchronized loop");
  assert.ok(positions.size > 45, `${positions.size} distinct locations instead of permanent global seeds`);
});

test("complete ripple footprints avoid the shore and tiny holes inside their perimeter", () => {
  const pond = { ...scene, water: { surfaces: [rectangle("pond", 0, 0, 200, 200)], exclusions: [] } };
  const base = forestWaterFrame(pond, { ...options, rain: 1 }).impacts[0];
  const edited = { ...pond, water: { ...pond.water,
    exclusions: [rectangle("tiny-leaf", base.x + 2, base.y - .05, .1, .1)] } };
  let count = 0;
  for (let elapsed = 0; elapsed < 8; elapsed += .2) {
    for (const hit of forestWaterFrame(edited, { ...options, elapsed, rain: 1 }).impacts) {
      count++;
      const scale = hit.radiusX / 9;
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
        assert.ok(isForestWater(edited, { x: hit.x + Math.cos(angle) * hit.radiusX,
          y: hit.y + Math.sin(angle) * hit.radiusY }), "maximum expanding ring stays inside water");
      }
      const holeX = base.x + 2.05, holeY = base.y;
      assert.ok(((holeX - hit.x) / (11 * scale)) ** 2 + ((holeY - hit.y) / (6 * scale)) ** 2 > 1,
        "even a tiny leaf wholly within a ripple footprint removes that candidate");
    }
  }
  assert.ok(count > 100, "geometry checks exercise an active pond");
});
