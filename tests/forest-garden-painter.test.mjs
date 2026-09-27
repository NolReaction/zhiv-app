import assert from 'node:assert/strict';
import { withPlacedBushArtwork } from "./helpers/forest-bush-fixture.mjs";
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
const { createForestGarden, cancelForestGarden, gardenWorkReachable } = await vite.ssrLoadModule('/features/world/forest-garden.ts');
const { forestFruitVisual, FOREST_FRUIT_APPEARANCES } = await vite.ssrLoadModule('/features/world/forest-fruit-appearance.ts');
const { default: sourceScene } = await vite.ssrLoadModule('/features/world/tiled/forest.generated.json');
const scene = withPlacedBushArtwork(sourceScene);
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
  const buds = forestGardenBerries(scene, garden);
  assert.ok(buds.length >= 5 && buds.length <= 11);
  for (const item of buds) assert.ok(previewPointInPolygon(item, scene.bushes[0].points));
  garden.bushes[0].growth = .65;
  const green = forestGardenBerries(scene, garden);
  garden.bushes[0].growth = 1;
  const ripe = forestGardenBerries(scene, garden);
  assert.deepEqual(green.map(({ x, y }) => [x, y]), buds.map(({ x, y }) => [x, y]));
  assert.deepEqual(ripe.map(({ x, y }) => [x, y]), buds.map(({ x, y }) => [x, y]));
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

test('berries grow as detailed warm clusters without any flower glyphs', () => {
  const { garden } = setup();
  const samples = [];
  for (const growth of [.08, .2, .4, .8, 1]) {
    garden.bushes[0].growth = growth;
    const surface = context(); drawForestGardenPlants(surface.ctx, scene, garden);
    const fruit = surface.calls.filter(call => call.method === 'ellipse');
    assert.ok(fruit.length > 20, 'cluster fruit has colored body, highlight and surface detail');
    assert.ok(!surface.calls.some(call => ['#e3dec0', '#c8b45c', '#fff8e8'].includes(call.fill)), 'no pale cross/petals in the crop');
    samples.push(fruit[0].args[2]);
  }
  assert.ok(samples.every((size, index) => !index || size > samples[index - 1]), 'berry size increases smoothly with growth');
});

test('fruit ripens at slightly different rates and every cluster is ripe at the existing harvest threshold', () => {
  const definition = structuredClone(FOREST_FRUIT_APPEARANCES.woodlandBerry);
  for (let cluster = 0; cluster < 7; cluster++) for (let fruit = 0; fruit < 3; fruit++) {
    let previous = forestFruitVisual(0, cluster, fruit);
    assert.equal(previous.opacity, 0);
    for (let step = 1; step <= 100; step++) {
      const next = forestFruitVisual(step / 100, cluster, fruit);
      for (const field of ['size', 'opacity', 'maturity', 'ripeness']) {
        assert.ok(Number.isFinite(next[field]));
        assert.ok(next[field] >= previous[field], `${field} never jumps backward`);
      }
      previous = next;
    }
    const ripe = forestFruitVisual(.98, cluster, fruit);
    assert.equal(ripe.maturity, 1); assert.equal(ripe.size, 1); assert.equal(ripe.ripeness, 1);
    assert.deepEqual(ripe, forestFruitVisual(1, cluster, fruit), 'visual harvest readiness matches game readiness');
  }
  const first = forestFruitVisual(.55, 0, 0), late = forestFruitVisual(.55, 6, 2);
  assert.ok(first.size > late.size && first.maturity > late.maturity, 'clusters do not grow in lockstep');
  assert.deepEqual(forestFruitVisual(NaN, Infinity, -3), forestFruitVisual(0));
  assert.deepEqual(FOREST_FRUIT_APPEARANCES.woodlandBerry, definition, 'sampling never changes the appearance catalogue');
});

