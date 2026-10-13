import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestObjects, initialProps, objectBounds, objectDepth, pickObject, INITIAL_WIDTH, MAX_WIDTH, WORLD_HEIGHT, INITIAL_SEED } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/objects.ts");
const { createForestPainter } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/renderer.ts");
const options = (overrides = {}) => ({ seed: INITIAL_SEED, width: INITIAL_WIDTH, trees: true, grid: false, removed: new Set(), planted: [], ...overrides });
const queryPainter = () => createForestPainter(() => { throw new Error("Scene queries must not allocate drawing surfaces"); });
const generated = forestObjects(INITIAL_SEED, { x: 0, y: 0, width: INITIAL_WIDTH, height: WORLD_HEIGHT });

test("default props preserve their anchors and authored painter depths", () => {
  const props = initialProps();
  assert.deepEqual(props.map(object => [object.id, object.x, object.y, objectDepth(object)]), [
    ["prop:ruins", 780, 420, 440], ["prop:jetty", 1330, 1070, 1140], ["prop:bridge", 749, 1249, 1280],
  ]);
  props[0].x = 100;
  assert.equal(initialProps()[0].x, 780, "scene edits cannot mutate the default props");
  const painter = queryPainter();
  assert.deepEqual(painter.objects(options()), painter.objects(options()), "default ordering is deterministic");
  assert.equal(painter.objects(options()).length, generated.length + 3);
  painter.dispose();
});

test("all object kinds accept edits and removal while the vegetation layer hides only vegetation", () => {
  const painter = queryPainter();
  const planted = ["tree", "shrub", "rock", "ruins", "bridge", "jetty", "image"].map((kind, index) =>
    Object.freeze({ id: `planted:${kind}`, x: 200 + index * 50, y: 620, scale: 1, variant: 2, kind,
      ...(kind === "image" ? { assetId: "png:test", imageWidth: 320, imageHeight: 160 } : {}) }));
  const editedRock = Object.freeze({ ...planted[2], x: 400, y: 650, scale: 2, rotation: 31 });
  const movedBridge = Object.freeze({ ...initialProps().find(object => object.kind === "bridge"), x: 300, y: 700, rotation: 90 });
  const removed = new Set(["prop:jetty", "planted:ruins"]);
  const modified = new Map([[editedRock.id, editedRock], [movedBridge.id, movedBridge]]);
  const scene = painter.objects(options({ planted, removed, modified, trees: false }));
  assert.ok(scene.every(object => object.kind !== "tree" && object.kind !== "shrub"));
  assert.equal(scene.find(object => object.id === editedRock.id), editedRock);
  assert.equal(scene.find(object => object.id === movedBridge.id), movedBridge);
  assert.ok(scene.some(object => object.id === "planted:bridge"));
  assert.ok(scene.some(object => object.id === "planted:jetty"));
  assert.ok(scene.some(object => object.id === "planted:image"));
  assert.ok(!scene.some(object => removed.has(object.id)));
  const restoredLayer = painter.objects(options({ planted, removed, modified }));
  assert.ok(restoredLayer.some(object => object.id === "planted:tree"));
  assert.equal(planted[2].x, 300, "queries leave caller-owned records untouched");
  assert.deepEqual([...removed], ["prop:jetty", "planted:ruins"]);
  painter.dispose();
});

test("moving a generated object persists through expansion and shrinking of its original area", () => {
  const painter = queryPainter();
  const eastern = forestObjects(INITIAL_SEED, { x: 0, y: 0, width: MAX_WIDTH, height: WORLD_HEIGHT }).find(object => object.x > 2300);
  const moved = Object.freeze({ ...eastern, x: 400, y: 500, scale: 1.4, rotation: -42 });
  const modified = new Map([[moved.id, moved]]);
  for (const width of [MAX_WIDTH, INITIAL_WIDTH, INITIAL_WIDTH + 800, MAX_WIDTH]) {
    const scene = painter.objects(options({ width, modified }));
    assert.equal(scene.find(object => object.id === moved.id), moved);
    assert.equal(scene.filter(object => object.id === moved.id).length, 1);
  }
  assert.deepEqual([...modified.values()], [moved]);
  painter.dispose();
});

