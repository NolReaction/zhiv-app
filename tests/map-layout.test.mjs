import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import sharp from "sharp";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { FOREST_MAP } = await vite.ssrLoadModule("/features/world/map-manifest.ts");
const { MAP_SIZE, HOME_AREA, homeToWorld, worldToHome, mapPlaceAt, pointInPolygon } = await vite.ssrLoadModule("/features/world/map-layout.ts");
const { worldToScreen, screenToWorld, viewportPoint } = await vite.ssrLoadModule("/features/world/camera.ts");
const { houseVariantFor } = await vite.ssrLoadModule("/features/mochlik/house-variants.ts");
const { createHabitat, HOME, DOORSTEP, BUSH, BUSH_EDGE } = await vite.ssrLoadModule("/features/mochlik/habitat.ts");

test("enhanced region preserves 2048 source pixels without changing the logical home crop", async () => {
  const master = await readFile(`${root}/public/world/maps/forest-region-v3.png`);
  assert.equal(createHash("sha256").update(master).digest("hex"), "6bc7d8274bc1f1e660de570f0ac4d9eb1f7651ad1a38a84abba9e5b01c45be59");
  const bytes = await readFile(`${root}/public${FOREST_MAP.image}`), metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 2048); assert.equal(metadata.height, 2048);
  assert.equal(MAP_SIZE, 1254, "higher artwork resolution does not move world coordinates");
  assert.ok(HOME_AREA.x >= 0 && HOME_AREA.y >= 0 && HOME_AREA.x + HOME_AREA.size <= MAP_SIZE && HOME_AREA.y + HOME_AREA.size <= MAP_SIZE);
  assert.equal(HOME_AREA.size % 256, 0, "integer effect scaling, without downsampling the background");
});

test("full-resolution artwork keeps every RGBA pixel from the supplied enhanced PNGs", async () => {
  const sources = JSON.parse(await readFile(`${root}/public/world/art-sources.json`, "utf8"));
  const assets = JSON.parse(await readFile(`${root}/features/world/runtime-art.json`, "utf8"));
  const suppliedPixels = {
    map: "1066db9895fee688be031680cfda29a77e2c16fc0f749dd46e01fbb686428105",
    homeDetail: "7eee9708b5a1c9f43ea58a1cf9700e1a91fcf9832a090f050e8278fcd2a7ae7e",
  };
  for (const [name, expectedPixels] of Object.entries(suppliedPixels)) {
    const source = sources.artworks[name];
    assert.equal(assets[name], source.runtimePath, "full artwork has a single canonical copy");
    const bytes = await readFile(`${root}/public${assets[name]}`);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 2048); assert.equal(metadata.height, 2048);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
    const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer();
    assert.equal(createHash("sha256").update(pixels).digest("hex"), expectedPixels, `${name} must not lose detail during asset preparation`);
    assert.equal(source.rgbaSha256, expectedPixels);
  }
});

test("first frames fit the slow-network budget and every cached artwork URL follows its content", async () => {
  const assets = JSON.parse(await readFile(`${root}/features/world/runtime-art.json`, "utf8"));
  for (const [name, url] of Object.entries(assets)) {
    const bytes = await readFile(`${root}/public${url}`);
    assert.ok(url.includes(createHash("sha256").update(bytes).digest("hex").slice(0, 12)), `${name} changes its cache key when its artwork changes`);
    if (name === "homePreview" || name === "mapPreview") {
      const metadata = await sharp(bytes).metadata(), size = name === "homePreview" ? 256 : 384;
      assert.equal(metadata.width, size); assert.equal(metadata.height, size);
      assert.ok(bytes.length < (name === "homePreview" ? 32_000 : 55_000), `${name} must not block the first frame with full-size artwork`);
    }
  }
});

test("all visible water is a destination, with land excluded and boundary taps included", () => {
  for (const [x, y] of [[1235, 735], [1160, 850], [900, 985], [1050, 1100], [750, 1225], [1225, 1200], [1254, 750], [1254, 1254]])
    assert.equal(mapPlaceAt({ x, y }), "fishing", `${x},${y}`);
  for (const [x, y] of [[800, 950], [1000, 955], [1160, 1020], [1040, 1230], [1255, 1200]])
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
  assert.equal(habitat.moveTo(worldToHome(FOREST_MAP.clearing.spawn)), true);
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
