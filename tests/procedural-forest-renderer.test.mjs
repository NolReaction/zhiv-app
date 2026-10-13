import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestPainter } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/renderer.ts");
const { forestObjects, initialProps, objectCorners, objectDepth, INITIAL_SEED, INITIAL_WIDTH, WORLD_HEIGHT, MAX_WIDTH } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/objects.ts");
const removed = new Set([...forestObjects(INITIAL_SEED, { x: 0, y: 0, width: INITIAL_WIDTH, height: WORLD_HEIGHT }), ...initialProps()].map(object => object.id));
const options = (overrides = {}) => ({ seed: INITIAL_SEED, width: INITIAL_WIDTH, trees: true, grid: false, removed, planted: [], ...overrides });
const asset = (id, overrides = {}) => ({ id, name: `${id}.png`, dataUrl: `data:image/png;base64,${id}`, width: 1200, height: 600, ...overrides });
const imageObject = (image, overrides = {}) => ({ id: "planted:image", kind: "image", assetId: image.id, imageWidth: 320, imageHeight: 160, x: 700, y: 800, scale: 1, rotation: 0, variant: 0, ...overrides });
const blankView = { x: 10000, y: 10000, width: 1, height: 1 };
const view = { x: 550, y: 600, width: 100, height: 100 };
function context(calls = []) {
  return new Proxy({}, {
    get: (_, key) => key === "createRadialGradient" || key === "createLinearGradient"
      ? () => ({ addColorStop() {} }) : (...args) => calls.push([key, ...args]),
    set: (_, key, value) => { calls.push(["set", key, value]); return true; },
  });
}
const factory = (width, height) => ({ width, height, getContext: () => context() });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test("PNG drawing reuses its original decoded source while movement preserves aspect and alpha", async () => {
  const image = asset("one"), native = { source: "original PNG", width: 1200, height: 600 }, decoded = [], calls = [];
  const painter = createForestPainter(factory, undefined, async url => { decoded.push(url); return native; });
  await Promise.all([painter.prepareAssets([image]), painter.prepareAssets([image])]);
  const item = imageObject(image, { rotation: 17, scale: 1.3 });
  const settings = options({ assets: new Map([[image.id, image]]), planted: [item] });
  const visible = { x: 550, y: 600, width: 400, height: 400 };
  painter.paint(context(calls), visible, settings);
  assert.deepEqual(calls.find(call => call[0] === "drawImage" && call[1] === native), ["drawImage", native, -160, -160, 320, 160]);
  assert.ok(calls.some(call => call[0] === "rotate" && call[1] === item.rotation * Math.PI / 180));
  assert.ok(calls.some(call => call[0] === "scale" && call[1] === 1.3 && call[2] === 1.3));
  assert.ok(!calls.some(call => call[0] === "createRadialGradient"), "an imported PNG does not acquire a procedural shadow");
  calls.length = 0;
  painter.paint(context(calls), visible, { ...settings, planted: [{ ...item, x: 710 }] });
  await painter.prepareAssets([image]);
  assert.deepEqual(decoded, [image.dataUrl], "movement and repeated preparation do not re-decode the file");
  assert.ok(calls.some(call => call[0] === "translate" && call[1] === 710));
  painter.dispose();
});

test("PNG culling uses its rectangle even when the bottom anchor is outside the viewport", async () => {
  const image = asset("wide"), native = {}, calls = [];
  const painter = createForestPainter(factory, undefined, async () => native);
  await painter.prepareAssets([image]);
  const item = imageObject(image);
  painter.paint(context(calls), view, options({ assets: new Map([[image.id, image]]), planted: [item] }));
  assert.ok(calls.some(call => call[0] === "drawImage" && call[1] === native));
  calls.length = 0;
  painter.paint(context(calls), view, options({ assets: new Map([[image.id, image]]), planted: [{ ...item, x: 1200 }] }));
  assert.ok(!calls.some(call => call[0] === "drawImage" && call[1] === native));
  painter.dispose();
});

test("rotated selection uses transformed corners with four screen-sized handles and is omitted from exports", async () => {
  const image = asset("selected"), item = imageObject(image, { rotation: 45, scale: 1.8 }), calls = [];
  const painter = createForestPainter(factory, undefined, async () => ({}));
  await painter.prepareAssets([image]);
  const settings = options({ assets: new Map([[image.id, image]]), planted: [item], selectedId: item.id, selectionZoom: .5 });
  painter.paint(context(calls), view, settings);
  const corners = objectCorners(item), handles = calls.filter(call => call[0] === "arc" && call[3] === 14);
  assert.deepEqual(handles.map(call => call.slice(1, 3)), corners.map(({ x, y }) => [x, y]));
  assert.ok(calls.some(call => call[0] === "moveTo" && call[1] === corners[0].x && call[2] === corners[0].y));
  assert.ok(calls.some(call => call[0] === "set" && call[1] === "lineWidth" && call[2] === 4));
  calls.length = 0;
  painter.paint(context(calls), view, { ...settings, selectedId: undefined });
  assert.ok(!calls.some(call => call[0] === "arc" || call[0] === "strokeRect"), "PNG export has no selection handles or frame");
  painter.dispose();
});

