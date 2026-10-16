import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root, configFile: false, logLevel: 'silent', resolve: { alias: { '@': root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestTreeInteractions: create, touchForestTree: touch, hitForestTree: hit,
  advanceForestTreeInteractions: advance, clearForestTreeInteractions: clear,
  FOREST_TREE_INTERACTION_LIMITS: limits } = await vite.ssrLoadModule('/features/world/environment/trees/forest-tree-interactions.ts');
const { drawForestTreeCrownMotion: drawCrowns, drawForestTreeLeaves: drawLeaves }
  = await vite.ssrLoadModule('/features/world/environment/trees/forest-tree-interactions-painter.ts');
const { previewPointInPolygon: contains } = await vite.ssrLoadModule('/features/world/tiled/preview-state.ts');
const { TILED_WORLD: scene } = await vite.ssrLoadModule('/features/world/scene/presentation.ts');
const authoredMap = JSON.parse(await readFile(new URL('../world/tiled/forest.tmj', import.meta.url), 'utf8'));
function authoredCrowns(layers, inside = false) {
  return layers.flatMap(layer => {
    const active = inside || layer.name === 'TreeInteractions';
    return [...(active ? layer.objects ?? [] : []), ...authoredCrowns(layer.layers ?? [], active)];
  });
}
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const crown = (id, x = 10, frontY = 90) => ({ id, points: rect(x, 10, 60, 70), frontY });
const simple = { ...scene, treeInteractions: [crown('west-tree'), crown('east-canopy', 100)] };
const point = { x: 40, y: 35 }, second = { x: 130, y: 35 };
function inner(crown) {
  for (let y = crown.top + 1; y < crown.bottom; y += 2) for (let x = crown.left + 1; x < crown.right; x += 2) {
    if (contains({ x, y }, crown.points)) return { x, y };
  }
  throw new Error(`No inside point for ${crown.id}`);
}

test('every authored independent interaction crown reacts without consulting occluders', () => {
  const state = create(scene);
  const expected = authoredCrowns(authoredMap.layers).map(object => object.name).sort();
  assert.ok(expected.length > 0, 'the actual authoring map has independent touch crowns');
  assert.deepEqual(state.crowns.map(crown => crown.id).sort(), expected,
    'every current Tiled crown is interactive, including editor changes to their number');
  assert.ok(state.crowns.some(crown => crown.id === 'shishkolap-tree-touch'));
  for (const crown of state.crowns) assert.equal(hit(state, inner(crown)).id, crown.id);
  assert.deepEqual(create({ ...scene, occluders: [] }).crowns, state.crowns);
  assert.deepEqual(create({ ...scene, occluders: [crown('invented-tree')] }).crowns, state.crowns);
  assert.equal(create({ ...scene, treeInteractions: undefined }).crowns.length, 0, 'no fallback to occlusion masks');
  assert.equal(create({ ...scene, treeInteractions: [] }).crowns.length, 0);
});

test('adding moving and deleting a named interaction zone changes only its touch target', () => {
  const originalMasks = structuredClone(scene.occluders);
  const added = create({ ...scene, treeInteractions: [crown('my-new-crown')] });
  assert.equal(hit(added, point).id, 'my-new-crown', 'name needs no tree or canopy suffix');
  const moved = create({ ...scene, treeInteractions: [crown('my-new-crown', 100)] });
  assert.equal(hit(moved, point), null);
  assert.equal(hit(moved, second).id, 'my-new-crown');
  assert.equal(hit(create({ ...scene, treeInteractions: [] }), second), null);
  assert.deepEqual(scene.occluders, originalMasks);
});

test('hit testing follows the exact concave silhouette and the frontmost tree', () => {
  const concave = { ...crown('concave-tree'), points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 20 },
    { x: 20, y: 20 }, { x: 20, y: 80 }, { x: 0, y: 80 }] };
  const state = create({ ...scene, treeInteractions: [concave] });
  assert.equal(hit(state, { x: 50, y: 50 }), null, 'empty space inside the AABB stays empty');
  assert.equal(hit(state, { x: 10, y: 60 }).id, 'concave-tree');
  assert.equal(hit(state, { x: NaN, y: 20 }), null);
  assert.equal(hit(state, { x: 10, y: Infinity }), null);
  const overlap = create({ ...scene, treeInteractions: [crown('front-tree', 10, 120), crown('back-canopy', 10, 100)] });
  assert.equal(hit(overlap, point).id, 'front-tree');
});

