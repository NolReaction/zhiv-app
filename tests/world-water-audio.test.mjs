import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestWaterContactsFrame, forestWaterFrame } = await vite.ssrLoadModule('/features/world/environment/water/forest-water.ts');
const { createWorldWaterAudioTracker, WATER_AUDIO_INTERVAL } = await vite.ssrLoadModule('/features/world/audio/world-water-audio.ts');
const { worldAudioListener } = await vite.ssrLoadModule('/features/world/audio/world-audio-frame.ts');
const { createWorldAudioController } = await vite.ssrLoadModule('/features/world/audio/world-audio-controller.ts');
const { connectForestSession } = await vite.ssrLoadModule('/features/world/state/forest-session.ts');
const authored = JSON.parse(await readFile(new URL('../features/world/tiled/forest.generated.json', import.meta.url)));
const scene = { ...authored, id: 'water-audio-test', focus: { x: 725, y: 725, width: 350, height: 350 },
  water: { surfaces: [{ id: 'pond', points: [{ x: 800, y: 800 }, { x: 1000, y: 800 }, { x: 1000, y: 1000 }, { x: 800, y: 1000 }] }], exclusions: [] } };
const camera = { x: 900, y: 900, zoom: 1, viewportWidth: 500, viewportHeight: 420 };
const epoch = {};
const options = (elapsed, extra = {}) => ({ elapsed, rain: 1, dusk: 0, reducedMotion: false, ...extra });
const sample = (tracker, elapsed, extra = {}, view = camera, emit = true, sampleEpoch = epoch) =>
  tracker.sample({ scene, epoch: sampleEpoch, options: options(elapsed, extra) }, worldAudioListener(scene, view), view,
    'owner:water', 10000 + elapsed * 1000, emit);
const waterEvents = events => events.filter(event => event.cueId === 'water.drop');

// These are real renderer contacts, not separate random drops or a polling timer.
test('water audio extracts exactly the painted rain impacts and dry fish landing phases', () => {
  for (const rain of [0, .35, 1]) for (const dusk of [0, 1]) for (const elapsed of [0, .17, 5, 17.4, 35]) {
    const input = options(elapsed, { rain, dusk });
    const paint = forestWaterFrame(scene, input), contact = forestWaterContactsFrame(scene, input);
    assert.deepEqual(contact.impacts, paint.impacts);
    assert.deepEqual(contact.splashes, paint.splashes);
  }
  assert.deepEqual(forestWaterContactsFrame(scene, options(3, { reducedMotion: true })), { impacts: [], splashes: [] });
});

test('a storm produces sparse soft nearby plops, each at a newly painted contact, once only', () => {
  const tracker = createWorldWaterAudioTracker(), emitted = [];
  assert.deepEqual(sample(tracker, 0), [], 'entering on existing rings is silent');
  for (let tick = 1; tick <= 600; tick++) {
    const elapsed = tick * .025, events = sample(tracker, elapsed);
    assert.ok(events.length <= 1);
    for (const event of events) {
      const frame = forestWaterContactsFrame(scene, options(elapsed));
      assert.ok(frame.impacts.some(p => event.id.endsWith(`drop:${p.eventId}`) && p.phase <= .12)
        || frame.splashes.some(p => event.id.endsWith(`splash:${p.id}`) && p.phase <= .12));
      assert.ok(event.gain > .06 && event.gain <= 1);
      assert.ok(event.pan >= -1 && event.pan <= 1);
      assert.equal(event.maxAgeMs, 250, 'cold assets cannot arrive after their visible ripple');
      emitted.push({ event, elapsed });
    }
    assert.deepEqual(sample(tracker, elapsed), [], 'subscription and paint copy do not replay');
  }
  assert.ok(emitted.length >= 5 && emitted.length <= 13, `sparse river: ${emitted.length}`);
  for (let index = 1; index < emitted.length; index++) assert.ok(emitted[index].elapsed - emitted[index - 1].elapsed >= WATER_AUDIO_INTERVAL);
  assert.equal(new Set(emitted.map(({ event }) => event.id)).size, emitted.length);
});

test('camera movement cannot revive existing rings; far, overview and offscreen water remain quiet', () => {
  const tracker = createWorldWaterAudioTracker(), far = { ...camera, x: 20, y: 20 };
  for (let tick = 0; tick < 100; tick++) assert.deepEqual(sample(tracker, tick * .025, {}, far), []);
  const elapsed = 2.475;
  assert.deepEqual(sample(tracker, elapsed, {}, camera), [], 'pan at the same simulation clock');
  // Changing day/night at a frozen clock still cannot create a water hit.
  assert.deepEqual(sample(tracker, elapsed, { dusk: 1 }, camera), []);
  const overview = { ...camera, zoom: .1 };
  const noScreen = { ...camera, y: 700, viewportHeight: 60 };
  for (const view of [far, overview, noScreen]) {
    const quiet = createWorldWaterAudioTracker();
    for (let tick = 0; tick < 200; tick++) assert.deepEqual(sample(quiet, tick * .025, {}, view), []);
  }
  const portrait = createWorldWaterAudioTracker(), landscape = createWorldWaterAudioTracker();
  let tallCount = 0, shortCount = 0;
  for (let tick = 0; tick < 400; tick++) {
    tallCount += sample(portrait, tick * .025).length;
    shortCount += sample(landscape, tick * .025, {}, { ...camera, viewportHeight: 20 }).length;
  }
  assert.ok(tallCount > shortCount, 'height is respected independently of width');
});

