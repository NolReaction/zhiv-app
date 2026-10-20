import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createExpression, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createEarthLandMaterialImage, registerEarthMaterialImage, installEarthMaterialImages,
  EARTH_LAND_MATERIAL_IMAGE, EARTH_LAND_MATERIAL_SIZE, EARTH_LAND_MATERIAL_MAX_ZOOM } = await vite.ssrLoadModule("/features/earth/land-material.ts");
const { createEarthCoastlineData, earthCoastMaterialLayers, EARTH_COAST_SOURCE } = await vite.ssrLoadModule("/features/earth/coast-material.ts");
const { createCartoonEarthStyle, EARTH_LAND_SOURCE } = await vite.ssrLoadModule("/features/earth/cartoon-style.ts");
const style = createCartoonEarthStyle({ type: "vector", url: "https://tiles.openfreemap.org/planet" });

test("matte grain is a bounded deterministic RGBA image and a transferred copy cannot damage later maps", () => {
  const first = createEarthLandMaterialImage(); const second = createEarthLandMaterialImage();
  assert.equal(first.width, EARTH_LAND_MATERIAL_SIZE);
  assert.equal(first.height, EARTH_LAND_MATERIAL_SIZE);
  assert.equal(first.width & first.width - 1, 0, "patterns use a power-of-two repeat size");
  assert.equal(first.data.byteLength, 65_536);
  assert.deepEqual(first.data, second.data);
  assert.notEqual(first.data.buffer, second.data.buffer);
  structuredClone(first, { transfer: [first.data.buffer] });
  assert.equal(first.data.byteLength, 0);
  assert.deepEqual(createEarthLandMaterialImage().data, second.data);
  const alpha = second.data.filter((_, index) => index % 4 === 3);
  assert.ok(Math.min(...alpha) > 0 && Math.max(...alpha) < 128, "grain blends into the land rather than replacing its colour");
});

test("texture repeat edges have no larger contrast jump than ordinary interior grain", () => {
  const { width, height, data } = createEarthLandMaterialImage();
  const luminance = (x, y) => {
    const offset = (y * width + x) * 4; const alpha = data[offset + 3] / 255;
    return (data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722 - 200) * alpha;
  };
  const inner = []; const seam = []; const tone = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const value = luminance(x, y); tone.push(value);
    if (x > 0) inner.push(Math.abs(value - luminance(x - 1, y)));
    if (y > 0) inner.push(Math.abs(value - luminance(x, y - 1)));
  }
  for (let index = 0; index < width; index += 1) {
    seam.push(Math.abs(luminance(0, index) - luminance(width - 1, index)));
    seam.push(Math.abs(luminance(index, 0) - luminance(index, height - 1)));
  }
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const average = mean(tone);
  const deviation = Math.sqrt(mean(tone.map(value => (value - average) ** 2)));
  assert.ok(mean(seam) <= mean(inner) * 1.4, "the repeating image must not form tile borders");
  assert.ok(deviation > 3 && deviation < 20, "material has visible but restrained variation");
});

test("image installation is idempotent, handles a style replacement, and does not hide unrelated missing images", () => {
  const images = new Map(); const added = []; let resolver;
  const map = {
    hasImage: id => images.has(id),
    addImage: (id, image, options) => { assert.ok(!images.has(id)); images.set(id, image); added.push({ id, image, options }); },
    setMissingStyleImageResolver: callback => { resolver = callback; },
  };
  installEarthMaterialImages(map);
  resolver("unexpected-provider-image");
  assert.equal(added.length, 0);
  resolver(EARTH_LAND_MATERIAL_IMAGE);
  registerEarthMaterialImage(map);
  resolver(EARTH_LAND_MATERIAL_IMAGE);
  assert.equal(added.length, 1);
  assert.equal(added[0].options.pixelRatio, 2);
  images.clear();
  registerEarthMaterialImage(map);
  assert.equal(added.length, 2);
  assert.notEqual(added[0].image.data.buffer, added[1].image.data.buffer);
});

