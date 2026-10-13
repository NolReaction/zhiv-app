import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestObjects, canPlant, pickObject, INITIAL_WIDTH, MAX_WIDTH, WORLD_HEIGHT, INITIAL_SEED } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/objects.ts");
const { sampleGround } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/layout.ts");
const { createForestPainter } = await vite.ssrLoadModule("/features/world/dev/procedural-forest/renderer.ts");
const bounds = Object.freeze({ x: 0, y: 0, width: INITIAL_WIDTH, height: WORLD_HEIGHT });
const original = forestObjects(INITIAL_SEED, bounds);
const painter = () => createForestPainter(() => { throw new Error("Object queries must not allocate drawing surfaces"); });
const options = (overrides = {}) => ({ seed: INITIAL_SEED, width: INITIAL_WIDTH, trees: true, grid: false, removed: new Set(), planted: [], ...overrides });

test("the same seed recreates independent objects with stable, unique IDs", () => {
  const recreated = forestObjects(INITIAL_SEED, bounds);
  assert.ok(original.length > 0);
  assert.deepEqual(recreated, original);
  assert.equal(new Set(recreated.map(object => object.id)).size, recreated.length);
  assert.notEqual(recreated[0], original[0]);
  recreated[0].x += 100;
  assert.deepEqual(forestObjects(INITIAL_SEED, bounds), original, "editing a returned list cannot change future generation");
});

test("both eastward extensions preserve every original object, including the overscan margin", () => {
  assert.ok(original.some(object => object.x > INITIAL_WIDTH), "the initial map includes trees rooted beyond its visible eastern edge");
  for (const width of [INITIAL_WIDTH + 800, MAX_WIDTH]) {
    const expanded = forestObjects(INITIAL_SEED, { ...bounds, width });
    const byId = new Map(expanded.map(object => [object.id, object]));
    for (const object of original) assert.deepEqual(byId.get(object.id), object, `extension to ${width} changed ${object.id}`);
    assert.ok(expanded.some(object => object.x > INITIAL_WIDTH + 200 && object.x < width));
  }
});

test("independently requested neighbouring areas agree throughout their overlap", () => {
  const left = forestObjects(INITIAL_SEED, { x: 0, y: 0, width: 800, height: WORLD_HEIGHT });
  const right = forestObjects(INITIAL_SEED, { x: 800, y: 0, width: 800, height: WORLD_HEIGHT });
  const inOverlap = objects => objects.filter(object => object.x >= 680 && object.x <= 920);
  assert.ok(inOverlap(left).length > 0);
  assert.deepEqual(inOverlap(left), inOverlap(right));
});

test("a different seed changes the forest while preserving valid object placement", () => {
  const another = forestObjects(INITIAL_SEED + 137, bounds);
  assert.notDeepEqual(another, original);
  for (const object of [...original, ...another]) {
    const ground = sampleGround(object.x, object.y);
    assert.ok(ground.water < 0, `${object.id} is rooted in water`);
    assert.ok(ground.path < .2, `${object.id} blocks a main trail`);
    assert.ok(Number.isFinite(object.x) && Number.isFinite(object.y) && object.scale > 0);
  }
});

test("planting rejects water, trails and coordinates outside the open map", () => {
  assert.equal(canPlant(200, 620, INITIAL_WIDTH), true, "open grass can receive a tree");
  assert.equal(canPlant(1500, 1400, INITIAL_WIDTH), false, "lake water cannot receive a tree");
  assert.equal(canPlant(620, 773, INITIAL_WIDTH), false, "the middle of a trail stays open");
  assert.equal(canPlant(730, 400, INITIAL_WIDTH), false, "ruins cannot receive a tree");
  assert.equal(canPlant(1320, 1060, INITIAL_WIDTH), false, "the quay stays clear");
  for (const [x, y] of [[-1, 500], [INITIAL_WIDTH + 1, 500], [500, -1], [500, WORLD_HEIGHT + 1], [NaN, 500], [500, NaN], [Infinity, 500]]) {
    assert.equal(canPlant(x, y, INITIAL_WIDTH), false);
  }
  assert.equal(canPlant(1900, 100, INITIAL_WIDTH), false);
  assert.equal(canPlant(1900, 100, MAX_WIDTH), true, "newly opened land becomes editable");
});

test("object queries preserve edits and inputs while extending or hiding vegetation", () => {
  const renderer = painter();
  const removedObject = original.find(object => object.kind === "tree");
  const planted = Object.freeze([{ id: "planted:test", x: 200, y: 620, scale: 1, variant: 2, kind: "tree" }].map(Object.freeze));
  const removed = new Set([removedObject.id]);
  const edited = options({ planted, removed });
  const visible = renderer.objects(edited);
  assert.ok(visible.some(object => object.id === "planted:test"));
  assert.ok(!visible.some(object => object.id === removedObject.id));
  const expanded = renderer.objects({ ...edited, width: MAX_WIDTH });
  assert.ok(expanded.some(object => object.id === "planted:test"));
  assert.ok(!expanded.some(object => object.id === removedObject.id));
  const groundOnly = renderer.objects({ ...edited, trees: false });
  assert.ok(groundOnly.length > 0);
  assert.ok(groundOnly.every(object => object.kind === "rock"));
  assert.deepEqual(renderer.objects(edited), visible, "layer visibility never destroys objects");
  assert.deepEqual([...removed], [removedObject.id]);
  assert.equal(planted.length, 1);
  assert.deepEqual(renderer.objects(options()), original, "discarding edit state restores the original forest");
  renderer.dispose();
});

test("picking overlapping objects selects the frontmost visible object in painter order", () => {
  const renderer = painter();
  const back = Object.freeze({ id: "planted:back", x: 620, y: 1000, scale: 1, variant: 0, kind: "tree" });
  const front = Object.freeze({ ...back, id: "planted:front", y: 1020 });
  const planted = Object.freeze([front, back]);
  const ordered = renderer.objects(options({ removed: new Set(original.map(object => object.id)), planted }));
  assert.deepEqual(ordered.map(object => object.id), [back.id, front.id]);
  assert.equal(pickObject(ordered, 620, 970)?.id, front.id);
  assert.equal(pickObject(ordered.filter(object => object.id !== front.id), 620, 970)?.id, back.id);
  assert.equal(pickObject(ordered, 100, 100), undefined);
  assert.equal(pickObject(ordered, NaN, 970), undefined);
  assert.deepEqual(planted, [front, back], "sorting for drawing must not reorder caller data");
  renderer.dispose();
});