test("failed preparation keeps ready sources and allows an explicit retry of the same PNG", async () => {
  const old = asset("old"), broken = asset("broken"), native = {}, attempts = new Map(), calls = [];
  const painter = createForestPainter(factory, undefined, async url => {
    attempts.set(url, (attempts.get(url) ?? 0) + 1);
    if (url === broken.dataUrl && attempts.get(url) === 1) throw new Error("bad PNG");
    return native;
  });
  await painter.prepareAssets([old]);
  await assert.rejects(painter.prepareAssets([old, broken]), /bad PNG/);
  painter.paint(context(calls), view, options({ assets: new Map([[old.id, old]]), planted: [imageObject(old)] }));
  assert.ok(calls.some(call => call[0] === "drawImage" && call[1] === native));
  await painter.prepareAssets([old, broken]);
  assert.equal(attempts.get(old.dataUrl), 1);
  assert.equal(attempts.get(broken.dataUrl), 2);
  painter.dispose();
});

test("a pending decode cannot invalidate a disposed editor or repopulate its cache", async () => {
  const image = asset("late");
  let complete, callbacks = 0;
  const painter = createForestPainter(factory, () => callbacks++, () => new Promise(resolve => { complete = resolve; }));
  const pending = painter.prepareAssets([image]);
  await Promise.resolve();
  painter.dispose(); complete({});
  await assert.rejects(pending, /закрыт/);
  assert.equal(callbacks, 0);
  await assert.rejects(painter.prepareAssets([image]), /закрыт/);
});

test("decoded history uses a pixel budget while preserving the current scene and lazily restoring evicted sources", async () => {
  const images = ["a", "b", "c", "d", "e"].map(id => asset(id, { width: 4000, height: 4000 })), attempts = new Map();
  const painter = createForestPainter(factory, undefined, async url => { attempts.set(url, (attempts.get(url) ?? 0) + 1); return {}; });
  await painter.prepareAssets([images[0]]);
  painter.paint(context(), blankView, options({ assets: new Map([[images[0].id, images[0]]]) }));
  for (const image of images.slice(1)) await painter.prepareAssets([image]);
  await painter.prepareAssets([images[0]]);
  assert.equal(attempts.get(images[0].dataUrl), 1, "the current scene source cannot be evicted");
  painter.paint(context(), blankView, options({ assets: new Map([[images[1].id, images[1]]]) }));
  await flush();
  assert.equal(attempts.get(images[1].dataUrl), 2, "the oldest unprotected decoded image reloads on undo");
  painter.dispose();
});

test("a failed lazy restore does not re-decode on every paint and explicit preparation retries it", async () => {
  const image = asset("bad"), settings = options({ assets: new Map([[image.id, image]]) });
  let attempts = 0;
  const painter = createForestPainter(factory, undefined, async () => { attempts++; throw new Error("bad PNG"); });
  painter.paint(context(), blankView, settings);
  await flush();
  painter.paint(context(), blankView, settings);
  await flush();
  assert.equal(attempts, 1);
  await assert.rejects(painter.prepareAssets([image]), /bad PNG/);
  assert.equal(attempts, 2);
  painter.dispose();
});

test("manual stacking swaps overlapping PNGs without changing placement or re-decoding sources", async () => {
  const images = [asset("first"), asset("second")], decoded = [], calls = [];
  const native = new Map(images.map(image => [image.dataUrl, { name: image.id }]));
  const painter = createForestPainter(factory, undefined, async url => { decoded.push(url); return native.get(url); });
  await painter.prepareAssets(images);
  const items = images.map((image, index) => imageObject(image, { id: `planted:${index}`, stackOrder: [100 + index * 100] }));
  const settings = options({ assets: new Map(images.map(image => [image.id, image])), planted: items });
  const drawingOrder = () => calls.filter(call => call[0] === "drawImage" && [...native.values()].includes(call[1])).map(call => call[1].name);
  assert.deepEqual(painter.objects(settings).map(item => item.id), ["planted:0", "planted:1"]);
  painter.paint(context(calls), view, settings);
  assert.deepEqual(drawingOrder(), ["first", "second"]);
  calls.length = 0;
  const swapped = { ...settings, planted: [{ ...items[0], stackOrder: [300] }, items[1]] };
  assert.deepEqual(painter.objects(swapped).map(item => item.id), ["planted:1", "planted:0"]);
  painter.paint(context(calls), view, swapped);
  assert.deepEqual(drawingOrder(), ["second", "first"]);
  assert.deepEqual(swapped.planted.map(({ x, y, scale, rotation }) => ({ x, y, scale, rotation })), items.map(({ x, y, scale, rotation }) => ({ x, y, scale, rotation })));
  assert.deepEqual(decoded, images.map(image => image.dataUrl));
  painter.dispose();
});

