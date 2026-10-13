import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldAudioController } = await vite.ssrLoadModule('/features/world/audio/world-audio-controller.ts');
const { connectForestSession } = await vite.ssrLoadModule('/features/world/state/forest-session.ts');
const scene = JSON.parse(await readFile(new URL('../features/world/tiled/forest.generated.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../features/audio/catalog/audio-catalog.json', import.meta.url)));
const point = { x: 900, y: 900 };

function fixture(t) {
  const events = [], controller = createWorldAudioController({ updateFrame() {}, clearFrame() {},
    play: event => events.push(event) });
  const session = connectForestSession(undefined, scene, 'circle', 10000, 0, () => {}, { persistence: false, sync: false });
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const input = { sceneId: 'tree-touch-test', now, dusk: 0, rain: 0, levels: {}, fires: [],
    camera: { ...point, zoom: 1, viewportWidth: 400, viewportHeight: 600 } };
  const control = { scope: 'world', visible: true, observationOwner: true, emitEvents: false,
    showHero: false, actorAway: false, reducedMotion: false };
  t.after(() => { controller.dispose(); session.release(); });
  return { controller, events, advance: milliseconds => { now += milliseconds; },
    update: (changes = {}, camera = input.camera) => controller.update(scene, session.state,
      { ...input, camera }, { ...control, ...changes }) };
}

test('accepted tree taps emit one owned rustle; camera observation cannot repeat it', t => {
  const f = fixture(t);
  assert.equal(f.controller.touchTree(point), false, 'no active view');
  f.update();
  assert.equal(f.controller.touchTree(point), true);
  const event = f.events[0];
  assert.equal(event.cueId, 'action.tree.rustle');
  assert.equal(event.ownerId, f.controller.getFrame().ownerId);
  assert.equal(event.maxAgeMs, 200, 'cold decodes must not rustle long after the visual');
  assert.equal(event.gain, 1);
  assert.equal(event.pan, 0);
  assert.equal(f.controller.touchTree(point), false);
  f.advance(349);
  assert.equal(f.controller.touchTree(point), false);
  f.advance(1);
  assert.equal(f.controller.touchTree(point), true);
  assert.notEqual(f.events[1].id, event.id);
  for (let index = 0; index < 80; index++) {
    f.advance(20);
    f.update({}, { ...point, x: point.x + index, zoom: 1 + index / 30, viewportWidth: 400, viewportHeight: 600 });
  }
  assert.equal(f.events.length, 2, 'moving, zooming and redrawing never create a tree event');
});

test('tree and water touches have independent cooldowns and unique event identities', t => {
  const f = fixture(t);
  f.update();
  assert.equal(f.controller.touchTree(point), true);
  assert.equal(f.controller.touchWater(point), true);
  f.advance(180);
  assert.equal(f.controller.touchTree(point), false);
  assert.equal(f.controller.touchWater(point), true);
  f.advance(170);
  assert.equal(f.controller.touchTree(point), true);
  assert.equal(f.controller.touchWater(point), false);
  assert.deepEqual(f.events.map(event => event.cueId), [
    'action.tree.rustle', 'action.water.touch', 'action.water.touch', 'action.tree.rustle',
  ]);
  assert.equal(new Set(f.events.map(event => event.id)).size, f.events.length);
});

test('tree tap level stays quiet at every zoom with narrow left and right panorama', t => {
  const f = fixture(t);
  for (const zoom of [.1, .5, 1, 3, 8]) {
    f.update({}, { ...point, zoom, viewportWidth: 400, viewportHeight: 600 });
    for (const x of [-10000, point.x, 10000]) {
      f.advance(350);
      assert.equal(f.controller.touchTree({ x, y: point.y }), true);
      const event = f.events.at(-1);
      assert.equal(event.gain, 1);
      assert.ok(Math.abs(event.pan) <= .36 + Number.EPSILON);
      assert.equal(Math.sign(event.pan), Math.sign(x - point.x));
    }
  }
  f.advance(350);
  for (const invalid of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }]) {
    assert.equal(f.controller.touchTree(invalid), false);
  }
});

test('menu, hidden, secondary and disposed observers cannot request tree sounds', t => {
  const f = fixture(t);
  for (const control of [{ scope: 'music' }, { visible: false }, { observationOwner: false }]) {
    f.update();
    f.update(control);
    f.advance(350);
    assert.equal(f.controller.touchTree(point), false);
  }
  f.update();
  f.controller.dispose();
  assert.equal(f.controller.touchTree(point), false);
  assert.equal(f.events.length, 0);
});

test('tree feedback reuses short leaf rustles on the action slider without sharing berry cooldown', () => {
  const tree = catalog.cues.find(cue => cue.id === 'action.tree.rustle');
  const bush = catalog.cues.find(cue => cue.id === 'action.bush.rustle');
  assert.deepEqual(tree.assets, bush.assets, 'reuse the original soft leaf recordings');
  assert.equal(tree.bus, 'world');
  assert.equal(tree.mode, 'one-shot');
  assert.equal(tree.maxInstances, 2);
  assert.ok(tree.gainDb <= -16);
  assert.ok(tree.cooldownMs >= 350);
  assert.ok(tree.pitchVariation > 0 && tree.pitchVariation <= .04);
  assert.notEqual(tree.id, bush.id);
});
