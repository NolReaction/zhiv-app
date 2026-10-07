import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { drawForestCampfires, drawForestCampfireGlow } = await vite.ssrLoadModule('/features/world/forest-campfire-painter.ts');
const { createForestCampfires, advanceForestCampfires } = await vite.ssrLoadModule('/features/world/forest-campfire.ts');
const { default: world } = await vite.ssrLoadModule('/features/world/tiled/forest.generated.json');

function context() {
  const calls = [], stack = [];
  const state = { globalAlpha: .37, fillStyle: 'before', strokeStyle: 'before', globalCompositeOperation: 'source-over' };
  const ctx = new Proxy(state, {
    get: (object, key) => key in object ? object[key] : (...args) => {
      assert.ok(args.every(arg => typeof arg !== 'number' || Number.isFinite(arg)), `${String(key)} uses finite coordinates`);
      calls.push({ method: key, args, fill: object.fillStyle, stroke: object.strokeStyle, alpha: object.globalAlpha });
      if (key === 'save') stack.push({ ...object });
      if (key === 'restore') {
        for (const key of Object.keys(object)) delete object[key];
        Object.assign(object, stack.pop());
      }
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        const value = { type: key, args, stops: [] };
        return { ...value, addColorStop: (offset, color) => value.stops.push([offset, color]) };
      }
    },
    set: (object, key, value) => { object[key] = value; return true; },
  });
  // Gradient callbacks are deliberately omitted from a comparison of drawing commands.
  return { ctx, calls, sample: () => JSON.parse(JSON.stringify(calls)), state };
}
const fire = { id: 'clearing-fire', position: { x: 70, y: 60 }, seat: { x: 40, y: 75 }, radius: 10,
  flame: .9, embers: .8, wetness: .2, drySeconds: 6, lit: true };
const paintCalls = calls => calls.filter(call => ['fill', 'stroke', 'fillRect'].includes(call.method));

test('both cameras sample the same fire without changing its state or leaking Canvas settings', () => {
  const fires = [structuredClone(fire)], before = structuredClone(fires), first = context(), second = context();
  for (const surface of [first, second]) {
    drawForestCampfires(surface.ctx, fires, 8.4, false);
    drawForestCampfireGlow(surface.ctx, fires, 8.4, false, 1);
    assert.deepEqual(surface.state, { globalAlpha: .37, fillStyle: 'before', strokeStyle: 'before', globalCompositeOperation: 'source-over' });
    assert.ok(paintCalls(surface.calls).every(call => call.alpha >= 0 && call.alpha <= .37), 'effects respect the parent opacity');
  }
  assert.deepEqual(first.sample(), second.sample()); assert.deepEqual(fires, before);
});

test('reduced motion freezes flame, coals and glow and removes rising smoke and sparks', () => {
  const first = context(), later = context(), moving = context();
  drawForestCampfires(first.ctx, [fire], 2, true); drawForestCampfireGlow(first.ctx, [fire], 2, true, 1);
  drawForestCampfires(later.ctx, [fire], 99, true); drawForestCampfireGlow(later.ctx, [fire], 99, true, 1);
  assert.deepEqual(first.sample(), later.sample());
  drawForestCampfires(moving.ctx, [fire], 2, false);
  assert.ok(moving.calls.some(call => call.method === 'createRadialGradient'), 'ordinary fire emits soft smoke');
  assert.equal(first.calls.filter(call => call.method === 'createRadialGradient').length, 1, 'only the static night glow remains');
  assert.ok(!first.calls.some(call => call.method === 'stroke' && call.stroke === '#ffc977'));
});

test('emission pass excludes solid hearth and smoke; hero occlusion suppresses only the bright flame', () => {
  const emission = context(); drawForestCampfires(emission.ctx, [fire], 6, false, true);
  assert.ok(emission.calls.some(call => call.method === 'bezierCurveTo'));
  assert.equal(emission.calls.filter(call => call.method === 'createRadialGradient').length, 0);
  const cold = context(); drawForestCampfires(cold.ctx, [{ ...fire, lit: false, flame: 0, embers: 0 }], 6, false);
  const pigment = call => call.method === 'stroke' ? call.stroke : call.fill;
  const solidColors = new Set(paintCalls(cold.calls).filter(call => call.alpha > 0).map(pigment));
  assert.ok(solidColors.size > 0);
  assert.ok(paintCalls(emission.calls).every(call => !solidColors.has(pigment(call))),
    'the emission layer cannot repaint any currently painted stone or wood material');
  const covered = context(), exposed = context();
  drawForestCampfireGlow(covered.ctx, [fire], 6, false, 1, { x: 70, y: 70, size: 50 });
  drawForestCampfireGlow(exposed.ctx, [fire], 6, false, 1, { x: 30, y: 70, size: 50 });
  assert.equal(covered.calls.filter(call => call.method === 'bezierCurveTo').length, 0);
  assert.ok(covered.calls.some(call => call.method === 'fillRect'), 'ground light still reaches the scene');
  assert.ok(exposed.calls.some(call => call.method === 'bezierCurveTo'));
});

