import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestPainter } = await vite.ssrLoadModule("/apps/engine/examples/forest/rendering/renderer.ts");
const { forestObjects, initialProps, objectCorners, objectDepth, INITIAL_SEED, INITIAL_WIDTH, WORLD_HEIGHT, MAX_WIDTH } = await vite.ssrLoadModule("/apps/engine/examples/forest/scene/objects.ts");
const { drawTerrain } = await vite.ssrLoadModule("/apps/engine/examples/forest/terrain/terrain.ts");
const { sampleGround, TRAILS } = await vite.ssrLoadModule("/apps/engine/examples/forest/terrain/layout.ts");
const { initialLighting } = await vite.ssrLoadModule("/apps/engine/examples/forest/lighting/lighting-data.ts");
const removed = new Set([...forestObjects(INITIAL_SEED, { x: 0, y: 0, width: INITIAL_WIDTH, height: WORLD_HEIGHT }), ...initialProps()].map(object => object.id));
const options = (overrides = {}) => ({ seed: INITIAL_SEED, width: INITIAL_WIDTH, trees: true, grid: false, removed, planted: [], ...overrides });
const asset = (id, overrides = {}) => ({ id, name: `${id}.png`, dataUrl: `data:image/png;base64,${id}`, width: 1200, height: 600, ...overrides });
const imageObject = (image, overrides = {}) => ({ id: "planted:image", kind: "image", assetId: image.id, imageWidth: 320, imageHeight: 160, x: 700, y: 800, scale: 1, rotation: 0, variant: 0, ...overrides });
const blankView = { x: 10000, y: 10000, width: 1, height: 1 };
const view = { x: 550, y: 600, width: 100, height: 100 };
function context(calls = []) {
  return new Proxy({}, {
    get: (_, key) => key === "createRadialGradient" || key === "createLinearGradient"
      ? () => ({ addColorStop() {} }) : key === "createImageData" ? (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
        : (...args) => calls.push([key, ...args]),
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

test("warm camera frames reuse prepared scene geometry and shadow artwork", () => {
  const items = Array.from({ length: 500 }, (_, index) => ({ id: `planted:${index}`, kind: "tree", x: 600 + index % 10 * 5,
    y: 800 + Math.floor(index / 10), scale: 1, rotation: 0, variant: 0 }));
  const painter = createForestPainter(factory), settings = options({ planted: items });
  painter.paint(context(), { x: 550, y: 600, width: 400, height: 400 }, settings);
  const warm = painter.diagnostics();
  assert.equal(warm.sceneBuilds, 1); assert.equal(warm.boundsComputed, 500); assert.equal(warm.shadowBuilds, 1);
  for (let index = 0; index < 5; index++) painter.paint(context(), { x: 540 + index * 10, y: 600 + index * 5, width: 400, height: 400 }, settings);
  assert.deepEqual(painter.diagnostics(), warm, "camera movement neither sorts the scene nor computes geometry nor creates shadows");
  const original = painter.objects(settings).map(item => item.id);
  painter.objects(settings).reverse();
  assert.deepEqual(painter.objects(settings).map(item => item.id), original, "list callers cannot mutate the painter's cached draw order");
  painter.dispose();
});

test("live preview replaces a base object, updates depth and culling, and leaves the committed cache intact", async () => {
  const images = [asset("preview-a"), asset("preview-b")], calls = [], native = new Map(images.map(image => [image.dataUrl, { name: image.id }]));
  const painter = createForestPainter(factory, undefined, async url => native.get(url));
  await painter.prepareAssets(images);
  const items = images.map((image, index) => imageObject(image, { id: `planted:${index}`, y: 800 + index * 50 }));
  const previewObjects = new Map(), settings = options({ assets: new Map(images.map(image => [image.id, image])), planted: items, previewObjects, previewRevision: 0 });
  const visible = { x: 500, y: 600, width: 500, height: 350 };
  painter.paint(context(), visible, settings);
  const prepared = painter.diagnostics().sceneBuilds;
  previewObjects.set(items[0].id, { ...items[0], y: 900 }); settings.previewRevision++;
  painter.paint(context(calls), visible, settings);
  assert.deepEqual(calls.filter(call => call[0] === "drawImage" && call[1].name).map(call => call[1].name), ["preview-b", "preview-a"]);
  assert.equal(painter.objects(settings).find(item => item.id === items[0].id).y, 900);
  assert.equal(items[0].y, 800);
  calls.length = 0;
  previewObjects.set(items[0].id, { ...items[0], y: 500 }); settings.previewRevision++;
  painter.paint(context(calls), visible, settings);
  assert.deepEqual(calls.filter(call => call[0] === "drawImage" && call[1].name).map(call => call[1].name), ["preview-b"], "the old position disappears while the preview is outside the viewport");
  previewObjects.clear(); settings.previewRevision++;
  painter.paint(context(), visible, settings);
  assert.equal(painter.diagnostics().sceneBuilds, prepared);
  assert.deepEqual(painter.objects(settings).map(item => item.y), [800, 850]);
  painter.dispose();
});

test("terrain edits and undo update only touched chunks while retaining base geometry and untouched composites", () => {
  const painter = createForestPainter(factory), calls = [], settings = options({ terrain: { baseTrails: true, cells: {} } });
  const visible = { x: 450, y: 50, width: 200, height: 300 };
  const tiles = () => calls.filter(call => call[0] === "drawImage" && call.length === 4).map(call => call[1]);
  painter.paint(context(calls), visible, settings); const base = tiles();
  assert.equal(base.length, 2);
  const warm = painter.diagnostics(); calls.length = 0;
  settings.terrain = { baseTrails: true, cells: { "3:3": "water" } };
  painter.paint(context(calls), visible, settings); const edited = tiles();
  assert.notEqual(edited[0], base[0]); assert.equal(edited[1], base[1]);
  assert.equal(painter.diagnostics().baseTerrainBuilds, warm.baseTerrainBuilds);
  assert.equal(painter.diagnostics().sceneBuilds, warm.sceneBuilds, "painting ground does not regenerate or sort objects");
  assert.equal(painter.diagnostics().terrainComposites, warm.terrainComposites + 1);
  painter.paint(context(), visible, settings);
  assert.equal(painter.diagnostics().terrainComposites, warm.terrainComposites + 1, "camera movement reuses the edited chunk");
  settings.terrain = { baseTrails: true, cells: {} }; calls.length = 0;
  painter.paint(context(calls), visible, settings);
  const restored = tiles();
  assert.equal(restored[1], base[1], "undo leaves unrelated composites intact");
  assert.deepEqual([restored[0].width, restored[0].height], [base[0].width, base[0].height]);
  assert.equal(painter.diagnostics().baseTerrainBuilds, warm.baseTerrainBuilds, "restoration reuses the original cached base geometry");
  painter.dispose();
});

test("terrain preview versions update neighbouring seam chunks and restore without changing committed cells", () => {
  const painter = createForestPainter(factory), calls = [], cells = new Map(), chunkVersions = new Map();
  const settings = options({ terrain: { baseTrails: true, cells: {} }, terrainPreview: { cells, chunkVersions } });
  const visible = { x: 450, y: 50, width: 200, height: 300 };
  const tiles = () => calls.filter(call => call[0] === "drawImage" && call.length === 4).map(call => call[1]);
  painter.paint(context(calls), visible, settings); const base = tiles(), warm = painter.diagnostics();
  cells.set("31:10", "path"); chunkVersions.set("0:0", 1); chunkVersions.set("1:0", 1); calls.length = 0;
  painter.paint(context(calls), visible, settings); const painted = tiles();
  assert.deepEqual(painted.map(canvas => [canvas.width, canvas.height]), base.map(canvas => [canvas.width, canvas.height]));
  assert.equal(painter.diagnostics().terrainComposites, warm.terrainComposites + 2);
  assert.deepEqual(settings.terrain.cells, {});
  painter.paint(context(), visible, settings); assert.equal(painter.diagnostics().terrainComposites, warm.terrainComposites + 2);
  cells.set("31:10", null); chunkVersions.set("0:0", 2); chunkVersions.set("1:0", 2); calls.length = 0;
  painter.paint(context(calls), visible, settings);
  assert.deepEqual(tiles().map(canvas => [canvas.width, canvas.height]), base.map(canvas => [canvas.width, canvas.height]));
  assert.equal(painter.diagnostics().baseTerrainBuilds, warm.baseTerrainBuilds);
  painter.dispose();
});

test("nested folder visibility and locks control drawing and group frames", async () => {
  const image = asset("folder"), native = {}, calls = [], painter = createForestPainter(factory, undefined, async () => native);
  await painter.prepareAssets([image]);
  const folders = [{ id: "group", name: "Group", parentId: null, visible: true, locked: false }, { id: "child", name: "Child", parentId: "group", visible: true, locked: false }];
  const item = imageObject(image, { folderId: "child" });
  const settings = options({ folders, assets: new Map([[image.id, image]]), planted: [item], selectedFolderId: "group" });
  painter.paint(context(calls), view, settings);
  assert.ok(calls.some(call => call[0] === "strokeRect"), "the parent group frame includes descendant objects");
  assert.ok(!calls.some(call => call[0] === "arc"), "a folder frame has no resize handles");
  calls.length = 0;
  painter.paint(context(calls), view, { ...settings, selectedFolderId: undefined, selectedId: item.id, folders: [{ ...folders[0], locked: true }, folders[1]] });
  assert.ok(calls.some(call => call[0] === "drawImage" && call[1] === native));
  assert.equal(calls.filter(call => call[0] === "arc" && call[3] === 7).length, 0, "an ancestor lock disables resize handles");
  const hidden = { ...settings, folders: [{ ...folders[0], visible: false }, folders[1]] }; calls.length = 0;
  assert.equal(painter.paint(context(calls), view, hidden).objects, 0);
  assert.equal(painter.objects({ ...hidden, includeHidden: true }).length, 1);
  assert.ok(!calls.some(call => call[0] === "drawImage" && call[1] === native));
  assert.ok(!calls.some(call => call[0] === "strokeRect"));
  painter.dispose();
});

test("brush and area outlines are transient drawing options omitted from a normal export", () => {
  const painter = createForestPainter(factory), calls = [], settings = options();
  painter.paint(context(calls), view, { ...settings, brushCursor: { x: 600, y: 650, diameter: 120 }, selectionArea: { x: 580, y: 620, width: 40, height: 30 } });
  assert.ok(calls.some(call => call[0] === "arc" && call[1] === 600 && call[2] === 650 && call[3] === 60));
  assert.ok(calls.some(call => call[0] === "strokeRect" && call[1] === 580 && call[3] === 40));
  calls.length = 0; painter.paint(context(calls), view, settings);
  assert.ok(!calls.some(call => call[0] === "arc" || call[0] === "strokeRect"));
  painter.dispose();
});

test("hiding baseline trails removes their strokes and path sampling while keeping the default drawing contract", () => {
  const standard = [], explicit = [], hidden = [], bounds = { x: 500, y: 600, width: 200, height: 200 };
  drawTerrain(context(standard), INITIAL_SEED, bounds);
  drawTerrain(context(explicit), INITIAL_SEED, bounds, true);
  drawTerrain(context(hidden), INITIAL_SEED, bounds, false);
  assert.equal(JSON.stringify(standard), JSON.stringify(explicit));
  assert.equal(standard.filter(call => call[0] === "stroke").length - hidden.filter(call => call[0] === "stroke").length, TRAILS.length * 5);
  assert.ok(sampleGround(620, 773).path > .9);
  assert.equal(sampleGround(620, 773, false).path, 0);
});

const distantTrees = (count, start = 0) => Array.from({ length: count }, (_, index) => ({ id: `planted:cache-${start + index}`, kind: "tree",
  x: 1200 + index % 10, y: 1200 + Math.floor(index / 10), scale: 1, rotation: 0, variant: 0 }));

test("interactive low-zoom bitmap reuses static objects across camera and terrain changes within its memory budget", () => {
  const painter = createForestPainter(factory), calls = [], settings = options({ planted: distantTrees(500), interactiveCache: true, renderScale: .5,
    terrain: { baseTrails: true, cells: {} } });
  const visible = { x: 1000, y: 1000, width: 400, height: 400 };
  painter.paint(context(calls), visible, settings);
  const warm = painter.diagnostics();
  assert.ok(warm.staticTileBuilds > 0); assert.ok(warm.staticPixels <= MAX_WIDTH * WORLD_HEIGHT + 514 ** 2);
  calls.length = 0; painter.paint(context(calls), { ...visible, x: 1010 }, settings);
  assert.equal(painter.diagnostics().staticTileBuilds, warm.staticTileBuilds);
  assert.ok(!calls.some(call => call[0] === "translate"), "warm static objects are drawn as one bitmap instead of individual sprites");
  settings.terrain = { baseTrails: true, cells: { "65:65": "water" } };
  painter.paint(context(), visible, settings);
  assert.equal(painter.diagnostics().staticTileBuilds, warm.staticTileBuilds, "ground painting does not rebuild the transparent actor bitmap");
  calls.length = 0; painter.paint(context(calls), visible, { ...settings, interactiveCache: false, renderScale: 1 });
  assert.ok(calls.some(call => call[0] === "translate" && call[1] >= 1200), "export-style rendering uses the individual original drawing sources");
  assert.equal(painter.diagnostics().staticTileBuilds, warm.staticTileBuilds);
  painter.dispose();
});

test("cached live preview repairs opaque ground before drawing lower and higher alpha layers in depth order", async () => {
  const images = [asset("repair-a"), asset("repair-b")], calls = [], native = new Map(images.map(image => [image.dataUrl, { name: image.id }]));
  const painter = createForestPainter(factory, undefined, async url => native.get(url));
  await painter.prepareAssets(images);
  const items = images.map((image, index) => imageObject(image, { id: `planted:repair-${index}`, y: 800 + index * 50 }));
  const previewObjects = new Map(), settings = options({ planted: [...items, ...distantTrees(498)], assets: new Map(images.map(image => [image.id, image])),
    interactiveCache: true, renderScale: .5, previewObjects, previewRevision: 0 });
  const visible = { x: 500, y: 600, width: 500, height: 350 };
  painter.paint(context(), visible, settings); const warm = painter.diagnostics().staticTileBuilds;
  previewObjects.set(items[0].id, { ...items[0], y: 820 }); settings.previewRevision++;
  painter.paint(context(calls), visible, settings);
  const sourceCalls = calls.map((call, index) => ({ call, index })).filter(({ call }) => call[0] === "drawImage" && call[1].name);
  assert.deepEqual(sourceCalls.map(({ call }) => call[1].name), ["repair-a", "repair-b"], "an object behind another PNG does not jump above it during a cached drag");
  const clip = calls.findLastIndex(call => call[0] === "clip");
  assert.ok(clip >= 0 && clip < sourceCalls[0].index);
  assert.ok(calls.slice(clip + 1, sourceCalls[0].index).some(call => call[0] === "drawImage" && call.length === 4 && call[1].width === 514), "opaque ground replaces the old alpha composite before the patch is rebuilt");
  assert.ok(painter.diagnostics().staticTileBuilds > warm, "the original position is removed from affected static tiles");
  const dragging = painter.diagnostics().staticTileBuilds;
  previewObjects.set(items[0].id, { ...items[0], y: 830 }); settings.previewRevision++;
  painter.paint(context(), visible, settings);
  assert.equal(painter.diagnostics().staticTileBuilds, dragging, "moving an existing preview does not rebuild its static neighbours");
  previewObjects.clear(); settings.previewRevision++; calls.length = 0;
  painter.paint(context(calls), visible, settings);
  assert.ok(painter.diagnostics().staticTileBuilds > dragging, "cancel restores the original object into its static tiles");
  assert.ok(!calls.some(call => call[0] === "drawImage" && call[1].name));
  assert.equal(painter.objects(settings).find(object => object.id === items[0].id).y, 800);
  painter.dispose();
});

test("committed object changes invalidate only their footprint and source readiness replaces cached PNG placeholders", async () => {
  const image = asset("ready"), native = { name: "ready" }, recorded = [];
  let complete;
  const painter = createForestPainter((width, height) => ({ width, height, getContext: () => context(recorded) }), undefined,
    () => new Promise(resolve => { complete = resolve; }));
  const item = imageObject(image), settings = options({ planted: [item, ...distantTrees(499)], assets: new Map([[image.id, image]]), interactiveCache: true, renderScale: .5 });
  const visible = { x: 450, y: 600, width: 500, height: 350 };
  painter.paint(context(), visible, settings); const pending = painter.diagnostics().staticTileBuilds;
  await Promise.resolve(); complete(native); await flush(); recorded.length = 0;
  painter.paint(context(), visible, settings);
  assert.ok(painter.diagnostics().staticTileBuilds > pending);
  assert.ok(recorded.some(call => call[0] === "drawImage" && call[1] === native), "source decode invalidates the cached placeholder");
  const ready = painter.diagnostics().staticTileBuilds;
  settings.planted = [{ ...item, x: 710 }, ...settings.planted.slice(1)]; settings.objectRevision = 1;
  painter.paint(context(), visible, settings);
  assert.equal(painter.diagnostics().staticTileBuilds, ready + 1, "unrelated previously cached chunks remain valid after a position change");
  painter.dispose();
});

test("lighting honors inherited folder visibility, shades before editor overlays and preserves decoded PNG sources", async () => {
  const image = asset("lit-original"), native = { original: true }, calls = [], painter = createForestPainter(factory, undefined, async () => native);
  await painter.prepareAssets([image]);
  const item = imageObject(image, { shadowHeight: 120 });
  const lighting = { ...initialLighting(), enabled: true, ambient: .4 };
  const settings = options({ planted: [item], assets: new Map([[image.id, image]]), selectedId: item.id, lighting });
  painter.paint(context(calls), view, settings);
  assert.ok(calls.some(call => call[0] === "drawImage" && call[1] === native), "the original source still draws the object");
  const illumination = calls.findIndex(call => call[0] === "set" && call[1] === "globalCompositeOperation" && call[2] === "multiply");
  const handle = calls.findIndex(call => call[0] === "arc" && call[3] === 7);
  assert.ok(illumination >= 0 && illumination < handle, "selection handles are drawn after the scene's lighting pass");
  const warm = painter.diagnostics().lighting;
  calls.length = 0;
  painter.paint(context(calls), view, { ...settings, folders: [{ id: "images", name: "Images", parentId: null, visible: false, locked: false }] });
  assert.ok(!calls.some(call => call[0] === "drawImage" && call[1] === native));
  assert.ok(painter.diagnostics().lighting.sunBuilds > warm.sunBuilds, "hiding a folder erases the previous cast shadow");
  assert.equal(image.dataUrl, settings.assets.get(image.id).dataUrl);
  painter.dispose();
});

test("two restored PNGs decoded before the next frame both refresh their cached shadow alpha and export sources", async () => {
  const images = [asset("restored-a"), asset("restored-b")], native = images.map(image => ({ name: image.id }));
  const pending = new Map(), decoded = [], masks = [];
  const painter = createForestPainter((width, height) => ({ width, height, getContext: () => context(masks) }), undefined, url => {
    decoded.push(url); return new Promise(resolve => pending.set(url, resolve));
  });
  const items = images.map((image, index) => imageObject(image, { id: `planted:restored-${index}`, x: 700 + index * 80, shadowHeight: 100 }));
  const lighting = { ...initialLighting(), enabled: true };
  const settings = options({ planted: items, assets: new Map(images.map(image => [image.id, image])), lighting });
  const fullView = { x: 0, y: 0, width: INITIAL_WIDTH, height: WORLD_HEIGHT };
  painter.paint(context(), fullView, settings);
  await Promise.resolve();
  for (let index = 0; index < images.length; index++) pending.get(images[index].dataUrl)(native[index]);
  // Both completions invalidate cache state without an intervening render, as during a reload.
  await painter.prepareAssets(images); masks.length = 0;
  painter.paint(context(), fullView, settings);
  for (const source of native) assert.ok(masks.some(call => call[0] === "drawImage" && call[1] === source), "both ready PNGs must reach the alpha projection cache");
  const ready = painter.diagnostics().lighting, exported = [];
  painter.paint(context(exported), fullView, { ...settings, assets: new Map(settings.assets), lighting: { ...lighting }, interactiveCache: false, selectedId: null });
  for (const source of native) assert.ok(exported.some(call => call[0] === "drawImage" && call[1] === source), "PNG export keeps each decoded original source");
  assert.equal(painter.diagnostics().lighting.sunBuilds, ready.sunBuilds, "export reuses the complete, refreshed shadow masks");
  assert.deepEqual(decoded, images.map(image => image.dataUrl));
  painter.dispose();
});

test("a replaced asset with unchanged object identity refreshes its alpha after the new scene becomes active", async () => {
  const original = asset("same-id"), replacement = { ...original, dataUrl: original.dataUrl + "replacement" };
  const oldSource = { name: "old pixels" }, newSource = { name: "replacement pixels" }, masks = [], decoded = [];
  const painter = createForestPainter((width, height) => ({ width, height, getContext: () => context(masks) }), undefined, async url => {
    decoded.push(url); return url === original.dataUrl ? oldSource : newSource;
  });
  const item = imageObject(original), fullView = { x: 0, y: 0, width: INITIAL_WIDTH, height: WORLD_HEIGHT };
  const settings = options({ planted: [item], assets: new Map([[original.id, original]]), lighting: { ...initialLighting(), enabled: true } });
  await painter.prepareAssets([original]); painter.paint(context(), fullView, settings);
  // Decoding occurs while the current scene still references the original source.
  await painter.prepareAssets([replacement]); masks.length = 0;
  const next = { ...settings, assets: new Map([[replacement.id, replacement]]) }, exported = [];
  painter.paint(context(exported), fullView, next);
  assert.ok(masks.some(call => call[0] === "drawImage" && call[1] === newSource), "the cached caster must use the active scene's alpha");
  assert.ok(!masks.some(call => call[0] === "drawImage" && call[1] === oldSource));
  assert.ok(exported.some(call => call[0] === "drawImage" && call[1] === newSource));
  assert.ok(!exported.some(call => call[0] === "drawImage" && call[1] === oldSource));
  assert.deepEqual(decoded, [original.dataUrl, replacement.dataUrl]);
  painter.dispose();
});
