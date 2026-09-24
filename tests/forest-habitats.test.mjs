import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { habitatContains, habitatFlightTarget, habitatCanTraverse } = await vite.ssrLoadModule('/features/world/forest-habitats.ts');
const { createForestFauna, advanceForestFauna, requestFaunaInteraction } = await vite.ssrLoadModule('/features/world/forest-fauna.ts');
const rectangle = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const clearing = { id: 'clearing-butterflies', points: rectangle(95, 90, 110, 120) };
const forest = { id: 'forest-butterflies', species: 'butterfly', capacity: 3, points: rectangle(0, 0, 300, 300),
  exclusions: [clearing], anchors: [{ id: 'east-leaf', position: { x: 250, y: 150 }, kind: 'rest' },
    { id: 'west-shelter', position: { x: 40, y: 150 }, kind: 'shelter' }] };
const scene = { schemaVersion: 1, id: 'habitat-exclusion-test', width: 300, height: 300,
  focus: { x: 50, y: 50, width: 200, height: 200 }, terrain: [], sites: [], paths: [], habitats: [forest] };

test('the forest excludes the exact clearing contour and allows its surrounding habitat', () => {
  assert.equal(habitatContains(forest, { x: 150, y: 150 }), false);
  assert.equal(habitatContains(forest, { x: 95, y: 150 }), false, 'excluded boundary is not shared');
  assert.equal(habitatContains(forest, { x: 94, y: 150 }, 2), false, 'full flight clearance matters');
  assert.equal(habitatContains(forest, { x: 50, y: 150 }, 2), true);
  assert.equal(habitatContains(forest, { x: 310, y: 150 }), false);
});

test('spawning and the whole orbit avoid an exclusion for different stable seeds', () => {
  for (let seed = 0; seed < 64; seed++) {
    const state = createForestFauna(scene, seed);
    assert.equal(state.entities.length, 3);
    for (const e of state.entities) {
      assert.ok(habitatContains(forest, e, 2));
      for (let t = 0; t < 200; t++) {
        const o = e.orbit;
        assert.ok(habitatContains(forest, { x: o.x + Math.sin(t * o.sx + o.px) * o.rx,
          y: o.y + Math.sin(t * o.sy + o.py) * o.ry }, 2));
      }
    }
  }
});

test('a fully excluded habitat stays empty rather than spawning in the clearing', () => {
  const blocked = { ...forest, exclusions: [{ id: 'whole-area', points: rectangle(0, 0, 300, 300) }] };
  assert.deepEqual(createForestFauna({ ...scene, habitats: [blocked] }).entities, []);
});

test('independent orbit phases retain clearance beside diagonal clearing edges', () => {
  const diagonal = { ...forest, exclusions: [{ id: 'diagonal-clearing',
    points: [{ x: 30, y: 150 }, { x: 150, y: 30 }, { x: 270, y: 150 }, { x: 150, y: 270 }] }] };
  for (let seed = 0; seed < 80; seed++) {
    const state = createForestFauna({ ...scene, habitats: [diagonal] }, seed);
    for (const e of state.entities) {
      const o = e.orbit;
      // Frequencies differ: all combinations, including diagonal corners, need clearance.
      for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) {
        assert.ok(habitatContains(diagonal, { x: o.x + sx * o.rx, y: o.y + sy * o.ry }, 2));
      }
    }
  }
});

test('a cached flight route goes around the clearing and reaches the other side', () => {
  const position = { x: 40, y: 150 }, target = { x: 250, y: 150 };
  assert.equal(habitatCanTraverse(forest, position, target), false);
  let detoured = false;
  for (let tick = 0; tick < 1200 && Math.hypot(position.x - target.x, position.y - target.y) > .5; tick++) {
    const next = habitatFlightTarget(forest, position, target, tick * .025);
    assert.ok(next, 'a valid surrounding route exists');
    assert.ok(habitatCanTraverse(forest, position, next));
    const d = Math.hypot(next.x - position.x, next.y - position.y), amount = Math.min(.75, d);
    if (d) { position.x += (next.x - position.x) / d * amount; position.y += (next.y - position.y) / d * amount; }
    assert.ok(habitatContains(forest, position, 2));
    if (position.y < 90 || position.y > 210) detoured = true;
  }
  assert.ok(detoured); assert.ok(Math.hypot(position.x - target.x, position.y - target.y) < 1);
});

test('ambient rest, shelter and return flights never cross the excluded clearing', () => {
  const state = createForestFauna(scene), e = state.entities[0];
  state.entities = [e];
  Object.assign(e, { x: 40, y: 150, vx: 0, vy: 0, nextRestAt: 0 });
  Object.assign(e.orbit, { x: 40, y: 150, rx: 8, ry: 5 });
  let rested = false, sheltered = false;
  for (let tick = 0; tick < 4000; tick++) {
    const before = { x: e.x, y: e.y };
    advanceForestFauna(state, .025, { dusk: tick < 2000 ? 0 : 1, rain: 0 });
    assert.ok(habitatCanTraverse(forest, before, e), `safe segment at ${tick}, ${e.mode}`);
    if (e.mode === 'rest') rested = true;
    if (e.mode === 'refuge' && Math.hypot(e.x - 40, e.y - 150) < 3) sheltered = true;
  }
  assert.ok(rested, 'reached the east leaf without cutting through the hole');
  assert.ok(sheltered, 'returned to the west shelter at night');
});

test('forest residents cannot be requested into the excluded home clearing', () => {
  const state = createForestFauna(scene);
  Object.assign(state.entities[0], { x: 90, y: 150 });
  assert.equal(requestFaunaInteraction(state, 'butterfly', { x: 150, y: 170, size: 56 }, { dusk: 0, rain: 0 }, true), false);
});
