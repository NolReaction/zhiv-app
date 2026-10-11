import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { buildWorldAudioFrame, worldAudioListener } = await vite.ssrLoadModule('/features/world/audio/world-audio-frame.ts');
const { createWorldAudioMarkerTracker } = await vite.ssrLoadModule('/features/world/audio/world-audio-markers.ts');
const { createWorldAudioController } = await vite.ssrLoadModule('/features/world/audio/world-audio-controller.ts');
const { connectForestSession } = await vite.ssrLoadModule('/features/world/state/forest-session.ts');
const point = { x: 100, y: 100 };
const emitter = (id, activation = 'production-working', extra = {}) => ({
  id, profileId: 'workshop.woodworking', position: point, activation, stationId: 'workshop', siteId: 'workshop',
  innerRadius: 30, outerRadius: 300, gainDb: 0, ...extra,
});
const polygon = [{ x: 70, y: 70 }, { x: 130, y: 70 }, { x: 130, y: 130 }, { x: 70, y: 130 }];
const scene = { schemaVersion: 1, id: 'sound-test', width: 1200, height: 1200,
  focus: { x: -75, y: -75, width: 350, height: 350 }, actor: { spawn: point, size: 36 },
  terrain: [], paths: [], lights: [], destinations: [], sites: [{ id: 'workshop', initialLevel: 1, entry: point,
    anchor: point, bounds: { x: 80, y: 70, width: 40, height: 40 }, hitArea: polygon,
    states: [{ level: 1, image: '/test.png', imageWidth: 1, imageHeight: 1 }] }],
  audio: { emitters: [emitter('workshop-main')], zones: [] },
  campfires: [{ id: 'clearing-campfire', position: point, radius: 12 }],
};
const now = Date.parse('2026-10-08T12:00:00Z');
const job = (id, stationId = 'workshop', start = now - 1000, end = now + 1000) => ({
  id, stationId, stationLevel: 1, recipeId: 'boards', targetLevel: 2,
  startedAt: new Date(start).toISOString(), finishesAt: new Date(end).toISOString(),
});
const snapshot = jobs => ({ ownerPublicId: 'test-owner', revision: 1, jobs });
const input = extra => ({ ownerId: 'view', sceneId: 'owner:sound-test', ownerPublicId: 'test-owner',
  now, dusk: 0, rain: 0, levels: { workshop: 1 }, fires: [], ...extra });
const cue = (frame, id) => frame.loops.filter(loop => loop.cueId === id);

test('circle listener uses its focus; world camera uses logical viewport width and soft overview detail', () => {
  assert.deepEqual(worldAudioListener(scene).position, point);
  const close = worldAudioListener(scene, { x: 260, y: 180, zoom: 2, viewportWidth: 700 });
  assert.deepEqual(close.position, { x: 260, y: 180 });
  assert.equal(close.viewportWidth, 350);
  assert.equal(close.detail, 1);
  assert.ok(worldAudioListener(scene, { ...point, zoom: .25, viewportWidth: 700 }).detail < .1);
});

test('multiple working and ready slots create one station bed and gently duck music', () => {
  const frame = buildWorldAudioFrame(scene, input({ production: snapshot([job('a'), job('b'), job('ready', 'workshop', now - 3000, now)]) }));
  assert.equal(cue(frame, 'workshop.woodworking').length, 1);
  assert.equal(cue(frame, 'workshop.woodworking')[0].gain, 1);
  assert.ok(Math.abs(frame.musicDuck - .68) < 1e-9);
});

test('ready, future, malformed, and foreign-account jobs remain silent', () => {
  for (const production of [snapshot([job('ready', 'workshop', now - 1000, now)]),
    snapshot([job('future', 'workshop', now + 1000, now + 5000)]),
    snapshot([{ ...job('bad'), finishesAt: 'bad' }]),
    { ...snapshot([job('foreign')]), ownerPublicId: 'someone-else' }]) {
    const frame = buildWorldAudioFrame(scene, input({ production }));
    assert.equal(cue(frame, 'workshop.woodworking').length, 0);
    assert.equal(frame.sources.find(source => source.id === 'workshop-main').reason, 'production-idle-or-ready');
  }
});