test('missing and malformed tree geometry is inert', () => {
  for (const treeInteractions of [undefined, [], [{ ...crown('broken-tree'), frontY: NaN }],
    [{ ...crown('broken-tree'), points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] }],
    [{ ...crown('broken-tree'), points: [{ x: 0, y: NaN }, { x: 1, y: 0 }, { x: 0, y: 1 }] }]]) {
    const state = create({ ...scene, treeInteractions });
    assert.equal(hit(state, point), null);
    assert.equal(touch(state, point), null);
    assert.equal(state.leaves.length, 0);
  }
});

test('cooldowns suppress births and sound contacts but never let a crown tap fall through', () => {
  const state = create(simple);
  assert.deepEqual(touch(state, point, { now: 10 }), { treeId: 'west-tree', point });
  assert.equal(touch(state, point, { now: 10.1 }), null);
  assert.equal(touch(state, second, { now: 10.2 }), null);
  assert.equal(hit(state, point).id, 'west-tree');
  assert.ok(touch(state, second, { now: 10.4 }));
  assert.equal(touch(state, point, { now: 10.6 }), null);
  assert.ok(touch(state, point, { now: 10.8 }));
  assert.equal(state.bursts.length, 2, 'another contact refreshes the existing crown');
  assert.equal(state.leaves.length, limits.leavesPerTouch * 3);
  assert.equal(touch(state, { x: -300, y: 20 }, { now: 20 }), null);
  assert.equal(state.lastTouch, 10.8, 'a miss does not throttle a following valid tap');
  assert.equal(touch(state, point, { now: NaN }), null);
});

test('leaf births stay inside actual crowns and seeded motion is repeatable', () => {
  const first = create(scene), second = create(scene);
  for (let index = 0; index < first.crowns.length; index++) {
    const crown = first.crowns[index], contact = inner(crown);
    assert.ok(touch(first, contact, { now: index }));
    assert.ok(touch(second, contact, { now: index }));
    for (const leaf of first.leaves.slice(-limits.leavesPerTouch)) {
      assert.ok(contains({ x: leaf.originX, y: leaf.originY }, crown.points), crown.id);
    }
  }
  for (let index = 0; index < 20; index++) { advance(first, .04); advance(second, .04); }
  assert.deepEqual(first.leaves, second.leaves);
  assert.ok(first.leaves.every(leaf => Number.isFinite(leaf.x) && Number.isFinite(leaf.y) && leaf.opacity > 0 && leaf.opacity <= 1));
});

test('rapid taps on different trees retain bounded particles and crown animations', () => {
  const state = create(scene);
  for (let index = 0; index < 400; index++) {
    const crown = state.crowns[index % state.crowns.length];
    assert.ok(touch(state, inner(crown), { now: index }));
    assert.ok(state.bursts.length <= limits.bursts);
    assert.ok(state.leaves.length <= limits.leaves);
  }
  assert.equal(state.leaves.length, limits.leaves);
  assert.equal(state.bursts.length, limits.bursts);
  assert.ok(state.treeTouches.size <= state.crowns.length);
  for (let index = 0; index < 110; index++) advance(state, .04);
  assert.equal(state.leaves.length, 0);
  assert.equal(state.bursts.length, 0);
});

