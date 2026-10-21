import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root, configFile: false, logLevel: 'silent', resolve: { alias: { '@': root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const load = path => vite.ssrLoadModule(`/features/world/${path}.ts`);
const { TILED_WORLD } = await load('scene/presentation');
const { previewWorldScene, initialPreviewLevels } = await load('tiled/preview-state');
const { connectForestSession } = await load('state/forest-session');
const { worldAudioMarkers, createWorldAudioMarkerTracker } = await load('audio/world-audio-markers');
const { worldAudioListener, quarryAudioWorking } = await load('audio/world-audio-frame');
const { createWorldAudioController } = await load('audio/world-audio-controller');
const { syncForestJourneyTravel, forestJourneyFishingFrame } = await load('activities/journeys/forest-journey-travel');
const { miningWorkRhythm } = await load('activities/mining/forest-mining');
const { createPleskMind, advancePleskMind, pleskMindFrame } = await load('characters/plesk/plesk-mind');
const { fishingShoreRig } = await load('activities/fishing/fishing-shore-rig');
const { fishingTackleFrame } = await load('activities/fishing/fishing-props');
const scene = previewWorldScene(TILED_WORLD, { ...initialPreviewLevels(TILED_WORLD), quarry: 1 });
const now = Date.parse('2026-10-12T12:00:00Z');
const options = { showHero: true, showBuildings: true, actorAway: false, reducedMotion: false };
const create = () => connectForestSession(undefined, scene, 'world', now, 0, () => {}, { persistence: false, sync: false });
const journey = routeId => ({ id: `work-${routeId}`, routeId, rewards: { fish: 4, stone: 8 },
  startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 100_000).toISOString() });
const at = position => worldAudioListener(scene, { ...position, zoom: 2, viewportWidth: 700 });
const only = (events, cue) => events.filter(event => event.cueId === cue);

for (const character of ['mochlik', 'plesk']) test(`${character} float sounds once at the actual cast landing, with no waiting-phase repeats`, () => {
  const session = create(), state = session.state, tracker = createWorldAudioMarkerTracker();
  try {
    let frame;
    if (character === 'mochlik') {
      syncForestJourneyTravel(state, scene, journey('shore'), now, false);
      frame = () => forestJourneyFishingFrame(state, scene);
      state.pleskMind = null;
    } else {
      state.pleskMind = createPleskMind(scene);
      frame = () => pleskMindFrame(state.pleskMind, scene, false);
    }
    const sample = () => {
      const visible = frame();
      const events = only(tracker.sample(worldAudioMarkers(scene, state, options),
        at(visible?.waterTarget ?? visible ?? state.pleskMind?.position ?? state.clearing.position), 'test', now + state.elapsed * 1000), 'action.fish.bobber');
      if (!visible) assert.equal(events.length, 0, 'an indoor resident cannot splash an invisible float');
      return events;
    };
    assert.equal(sample().length, 0);
    let impacts = 0;
    for (let tick = 1; tick <= 4000; tick++) {
      const before = frame();
      state.elapsed += .05;
      if (character === 'mochlik') state.journeyTravel.jobAge += .05;
      else advancePleskMind(state.pleskMind, scene, .05, { rain: 0, dusk: 0 });
      const afterFrame = frame(), events = sample();
      if (events.length) {
        assert.equal(before.action, 'cast');
        assert.equal(afterFrame.action, 'fish');
        const beforeTackle = fishingTackleFrame(before, false, fishingShoreRig(before, false, character));
        const afterTackle = fishingTackleFrame(afterFrame, false, fishingShoreRig(afterFrame, false, character));
        assert.ok(beforeTackle.cast < 1);
        assert.equal(afterTackle.cast, 1);
        assert.equal(events.length, 1);
        assert.equal(events[0].maxAgeMs, 250, 'late decoded contacts expire instead of sounding in the waiting pose');
        impacts++;
      }
      assert.equal(sample().length, 0, 'repeated paints never trigger another impact');
    }
    assert.ok(impacts >= 2, 'later real casts are audible, not just the first cast');
  } finally { session.release(); }
});

test('old floats stay silent after first observation, pan, reduced motion, hidden actor and long gaps', () => {
  const session = create(), state = session.state;
  try {
    syncForestJourneyTravel(state, scene, journey('shore'), now, false);
    state.pleskMind = null;
    const travel = state.journeyTravel, started = travel.jobAge;
    const sample = (tracker, changes = {}, emit = true, far = false) => only(tracker.sample(worldAudioMarkers(scene, state,
      { ...options, ...changes }), at(far ? { x: 5000, y: 5000 } : travel.waterTarget), 'test', now, emit), 'action.fish.bobber');
    for (const changes of [{ reducedMotion: true }, { showHero: false }, { actorAway: true }]) {
      const tracker = createWorldAudioMarkerTracker();
      travel.jobAge = started + 3.15; state.elapsed = 3.15; sample(tracker, changes);
      travel.jobAge = started + 3.25; state.elapsed += .1;
      assert.equal(sample(tracker, changes).length, 0);
      assert.equal(sample(tracker).length, 0, 'revealing a landed float is not a new cast');
    }
    for (const cause of ['initial', 'far', 'gap', 'muted', 'changed-job']) {
      const tracker = createWorldAudioMarkerTracker();
      travel.jobAge = started + 3.15; state.elapsed = 3.15;
      if (cause !== 'initial') sample(tracker);
      travel.jobAge = started + 3.25; state.elapsed += cause === 'gap' ? 10 : .1;
      if (cause === 'changed-job') travel.jobId += '-new';
      assert.equal(sample(tracker, {}, cause !== 'muted', cause === 'far').length, 0, cause);
      assert.equal(sample(tracker).length, 0);
    }
  } finally { session.release(); }
});

test('the mine contacts share the painted pickaxe beat and require the confirmed local working phase', () => {
  const session = create(), state = session.state, job = journey('quarry_stone'), tracker = createWorldAudioMarkerTracker();
  try {
    syncForestJourneyTravel(state, scene, job, now, false);
    assert.equal(state.journeyTravel.phase, 'working');
    const doorway = state.journeyTravel.mining.doorway;
    const sample = (changes = {}, confirmed = job, time = now) => {
      const snapshot = worldAudioMarkers(scene, state, { ...options, actorAway: true,
        quarryWorking: quarryAudioWorking(scene, state, confirmed, time), ...changes });
      assert.deepEqual(snapshot.markers.find(marker => marker.key === 'mochlik-mine').position, doorway);
      return only(tracker.sample(snapshot, at(doorway), 'test', time), 'action.mine.strike');
    };
    assert.equal(sample().length, 0);
    let strikes = 0;
    for (let tick = 1; tick <= 160; tick++) {
      const before = miningWorkRhythm(state.director.elapsed);
      state.elapsed += .05; state.director.elapsed += .05;
      const events = sample();
      if (events.length) {
        assert.notEqual(miningWorkRhythm(state.director.elapsed).strike, before.strike);
        assert.ok(miningWorkRhythm(state.director.elapsed).swing < -.98);
        assert.equal(events[0].gain, 1);
        assert.equal(events[0].pan, 0);
        assert.equal(events[0].maxAgeMs, 250);
        strikes++;
      }
      assert.equal(sample().length, 0);
    }
    assert.equal(strikes, 4);
    const originalId = state.journeyTravel.jobId;
    state.journeyTravel.jobId = 'replacement-job';
    assert.equal(sample({}, { ...job, id: 'replacement-job' }).length, 0, 'a new job starts with its own silent baseline');
    state.journeyTravel.jobId = originalId;
    sample();
    for (const [changes, confirmed, time] of [[{ reducedMotion: true }, job, now], [{ showBuildings: false }, job, now],
      [{}, null, now], [{}, { ...job, id: 'old-account' }, now], [{}, job, Date.parse(job.finishesAt)]]) {
      sample(changes, confirmed, time);
      state.elapsed += .05; state.director.elapsed += 2;
      assert.equal(sample(changes, confirmed, time).length, 0);
      assert.equal(sample().length, 0, 'reenabling work must wait for its next real contact');
    }
    for (const phase of ['leaving', 'entering', 'exiting', 'returning']) {
      state.journeyTravel.phase = phase;
      state.elapsed += .05; state.director.elapsed += 2;
      assert.equal(sample().length, 0);
    }
  } finally { session.release(); }
});

test('map preparation warms shared contacts and new resident greetings, and aborts on hidden view, menu and disposal', () => {
  const session = create(), state = session.state, preparations = [];
  const controller = createWorldAudioController({ updateFrame() {}, clearFrame() {}, play() {},
    prepare(cues, options) { preparations.push({ cues, signal: options.signal }); return Promise.resolve(); } });
  const input = { sceneId: 'test', now, dusk: 0, rain: 0, levels: {}, fires: [] };
  const control = { ...options, scope: 'music', visible: true, observationOwner: true, emitEvents: true };
  try {
    controller.update(scene, state, input, control);
    assert.equal(preparations.length, 0);
    controller.update(scene, state, input, { ...control, scope: 'world' });
    controller.update(scene, state, input, { ...control, scope: 'world' });
    assert.equal(preparations.length, 1);
    assert.deepEqual(preparations[0].cues, ['action.fish.bobber', 'action.mine.strike', 'action.tree.rustle',
      'actor.lopukh.greeting', 'actor.kamneshmyg.greeting', 'actor.leaftail.greeting']);
    controller.update(scene, state, input, { ...control, scope: 'world', visible: false });
    assert.equal(preparations[0].signal.aborted, true);
    controller.update(scene, state, input, { ...control, scope: 'world' });
    controller.update(scene, state, input, control);
    assert.equal(preparations[1].signal.aborted, true);
    controller.update(scene, state, input, { ...control, scope: 'world' });
    controller.dispose();
    assert.equal(preparations[2].signal.aborted, true);
  } finally { controller.dispose(); session.release(); }
});