test('unbuilt/hidden station gates are visible to diagnostics', () => {
  const production = snapshot([job('a')]);
  assert.equal(buildWorldAudioFrame(scene, input({ production, levels: { workshop: 0 } })).sources.find(x => x.id === 'workshop-main').reason, 'building-unbuilt');
  assert.equal(buildWorldAudioFrame(scene, input({ production, showBuildings: false })).sources.find(x => x.id === 'workshop-main').reason, 'buildings-hidden');
});

test('source fades at distance with pan and does not play from the pet location', () => {
  const frame = buildWorldAudioFrame(scene, input({ production: snapshot([job('a')]), camera: { x: 450, y: 100, zoom: 1, viewportWidth: 350 } }));
  assert.equal(cue(frame, 'workshop.woodworking').length, 0);
  const close = buildWorldAudioFrame(scene, input({ production: snapshot([job('a')]), camera: { x: 160, y: 100, zoom: 1, viewportWidth: 350 } }));
  assert.ok(cue(close, 'workshop.woodworking')[0].pan < 0);
  assert.ok(cue(close, 'workshop.woodworking')[0].gain < 1);
});

test('duplicate station emitters aggregate by station and profile', () => {
  const frame = buildWorldAudioFrame({ ...scene, audio: { emitters: [emitter('a'), emitter('b')], zones: [] } }, input({ production: snapshot([job('a')]) }));
  assert.equal(cue(frame, 'workshop.woodworking').length, 1);
});

test('construction follows the current physical station entry, including the kiln interior', () => {
  const frame = buildWorldAudioFrame(scene, input({ construction: snapshot([job('a', 'kiln'), job('b', 'kiln')]) }));
  assert.equal(cue(frame, 'construction.working').length, 1);
  assert.equal(cue(frame, 'construction.working')[0].gain, 1);
  assert.equal(cue(buildWorldAudioFrame(scene, input({ construction: snapshot([job('r', 'kiln', now - 2000, now)]) })), 'construction.working').length, 0);
});

test('campfire checks its own live fire; dryer working state can own the visible flame', () => {
  const map = { ...scene, audio: { zones: [], emitters: [emitter('fire', 'campfire-lit', { profileId: 'campfire', campfireId: 'clearing-campfire' })] } };
  assert.equal(cue(buildWorldAudioFrame(map, input({ fires: [{ id: 'other', lit: true, flame: 1, position: point }] })), 'campfire').length, 0);
  assert.equal(cue(buildWorldAudioFrame(map, input({ fires: [{ id: 'clearing-campfire', lit: true, flame: .6, position: point }] })), 'campfire')[0].gain, .6);
  assert.equal(cue(buildWorldAudioFrame(map, input({ production: snapshot([job('cook', 'dryer')]) })), 'campfire')[0].gain, 1);
});

test('river polygons blend without adding duplicate loops and include polygon interiors', () => {
  const zone = { id: 'river', profileId: 'river', points: polygon, fadeDistance: 200, gainDb: 0 };
  const map = { ...scene, audio: { emitters: [], zones: [zone, { ...zone, id: 'river-2' }] } };
  const frame = buildWorldAudioFrame(map, input());
  assert.equal(cue(frame, 'river').length, 1);
  assert.equal(cue(frame, 'river')[0].gain, 1);
});

test('day/night and rain are independent layers, available without a production snapshot', () => {
  const frame = buildWorldAudioFrame(scene, input({ dusk: 1, rain: .75 }));
  assert.equal(cue(frame, 'music.day').length, 0);
  assert.equal(cue(frame, 'music.night').length, 1);
  assert.equal(cue(frame, 'weather.rain')[0].gain, .75);
  assert.equal(cue(frame, 'forest.night').length, 1);
});

const marker = token => ({ key: 'speech', token, cueId: 'actor.mochlik.greeting', position: point, active: true });
const markerSnapshot = (epoch, elapsed, token) => ({ epoch, elapsed, markers: [marker(token)] });

test('marker observer suppresses initial hydration, repeated snapshots and silent camera baselines', () => {
  const tracker = createWorldAudioMarkerTracker(), epoch = {}, listener = worldAudioListener(scene);
  assert.equal(tracker.sample(markerSnapshot(epoch, 1, 'old'), listener, 'session', now).length, 0);
  const fresh = tracker.sample(markerSnapshot(epoch, 1.05, 'new'), listener, 'session', now);
  assert.equal(fresh.length, 1);
  assert.equal(tracker.sample(markerSnapshot(epoch, 1.05, 'new'), listener, 'session', now).length, 0);
  assert.equal(tracker.sample(markerSnapshot(epoch, 1.05, 'muted'), listener, 'session', now, false).length, 0);
  assert.equal(tracker.sample(markerSnapshot(epoch, 1.1, 'muted'), listener, 'session', now).length, 0);
});

