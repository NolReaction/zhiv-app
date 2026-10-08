import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ configFile: false, root, resolve: { alias: { '@': root } },
  server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createForestFauna, advanceForestFauna, requestFaunaInteraction, cancelFaunaInteraction, faunaRenderFrame } =
  await vite.ssrLoadModule('/features/world/environment/wildlife/forest-fauna.ts');
const rectangle = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const conditions = { dusk: 0, rain: 0 };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const scene = { schemaVersion: 1, id: 'landing-reservations', width: 300, height: 300,
  focus: { x: 22, y: 22, width: 256, height: 256 }, sites: [], paths: [], habitats: [] };
const habitat = (id, species, capacity, kind = 'rest') => ({ id, species, capacity,
  points: rectangle(1, 1, 298, 298), anchors: [{ id: `${id}-leaf`, kind, position: { x: 150, y: 150 } }] });
const advance = (state, seconds, options = conditions, inspect) => {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += .025) {
    advanceForestFauna(state, Math.min(.025, seconds - elapsed), options); inspect?.(state);
  }
};
function reservations(state) {
  return state.entities.filter(e => e.anchorId && ['rest-seek', 'rest', 'refuge'].includes(e.mode)).map(e => {
    const anchor = state.habitats.find(h => h.id === e.habitatId).anchors.find(a => a.id === e.anchorId);
    return { e, position: { x: anchor.position.x + e.anchorOffset.x, y: anchor.position.y + e.anchorOffset.y } };
  });
}
function assertSpaced(state) {
  const landings = reservations(state);
  for (let i = 0; i < landings.length; i++) for (let j = i + 1; j < landings.length; j++) {
    const a = landings[i], b = landings[j];
    // Folded butterfly wings are taller than the beetle body; include their visible extent.
    const radius = e => e.size * (e.species === 'butterfly' ? 2.4 : 1.4);
    const clear = radius(a.e) + radius(b.e);
    assert.ok(distance(a.position, b.position) > clear, `reserved leaves overlap: ${a.e.id}, ${b.e.id}`);
    if (distance(a.e, a.position) < .65 && distance(b.e, b.position) < .65) {
      assert.ok(distance(a.e, b.e) > clear, `landed bodies overlap: ${a.e.id}, ${b.e.id}`);
    }
  }
}

test('different leaf IDs at the same position reserve one seat before either insect lands', () => {
  const state = createForestFauna({ ...scene, habitats: [habitat('west', 'butterfly', 3), habitat('east', 'butterfly', 3)] });
  state.entities.forEach((e, i) => Object.assign(e, { x: 40 + i * 12, y: 80, vx: 0, vy: 0, nextRestAt: 0 }));
  const before = structuredClone(state.entities);
  advance(state, .025);
  assert.equal(reservations(state).length, 1, 'inbound rest-seek already owns the actual leaf');
  assert.equal(reservations(state)[0].e.mode, 'rest-seek');
  state.entities.forEach((e, i) => assert.ok(distance(e, before[i]) < 23 * .025));
  let rested = false;
  advance(state, 100, conditions, () => {
    assert.equal(reservations(state).length <= 1, true);
    rested ||= state.entities.some(e => e.mode === 'rest');
  });
  assert.ok(rested);
});

test('crowded shelter has finite spaced seats, retries overflow and ignores species and draw order', () => {
  const crowded = { ...scene, habitats: [habitat('day', 'butterfly', 6, 'shelter'), habitat('night', 'firefly', 12, 'shelter')] };
  for (let seed = 1; seed <= 6; seed++) {
    const state = createForestFauna(crowded, seed), reverse = createForestFauna(crowded, seed);
    reverse.entities.reverse();
    const identities = state.entities.map(e => e.id);
    for (const dusk of [0, 1, 0]) {
      advance(state, 20, { dusk, rain: 1 }, () => assertSpaced(state));
      advance(reverse, 20, { dusk, rain: 1 });
      assert.deepEqual(state.entities, [...reverse.entities].reverse(), 'reservation winners are deterministic');
      const occupied = reservations(state);
      assert.ok(occupied.length >= 3 && occupied.length < 18, 'full foliage never packs in overflow');
      assert.ok(occupied.every(({ position }) => distance(position, { x: 150, y: 150 }) < 10.01));
      assert.ok(state.entities.some(e => e.mode === 'fly' || e.mode === 'return'));
    }
    const leaving = reservations(state)[0].e;
    const waiting = new Set(state.entities.filter(e => !e.anchorId).map(e => e.id));
    state.entities = state.entities.filter(e => e !== leaving);
    let filled = false;
    advance(state, 20, { dusk: 1, rain: 1 }, () => {
      assertSpaced(state);
      filled ||= reservations(state).some(({ e }) => waiting.has(e.id));
    });
    assert.ok(filled, 'freed foliage is eventually claimed, without a stale separate occupancy lock');
    assert.deepEqual(state.entities.map(e => e.id), identities.filter(id => id !== leaving.id));
  }
});

