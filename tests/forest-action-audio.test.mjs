import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { worldAudioMarkers, createWorldAudioMarkerTracker } = await vite.ssrLoadModule('/features/world/audio/world-audio-markers.ts');
const { worldAudioListener } = await vite.ssrLoadModule('/features/world/audio/world-audio-frame.ts');
const { createWorldAudioController } = await vite.ssrLoadModule('/features/world/audio/world-audio-controller.ts');
const { connectForestSession } = await vite.ssrLoadModule('/features/world/state/forest-session.ts');
const { createClearingActivity, requestClearingBush, advanceClearingActivity } = await vite.ssrLoadModule('/features/world/simulation/clearing-activity.ts');
const { triggerForestLife, advanceForestLife, forestLifeFrame, interruptForestLife } = await vite.ssrLoadModule('/features/world/simulation/forest-life.ts');
const point = (x, y) => ({ x, y });
const scene = { schemaVersion: 1, id: 'action-audio', width: 400, height: 400, terrain: [], sites: [],
  focus: { x: 50, y: 50, width: 300, height: 300 }, actor: { spawn: point(200, 210), size: 40 },
  paths: [{ id: 'bush-path', behavior: 'clearing', activity: 'bush', bushId: 'nearby-bush', pauseSeconds: 3,
    points: [point(200, 210), point(185, 210), point(180, 190)] }],
  bushes: [{ id: 'nearby-bush', points: [point(150, 135), point(190, 135), point(190, 185), point(150, 185)],
    entry: point(180, 190), hide: point(165, 175) }],
  mushrooms: [{ id: 'mushroom', position: point(194, 218) }],
};
const options = { showHero: true, showBuildings: false, actorAway: false, reducedMotion: false };
const conditions = { enabled: true, blocked: false, dusk: 0, rain: 0, autoLife: false };
const now = Date.parse('2026-10-11T12:00:00Z');
const listener = worldAudioListener(scene);
const makeSession = () => connectForestSession(undefined, scene, 'world', now, 0, () => {}, { persistence: false, sync: false });
const sample = (tracker, state, changes = {}, heard = true, position = listener) =>
  tracker.sample(worldAudioMarkers(scene, state, { ...options, ...changes }), position, 'test', now + state.elapsed * 1000, heard);
const only = (events, cueId) => events.filter(event => event.cueId === cueId);
const advance = (state, seconds, callback = () => {}, blocked = false) => {
  for (let tick = 0; tick < Math.round(seconds / .025); tick++) {
    state.elapsed += .025;
    advanceForestLife(state.life, .025, { ...conditions, blocked });
    callback();
  }
};

test('a real bush visit sounds once at the existing foliage contact, never once per paint or shake', () => {
  const session = makeSession(), state = session.state, tracker = createWorldAudioMarkerTracker();
  const heard = [];
  try {
    state.clearing = createClearingActivity(scene, 1);
    sample(tracker, state);
    assert.equal(requestClearingBush(state.clearing), true);
    for (let tick = 0; tick < 1000; tick++) {
      const previous = state.clearing.bushEffect?.emitted ?? 0;
      state.elapsed += .025;
      advanceClearingActivity(state.clearing, .025, { ...conditions, enabled: true });
      const events = only(sample(tracker, state), 'action.bush.rustle');
      if (events.length) {
        assert.equal(previous & 1, 0, 'entry sound occurs when the leaves are first displaced');
        assert.equal(state.clearing.bushEffect.emitted & 1, 1);
        assert.equal(state.clearing.stage, 'bush-enter');
        assert.ok(state.clearing.bushProgress >= .5);
        heard.push(...events);
      }
      for (let paint = 0; paint < 3; paint++) assert.equal(only(sample(tracker, state), 'action.bush.rustle').length, 0);
      if (heard.length && state.clearing.stage === 'home') break;
    }
    assert.equal(heard.length, 1);
  } finally { session.release(); }
});

test('mushroom bites follow the three visible chewing cycles, with no pickup or swallowed-food sounds', () => {
  const session = makeSession(), state = session.state, tracker = createWorldAudioMarkerTracker(), contacts = [];
  try {
    sample(tracker, state);
    triggerForestLife(state.life, 'mushroom');
    advance(state, 8.2, () => {
      const events = only(sample(tracker, state), 'action.mushroom.eat');
      if (events.length) {
        const frame = forestLifeFrame(state.life, { ...state.clearing.position, size: state.clearing.size }, state.elapsed);
        assert.equal(frame.stage, 'chew');
        assert.equal(frame.frame, 0, 'bite begins the next four-frame mouth cycle');
        assert.ok(frame.heldMushroom);
        contacts.push(state.life.routine.elapsed);
      }
      assert.equal(only(sample(tracker, state), 'action.mushroom.eat').length, 0);
    });
    assert.equal(contacts.length, 3);
    for (let index = 0; index < contacts.length; index++) assert.ok(Math.abs(contacts[index] - (4.1 + .8 * index)) < .026);
    // DEV replay uses the same semantic action and must not reuse an old bite.
    triggerForestLife(state.life, 'mushroom');
    const replay = [];
    advance(state, 8.2, () => replay.push(...only(sample(tracker, state), 'action.mushroom.eat')));
    assert.equal(replay.length, 3);
  } finally { session.release(); }
});