test("coarse and detailed land use identical material, then become undecorated before street zoom", () => {
  assert.deepEqual(validateStyleMin(style).map(error => error.message), []);
  const coarse = style.layers.find(layer => layer.id === "earth-land-material");
  const detail = style.layers.find(layer => layer.id === "earth-detail-land-material");
  assert.deepEqual(coarse.paint, detail.paint);
  assert.equal(coarse.paint["fill-pattern"], EARTH_LAND_MATERIAL_IMAGE);
  assert.equal(coarse.maxzoom, 4);
  assert.equal(detail.minzoom, coarse.maxzoom, "coarse and detailed grain hand off without double exposure");
  assert.equal(detail.maxzoom, EARTH_LAND_MATERIAL_MAX_ZOOM);
  const opacity = createExpression(coarse.paint["fill-opacity"], "fill-opacity");
  assert.equal(opacity.result, "success");
  assert.ok(opacity.value.evaluate({ zoom: 0 }) > 0.5);
  assert.equal(opacity.value.evaluate({ zoom: 8 }), 0);
  const index = id => style.layers.findIndex(layer => layer.id === id);
  assert.ok(index("earth-land") < index("earth-detail-land") && index("earth-detail-land") < index(coarse.id));
  assert.ok(index("earth-detail-land") < index(detail.id) && index(detail.id) < index("earth-water"));
  assert.equal(style.sources[EARTH_COAST_SOURCE].maxzoom, 0);
  assert.equal(typeof style.sources[EARTH_COAST_SOURCE].data, "object");
  const coast = style.layers.filter(layer => layer.source === EARTH_COAST_SOURCE);
  assert.equal(coast.length, 3);
  assert.ok(coast.every(layer => layer.maxzoom <= detail.minzoom), "coarse coast treatment ends before precise coastlines take over");
});

test("illustrated shallow water remains a restrained coast fringe beneath land and fades before streets", () => {
  const { shelf } = earthCoastMaterialLayers();
  assert.equal(shelf.source, EARTH_COAST_SOURCE);
  assert.equal(shelf.type, "line");
  assert.equal(shelf.maxzoom, 4);
  const opacity = createExpression(shelf.paint["line-opacity"], "line-opacity");
  const width = createExpression(shelf.paint["line-width"], "line-width");
  assert.equal(opacity.result, "success");
  assert.equal(width.result, "success");
  for (const zoom of [0, 1, 2, 3, 4, 8]) {
    assert.ok(opacity.value.evaluate({ zoom }) >= 0 && opacity.value.evaluate({ zoom }) <= 0.4);
    assert.ok(width.value.evaluate({ zoom }) <= 14, "a blurred shelf must not become a wide neon halo");
  }
  assert.ok(opacity.value.evaluate({ zoom: 2 }) > 0);
  assert.equal(opacity.value.evaluate({ zoom: 4 }), 0);
  assert.ok(style.layers.findIndex(layer => layer.id === shelf.id) < style.layers.findIndex(layer => layer.id === "earth-land"));
  assert.equal(style.sources[shelf.source].data, style.sources[EARTH_COAST_SOURCE].data, "no separate geometry or source is generated for the shelf");
});

test("coastline treatment excludes synthetic date-line and pole closures without changing real land geometry", () => {
  const land = style.sources[EARTH_LAND_SOURCE].data;
  const before = JSON.stringify(land);
  const coast = createEarthCoastlineData(land);
  assert.equal(JSON.stringify(land), before);
  assert.ok(coast.features.length >= 100);
  const realEdges = new Set();
  for (const feature of land.features) for (const ring of feature.geometry.coordinates) {
    for (let index = 1; index < ring.length; index += 1) realEdges.add(JSON.stringify([ring[index - 1], ring[index]]));
  }
  for (const feature of coast.features) {
    const points = feature.geometry.coordinates;
    assert.ok(points.length > 1);
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]; const b = points[index];
      assert.ok(realEdges.has(JSON.stringify([a, b])), "visible coast remains an existing geographic edge");
      assert.ok(Math.abs(a[0] - b[0]) <= 180);
      assert.ok(Math.abs(a[1]) < 90 && Math.abs(b[1]) < 90);
      assert.ok(!(Math.abs(a[0]) === 180 && Math.abs(b[0]) === 180));
    }
  }
});