test('individual fruit centers remain fixed throughout growth and both cameras read the same stage', () => {
  const { garden } = setup();
  const bodies = calls => calls.filter(call => call.method === 'ellipse' && Math.abs(call.args[3] - call.args[2] * 1.08) < 1e-10);
  let centers;
  for (const growth of [.2, .4, .7, .98, 1]) {
    garden.bushes[0].growth = growth;
    const normal = context(), frozen = context(), original = structuredClone(garden);
    drawForestGardenPlants(normal.ctx, scene, garden);
    garden.elapsed += 1000;
    drawForestGardenPlants(frozen.ctx, scene, garden);
    garden.elapsed = original.elapsed;
    assert.deepEqual(normal.calls, frozen.calls, 'only saved growth affects fruit appearance, not the render clock');
    const positions = bodies(normal.calls).map(call => call.args.slice(0, 2));
    assert.equal(positions.length, forestGardenBerries(scene, garden).length * 3);
    if (centers) assert.deepEqual(positions, centers, 'filling fruit does not slide along the leaves');
    centers = positions;
    assert.deepEqual(garden, original);
  }
});

test('the three harvested fruits start exactly at their visible centers even at 98 percent growth', () => {
  const { garden, actor } = setup('collect');
  garden.bushes[0].growth = .98;
  for (let index = 0; index < 3; index++) {
    const graspAt = .85 + index + .3;
    garden.routine.elapsed = graspAt - 1e-6;
    const surface = context(); drawForestGardenPlants(surface.ctx, scene, garden);
    const fruits = surface.calls.filter(call => call.method === 'ellipse' && Math.abs(call.args[3] - call.args[2] * 1.08) < 1e-10);
    garden.routine.elapsed = graspAt + 1e-6;
    const frame = forestGardenVisualFrame(garden, actor, motion);
    assert.ok(frame.pickedBerry);
    assert.ok(fruits.some(({ args }) => Math.hypot(args[0] - frame.pickedBerry.x, args[1] - frame.pickedBerry.y) < 1e-10),
      'the paw takes an existing berry rather than an offset copy');
    const held = context(); drawForestGardenProps(held.ctx, frame, 'front');
    assert.ok(held.calls.some(call => call.method === 'ellipse'
      && Math.abs(call.args[0] - frame.pickedBerry.x) < 1e-10 && Math.abs(call.args[1] - frame.pickedBerry.y) < 1e-10
      && Math.abs(call.args[2] - frame.pickedBerry.size) < 1e-10), 'carried fruit retains the ripe size');
  }
});

test('harvest basket has matching endpoints at every phase and stays visible beside the feet', () => {
  const { garden, actor } = setup('collect', 0), original = structuredClone(garden);
  const at = (phase, elapsed, position = actor) => {
    garden.routine.phase = phase; garden.routine.elapsed = elapsed;
    garden.routine.carryingBasket = !['take-basket', 'settle'].includes(phase);
    return forestGardenVisualFrame(garden, position, motion);
  };
  const home = { ...garden.basket.homeApproach, size: actor.size };
  for (const [before, after] of [
    [at('take-basket', 1, home), at('approach-bush', 0, home)],
    [at('approach-bush', 10), at('collect', 0)],
    [at('collect', 5), at('return-basket', 0)],
    [at('return-basket', 10, home), at('deposit', 0, home)],
  ]) assert.ok(Math.hypot(before.basket.x - after.basket.x, before.basket.y - after.basket.y) < 1e-8);
  const lowered = at('collect', 2);
  assert.equal(lowered.basket.grounded, true);
  assert.ok(Math.abs(lowered.basket.x - actor.x) >= actor.size * .3, 'basket is beside the torso within paw reach');
  const behind = context(), front = context();
  drawForestGardenGround(behind.ctx, garden, actor.size, lowered, actor);
  drawForestGardenProps(front.ctx, lowered, 'front');
  assert.equal(behind.calls.length, 0, 'active basket cannot be covered by the hero pass');
  assert.ok(front.calls.some(call => call.method === 'translate' && call.args[0] === lowered.basket.x));
  assert.equal(original.basket.berries, garden.basket.berries, 'sampling does not deposit a reward');
  const lifted = at('take-basket', 1, home);
  assert.ok(lifted.basket.y < garden.basket.position.y - 2, 'pickup visibly lifts the basket above its parking spot');
});

