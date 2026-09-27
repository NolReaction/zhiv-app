import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { drawForestCampfires, drawForestCampfireGlow } = await vite.ssrLoadModule('/features/world/forest-campfire-painter.ts');

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
  assert.ok(!emission.calls.some(call => ['#403a28', '#585b4c', '#676551', '#2c2119'].includes(call.fill)
    || call.stroke === '#2c2119'));
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