test('interruption and a paused prop animation cannot invent or repeat mushroom bites', () => {
  for (const interruptedAt of [3.9, 4.2]) {
    const session = makeSession(), state = session.state, tracker = createWorldAudioMarkerTracker(), events = [];
    try {
      sample(tracker, state);
      triggerForestLife(state.life, 'mushroom');
      const hear = () => events.push(...only(sample(tracker, state), 'action.mushroom.eat'));
      advance(state, interruptedAt, hear);
      const previous = events.length;
      advance(state, 2, hear, true);
      assert.equal(events.length, previous, 'manual animation pauses routine contacts');
      interruptForestLife(state.life);
      advance(state, 2, hear);
      assert.equal(events.length, interruptedAt < 4.1 ? 0 : 1);
    } finally { session.release(); }
  }
});

test('hydration, clock jumps, reduced motion, invisibility and out-of-range contacts stay consumed', () => {
  const session = makeSession(), state = session.state;
  try {
    triggerForestLife(state.life, 'mushroom');
    advance(state, 4.2);
    const tracker = createWorldAudioMarkerTracker();
    assert.equal(only(sample(tracker, state), 'action.mushroom.eat').length, 0, 'first sample is a baseline');
    for (const change of [{ reducedMotion: true }, { showHero: false }, { actorAway: true }]) {
      sample(tracker, state, change);
      assert.equal(only(sample(tracker, state), 'action.mushroom.eat').length, 0, 'no replay after a visual toggle');
    }
    const silent = createWorldAudioMarkerTracker();
    sample(silent, state);
    advance(state, .8, () => assert.equal(only(sample(silent, state, {}, true,
      { ...listener, position: point(5000, 5000) }), 'action.mushroom.eat').length, 0));
    assert.equal(only(sample(silent, state), 'action.mushroom.eat').length, 0, 'camera return cannot play an old bite');
    advance(state, .8);
    assert.equal(only(sample(tracker, state), 'action.mushroom.eat').length, 0, 'long gaps discard the contact');
    state.clearing = createClearingActivity(scene, 3);
    assert.equal(only(sample(tracker, state), 'action.mushroom.eat').length, 0, 'rehydrated epoch starts silently');
  } finally { session.release(); }
});

test('menu, mute sampling and map reentry never release a backlog of action contacts', () => {
  const session = makeSession(), state = session.state, events = [];
  const controller = createWorldAudioController({ updateFrame() {}, clearFrame() {}, play: event => events.push(event) });
  const input = { sceneId: 'test', now, dusk: 0, rain: 0, levels: {}, fires: [], showBuildings: false };
  const control = { ...options, scope: 'music', visible: true, observationOwner: true, emitEvents: true };
  try {
    controller.update(scene, state, input, control);
    triggerForestLife(state.life, 'mushroom');
    advance(state, 4.2, () => controller.update(scene, state, input, control));
    controller.update(scene, state, input, { ...control, scope: 'world' });
    assert.equal(only(events, 'action.mushroom.eat').length, 0);
    advance(state, .8, () => controller.update(scene, state, input, { ...control, scope: 'world', emitEvents: false }));
    controller.update(scene, state, input, { ...control, scope: 'world' });
    assert.equal(only(events, 'action.mushroom.eat').length, 0);
    advance(state, .8, () => controller.update(scene, state, input, { ...control, scope: 'world' }));
    assert.equal(only(events, 'action.mushroom.eat').length, 1, 'only the next real bite is audible');
  } finally { controller.dispose(); session.release(); }
});

test('each new resident speaks once from his own feet even when the main hero is away', () => {
  const session = makeSession(), state = session.state;
  try {
    for (const [index, speaker] of ['lopukh', 'kamneshmyg', 'leaftail'].entries()) {
      const tracker = createWorldAudioMarkerTracker();
      const resident = state.villagers.residents[speaker];
      resident.available = true; resident.position = point(80 + index * 65, 130);
      state.social.current = null;
      sample(tracker, state, { showBuildings: true, showHero: false, actorAway: true });
      state.social.current = { id: `resident-tap-${speaker}`, speaker, text: 'Привет!', elapsed: 0, duration: 3, origin: 'interaction' };
      state.elapsed += .025;
      const snapshot = worldAudioMarkers(scene, state, { ...options, showBuildings: true, showHero: false, actorAway: true });
      const marker = snapshot.markers.find(marker => marker.key === 'speech');
      assert.deepEqual(marker.position, resident.position);
      assert.notDeepEqual(marker.position, state.clearing.position, 'a new resident never borrows the absent hero position');
      const events = tracker.sample(snapshot, listener, 'test', now + state.elapsed * 1000);
      assert.equal(events.length, 1); assert.equal(events[0].cueId, `actor.${speaker}.greeting`);
      assert.equal(events[0].gain, 1, 'direct replies remain audible in overview');
      assert.equal(sample(tracker, state, { showBuildings: true, showHero: false, actorAway: true }).length, 0);
      assert.equal(sample(tracker, state, { showBuildings: true, showHero: false, actorAway: true }).length, 0);
    }
  } finally { session.release(); }
});