test("unmodified scenes retain their original automatic depth order at both map sizes", () => {
  const painter = createForestPainter(() => { throw new Error("Scene lookup must not draw"); });
  for (const width of [INITIAL_WIDTH, MAX_WIDTH]) {
    const baseline = [...forestObjects(INITIAL_SEED, { x: 0, y: 0, width, height: WORLD_HEIGHT }), ...initialProps()]
      .sort((a, b) => objectDepth(a) - objectDepth(b) || a.x - b.x || a.id.localeCompare(b.id));
    assert.deepEqual(painter.objects(options({ width, removed: new Set() })).map(item => item.id), baseline.map(item => item.id));
  }
  painter.dispose();
});

test("layer order takes priority over manual object order and PNG export uses the same stacking", async () => {
  const images = [asset("back"), asset("front")], calls = [], native = new Map(images.map(image => [image.dataUrl, { name: image.id }]));
  const painter = createForestPainter(factory, undefined, async url => native.get(url));
  await painter.prepareAssets(images);
  const layers = [{ id: "back", name: "Back", visible: true, locked: false }, { id: "world", name: "World", visible: true, locked: false }, { id: "front", name: "Front", visible: true, locked: false }];
  const items = [imageObject(images[0], { id: "planted:back", layerId: "back", stackOrder: [65000] }), imageObject(images[1], { id: "planted:front", layerId: "front", stackOrder: [1] })];
  const settings = options({ layers, assets: new Map(images.map(image => [image.id, image])), planted: items });
  assert.deepEqual(painter.objects(settings).map(item => item.id), ["planted:back", "planted:front"]);
  painter.paint(context(calls), view, settings);
  assert.deepEqual(calls.filter(call => call[0] === "drawImage" && call[1].name).map(call => call[1].name), ["back", "front"]);
  calls.length = 0;
  const reordered = { ...settings, layers: [layers[2], layers[1], layers[0]] };
  painter.paint(context(calls), view, reordered);
  assert.deepEqual(calls.filter(call => call[0] === "drawImage" && call[1].name).map(call => call[1].name), ["front", "back"]);
  assert.ok(!calls.some(call => call[0] === "arc"), "export-style painting has no selection markers");
  painter.dispose();
});

test("object-list queries include hidden records while painting and export honor all visibility controls", async () => {
  const image = asset("visible"), native = {}, calls = [];
  const painter = createForestPainter(factory, undefined, async () => native);
  await painter.prepareAssets([image]);
  const layers = [{ id: "world", name: "World", visible: true, locked: false }, { id: "back", name: "Back", visible: false, locked: false }];
  const individual = imageObject(image, { id: "planted:individual", hidden: true });
  const byLayer = imageObject(image, { id: "planted:layer", layerId: "back" });
  const tree = { id: "planted:tree", kind: "tree", x: 700, y: 800, scale: 1, rotation: 0, variant: 0 };
  const settings = options({ layers, trees: false, assets: new Map([[image.id, image]]), planted: [individual, byLayer, tree] });
  assert.deepEqual(painter.objects(settings), []);
  assert.deepEqual(new Set(painter.objects({ ...settings, includeHidden: true }).map(item => item.id)), new Set([individual.id, byLayer.id, tree.id]));
  for (const selectedId of [individual.id, byLayer.id, undefined]) {
    calls.length = 0;
    assert.equal(painter.paint(context(calls), view, { ...settings, includeHidden: true, selectedId }).objects, 0);
    assert.ok(!calls.some(call => call[0] === "drawImage" && call[1] === native));
    assert.ok(!calls.some(call => call[0] === "arc"), "hidden objects do not show selection handles or an anchor");
  }
  calls.length = 0;
  const shown = { ...settings, layers: [layers[0], { ...layers[1], visible: true }] };
  assert.equal(painter.paint(context(calls), view, shown).objects, 1);
  assert.equal(calls.filter(call => call[0] === "drawImage" && call[1] === native).length, 1);
  painter.dispose();
});

test("locked objects and locked layers remain visible with a selection frame but no resize handles", async () => {
  const image = asset("locked"), native = {}, item = imageObject(image), calls = [];
  const painter = createForestPainter(factory, undefined, async () => native);
  await painter.prepareAssets([image]);
  const settings = options({ assets: new Map([[image.id, image]]), planted: [item], selectedId: item.id });
  painter.paint(context(calls), view, settings);
  assert.equal(calls.filter(call => call[0] === "arc" && call[3] === 7).length, 4);
  for (const locked of [{ ...settings, planted: [{ ...item, locked: true }] }, { ...settings, layers: [{ id: "world", name: "World", visible: true, locked: true }] }]) {
    calls.length = 0;
    painter.paint(context(calls), view, locked);
    assert.ok(calls.some(call => call[0] === "drawImage" && call[1] === native));
    assert.ok(calls.some(call => call[0] === "moveTo"), "locked selection still has a frame");
    assert.equal(calls.filter(call => call[0] === "arc" && call[3] === 7).length, 0);
  }
  painter.dispose();
});