test('one real fruit travels from foliage via the two paws into the basket without blinking', () => {
  const { garden, actor } = setup('collect', 0);
  garden.bushes[0].growth = 1;
  const at = time => {
    garden.routine.elapsed = time;
    return forestGardenVisualFrame(garden, actor, motion);
  };
  let previous;
  for (let t = 0; t <= 5; t += 1 / 120) {
    const frame = at(t);
    assert.equal(frame.pose, 'idle', 'gathering keeps the body and feet still');
    assert.equal(frame.frame, 0);
    assert.equal(frame.rig.gardening, true);
    if (previous) frame.arms.forEach((arm, index) => {
      const prior = previous.arms[index].hand;
      assert.ok(Math.hypot(arm.hand.x - prior.x, arm.hand.y - prior.y) < 3, `hand moves continuously at ${t}`);
    });
    previous = frame;
  }
  for (let cycle = 0; cycle < 3; cycle++) {
    const start = .85 + cycle;
    const grasp = at(start + .300001);
    assert.ok(grasp.pickedBerry && previewPointInPolygon(grasp.pickedBerry, scene.bushes[0].points), 'fruit starts at its actual cluster');
    assert.ok(grasp.pickedBerry.y > actor.y - actor.size * .3, 'worked fruit sits below the near ear');
    assert.ok(grasp.pickedBerry.x < actor.x - actor.size * .32, 'worked fruit stays beside the torso');
    assert.equal(forestGardenBerries(scene, garden)[0].picked, cycle + 1, 'the plucked fruit is removed from that cluster');
    let last = grasp.pickedBerry;
    for (let phase = .31; phase < .8; phase += .01) {
      const next = at(start + phase).pickedBerry;
      assert.ok(next, 'fruit remains attached until the deposit');
      assert.ok(Math.hypot(next.x - last.x, next.y - last.y) < 2);
      last = next;
    }
    const deposited = at(start + .800001);
    assert.equal(deposited.pickedBerry, null);
    assert.equal(deposited.basket.berries, cycle + 1, 'contents change when the paw reaches the rim');
  }
});

test('a deposited empty or filled basket keeps the same transform and foreground depth near the hero', () => {
  for (const berries of [0, 6]) {
    const { garden, actor } = setup('deposit', 1.5);
    garden.basket.berries = berries;
    const home = { ...garden.basket.homeApproach, size: actor.size };
    const frame = forestGardenVisualFrame(garden, home, motion);
    assert.deepEqual([frame.basket.x, frame.basket.y], [garden.basket.homePosition.x, garden.basket.homePosition.y]);
    garden.routine = null;
    const behind = context(), front = context();
    drawForestGardenGround(behind.ctx, garden, actor.size, null, home, 'behind');
    drawForestGardenGround(front.ctx, garden, actor.size, null, home, 'front');
    assert.equal(behind.calls.length, 0);
    assert.deepEqual(front.calls.find(call => call.method === 'translate').args, [frame.basket.x, frame.basket.y]);
    const far = context(); drawForestGardenGround(far.ctx, garden, actor.size, null, { x: 0, y: 0 }, 'behind');
    assert.ok(far.calls.length, 'distant parked props keep their ordinary ground pass');
  }
});

test('referenced shrub artwork must be placed over the contour before fruit overlays appear', () => {
  const pending = structuredClone(scene); pending.bushes[0].imageId = 'future-shrub';
  const garden = createForestGarden(pending); garden.bushes[0].growth = 1;
  assert.deepEqual(forestGardenBerries(pending, garden), []);
  const placed = withPlacedBushArtwork(pending);
  assert.ok(forestGardenBerries(placed, garden).length > 0);
  placed.terrain.find(item => item.id === 'future-shrub').bounds.x += 500;
  assert.deepEqual(forestGardenBerries(placed, garden), [], 'an image elsewhere does not turn empty grass into a fruit bush');
});


