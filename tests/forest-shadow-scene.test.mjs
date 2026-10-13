import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root, configFile: false, logLevel: 'silent', resolve: { alias: { '@': root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestShadowFrame: frame, drawForestTestLamp: drawLamp }
  = await vite.ssrLoadModule('/features/world/environment/lighting/forest-shadow-scene.ts');
const scene = { id: 'light-scene', width: 400, height: 400, sites: [{ id: 'home', entry: { x: 180, y: 230 } }] };
const options = (overrides = {}) => ({ night: .8, elapsed: 12, reducedMotion: false, lights: [], fires: [], actors: [], ...overrides });
const light = (overrides = {}) => ({ id: 'lamp', position: { x: 100, y: 180 }, kind: 'lantern',
  radius: 110, intensity: .9, color: '#ffd28a', flicker: .06, ...overrides });
const fire = (overrides = {}) => ({ id: 'camp', position: { x: 240, y: 270 }, radius: 9,
  flame: .6, embers: .4, lit: true, wetness: 0, drySeconds: 10, ...overrides });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test('painted lamps reconstruct their glass position from ground anchor and height', () => {
  const lights = [light({ id: 'authored', height: 37, siteId: 'home' }),
    light({ id: 'house', siteId: 'home' }), light({ id: 'post', kind: 'torch' }), light({ id: 'free' })];
  const original = structuredClone(lights);
  const sources = frame(scene, options({ lights })).sources;
  assert.deepEqual(sources.map(source => source.height), [37, 50, 17, 24]);
  sources.forEach((source, index) => {
    near(source.position.x, lights[index].position.x);
    near(source.position.y - source.height, lights[index].position.y);
    assert.equal(source.radius, lights[index].radius);
    assert.equal(source.color, lights[index].color);
  });
  assert.equal(sources[0].ownerSiteId, 'home');
  assert.deepEqual(lights, original, 'building artwork positions are never rewritten in-place');
  const shifted = frame(scene, options({ lights: [light({ height: 37, position: { x: 121, y: 190 } })] })).sources[0];
  near(shifted.position.x - sources[0].position.x, 21);
  near(shifted.position.y - sources[0].position.y, 10);
});

test('inferred building height is bounded while explicit authored heights take precedence', () => {
  const sources = frame(scene, options({ lights: [light({ siteId: 'home', position: { x: 100, y: 240 } }),
    light({ siteId: 'home', position: { x: 100, y: 10 } }),
    light({ siteId: 'home', kind: 'torch', height: 105 }), light({ siteId: 'unavailable-site' })] })).sources;
  assert.deepEqual(sources.map(source => source.height), [12, 90, 105, 24]);
  sources.forEach(source => assert.ok(source.height > 0));
});

test('lamp intensity animates with scene time and reduced motion freezes at authored brightness', () => {
  const source = light({ flicker: .25 });
  const samples = [0, 3, 17].map(elapsed => frame(scene, options({ lights: [source], elapsed })).sources[0].intensity);
  assert.ok(new Set(samples).size > 1);
  samples.forEach(intensity => assert.ok(intensity >= source.intensity * .75 && intensity <= source.intensity * 1.25));
  for (const elapsed of [0, 3, 17]) {
    near(frame(scene, options({ lights: [source], elapsed, reducedMotion: true })).sources[0].intensity, source.intensity);
  }
  near(frame(scene, options({ lights: [light({ intensity: 0 })] })).sources[0].intensity, 0);
});

test('flames and remaining embers light their ground anchor; cold hearths create no source', () => {
  const fires = [fire(), fire({ id: 'embers', flame: 0, embers: .4, lit: false }),
    fire({ id: 'cold', flame: 0, embers: 0, lit: false }),
    fire({ id: 'faded', flame: .015, embers: .02, lit: false })];
  const original = structuredClone(fires);
  const sources = frame(scene, options({ fires, reducedMotion: true })).sources;
  assert.deepEqual(sources.map(source => source.id), ['fire:camp', 'fire:embers']);
  assert.deepEqual(sources[0].position, fires[0].position, 'fire coordinates already describe the ground, not its flame tip');
  assert.notEqual(sources[0].position, fires[0].position);
  near(sources[0].height, 7.2); near(sources[0].radius, 58.5);
  assert.ok(sources[0].intensity > sources[1].intensity * 10, 'embers retain only a subdued pool');
  near(sources[0].intensity, .654); near(sources[1].intensity, .024);
  assert.deepEqual(fires, original, 'rendering does not advance or relight a campfire');
});

test('reduced motion stops fire flicker while ordinary flames stay within gentle intensity bounds', () => {
  const fires = [fire()];
  const stable = frame(scene, options({ fires, reducedMotion: true, elapsed: 0 })).sources;
  assert.deepEqual(frame(scene, options({ fires, reducedMotion: true, elapsed: 90 })).sources, stable);
  const samples = [0, 1, 9, 21].map(elapsed => frame(scene, options({ fires, elapsed })).sources[0].intensity);
  assert.ok(new Set(samples).size > 1);
  samples.forEach(intensity => assert.ok(intensity >= stable[0].intensity * .947 && intensity <= stable[0].intensity * 1.053));
});

test('moving actors retain ground footprints while jumps raise their body and fading removes their blocker', () => {
  const actors = [{ id: 'mochlik', x: 100, y: 150, size: 30, lift: 7, opacity: .4 },
    { id: 'builder', x: 120, y: 160, size: 20, lift: -3, opacity: 2 },
    { id: 'plesk', x: 140, y: 170, size: 25 },
    { id: 'hidden', x: 140, y: 170, size: 25, opacity: .01 },
    { id: 'invisible', x: 140, y: 170, size: 25, opacity: 0 },
    { id: 'absent', x: 140, y: 170, size: 0 }];
  const original = structuredClone(actors), casters = frame(scene, options({ actors })).actors;
  assert.deepEqual(casters.map(caster => caster.id), ['mochlik', 'builder', 'plesk']);
  assert.deepEqual(casters.map(caster => caster.opacity), [.4, 1, 1]);
  assert.deepEqual(casters.map(caster => caster.baseHeight), [7, 0, 0]);
  near(casters[0].height, 21.6);
  near(casters[0].points.reduce((sum, point) => sum + point.x, 0) / 8, actors[0].x);
  near(casters[0].points.reduce((sum, point) => sum + point.y, 0) / 8, actors[0].y);
  const grounded = frame(scene, options({ actors: [{ ...actors[0], lift: 0 }] })).actors[0];
  assert.deepEqual(grounded.points, casters[0].points, 'jump lift does not move the feet across the map');
  assert.deepEqual(actors, original);
});

test('building-shadow toggle is independent of visible building lights and debug lamp is opt-in', () => {
  const shared = options({ lights: [light({ siteId: 'home' })], showBuildings: true });
  const normal = frame(scene, { ...shared, buildingShadows: true });
  const noBuildingShadows = frame(scene, { ...shared, buildingShadows: false });
  assert.equal(noBuildingShadows.showBuildings, true);
  assert.equal(noBuildingShadows.buildingShadows, false);
  assert.deepEqual(noBuildingShadows.sources, normal.sources, 'disabling shadows preserves the building lamp');
  assert.ok(!normal.sources.some(source => source.id === 'dev:test-lamp'));
  const tested = frame(scene, { ...shared, testLamp: { x: 360, y: 330, height: 65 },
    azimuth: 123, elevation: 22, quality: 'high' });
  assert.deepEqual(tested.sources.slice(0, -1), normal.sources);
  const lamp = tested.sources.at(-1);
  assert.equal(lamp.id, 'dev:test-lamp'); assert.deepEqual(lamp.position, { x: 360, y: 330 });
  assert.equal(lamp.height, 65); assert.ok(lamp.intensity > 0); assert.ok(lamp.radius > 0);
  assert.equal(tested.azimuth, 123); assert.equal(tested.elevation, 22); assert.equal(tested.quality, 'high');
  assert.equal(tested.night, shared.night);
});

test('test lamp marker connects the ground to the elevated bulb and restores canvas state', () => {
  const calls = [], stack = [], ctx = { strokeStyle: 'original-stroke', fillStyle: 'original-fill', lineWidth: 4, dash: [9] };
  const snapshot = () => ({ strokeStyle: ctx.strokeStyle, fillStyle: ctx.fillStyle, lineWidth: ctx.lineWidth, dash: [...ctx.dash] });
  ctx.save = () => stack.push(snapshot()); ctx.restore = () => Object.assign(ctx, stack.pop());
  ctx.setLineDash = values => { ctx.dash = [...values]; };
  for (const method of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'ellipse', 'arc', 'fill']) {
    ctx[method] = (...args) => calls.push({ method, args });
  }
  const before = snapshot(); drawLamp(ctx, { x: 110, y: 140, height: 35 });
  assert.ok(calls.some(call => call.method === 'moveTo' && call.args[0] === 110 && call.args[1] === 140));
  assert.ok(calls.some(call => call.method === 'lineTo' && call.args[0] === 110 && call.args[1] === 105));
  assert.ok(calls.some(call => call.method === 'arc' && call.args[0] === 110 && call.args[1] === 105));
  assert.deepEqual(snapshot(), before); assert.equal(stack.length, 0);
});