test("picking and world bounds follow rotation and scale for all seven kinds", () => {
  for (const kind of ["tree", "shrub", "rock", "ruins", "bridge", "jetty", "image"]) {
    const object = { id: `test:${kind}`, kind, x: 600, y: 800, scale: 2.7, variant: 0, rotation: 123,
      ...(kind === "image" ? { assetId: "png:test", imageWidth: 320, imageHeight: 160 } : {}) };
    const angle = object.rotation * Math.PI / 180 + (kind === "bridge" ? .22 : kind === "jetty" ? .36 : 0);
    const local = kind === "tree" ? [0, -69] : kind === "shrub" ? [0, -20] : kind === "rock" ? [0, -12]
      : kind === "jetty" ? [50, 20] : [0, -20];
    const x = object.x + object.scale * (local[0] * Math.cos(angle) - local[1] * Math.sin(angle));
    const y = object.y + object.scale * (local[0] * Math.sin(angle) + local[1] * Math.cos(angle));
    assert.equal(pickObject([object], x, y), object, `${kind} is selectable at its transformed silhouette`);
    const bounds = objectBounds(object);
    assert.ok(x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height);
    assert.equal(pickObject([object], bounds.x - 10, bounds.y - 10), undefined);
  }
});

test("picking uses the same authored depth as rendering, independently of input order", () => {
  const ruins = { ...initialProps()[0], x: 400, y: 500 };
  const tree = { id: "test:tree", kind: "tree", x: 400, y: 510, scale: 1, variant: 0 };
  assert.equal(objectDepth(ruins), 520);
  assert.equal(pickObject([ruins, tree], 400, 470), ruins);
  assert.equal(pickObject([tree, ruins], 400, 470), ruins);
  assert.deepEqual([ruins, tree].map(object => object.id), ["prop:ruins", "test:tree"]);
});

test("painting respects removed props, scaled footprints and optional selection overlays", () => {
  const calls = [];
  const context = (record = false) => new Proxy({}, {
    get: (_, key) => key === "createRadialGradient" || key === "createLinearGradient"
      ? () => ({ addColorStop() {} }) : (...args) => { if (record) calls.push([key, ...args]); },
    set: () => true,
  });
  const painter = createForestPainter((width, height) => ({ width, height, getContext: () => context() }));
  const ruins = { ...initialProps()[0], x: 900, y: 420, scale: 8, rotation: 0 };
  const removed = new Set([...generated, ...initialProps()].filter(object => object.id !== ruins.id).map(object => object.id));
  const sceneOptions = options({ removed, modified: new Map([[ruins.id, ruins]]) });
  const view = { x: 1450, y: 300, width: 100, height: 100 };
  assert.equal(painter.paint(context(true), view, sceneOptions).objects, 1);
  assert.ok(calls.some(call => call[0] === "translate" && call[1] === 900 && call[2] === 420), "a large prop is painted when its footprint enters the viewport");
  assert.ok(!calls.some(call => call[0] === "translate" && ((call[1] === 749 && call[2] === 1249) || (call[1] === 1330 && call[2] === 1070))), "removed props are not painted at fixed coordinates");
  assert.ok(!calls.some(call => call[0] === "arc"), "export-style painting has no selection handles");
  calls.length = 0;
  painter.paint(context(true), view, { ...sceneOptions, selectedId: ruins.id });
  assert.equal(calls.filter(call => call[0] === "arc").length, 5, "the rotated frame has four corner handles and an anchor");
  calls.length = 0;
  painter.paint(context(true), view, { ...sceneOptions, removed: new Set([...removed, ruins.id]) });
  assert.ok(!calls.some(call => call[0] === "translate" && call[1] === 900 && call[2] === 420));
  painter.dispose();
});
