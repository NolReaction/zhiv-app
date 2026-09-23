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

test("unrecognized artwork has no stale water coordinates and terrain placement transforms the mask", () => {
  const changed = { ...scene, terrain: scene.terrain.map(t => ({ ...t, image: t.image + "-edited" })) };
  assert.deepEqual(forestWaterFrame(changed, options), { currents: [], impacts: [] });
  const moved = { ...scene, width: 3000, height: 3000,
    terrain: scene.terrain.map(t => ({ ...t, bounds: { x: 70, y: 130, width: t.bounds.width * 2, height: t.bounds.height * 2 } })) };
  assert.ok(isForestWater(moved, { x: 1200 * 2 + 70, y: 900 * 2 + 130 }));
  assert.equal(isForestWater(moved, { x: 812 * 2 + 70, y: 1120 * 2 + 130 }), false);
});
