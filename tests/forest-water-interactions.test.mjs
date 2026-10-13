import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root, configFile: false, logLevel: 'silent', resolve: { alias: { '@': root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const load = path => vite.ssrLoadModule(`/features/world/${path}.ts`);
const { createForestWaterInteractionTracker, FOREST_WATER_INTERACTION_LIMITS } = await load('environment/water/forest-water-interactions');
const { forestWaterContactsFrame } = await load('environment/water/forest-water');
const { TILED_WORLD: scene } = await load('scene/presentation');
const { connectForestSession } = await load('state/forest-session');
const { syncForestJourneyTravel, forestJourneyFishingFrame } = await load('activities/journeys/forest-journey-travel');
const { createPleskMind, advancePleskMind, pleskMindFrame } = await load('characters/plesk/plesk-mind');
const epoch = {};
const now = Date.parse('2026-10-13T12:00:00Z');
const frame = (action = 'cast', phase = .8, extra = {}) => ({ x: 900, y: 700, size: 40, direction: 'right',
  action, phase, frame: 0, carryingFish: false, waterTarget: { x: 940, y: 760 }, ...extra });
const fisher = (pose, extra = {}) => ({ key: 'mochlik', token: 'job:0', frame: pose, visible: true, ...extra });
const snapshot = (elapsed, fishing = [], extra = {}) => ({ epoch, scene, elapsed, reducedMotion: false, fishing, ...extra });
const castEvents = events => events.filter(event => event.kind === 'cast');

for (const character of ['mochlik', 'plesk']) test(`${character} disturbs water once when the actual float completes its cast`, () => {
  const session = connectForestSession(undefined, scene, 'world', now, 0, () => {}, { persistence: false, sync: false });
  const state = session.state, tracker = createForestWaterInteractionTracker();
  try {
    let displayed, token;
    if (character === 'mochlik') {
      syncForestJourneyTravel(state, scene, { id: 'water-fishing-job', routeId: 'shore', rewards: { fish: 4 },
        startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + 200_000).toISOString() }, now, false);
      displayed = () => forestJourneyFishingFrame(state, scene);
      token = pose => `${state.journeyTravel.jobId}:${pose?.castIndex ?? 0}`;
    } else {
      state.pleskMind = createPleskMind(scene);
      displayed = () => pleskMindFrame(state.pleskMind, scene, false);
      token = () => state.pleskMind.decisions;
    }
    const sample = () => {
      const pose = displayed();
      return tracker.sample(snapshot(state.elapsed, [fisher(pose, { key: character, token: token(pose) })], { epoch: state.clearing }));
    };
    assert.deepEqual(sample(), []);
    let impacts = 0;
    for (let tick = 1; tick <= 3000; tick++) {
      const before = displayed();
      state.elapsed += .05;
      if (character === 'mochlik') state.journeyTravel.jobAge += .05;
      else advancePleskMind(state.pleskMind, scene, .05, { rain: 0, dusk: 0 });
      const afterFrame = displayed(), events = castEvents(sample());
      if (events.length) {
        assert.equal(before.action, 'cast');
        assert.ok(before.phase < 1);
        assert.ok(afterFrame.action === 'fish' || afterFrame.action === 'cast' && afterFrame.phase === 1);
        assert.equal(events.length, 1);
        assert.deepEqual({ x: events[0].x, y: events[0].y }, afterFrame.waterTarget);
        assert.ok(events[0].strength > 1 && events[0].radius > 0);
        impacts++;
      }
      assert.deepEqual(sample(), [], 'a second camera at this clock cannot replay contacts');
    }
    assert.ok(impacts >= 2, `observed later real casts: ${impacts}`);
  } finally { session.release(); }
});

test('the observer copies mutable frames and consumes one landing per cast token', () => {
  const tracker = createForestWaterInteractionTracker(), pose = frame();
  tracker.sample(snapshot(0, [fisher(pose)]));
  pose.phase = 1;
  assert.equal(castEvents(tracker.sample(snapshot(.1, [fisher(pose)]))).length, 1);
  pose.phase = .8;
  assert.deepEqual(tracker.sample(snapshot(.15, [fisher(pose)])), []);
  pose.phase = 1;
  assert.deepEqual(tracker.sample(snapshot(.2, [fisher(pose)])), [], 'same cast cannot land a second time');
  pose.phase = .8;
  tracker.sample(snapshot(.25, [fisher(pose, { token: 'job:1' })]));
  pose.action = 'fish'; pose.phase = 0;
  assert.equal(castEvents(tracker.sample(snapshot(.3, [fisher(pose, { token: 'job:1' })]))).length, 1);
});

test('two nearby fishers keep independent cast identities without an audio listener', () => {
  const tracker = createForestWaterInteractionTracker();
  const fishers = pose => [fisher(pose), fisher(pose, { key: 'plesk', token: 12 })];
  tracker.sample(snapshot(0, fishers(frame())));
  const impulses = tracker.sample(snapshot(.05, fishers(frame('fish', .01))));
  assert.equal(impulses.length, 2);
  assert.equal(new Set(impulses.map(impulse => impulse.id)).size, 2);
  assert.ok(impulses.every(impulse => impulse.kind === 'cast'));
});

test('first observation, long gaps, rewinds, epoch changes and scene changes seed without replay', () => {
  const water = fisher(frame('fish', .01));
  assert.deepEqual(createForestWaterInteractionTracker().sample(snapshot(1, [water])), []);
  for (const change of [{ elapsed: 20 }, { elapsed: 0 }, { epoch: {} }, { scene: { ...scene } }]) {
    const tracker = createForestWaterInteractionTracker();
    tracker.sample(snapshot(1, [fisher(frame())]));
    const current = snapshot(1.05, [water], change);
    assert.deepEqual(tracker.sample(current), []);
    assert.deepEqual(tracker.sample({ ...current, elapsed: current.elapsed + .05 }), []);
  }
  const tracker = createForestWaterInteractionTracker();
  tracker.sample(snapshot(1, [fisher(frame())]));
  tracker.reset();
  assert.deepEqual(tracker.sample(snapshot(1.1, [water])), []);
  const replacementEpoch = {};
  assert.deepEqual(tracker.sample(snapshot(1.15, [fisher(frame())], { epoch: replacementEpoch })), []);
  assert.equal(castEvents(tracker.sample(snapshot(1.2, [water], { epoch: replacementEpoch }))).length, 1,
    'a new session may observe a new landing even when a previous session used this cast token');
});

test('hidden actors, reduced motion and explicit suspension consume contacts instead of queuing them', () => {
  for (const cause of ['hidden', 'reduced', 'suspended']) {
    const tracker = createForestWaterInteractionTracker();
    const sample = (elapsed, pose, suppressed) => tracker.sample(snapshot(elapsed,
      [fisher(pose, { visible: !(suppressed && cause === 'hidden') })],
      { reducedMotion: suppressed && cause === 'reduced' }), !(suppressed && cause === 'suspended'));
    sample(0, frame(), false);
    assert.deepEqual(sample(.05, frame('fish', .01), true), []);
    assert.deepEqual(sample(.1, frame('fish', .03), false), [], cause);
    assert.deepEqual(sample(.15, frame('fish', .05), false), [], cause);
  }
});

test('changing jobs, missing water, invalid points and settling do not manufacture a cast', () => {
  for (const change of [{ token: 'replacement-job' }, { frame: frame('fish', .01, { waterTarget: undefined }) },
    { frame: frame('fish', .01, { waterTarget: { x: Infinity, y: 0 } }) },
    { frame: frame('fish', .01, { settling: { from: frame(), phase: .2 } }) }]) {
    const tracker = createForestWaterInteractionTracker();
    tracker.sample(snapshot(0, [fisher(frame())]));
    assert.deepEqual(tracker.sample(snapshot(.05, [fisher(frame('fish', .01), change)])), []);
  }
});

test('bite impulses follow the displayed dip maxima and never repeat at a stationary clock', () => {
  for (const [action, extra, expected] of [['bite', {}, 3], ['bite', { outcome: 'large' }, 4], ['fish', { variation: 'nibble' }, 3]]) {
    const tracker = createForestWaterInteractionTracker(), pulses = [];
    tracker.sample(snapshot(0, [fisher(frame(action, 0, extra))]));
    for (let tick = 1; tick <= 120; tick++) {
      const current = snapshot(tick / 120, [fisher(frame(action, tick / 120, extra))]);
      const events = tracker.sample(current);
      assert.ok(events.length <= 1);
      assert.ok(events.every(event => event.kind === 'bite' && event.strength < .3));
      pulses.push(...events);
      assert.deepEqual(tracker.sample(current), []);
    }
    assert.equal(pulses.length, expected);
  }
});

const splash = (id, phase = .02) => ({ id, phase, x: 900, y: 900, scale: 1, opacity: 1, variation: 0 });
test('fish contact budgets consume omitted IDs and drop all catch-up after suspension', () => {
  const tracker = createForestWaterInteractionTracker();
  tracker.sample(snapshot(0, [], { splashes: [splash('old')] }));
  const burst = Array.from({ length: FOREST_WATER_INTERACTION_LIMITS.splashes }, (_, index) => splash(`new:${index}`));
  const events = tracker.sample(snapshot(.05, [], { splashes: burst }));
  assert.equal(events.length, FOREST_WATER_INTERACTION_LIMITS.splashImpulses);
  assert.ok(events.every(event => event.kind === 'fish'));
  assert.deepEqual(tracker.sample(snapshot(.1, [], { splashes: burst })), [], 'no backlog of dropped contacts');
  assert.deepEqual(tracker.sample(snapshot(100, [], { splashes: [splash('after-pause')] })), []);
  assert.deepEqual(tracker.sample(snapshot(100.05, [], { splashes: [splash('after-pause', .05)] })), []);
  assert.equal(tracker.sample(snapshot(100.1, [], { splashes: [splash('fresh')] })).length, 1);
  assert.deepEqual(tracker.sample(snapshot(100.15, [], { splashes: [splash('late', .5)] })), []);
});

test('deterministic fish landings couple at newborn coordinates without turning rain into duplicate impulses', () => {
  const pond = { ...scene, id: 'water-interactions-pond',
    water: { surfaces: [{ id: 'pond', points: [{ x: 800, y: 800 }, { x: 1000, y: 800 }, { x: 1000, y: 1000 }, { x: 800, y: 1000 }] }], exclusions: [] } };
  const tracker = createForestWaterInteractionTracker(), emitted = [];
  for (let tick = 0; tick <= 1600; tick++) {
    const elapsed = tick * .025;
    const contacts = forestWaterContactsFrame(pond, { elapsed, rain: 0, dusk: 0, reducedMotion: false, waterFish: 'on' });
    const events = tracker.sample(snapshot(elapsed, [], { scene: pond, splashes: contacts.splashes }));
    for (const event of events) {
      assert.equal(event.kind, 'fish');
      assert.ok(contacts.splashes.some(point => point.x === event.x && point.y === event.y
        && point.phase <= FOREST_WATER_INTERACTION_LIMITS.newbornPhase));
      emitted.push(event);
    }
  }
  assert.ok(emitted.length > 0);
  assert.equal(new Set(emitted.map(event => event.id)).size, emitted.length);
  const rainOnly = createForestWaterInteractionTracker();
  for (let tick = 0; tick <= 100; tick++) {
    const elapsed = tick * .025;
    const contacts = forestWaterContactsFrame(pond, { elapsed, rain: 1, dusk: 0, reducedMotion: false, waterFish: 'off' });
    assert.deepEqual(rainOnly.sample(snapshot(elapsed, [], { scene: pond, splashes: contacts.splashes })), []);
  }
});