test('an invited resting insect releases the leaf, but a replacement waits until the body has actually left', () => {
  const state = createForestFauna({ ...scene, habitats: [habitat('day', 'butterfly', 2)] });
  const [visitor, waiting] = state.entities;
  Object.assign(visitor, { x: 145, y: 145, vx: 0, vy: 0, nextRestAt: 0 });
  Object.assign(waiting, { x: 100, y: 110, vx: 0, vy: 0, nextRestAt: 100, cooldownUntil: 100 });
  advance(state, 4);
  assert.equal(visitor.mode, 'rest');
  const actor = { x: 155, y: 190, size: 56 };
  assert.equal(requestFaunaInteraction(state, 'butterfly', actor, conditions, true), true);
  assert.equal(visitor.anchorId, null);
  waiting.nextRestAt = 0;
  advance(state, .025, { ...conditions, actor });
  assert.equal(waiting.anchorId, null, 'releasing a token cannot instantly put another body underneath');
  cancelFaunaInteraction(state);
  visitor.nextRestAt = Infinity;
  let replaced = false;
  advance(state, 60, conditions, () => {
    assertSpaced(state);
    replaced ||= waiting.mode === 'rest';
  });
  assert.ok(replaced);
  assert.equal(visitor.interactionToken, null);
});

test('unreachable landing reservations expire without moving a body across an excluded barrier', () => {
  const divided = habitat('divided', 'butterfly', 1);
  divided.exclusions = [{ id: 'wall', points: rectangle(140, 0, 20, 300) }];
  divided.anchors[0].position = { x: 240, y: 150 };
  const state = createForestFauna({ ...scene, habitats: [divided] }), e = state.entities[0];
  Object.assign(e, { x: 80, y: 150, vx: 0, vy: 0, nextRestAt: 0 });
  Object.assign(e.orbit, { x: 80, y: 150, rx: 10, ry: 5 });
  advance(state, .025); assert.equal(e.mode, 'rest-seek');
  let released = false;
  advance(state, 40, conditions, () => {
    assert.ok(e.x < 140, 'no teleport through the excluded strip');
    released ||= e.anchorId === null;
  });
  assert.ok(released, 'a route failure cannot hold the leaf for the rest of the session');
});

test('the authored shared session keeps both populations spaced across weather, night and camera changes', async () => {
  const { TILED_WORLD } = await vite.ssrLoadModule('/features/world/scene/presentation.ts');
  const { connectForestSession } = await vite.ssrLoadModule('/features/world/state/forest-session.ts');
  const { advanceForestDirector } = await vite.ssrLoadModule('/features/world/simulation/forest-director.ts');
  const key = 'fauna-landing-climate-test';
  const circle = connectForestSession(key, TILED_WORLD, 'circle', 0, 0, () => {}, { persistence: false });
  const world = connectForestSession(key, TILED_WORLD, 'world', 0, 0, () => {}, { persistence: false });
  try {
    circle.configure('circle', true);
    const identities = circle.state.fauna.entities.map(e => e.id);
    const history = new Set();
    for (const [index, climate] of [{ dusk: 0, rain: 0 }, { dusk: 0, rain: 1 },
      { dusk: .6, rain: .5 }, { dusk: 1, rain: 0 }, { dusk: 0, rain: 0 }].entries()) {
      world.configure('world', index % 2 === 1);
      const owner = world.isOwner() ? world : circle;
      assert.equal(owner.state, circle.state);
      const options = { ...climate, autoLife: false, blocked: false, homeAvailable: true };
      for (let tick = 0; tick < 600; tick++) {
        advanceForestDirector(owner.state, .1, options);
        assertSpaced(owner.state.fauna);
        for (const { e } of reservations(owner.state.fauna)) history.add(e.species);
      }
      const frozen = structuredClone(owner.state.fauna);
      advanceForestDirector(owner.state, .1, { ...options, reducedMotion: true });
      const frame = faunaRenderFrame(world.state.fauna);
      assert.deepEqual(faunaRenderFrame(circle.state.fauna), frame);
      assert.deepEqual(owner.state.fauna, frozen, 'reduced motion and both cameras preserve reservations');
      assert.deepEqual(owner.state.fauna.entities.map(e => e.id), identities);
    }
    assert.deepEqual([...history].sort(), ['butterfly', 'firefly']);
  } finally { world.release(); circle.release(); }
});