test('wet embers release pale steam, but a fully cold wet hearth emits neither particles nor light', () => {
  const cooling = context(), cold = context(), dark = context();
  drawForestCampfires(cooling.ctx, [{ ...fire, flame: 0, embers: .7, wetness: .9 }], 4, false);
  assert.ok(cooling.sample().some(call => call.method === 'fillRect'
    && call.fill.stops.some(([, color]) => color === 'rgba(210,211,192,.75)')));
  const extinguished = { ...fire, lit: false, flame: 0, embers: 0, wetness: 1 };
  drawForestCampfires(cold.ctx, [extinguished], 4, false);
  drawForestCampfireGlow(dark.ctx, [extinguished], 4, false, 1);
  assert.ok(!cold.calls.some(call => call.method === 'createRadialGradient' || call.method === 'bezierCurveTo'));
  assert.equal(paintCalls(dark.calls).length, 0);
});

test('daylight disables the night glow and emission pass even while a hearth is still hot', () => {
  for (const still of [false, true]) {
    const daylight = context(), before = structuredClone(fire), state = { ...daylight.state };
    drawForestCampfireGlow(daylight.ctx, [fire], 8.4, still, 0);
    assert.equal(daylight.calls.length, 0, 'daylight cannot repaint a bright flame above the scene');
    assert.deepEqual(daylight.state, state); assert.deepEqual(fire, before);
    const hearth = context(); drawForestCampfires(hearth.ctx, [fire], 8.4, still);
    assert.ok(paintCalls(hearth.calls).length > 0, 'the ordinary daytime hearth remains visible');
  }
});

test('rendering follows real rain extinction and wet drying rather than relighting from elapsed time', () => {
  const fires = createForestCampfires(world), controlled = fires[0];
  assert.ok(controlled, 'the weather regression uses an authored hearth');
  const tick = (seconds, dusk, rain) => {
    for (let index = 0; index < Math.round(seconds / .05); index++) advanceForestCampfires(fires, .05, dusk, rain);
  };
  const emission = elapsed => {
    const surface = context(), before = structuredClone(fires), state = { ...surface.state };
    drawForestCampfires(surface.ctx, fires, elapsed, false, true);
    assert.deepEqual(fires, before, 'sampling cannot advance weather or ignition');
    assert.deepEqual(surface.state, state);
    return surface;
  };
  tick(20, 0, 0);
  assert.equal(controlled.lit, false); assert.equal(paintCalls(emission(20).calls).length, 0);
  tick(40, 1, 0);
  assert.equal(controlled.lit, true); assert.ok(controlled.flame > 0);
  assert.ok(emission(60).calls.some(call => call.method === 'bezierCurveTo'));
  tick(.05, 1, 1);
  assert.equal(controlled.lit, false); assert.ok(controlled.flame > 0);
  assert.ok(emission(60.05).calls.some(call => call.method === 'bezierCurveTo'),
    'rain stops ignition immediately while the existing visible flame fades gradually');
  tick(39.95, 1, 1);
  assert.ok(controlled.wetness > 0); assert.equal(controlled.lit, false);
  assert.equal(paintCalls(emission(100).calls).length, 0, 'fully cooled wet wood has no emissive layer');
  tick(2, 1, 0);
  assert.equal(controlled.lit, false, 'a short dry interval cannot bypass the wet-wood controller');
  for (const elapsed of [102, 1_000_000]) {
    const hearth = context(), glow = context(), before = structuredClone(fires);
    drawForestCampfires(hearth.ctx, fires, elapsed, false);
    drawForestCampfireGlow(glow.ctx, fires, elapsed, false, 1);
    assert.ok(paintCalls(hearth.calls).length > 0, 'cold stones and wood remain visible');
    assert.ok(!hearth.calls.some(call => call.method === 'createRadialGradient' || call.method === 'bezierCurveTo'),
      'a later render clock cannot generate smoke or flames from cold wet wood');
    assert.equal(paintCalls(glow.calls).length, 0); assert.deepEqual(fires, before);
  }
  tick(130, 1, 0);
  assert.equal(controlled.lit, true);
  assert.ok(emission(232).calls.some(call => call.method === 'bezierCurveTo'),
    'the painter shows the fire again only after the controller has dried and reignited it');
});

test('a pot covers only its own fire emission while each ground light remains visible', () => {
  const second = { ...fire, id: 'second-fire', position: { x: 140, y: 60 } }, fires = [fire, second];
  const covered = context(), exposed = context(), fullyCovered = context(), before = structuredClone(fires);
  drawForestCampfireGlow(covered.ctx, fires, 6, false, 1, undefined, [fire.id]);
  drawForestCampfireGlow(exposed.ctx, fires, 6, false, 1, undefined, ['missing-fire']);
  drawForestCampfireGlow(fullyCovered.ctx, fires, 6, false, 1, undefined, [fire.id, second.id]);
  const samplesFire = (surface, item) => surface.calls.some(call => call.method === 'translate'
    && call.args[0] === item.position.x && call.args[1] === item.position.y);
  assert.equal(samplesFire(covered, fire), false, 'the listed hearth cannot repaint its flame in front of the pot');
  assert.equal(samplesFire(covered, second), true, 'another hearth remains emissive');
  assert.equal(samplesFire(exposed, fire), true); assert.equal(samplesFire(exposed, second), true);
  assert.equal(fullyCovered.calls.some(call => call.method === 'bezierCurveTo'), false);
  for (const surface of [covered, exposed, fullyCovered]) {
    assert.equal(surface.calls.filter(call => call.method === 'createRadialGradient').length, fires.length,
      'covering flames does not suppress either ground light pool');
    assert.deepEqual(surface.state, { globalAlpha: .37, fillStyle: 'before', strokeStyle: 'before', globalCompositeOperation: 'source-over' });
  }
  assert.deepEqual(fires, before);
});