test('garden paws stay short and bent, water descends from the actual spout, and unsupported scales decline safely', () => {
  for (const size of [25, 35, 50, 56, 75, 100]) {
    const map = structuredClone(scene); map.actor.size = size;
    const garden = createForestGarden(map), plant = garden.bushes[0];
    if (!plant.workPosition) continue;
    for (const phase of ['collect', 'water', 'take-basket', 'deposit']) {
      if (phase !== 'water' && !garden.basket) continue;
      const actor = { ...(phase === 'take-basket' || phase === 'deposit' ? garden.basket.approach : plant.workPosition), size };
      garden.routine = { kind: phase === 'water' ? 'water-bush' : 'harvest-berries', bushId: plant.id,
        phase, elapsed: 0, totalElapsed: 0, carryingBasket: phase !== 'water' };
      for (let t = 0; t <= (phase === 'collect' ? 5 : phase === 'water' ? 4 : 1.5); t += .025) {
        garden.routine.elapsed = t;
        const frame = forestGardenVisualFrame(garden, actor, motion);
        for (const arm of frame.arms) {
          assert.ok(Math.hypot(arm.hand.x - arm.shoulder.x, arm.hand.y - arm.shoulder.y) <= size * .29,
            `${size}px ${phase} ${t}: wrist stays within a short paw`);
          assert.ok(Number.isFinite(arm.elbow.x) && Number.isFinite(arm.elbow.y));
        }
        if (frame.can?.pouring) {
          assert.ok(frame.can.target.y > frame.can.spout.y, 'water falls to lower soil rather than flying up into leaves');
          const u = frame.can.size / 14, tilt = frame.can.tilt;
          assert.ok(Math.abs(frame.can.spout.x - (frame.can.x + frame.can.side * u * (10 * Math.cos(tilt) + 2 * Math.sin(tilt)))) < 1e-9);
          assert.ok(Math.abs(frame.can.spout.y - (frame.can.y + u * (10 * Math.sin(tilt) - 2 * Math.cos(tilt)))) < 1e-9);
        }
      }
    }
  }
});

test('basket is grasped before lifting and gripping paws are painted over its real handle', () => {
  const { garden, actor } = setup('take-basket', .23), home = { ...garden.basket.approach, size: actor.size };
  const grasp = forestGardenVisualFrame(garden, home, motion);
  assert.deepEqual([grasp.basket.x, grasp.basket.y], [garden.basket.position.x, garden.basket.position.y]);
  garden.routine.elapsed = .24;
  const contact = forestGardenVisualFrame(garden, home, motion);
  const handleY = contact.basket.y - contact.basket.size * 12 / 14;
  contact.arms.forEach(arm => assert.ok(Math.abs(arm.hand.y - handleY) < .01, 'paws touch the upper handle before it moves'));
  const paint = context(); drawForestGardenProps(paint.ctx, contact, 'front');
  const lastWicker = paint.calls.findLastIndex(call => call.method === 'fillRect' && call.fill === '#d2ad6c');
  assert.ok(lastWicker > 0 && paint.calls.slice(lastWicker + 1).some(call => call.method === 'fillRect' && call.fill === '#f4e4ae'),
    'visible paws wrap over basket artwork instead of hiding behind it');
  garden.routine.elapsed = 1;
  const lifted = forestGardenVisualFrame(garden, home, motion);
  assert.ok(lifted.basket.y < grasp.basket.y - home.size * .08, 'basket visibly clears the ground');
});


test('a DEV-only resize rechecks the existing work point before the rendered rig can stretch', () => {
  const { garden } = setup();
  assert.equal(gardenWorkReachable(garden.bushes[0], 50), true);
  assert.equal(gardenWorkReachable(garden.bushes[0], 56), true);
  assert.equal(gardenWorkReachable(garden.bushes[0], 25), false, 'small hero cannot reach the old full-size target');
  assert.equal(gardenWorkReachable(garden.bushes[0], 100), false, 'large hero would cover the berry with its torso');
  for (const size of [0, -1, NaN, Infinity]) assert.equal(gardenWorkReachable(garden.bushes[0], size), false);
});
