import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestGardenBerries, forestGardenVisualFrame, drawForestGardenPlants, drawForestGardenGround,
  drawForestGardenProps } = await vite.ssrLoadModule('/features/world/forest-garden-painter.ts');
const { previewPointInPolygon } = await vite.ssrLoadModule('/features/world/tiled/preview-state.ts');
const { createForestGarden, cancelForestGarden } = await vite.ssrLoadModule('/features/world/forest-garden.ts');
const { default: scene } = await vite.ssrLoadModule('/features/world/tiled/forest.generated.json');
const motion = { pose: 'walk', frame: 1, direction: 'right' };

function context() {
  const calls = [], stack = [], target = { globalAlpha: .37, fillStyle: 'before', imageSmoothingEnabled: true };
  const ctx = new Proxy(target, {
    get: (object, key) => key in object ? object[key] : (...args) => {
      assert.ok(args.every(arg => typeof arg !== 'number' || Number.isFinite(arg)), `${String(key)} uses finite coordinates`);
      calls.push({ method: key, args, fill: object.fillStyle, alpha: object.globalAlpha });
      if (key === 'save') stack.push({ ...object });
      if (key === 'restore') Object.assign(object, stack.pop());
    },
    set: (object, key, value) => { object[key] = value; return true; },
  });
  return { ctx, calls };
}
function setup(phase = 'water', elapsed = 2) {
  const garden = createForestGarden(scene), actor = { ...garden.bushes[0].workPosition, size: scene.actor.size };
  assert.ok(garden.basket, 'authored map has a safe place for the basket');
  garden.routine = { kind: phase === 'water' ? 'water-bush' : 'harvest-berries', bushId: garden.bushes[0].id,
    phase, elapsed, totalElapsed: elapsed + 3, carryingBasket: ['collect', 'return-basket', 'deposit'].includes(phase) };
  return { garden, actor };
}

test('growth overlays stay inside the exact authored foliage and use the same positions at every stage', () => {
  const { garden } = setup();
  garden.bushes[0].growth = .2;
  const flowers = forestGardenBerries(scene, garden);
  assert.ok(flowers.length >= 5 && flowers.length <= 11);
  for (const item of flowers) assert.ok(previewPointInPolygon(item, scene.bushes[0].points));
  garden.bushes[0].growth = .65;
  const green = forestGardenBerries(scene, garden);
  garden.bushes[0].growth = 1;
  const ripe = forestGardenBerries(scene, garden);
  assert.deepEqual(green.map(({ x, y }) => [x, y]), flowers.map(({ x, y }) => [x, y]));
  assert.deepEqual(ripe.map(({ x, y }) => [x, y]), flowers.map(({ x, y }) => [x, y]));
  garden.bushes[0].growth = 0;
  assert.deepEqual(forestGardenBerries(scene, garden), []);
  garden.bushes[0].growth = NaN;
  assert.deepEqual(forestGardenBerries(scene, garden), []);
  assert.deepEqual(forestGardenBerries({ ...scene, bushes: [] }, garden), []);
});

test('all garden phases sample without mutating simulation and held props follow the physical rig', () => {
  for (const phase of ['approach-basket', 'take-basket', 'approach-bush', 'water', 'collect', 'return-basket', 'deposit', 'settle']) {
    const { garden, actor } = setup(phase);
    const before = structuredClone(garden), a = context(), b = context();
    const frame = forestGardenVisualFrame(garden, actor, motion);
    drawForestGardenPlants(a.ctx, scene, garden); drawForestGardenGround(a.ctx, garden, actor.size, frame);
    drawForestGardenProps(a.ctx, frame, 'behind'); drawForestGardenProps(a.ctx, frame, 'front');
    drawForestGardenPlants(b.ctx, scene, garden); drawForestGardenGround(b.ctx, garden, actor.size, frame);
    drawForestGardenProps(b.ctx, frame, 'behind'); drawForestGardenProps(b.ctx, frame, 'front');
    assert.deepEqual(a.calls, b.calls, `${phase}: both cameras sample identical frozen state`);
    assert.deepEqual(garden, before);
    assert.equal(a.ctx.globalAlpha, .37, 'rendering restores the parent alpha');
    assert.equal(a.ctx.fillStyle, 'before');
    if (phase === 'water') {
      const shifted = forestGardenVisualFrame(garden, { ...actor, x: actor.x + 8, y: actor.y + 4 }, motion);
      assert.equal(shifted.can.x, frame.can.x + 8);
      assert.equal(shifted.can.y, frame.can.y + 4);
    }
  }
});

test('watering droplets share the phase clock and reduced motion removes their motion', () => {
  const { garden, actor } = setup(), moving = context(), still = context();
  const frame = forestGardenVisualFrame(garden, actor, motion);
  drawForestGardenProps(moving.ctx, frame, 'front');
  drawForestGardenProps(still.ctx, forestGardenVisualFrame(garden, actor, motion, true), 'front');
  const droplets = calls => calls.filter(call => call.method === 'fillRect' && ['#b9dddc', '#e2efdb'].includes(call.fill));
  assert.equal(droplets(moving.calls).length, 10);
  assert.equal(droplets(still.calls).length, 0);
  assert.ok(droplets(moving.calls).every(call => call.alpha <= .37), 'a faded hero never emits fully opaque water');
  garden.routine.elapsed = 0;
  const starting = context(); drawForestGardenProps(starting.ctx, forestGardenVisualFrame(garden, actor, motion), 'front');
  assert.equal(droplets(starting.calls).length, 0, 'the can is raised before pouring');
});

test('a carried basket uses actor depth and cancellation leaves a grounded basket with committed contents', () => {
  const { garden, actor } = setup('return-basket');
  garden.basket.berries = 3;
  const before = structuredClone(garden), back = forestGardenVisualFrame(garden, actor, { ...motion, direction: 'back' });
  assert.equal(back.basket.behind, true);
  assert.equal(back.basket.berries, 6, 'pending crop is visible while its accounting waits for deposit');
  const behind = context(), front = context(), ground = context();
  drawForestGardenProps(behind.ctx, back, 'behind'); drawForestGardenProps(front.ctx, back, 'front');
  drawForestGardenGround(ground.ctx, garden, actor.size, back);
  assert.ok(behind.calls.some(call => call.method === 'fillRect'));
  assert.equal(front.calls.filter(call => call.method === 'fillRect').length, 0);
  assert.equal(ground.calls.length, 0, 'the basket is not duplicated at its parking place');
  assert.deepEqual(garden, before);
  const foot = { x: actor.x + 12, y: actor.y + 15 };
  cancelForestGarden(garden, foot);
  assert.equal(forestGardenVisualFrame(garden, actor, motion), null);
  const parked = context(); drawForestGardenGround(parked.ctx, garden, actor.size, null);
  assert.deepEqual(parked.calls.find(call => call.method === 'translate').args, [foot.x, foot.y]);
  assert.equal(garden.basket.berries, 3, 'visual pending fruit does not become harvested loot');
  assert.ok(parked.calls.some(call => call.method === 'ellipse' && call.fill === '#253719'), 'the basket contacts the ground');
});
