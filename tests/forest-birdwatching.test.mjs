import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { chooseForestBirdwatchTarget, createForestBirdwatch, advanceForestBirdwatch,
  forestBirdwatchFrame } = await vite.ssrLoadModule('/features/world/forest-birdwatching.ts');
const actor = { x: 300, y: 400, size: 50, direction: 'front' };
const bird = (id = 'robin-visit-1', patch = {}) => ({ id, x: 330, y: 370, size: 3,
  opacity: 1, phase: .2, angle: 0, state: 'perched', perchId: 'clearing-branch', ...patch });

function advance(watch, birds, seconds) {
  let result;
  for (let t = 0; t < seconds - 1e-9; t += .05) result = advanceForestBirdwatch(watch, birds, .05);
  return result;
}

test('only nearby visible perches are candidates; absent, flying and faded night birds are ignored', () => {
  const invalid = [bird('distant', { x: 451, y: 400 }), bird('', {}), bird('   ', {}),
    bird('bad-x', { x: NaN }), bird('bad-y', { y: Infinity }), bird('bad-size', { size: 0 }),
    bird('bad-alpha', { opacity: NaN }), bird('night-fade', { opacity: .499 }),
    ...['flap', 'glide', 'landing', 'takeoff', undefined].map(state => bird(`state-${state}`, { state }))];
  assert.equal(chooseForestBirdwatchTarget([], actor), null);
  assert.equal(chooseForestBirdwatchTarget(invalid, actor), null);
  for (const state of ['perched', 'preen', 'hop', 'peck', 'lookout']) {
    const candidate = bird(`valid-${state}`, { state, opacity: .5 });
    assert.equal(chooseForestBirdwatchTarget([...invalid, candidate], actor), candidate);
  }
  const atBoundary = bird('boundary', { x: actor.x + actor.size * 3, y: actor.y });
  assert.equal(chooseForestBirdwatchTarget([atBoundary], actor), atBoundary);
  for (const patch of [{ x: NaN }, { y: Infinity }, { size: 0 }, { size: -1 }, { size: NaN }])
    assert.equal(chooseForestBirdwatchTarget([bird()], { ...actor, ...patch }), null);
});

test('nearest candidate wins with deterministic identity tie-breaking and input remains unchanged', () => {
  const a = bird('a', { x: 310, y: 390 }), z = bird('z', { x: 290, y: 390 }), far = bird('far');
  const birds = [z, far, a], before = structuredClone(birds);
  assert.equal(chooseForestBirdwatchTarget(birds, actor), a);
  assert.equal(chooseForestBirdwatchTarget([...birds].reverse(), actor), a);
  assert.deepEqual(birds, before);
});

test('watch keeps the same individual, tracks its hops and locks the original bearing', () => {
  const initial = bird(), watch = createForestBirdwatch(initial);
  const firstTarget = structuredClone(watch.lookTarget), before = structuredClone(initial);
  assert.notEqual(watch.target, initial);
  assert.notEqual(watch.lookTarget, watch.target);
  const firstFrame = forestBirdwatchFrame(watch, actor);
  for (let index = 0; index < 20; index++) {
    const moved = bird(initial.id, { x: 299 + index % 2 * 2, y: 360, state: index % 2 ? 'hop' : 'preen' });
    assert.equal(advanceForestBirdwatch(watch, [bird('new-nearer', { x: 301, y: 399 }), moved], .05), 'watching');
    assert.equal(watch.birdId, initial.id);
    assert.deepEqual(watch.target, { x: moved.x, y: moved.y });
    assert.deepEqual(watch.lookTarget, firstTarget);
    assert.equal(forestBirdwatchFrame(watch, actor).direction, firstFrame.direction, 'small hops cannot flip facing');
  }
  assert.deepEqual(initial, before);
});

test('a missing or departing bird receives a finite outro and cannot be replaced or resurrected', () => {
  for (const disappeared of [[], [bird('another-individual')], [bird(undefined, { state: 'takeoff' })],
    [bird(undefined, { opacity: .2 })], [bird(undefined, { x: Infinity })]]) {
    const watch = createForestBirdwatch(bird()), target = structuredClone(watch.target);
    assert.equal(advance(watch, disappeared, .55), 'watching');
    assert.equal(forestBirdwatchFrame(watch, actor).stage, 'release');
    assert.deepEqual(watch.target, target, 'departure does not chase a flying or hidden bird');
    assert.equal(advanceForestBirdwatch(watch, disappeared, .05), 'finished');
    const finished = structuredClone(watch);
    assert.equal(advanceForestBirdwatch(watch, [bird()], .05), 'finished');
    assert.deepEqual(watch, finished, 'a finished observation never restarts itself');
  }
  const returning = createForestBirdwatch(bird());
  advance(returning, [], .3);
  advanceForestBirdwatch(returning, [bird()], .05);
  assert.equal(returning.missingSeconds, 0, 'a brief same-individual visibility gap does not create a new activity');
  assert.ok(returning.elapsed > .3);
});

test('duration is bounded, invalid deltas pause and long frames never catch up active time', () => {
  for (const [requested, expected] of [[undefined, 6], [-1, 6], [6.7, 6.7], [20, 8], [NaN, 6], [Infinity, 6]]) {
    const watch = createForestBirdwatch(bird(), requested);
    assert.equal(watch.duration, expected);
    const before = structuredClone(watch);
    for (const dt of [0, -.1, NaN, Infinity]) assert.equal(advanceForestBirdwatch(watch, [], dt), 'watching');
    assert.deepEqual(watch, before);
    advanceForestBirdwatch(watch, [bird()], 600);
    assert.equal(watch.elapsed, .1);
    assert.equal(advance(watch, [bird()], expected - .1), 'finished');
    assert.ok(watch.elapsed <= expected);
  }
  assert.throws(() => createForestBirdwatch(bird('', {})), /visible perched bird/);
  assert.throws(() => createForestBirdwatch(bird('flying', { state: 'glide' })), /visible perched bird/);
});

test('frames are pure, stationary, direction-aware and reduced-motion poses stay still', () => {
  const watch = createForestBirdwatch(bird(), 8), originalActor = structuredClone(actor);
  const still = forestBirdwatchFrame(watch, actor, true);
  let blinks = 0;
  for (let step = 0; step < 160; step++) {
    const elapsed = step * .05;
    watch.elapsed = elapsed;
    const before = structuredClone(watch), frame = forestBirdwatchFrame(watch, actor);
    assert.deepEqual(forestBirdwatchFrame(watch, actor), frame);
    assert.deepEqual(watch, before);
    assert.deepEqual(forestBirdwatchFrame(watch, actor, true), still);
    assert.ok(['wonder', 'idle', 'blink'].includes(frame.pose));
    assert.ok(Number.isInteger(frame.frame) && frame.frame >= 0 && frame.frame <= 3);
    assert.equal('x' in frame || 'y' in frame, false, 'watching cannot move the actor');
    if (elapsed > .7) assert.notEqual(frame.pose, 'wonder');
    if (frame.pose === 'blink') blinks++;
  }
  assert.ok(blinks > 0 && blinks < 12, 'blinks are brief, not a repeating rapid loop');
  assert.deepEqual(actor, originalActor);
  assert.equal(forestBirdwatchFrame(createForestBirdwatch(bird('left', { x: 240, y: 380 })), actor).direction, 'left');
  assert.equal(forestBirdwatchFrame(createForestBirdwatch(bird('right', { x: 360, y: 380 })), actor).direction, 'right');
  assert.equal(forestBirdwatchFrame(createForestBirdwatch(bird('above', { x: 300, y: 280 })), actor).direction, 'back');
});