test('clock jump and rehydrated simulation identity discard offline action backlog', () => {
  const tracker = createWorldAudioMarkerTracker(), epoch = {}, listener = worldAudioListener(scene);
  tracker.sample(markerSnapshot(epoch, 0, null), listener, 'session', now);
  assert.equal(tracker.sample(markerSnapshot(epoch, 10, 'offline'), listener, 'session', now).length, 0);
  assert.equal(tracker.sample(markerSnapshot({}, 0, 'saved'), listener, 'session', now).length, 0);
});

test('a continuing step contact emits once; walk entry and repeated painting do not', () => {
  const tracker = createWorldAudioMarkerTracker(), epoch = {}, listener = worldAudioListener(scene);
  const snap = (elapsed, token, active) => ({ epoch, elapsed, markers: [{ ...marker(token), key: 'mochlik-step', active }] });
  tracker.sample(snap(0, 0, false), listener, 'session', now);
  assert.equal(tracker.sample(snap(.05, 0, true), listener, 'session', now).length, 0);
  assert.equal(tracker.sample(snap(.1, 1, true), listener, 'session', now).length, 1);
  assert.equal(tracker.sample(snap(.1, 1, true), listener, 'session', now).length, 0);
});

test('controller elects only visible observation owner and retains ambient in reduced motion', () => {
  const active = new Map(), events = [];
  const runtime = { updateFrame: frame => active.set(frame.ownerId, frame), clearFrame: owner => active.delete(owner), play: event => events.push(event) };
  const session = connectForestSession(undefined, { ...scene, sites: [] }, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const circle = createWorldAudioController(runtime), world = createWorldAudioController(runtime);
  const control = { scope: 'world', visible: true, observationOwner: true, reducedMotion: true, showHero: true, actorAway: false, emitEvents: true };
  circle.update(scene, session.state, input(), control);
  assert.equal(active.size, 1);
  assert.equal(cue([...active.values()][0], 'music.day').length, 1);
  world.update(scene, session.state, input(), { ...control, observationOwner: false });
  assert.equal(active.size, 1);
  circle.update(scene, session.state, input(), { ...control, observationOwner: false });
  world.update(scene, session.state, input(), control);
  assert.equal(active.size, 1);
  assert.equal(events.length, 0);
  world.update(scene, session.state, input(), { ...control, visible: false });
  assert.equal(active.size, 0);
  circle.dispose(); world.dispose(); session.release();
});

test('repeated simulation and paint observations publish one unchanged mix without swallowing action sounds', () => {
  const frames = [], events = [];
  const runtime = { updateFrame: frame => frames.push(frame), clearFrame() {}, play: event => events.push(event) };
  const session = connectForestSession(undefined, { ...scene, sites: [] }, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const controller = createWorldAudioController(runtime);
  const control = { scope: 'world', visible: true, observationOwner: true, reducedMotion: true, showHero: true, actorAway: false, emitEvents: true };
  try {
    controller.update(scene, session.state, input(), control);
    for (let index = 0; index < 1200; index++) {
      session.state.elapsed = index / 120;
      if (index === 300) session.state.social.current = { id: 'one-greeting', speaker: 'mochlik', text: 'Hello', elapsed: 0, duration: 3 };
      controller.update(scene, session.state, input(), control);
    }
    assert.equal(frames.length, 1, '120 Hz stationary observations do not resubmit the mix');
    assert.equal(events.length, 1, 'a new contact still emits once with an unchanged ambient mix');
    const camera = { x: 200, y: 100, zoom: 1, viewportWidth: 350 };
    controller.update(scene, session.state, input({ camera }), control);
    assert.equal(frames.length, 2, 'a real listener movement immediately updates spatial mixing');
    assert.deepEqual(frames[1].listener.position, { x: 200, y: 100 });
    controller.update(scene, session.state, input({ camera }), { ...control, visible: false });
    controller.update(scene, session.state, input({ camera }), control);
    assert.equal(frames.length, 3, 'returning visibility reclaims the mix even at the same position');
  } finally { controller.dispose(); session.release(); }
});

test('real shared circle and map sessions keep one audio observer during camera movement and handoff', () => {
  const frames = [], events = [];
  let active = null;
  const runtime = { updateFrame(frame) { active = frame; frames.push(frame); },
    clearFrame(ownerId) { if (active?.ownerId === ownerId) active = null; }, play: event => events.push(event) };
  const key = 'audio-shared-camera-regression';
  const circleSession = connectForestSession(key, scene, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const worldSession = connectForestSession(key, scene, 'world', now, 0, () => {}, { persistence: false, sync: false });
  const circle = createWorldAudioController(runtime), world = createWorldAudioController(runtime);
  const control = { scope: 'world', visible: true, reducedMotion: true, showHero: true, actorAway: false, emitEvents: true };
  const updateCircle = () => circle.update(scene, circleSession.state, input(), { ...control, scope: 'music', observationOwner: circleSession.isObservationOwner() });
  const updateWorld = camera => world.update(scene, worldSession.state, input({ camera }),
    { ...control, observationOwner: worldSession.isObservationOwner() });
  try {
    assert.equal(circleSession.state, worldSession.state, 'both renderers share the same actual simulation');
    circleSession.configure('circle', true);
    updateCircle();
    const circleOwner = active.ownerId;
    assert.deepEqual(active.loops.map(loop => loop.cueId), ['music.day']);
    assert.equal(active.soundscape, false);
    const circleMusicKey = active.loops[0].id;
    worldSession.configure('world', true);
    updateCircle(); updateWorld({ x: 100, y: 100, zoom: 1, viewportWidth: 350 });
    const worldOwner = active.ownerId;
    assert.equal(active.soundscape, true);
    assert.equal(cue(active, 'music.day')[0].id, circleMusicKey);
    assert.equal(cue(active, 'forest.day').length, 1);
    assert.notEqual(worldOwner, circleOwner);
    const loopIds = active.loops.map(loop => loop.id);
    for (let index = 0; index < 600; index++) {
      const camera = { x: 100 + Math.sin(index / 30) * 150, y: 100, zoom: 1, viewportWidth: 350 };
      updateWorld(camera); updateCircle();
      assert.equal(active.ownerId, worldOwner, 'secondary circle cannot steal the mix after map paint');
      assert.deepEqual(active.loops.map(loop => loop.id), loopIds, 'camera movement preserves ambient source identities');
    }
    worldSession.configure('world', false);
    updateWorld({ x: 100, y: 100, zoom: 1, viewportWidth: 350 }); updateCircle();
    assert.equal(active.ownerId, circleOwner, 'the previous circle must republish even though its own mix is unchanged');
    assert.deepEqual(active.loops.map(loop => loop.cueId), ['music.day']);
    assert.equal(active.soundscape, false, 'returning to the circle requests a smooth scene-sound fade');
    assert.equal(events.length, 0, 'camera movement and handoff never synthesize action events');
  } finally { circle.dispose(); world.dispose(); circleSession.release(); worldSession.release(); }
});

test('stationary audio keeps a one-second reconciliation heartbeat for retries and released voice budget', t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const frames = [];
  const runtime = { updateFrame: frame => frames.push(frame), clearFrame() {}, play() {} };
  const session = connectForestSession(undefined, { ...scene, sites: [] }, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const controller = createWorldAudioController(runtime);
  const control = { scope: 'world', visible: true, observationOwner: true, reducedMotion: true, showHero: true, actorAway: false };
  try {
    controller.update(scene, session.state, input(), control);
    for (let index = 0; index < 3000; index++) {
      t.mock.timers.tick(10);
      controller.update(scene, session.state, input(), control);
    }
    assert.equal(frames.length, 31, '100 Hz observations become a bounded 1 Hz retry opportunity');
    assert.deepEqual(frames.at(-1), frames[0], 'heartbeat retains the existing mix and source keys');
  } finally { controller.dispose(); session.release(); }
});

test('circle stays music-only during rain, production and character actions; entering the map starts no action backlog', () => {
  let active = null;
  const events = [];
  const runtime = { updateFrame: frame => { active = frame; }, clearFrame() {}, play: event => events.push(event) };
  const session = connectForestSession(undefined, { ...scene, sites: [] }, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const controller = createWorldAudioController(runtime);
  const control = { scope: 'music', visible: true, observationOwner: true, showHero: true, actorAway: false, reducedMotion: false, emitEvents: true };
  const environment = input({ rain: 1, production: snapshot([job('working')]), fires: [{ id: 'clearing-campfire', position: point, lit: true, flame: 1 }] });
  const observeSpeech = (id, scope = 'music') => {
    session.state.elapsed += .05;
    session.state.social.current = { id, speaker: 'mochlik', text: 'Hello', elapsed: 0, duration: 3 };
    controller.update(scene, session.state, environment, { ...control, scope });
  };
  try {
    controller.update(scene, session.state, environment, control);
    observeSpeech('menu-greeting');
    assert.deepEqual(active.loops.map(loop => loop.cueId), ['music.day']);
    assert.equal(active.soundscape, false);
    assert.equal(active.musicDuck, 1, 'nearby production cannot duck the menu song');
    assert.deepEqual(events, [], 'visible character animation does not produce menu audio');
    observeSpeech('map-entry-greeting', 'world');
    assert.equal(active.soundscape, true);
    assert.equal(cue(active, 'weather.rain').length, 1);
    assert.equal(cue(active, 'workshop.woodworking').length, 1);
    assert.deepEqual(events, [], 'entering the map only establishes the current action baseline');
    observeSpeech('new-map-greeting', 'world');
    assert.equal(events.length, 1, 'new map actions remain audible');
    observeSpeech('menu-return-greeting');
    assert.deepEqual(active.loops.map(loop => loop.cueId), ['music.day']);
    assert.equal(active.soundscape, false);
    assert.equal(events.length, 1, 'returning to the circle suppresses character sounds immediately');
  } finally { controller.dispose(); session.release(); }
});

test('replaced simulation state republishes an identical mix after releasing its old frame', () => {
  const frames = [], cleared = [];
  const runtime = { updateFrame: frame => frames.push(frame), clearFrame: owner => cleared.push(owner), play() {} };
  const makeSession = () => connectForestSession(undefined, { ...scene, sites: [] }, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const first = makeSession(), second = makeSession(), controller = createWorldAudioController(runtime);
  const control = { scope: 'world', visible: true, observationOwner: true, reducedMotion: true, showHero: true, actorAway: false };
  try {
    controller.update(scene, first.state, input(), control);
    controller.update(scene, second.state, input(), control);
    assert.equal(cleared.length, 1);
    assert.equal(frames.length, 2, 'state replacement cannot leave audio without an owner');
  } finally { controller.dispose(); first.release(); second.release(); }
});

test('builder sound contacts follow the mallet hit phase, including the two quicker taps', async () => {
  const { worldAudioMarkers } = await vite.ssrLoadModule('/features/world/audio/world-audio-markers.ts');
  const session = connectForestSession(undefined, { ...scene, sites: [] }, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const state = session.state;
  state.builderMind = { available: true, scene, constructionPending: false, sleepPhase: 'awake', sleepProgress: 0,
    action: 'work', age: .9, position: point, direction: 'front', walked: 0, ready: false, jobKey: 'build-1', job: { stationId: 'workshop' } };
  const options = { showHero: true, showBuildings: true, actorAway: false, reducedMotion: false };
  const tracker = createWorldAudioMarkerTracker(), listener = worldAudioListener(scene);
  tracker.sample(worldAudioMarkers(scene, state, options), listener, 'session', now);
  const sample = age => { state.elapsed += .05; state.builderMind.age = age;
    return tracker.sample(worldAudioMarkers(scene, state, options), listener, 'session', now).filter(event => event.cueId === 'action.hammer'); };
  assert.equal(sample(.96).length, 0);
  assert.equal(sample(.98).length, 1);
  assert.equal(sample(1.02).length, 0);
  assert.equal(sample(2.65).length, 0);
  assert.equal(sample(2.7).length, 1);
  assert.equal(sample(3.7).length, 0);
  assert.equal(sample(3.8).length, 1);
  assert.equal(sample(5).length, 0);
  session.release();
});

test('watering starts at visible pour and berry pick follows hand contact; repeated reads stay silent', async () => {
  const { worldAudioMarkers } = await vite.ssrLoadModule('/features/world/audio/world-audio-markers.ts');
  const session = connectForestSession(undefined, { ...scene, sites: [] }, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const state = session.state, tracker = createWorldAudioMarkerTracker(), listener = worldAudioListener(scene);
  const options = { showHero: true, showBuildings: true, actorAway: false, reducedMotion: false };
  state.life.garden.routine = { kind: 'water-bush', bushId: 'berries', phase: 'water', elapsed: .75, totalElapsed: 1, carryingBasket: false };
  tracker.sample(worldAudioMarkers(scene, state, options), listener, 'session', now);
  const sample = elapsed => { state.elapsed += .05; state.life.garden.routine.elapsed = elapsed;
    return tracker.sample(worldAudioMarkers(scene, state, options), listener, 'session', now); };
  assert.deepEqual(sample(.85).map(event => event.cueId), ['action.water.pour']);
  assert.equal(sample(.95).length, 0);
  Object.assign(state.life.garden.routine, { kind: 'harvest-berries', phase: 'collect' });
  assert.equal(sample(1.1).length, 0);
  assert.deepEqual(sample(1.2).map(event => event.cueId), ['action.berry.pick']);
  assert.equal(sample(1.4).length, 0);
  assert.deepEqual(sample(2.2).map(event => event.cueId), ['action.berry.pick']);
  session.release();
});

test('same simulation session shares marker baseline across views and teardown cannot resurrect events', () => {
  const frames = new Map(), events = [];
  const runtime = { updateFrame: frame => frames.set(frame.ownerId, frame), clearFrame: owner => frames.delete(owner), play: event => events.push(event) };
  const session = connectForestSession(undefined, { ...scene, sites: [] }, 'circle', now, 0, () => {}, { persistence: false, sync: false });
  const circle = createWorldAudioController(runtime), world = createWorldAudioController(runtime);
  const control = { scope: 'world', visible: true, observationOwner: true, reducedMotion: true, showHero: true, actorAway: false, emitEvents: true };
  circle.update(scene, session.state, input(), control);
  session.state.social.current = { id: 'speech1', speaker: 'mochlik', text: 'Hello', elapsed: 0, duration: 3 };
  circle.update(scene, session.state, input(), control);
  assert.equal(events.length, 1);
  circle.update(scene, session.state, input(), { ...control, observationOwner: false });
  world.update(scene, session.state, input(), control);
  circle.dispose();
  assert.equal(frames.size, 1);
  assert.equal(events.length, 1);
  world.update(scene, session.state, input(), { ...control, visible: false });
  session.state.social.current.id = 'speech-from-hidden-state';
  world.update(scene, session.state, input(), control);
  assert.equal(events.length, 1);
  world.dispose(); world.update(scene, session.state, input(), control);
  assert.equal(frames.size, 0);
  session.release();
});

test('quarry exploration owns its work sound only after entering its current active account journey', async () => {
  const { quarryAudioWorking } = await vite.ssrLoadModule('/features/world/audio/world-audio-frame.ts');
  const journey = { ...job('mine-job'), routeId: 'quarry_ore' };
  const travel = { jobId: 'mine-job', scene, phase: 'working', mining: { prepared: true } };
  assert.equal(quarryAudioWorking(scene, { journeyTravel: travel }, journey, now), true);
  for (const [changedTravel, changedJourney, time] of [
    [{ ...travel, phase: 'entering' }, journey, now],
    [{ ...travel, phase: 'exiting' }, journey, now],
    [{ ...travel, cancelled: true }, journey, now],
    [{ ...travel, jobId: 'previous-account-or-old-job' }, journey, now],
    [{ ...travel, scene: {} }, journey, now],
    [travel, { ...journey, routeId: 'shore' }, now],
    [travel, null, now],
    [travel, journey, now + 1000],
    [travel, journey, now - 2000],
  ]) assert.equal(quarryAudioWorking(scene, { journeyTravel: changedTravel }, changedJourney, time), false);
  const map = { ...scene, sites: [{ ...scene.sites[0], id: 'quarry' }], audio: {
    zones: [], emitters: [emitter('quarry', 'production-working', { profileId: 'quarry.working', stationId: 'quarry', siteId: 'quarry' })] } };
  assert.equal(cue(buildWorldAudioFrame(map, input({ levels: { quarry: 1 }, quarryWorking: true })), 'quarry.working').length, 1);
  assert.equal(cue(buildWorldAudioFrame(map, input({ levels: { quarry: 1 }, quarryWorking: false })), 'quarry.working').length, 0);
});

test('authored +12dB survives frame conversion within the fourfold gain limit', () => {
  const map = { ...scene, audio: { emitters: [emitter('loud', 'always', { gainDb: 12 })], zones: [] } };
  const frame = buildWorldAudioFrame(map, input());
  assert.ok(Math.abs(cue(frame, 'workshop.woodworking')[0].gain - 10 ** (12 / 20)) < 1e-9);
});
