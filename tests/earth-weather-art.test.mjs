import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthCloudTilePixels, earthCloudSeed, earthCloudBankPixels } = await vite.ssrLoadModule("/features/earth/cloud-art.ts");
const { earthWeatherCanvasSize } = await vite.ssrLoadModule("/features/earth/weather-field.ts");
const alpha = pixels => pixels.filter((_, index) => index % 4 === 3);
const material = { coverage: .7, night: false, storm: false };

test("cloud material joins neighbouring world tiles and the date line without repeated silhouettes or seams", () => {
  const seed = earthCloudSeed("55:38"), size = 64, world = 8_388_608;
  const a = earthCloudTilePixels(0, 1024, world, seed, material, size);
  const b = earthCloudTilePixels(2048, 1024, world, seed, material, size);
  for (let row = 0; row < size; row++) assert.deepEqual(a.slice((row * size + size - 1) * 4, (row * size + size) * 4), b.slice(row * size * 4, row * size * 4 + 4));
  assert.notDeepEqual(a, b, "neighbouring tiles contain different pieces of one field, rather than a repeated stamp");
  const wrapped = earthCloudTilePixels(world, 1024, world, seed, material, size);
  assert.deepEqual(a, wrapped);
});

test("actual cloud coverage controls density, while material alpha stays low enough to read the map", () => {
  const seed = earthCloudSeed("59:30"), world = 8_388_608;
  const clear = earthCloudTilePixels(0, 0, world, seed, { ...material, coverage: 0 }, 64);
  assert.ok(clear.every(value => value === 0));
  const sparse = alpha(earthCloudTilePixels(0, 0, world, seed, { ...material, coverage: .25 }, 64));
  const dense = alpha(earthCloudTilePixels(0, 0, world, seed, { ...material, coverage: 1, storm: true }, 64));
  assert.ok(dense.reduce((a, b) => a + b, 0) > sparse.reduce((a, b) => a + b, 0));
  assert.ok(dense.every(value => value <= 89));
});

test("cloud material feathers out at the forecast boundary and decorative banks have finite unique soft edges", () => {
  const clip = { left: 64, right: 1984, top: 64, bottom: 1984, feather: 24 };
  const pixels = earthCloudTilePixels(0, 0, 8_388_608, earthCloudSeed("cell"), material, 64, 2048, clip);
  for (let index = 0; index < 64; index++) {
    assert.equal(pixels[index * 4 + 3], 0); assert.equal(pixels[(63 * 64 + index) * 4 + 3], 0);
    assert.equal(pixels[index * 64 * 4 + 3], 0); assert.equal(pixels[(index * 64 + 63) * 4 + 3], 0);
  }
  const a = earthCloudBankPixels(earthCloudSeed("bank-a"), 64, 32), b = earthCloudBankPixels(earthCloudSeed("bank-b"), 64, 32);
  assert.notDeepEqual(a, b); assert.ok(alpha(a).some(value => value > 0));
  for (let index = 0; index < 64; index++) { assert.equal(a[index * 4 + 3], 0); assert.equal(a[(31 * 64 + index) * 4 + 3], 0); }
});

test("high DPR and very wide displays cannot exceed fixed weather buffer limits", () => {
  for (const [width, height, dpr] of [[390, 844, 4], [1920, 1080, 3], [7680, 4320, 4], [16000, 300, 2]]) {
    const size = earthWeatherCanvasSize(width, height, dpr);
    assert.ok(size.width * size.height <= 1_048_576); assert.ok(Math.max(size.width, size.height) <= 1536);
    assert.ok(size.ratio <= 1.25 && size.ratio > 0);
  }
  for (const args of [[0, 1], [1, NaN], [Infinity, 100]]) assert.equal(earthWeatherCanvasSize(...args), null);
});