test('pause, restore, reset and reduced motion skip missed contacts instead of building a backlog', () => {
  const tracker = createWorldWaterAudioTracker();
  sample(tracker, 0);
  assert.deepEqual(sample(tracker, 15), [], 'long pause consumes current rings silently');
  assert.deepEqual(sample(tracker, 15), [], 'stationary clock');
  assert.deepEqual(sample(tracker, 2), [], 'clock rollback');
  assert.deepEqual(sample(tracker, 2.025, {}, camera, true, {}), [], 'new simulation epoch');
  for (let tick = 0; tick < 60; tick++) assert.deepEqual(sample(tracker, tick * .025, { reducedMotion: true }), []);
  tracker.reset();
  assert.deepEqual(sample(tracker, 12), [], 'visibility return does not replay existing rings');
  for (let tick = 0; tick < 100; tick++) assert.deepEqual(sample(tracker, tick * .025, {}, camera, false), []);
});

test('a rehydrated simulation can replay new contacts in the same cycle without runtime ID collisions', () => {
  const tracker = createWorldWaterAudioTracker(), first = [], second = [];
  for (let tick = 0; tick < 100; tick++) first.push(...sample(tracker, tick * .025));
  // A clock rewind starts a new observation sequence, not a queued old hit.
  for (let tick = 0; tick < 100; tick++) second.push(...sample(tracker, tick * .025));
  assert.ok(first.length > 0 && second.length > 0);
  assert.equal(first[0].id.split(':').slice(-4).join(':'), second[0].id.split(':').slice(-4).join(':'), 'same visual cycle');
  assert.equal(first.some(event => second.some(other => other.id === event.id)), false, 'fresh event IDs survive runtime dedup');
});

test('dry water sounds come from visible fish landings; DEV fish off, still frame and night remain silent', () => {
  for (const extra of [{ rain: 0, waterFish: 'off' }, { rain: 0, dusk: 1 }, { rain: 0, reducedMotion: true }]) {
    const tracker = createWorldWaterAudioTracker();
    for (let tick = 0; tick < 800; tick++) assert.deepEqual(sample(tracker, tick * .05, extra), []);
  }
  const tracker = createWorldWaterAudioTracker();
  let count = 0;
  for (let tick = 0; tick < 800; tick++) for (const event of sample(tracker, tick * .05, { rain: 0 })) {
    assert.match(event.id, /splash:/); count++;
  }
  assert.ok(count > 0, 'ordinary clear-water fish contacts remain audible');
});

test('map controller consumes contacts in menu and at view/visibility handoff without replay', () => {
  const events = [], frames = [];
  const runtime = { updateFrame: frame => frames.push(frame), clearFrame() {}, play: event => events.push(event) };
  const session = connectForestSession(undefined, scene, 'circle', 10000, 0, () => {}, { persistence: false, sync: false });
  const controller = createWorldAudioController(runtime), secondary = createWorldAudioController(runtime);
  const input = { sceneId: 'owner:water', now: 10000, rain: 1, dusk: 0, camera, levels: {}, fires: [], showBuildings: false };
  const control = { scope: 'music', visible: true, observationOwner: true, emitEvents: true, showHero: false, actorAway: false, reducedMotion: false };
  const step = (elapsed, settings = {}, viewInput = input, handle = controller) => {
    session.state.elapsed = elapsed;
    handle.update(scene, session.state, viewInput, { ...control, ...settings });
  };
  try {
    for (let tick = 0; tick < 100; tick++) step(tick * .025);
    assert.equal(waterEvents(events).length, 0, 'circle stays music only');
    step(2.475, { scope: 'world' });
    assert.equal(waterEvents(events).length, 0, 'first map observation seeds only');
    for (let tick = 100; tick < 300; tick++) {
      step(tick * .025, { scope: 'world' });
      step(tick * .025, { scope: 'world', observationOwner: false }, input, secondary);
      step(tick * .025, { scope: 'world', emitEvents: false }, { ...input, camera: { ...camera, x: 900 + tick % 3 } });
    }
    assert.ok(waterEvents(events).length > 0);
    events.length = 0;
    step(7.475, { scope: 'music' });
    step(7.475, { scope: 'world' });
    step(8, { scope: 'world', visible: false });
    step(18, { scope: 'world' });
    step(18, { scope: 'world' });
    assert.equal(waterEvents(events).length, 0, 'return/hidden pause/camera copies are silent');
    assert.ok(frames.some(frame => frame.soundscape === false));
  } finally { controller.dispose(); secondary.dispose(); session.release(); }
});

test('water plops use the forest/water bus and are independently capped in runtime catalog', async () => {
  const catalog = JSON.parse(await readFile(new URL('../features/audio/catalog/audio-catalog.json', import.meta.url)));
  const cue = catalog.cues.find(item => item.id === 'water.drop');
  assert.equal(cue.bus, 'ambience');
  assert.equal(cue.mode, 'one-shot');
  assert.equal(cue.maxInstances, 1);
  assert.ok(cue.cooldownMs >= WATER_AUDIO_INTERVAL * 1000);
});
