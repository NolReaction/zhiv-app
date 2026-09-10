import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { FOREST_MAP } = await vite.ssrLoadModule("/features/world/map-manifest.ts");
const { MAP_SIZE, HOME_AREA, homeToWorld, worldToHome, mapPlaceAt, pointInPolygon } = await vite.ssrLoadModule("/features/world/map-layout.ts");
const { worldToScreen, screenToWorld, viewportPoint } = await vite.ssrLoadModule("/features/world/camera.ts");
const { houseVariantFor } = await vite.ssrLoadModule("/features/mochlik/house-variants.ts");
const { createHabitat, HOME, DOORSTEP, BUSH, BUSH_EDGE } = await vite.ssrLoadModule("/features/mochlik/habitat.ts");

test("approved image bytes and source resolution are preserved, home is an integer crop", async () => {
  const bytes = await readFile(`${root}/public${FOREST_MAP.image}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "af3654bd7fe0d3737bbc8749924e46e54fe581ce043315e1247f06bbb84b139f");
  assert.equal(bytes.readUInt32BE(16), MAP_SIZE); assert.equal(bytes.readUInt32BE(20), MAP_SIZE);
  assert.ok(HOME_AREA.x >= 0 && HOME_AREA.y >= 0 && HOME_AREA.x + HOME_AREA.size <= MAP_SIZE && HOME_AREA.y + HOME_AREA.size <= MAP_SIZE);
  assert.equal(HOME_AREA.size % 256, 0, "integer effect scaling, without downsampling the background");
});

test("all visible water is a destination, with land excluded and boundary taps included", () => {
  for (const [x, y] of [[1233, 972], [1200, 989], [1161, 1085], [1254, 963], [1253, 980], [1205, 1040], [1210, 1100], [1080, 1130], [1035, 1160], [1100, 1240], [1254, 1254]])
    assert.equal(mapPlaceAt({ x, y }), "fishing", `${x},${y}`);
  for (const [x, y] of [[990, 1100], [1110, 1020], [950, 1220], [1190, 950], [1255, 1200]])
    assert.notEqual(mapPlaceAt({ x, y }), "fishing", `land ${x},${y}`);
  assert.equal(mapPlaceAt(FOREST_MAP.cave.entrance), "cave");
  assert.equal(mapPlaceAt({ x: NaN, y: 1000 }), null);
});

test("camera zoom, panning, responsive viewport and entrance CSS scaling never move hotspots", () => {
  for (const view of [{ width: 393, height: 852 }, { width: 1440, height: 900 }, { width: 852, height: 393 }])
    for (const camera of [{ x: 627, y: 627, zoom: .4 }, { x: 810, y: 990, zoom: 2.3 }])
      for (const landmark of [FOREST_MAP.house.marker, FOREST_MAP.bush.marker, FOREST_MAP.cave.marker, FOREST_MAP.water.marker]) {
        const screen = worldToScreen(landmark, camera, view);
        const rect = { left: 11, top: 19, width: view.width * 1.055, height: view.height * 1.055 };
        const client = { x: rect.left + screen.x * 1.055, y: rect.top + screen.y * 1.055 };
        const restored = screenToWorld(viewportPoint(client, rect, view), camera, view);
        assert.ok(Math.hypot(restored.x - landmark.x, restored.y - landmark.y) < 1e-8);
        assert.equal(mapPlaceAt(restored), mapPlaceAt(landmark));
      }
});

test("house, bush and approaches use the same coordinates in the habitat and full map", () => {
  for (const [local, source] of [[HOME, FOREST_MAP.house.inside], [DOORSTEP, FOREST_MAP.house.doorstep], [BUSH, FOREST_MAP.bush.inside], [BUSH_EDGE, FOREST_MAP.bush.approach]])
    assert.deepEqual(homeToWorld(local), source);
  const habitat = createHabitat();
  assert.equal(habitat.moveTo(worldToHome({ x: 600, y: 740 })), true);
  assert.equal(habitat.moveTo(worldToHome(FOREST_MAP.cave.entrance)), false);
  assert.equal(habitat.moveTo(worldToHome(FOREST_MAP.water.marker)), false);
  assert.equal(habitat.moveTo({ x: Infinity, y: .6 }), false);
  assert.ok(pointInPolygon(FOREST_MAP.house.inside, FOREST_MAP.house.doorway));
});

test("saved house levels never apply incompatible legacy art or change anchors", () => {
  for (let level = 1; level <= 5; level++) assert.equal(houseVariantFor(level), null);
  const slot = FOREST_MAP.house.upgradeSlot;
  for (const point of [FOREST_MAP.house.inside, FOREST_MAP.house.groundAnchor, FOREST_MAP.house.lamp]) {
    assert.ok(point.x >= slot.x && point.x <= slot.x + slot.width && point.y >= slot.y && point.y <= slot.y + slot.height);
  }
});