test('pause freezes motion, invalid time is ignored and resume cannot integrate a long gap', () => {
  const state = create(simple); touch(state, point);
  advance(state, .05);
  const before = structuredClone(state);
  for (const dt of [0, -1, NaN, Infinity]) advance(state, dt);
  advance(state, 100, { paused: true });
  assert.deepEqual(state, before);
  assert.equal(touch(state, second, { paused: true, now: 10 }), null);
  advance(state, 100);
  assert.ok(Math.abs(state.elapsed - .15) < 1e-9);
  assert.ok(state.leaves.length > 0);
});

test('reduced motion allows throttled sound contacts without retaining frozen particles', () => {
  const state = create(simple);
  assert.ok(touch(state, point, { reducedMotion: true, now: 1 }));
  assert.equal(state.leaves.length, 0); assert.equal(state.bursts.length, 0);
  assert.equal(touch(state, point, { reducedMotion: true, now: 1.5 }), null);
  assert.ok(touch(state, point, { reducedMotion: true, now: 2 }));
  assert.ok(touch(state, second, { now: 3 }));
  assert.ok(state.leaves.length > 0);
  advance(state, 0, { reducedMotion: true });
  assert.equal(state.leaves.length, 0); assert.equal(state.bursts.length, 0);
});

test('scene state is local and clearing removes all pending visual work', () => {
  const first = create(simple), second = create(simple);
  touch(first, point, { now: 10 });
  assert.equal(second.bursts.length, 0); assert.equal(second.leaves.length, 0);
  clear(first);
  assert.equal(first.bursts.length, 0); assert.equal(first.leaves.length, 0); assert.equal(first.treeTouches.size, 0);
  assert.ok(touch(first, point, { now: 10 }));
});

class Context {
  constructor() { this.draws = []; this.globalAlpha = 1; this.globalCompositeOperation = 'source-over'; this.stack = []; }
  save() { this.stack.push([this.globalAlpha, this.globalCompositeOperation]); }
  restore() { [this.globalAlpha, this.globalCompositeOperation] = this.stack.pop(); }
  drawImage(...args) { this.draws.push({ args, composite: this.globalCompositeOperation }); }
  setTransform() {} clearRect() {} beginPath() {} closePath() {} moveTo() {} lineTo() {} fill() {} stroke() {}
  translate() {} rotate() {} scale() {} quadraticCurveTo() {} bezierCurveTo() {}
}

test('painting is read-only, preserves caller alpha, and reuses one bounded local scratch surface', () => {
  const state = create(simple), target = new Context(), made = [], originalDocument = globalThis.document;
  globalThis.document = { createElement() {
    const context = new Context();
    const canvas = { width: 0, height: 0, getContext: () => context };
    made.push({ canvas, context }); return canvas;
  } };
  try {
    touch(state, point, { now: 0 }); touch(state, second, { now: 1 }); advance(state, .1); advance(state, .1);
    const before = structuredClone(state), image = { width: 1254, height: 1254 };
    const terrain = { id: 'backdrop', image: 'forest.webp', bounds: { x: 0, y: 0, width: 1254, height: 1254 } };
    target.globalAlpha = .63;
    drawCrowns(target, state, image, terrain); drawLeaves(target, state, { dusk: .8 });
    const allocated = made.length;
    drawCrowns(target, state, image, terrain); drawLeaves(target, state);
    assert.equal(made.length, allocated, 'repainting cached crowns allocates no new canvas');
    assert.equal(allocated, 3, 'two feather masks and one shared scratch surface');
    assert.ok(made.every(({ canvas }) => canvas.width <= 512 && canvas.height <= 512));
    assert.ok(made.some(({ context }) => context.draws.some(draw => draw.composite === 'destination-in')));
    assert.equal(target.globalAlpha, .63);
    assert.equal(target.stack.length, 0);
    assert.deepEqual(state, before);
    assert.ok(target.draws.every(({ args }) => args.length === 9 && args[7] < 100 && args[8] < 100),
      'only local crown rectangles are composited into world space');
    const count = target.draws.length;
    drawCrowns(target, state, image, terrain, { reducedMotion: true }); drawLeaves(target, state, { reducedMotion: true });
    assert.equal(target.draws.length, count);
  } finally { globalThis.document = originalDocument; }
});
