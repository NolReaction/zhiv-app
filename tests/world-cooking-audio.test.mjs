import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { buildWorldAudioFrame } = await vite.ssrLoadModule('/features/world/audio/world-audio-frame.ts');
const { forestProductionFrames } = await vite.ssrLoadModule('/features/world/state/economy/economy-production-state.ts');

const now = Date.parse('2026-10-11T12:00:00Z');
const point = { x: 100, y: 100 };
const scene = { id: 'cooking-test', focus: { x: -75, y: -75, width: 350, height: 350 }, sites: [],
  campfires: [{ id: 'clearing-campfire', position: point, radius: 12 }],
  audio: { zones: [], emitters: [{ id: 'fire', profileId: 'campfire', activation: 'campfire-lit',
    campfireId: 'clearing-campfire', position: point, innerRadius: 40, outerRadius: 310, gainDb: 0 }] } };
const job = (extra = {}) => ({ id: 'meal', stationId: 'dryer', stationLevel: 1, recipeId: 'mushroom-soup',
  startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 5000).toISOString(), ...extra });
const snapshot = jobs => ({ ownerPublicId: 'current-player', revision: 1, jobs });
const input = extra => ({ ownerId: 'map', sceneId: 'player:forest', ownerPublicId: 'current-player',
  now, dusk: 0, rain: 0, levels: {}, fires: [{ id: 'clearing-campfire', position: point, lit: false, flame: 0 }], ...extra });
const loops = (frame, cueId) => frame.loops.filter(loop => loop.cueId === cueId);
const simmer = (extra = {}, map = scene) => loops(buildWorldAudioFrame(map, input(extra)), 'cooking.simmer');

test('confirmed cooking simmers at the visible pot through all rain strengths with the decorative fire out', () => {
  const production = snapshot([job()]);
  let identity;
  for (const rain of [0, .05, .15, .5, 1]) {
    const frame = buildWorldAudioFrame(scene, input({ rain, production }));
    const actual = loops(frame, 'cooking.simmer');
    assert.equal(actual.length, 1);
    identity ??= actual[0].id;
    assert.equal(actual[0].id, identity);
    assert.equal(actual[0].gain, .8, 'rain cannot mute a working cooking burner');
    const pot = forestProductionFrames(production, scene, {}, now, 0)[0];
    assert.equal(pot.phase, 'working');
    assert.equal(frame.sources.find(source => source.id === 'fire').reason, 'cooking-fire');
    assert.equal(simmer({ rain }).length, 0, 'a rainy decorative fire alone never simmers');
  }
});

test('ready, future, cancelled, malformed and foreign cooking jobs remain silent', () => {
  for (const production of [null, snapshot([]),
    snapshot([job({ finishesAt: new Date(now).toISOString() })]),
    snapshot([job({ startedAt: new Date(now + 1000).toISOString() })]),
    snapshot([job({ startedAt: 'invalid' })]), snapshot([job({ finishesAt: 'invalid' })]),
    snapshot([job({ stationLevel: 0 })]), snapshot([job({ stationLevel: 1.5 })]),
    snapshot([job({ stationId: 'workshop' })]),
    { ...snapshot([job()]), ownerPublicId: 'previous-player' }]) {
    assert.equal(simmer({ production }).length, 0);
    assert.equal(loops(buildWorldAudioFrame(scene, input({ production })), 'campfire').length, 0,
      'only real current cooking may relight the weather-owned cold fire sound');
  }
  assert.equal(simmer({ production: snapshot([job()]), showBuildings: false }).length, 0);
  assert.equal(simmer({ production: snapshot([job()]) }, { ...scene, campfires: [] }).length, 0);
  assert.equal(simmer({ production: snapshot([job()]) }, { ...scene,
    campfires: [{ ...scene.campfires[0], radius: 0 }] }).length, 0);
  assert.equal(simmer({ fires: [{ ...input().fires[0], lit: true, flame: 1 }] }).length, 0,
    'lighting a fire without starting a recipe never creates cooking audio');
});

test('several cooking slots share one loop until the final working order finishes', () => {
  const firstEnd = now + 5000, lastEnd = now + 10000;
  const production = snapshot([job({ id: 'ready', finishesAt: new Date(now).toISOString() }),
    job(), job({ id: 'second-slot', finishesAt: new Date(lastEnd).toISOString() })]);
  const first = simmer({ production });
  assert.equal(first.length, 1);
  assert.equal(simmer({ production, now: firstEnd })[0].id, first[0].id);
  assert.equal(simmer({ production, now: lastEnd }).length, 0);
  assert.equal(simmer({ production: { ...production, revision: 2, jobs: [] } }).length, 0);
});

test('cooking follows campfire placement and camera pan without moving to the hero', () => {
  const production = snapshot([job()]);
  const near = simmer({ production })[0];
  const side = simmer({ production, camera: { x: 220, y: 100, zoom: 2, viewportWidth: 700 } })[0];
  assert.equal(side.id, near.id);
  assert.ok(side.gain > 0 && side.gain < near.gain);
  assert.ok(side.pan < 0);
  assert.equal(simmer({ production, camera: { x: 900, y: 900, zoom: 2, viewportWidth: 700 } }).length, 0);
  const moved = { ...scene, campfires: [{ ...scene.campfires[0], position: { x: 900, y: 900 } }] };
  assert.equal(simmer({ production }, moved).length, 0);
  assert.equal(simmer({ production, camera: { x: 900, y: 900, zoom: 2, viewportWidth: 700 } }, moved)[0].id, near.id);
});

test('a visible hot DEV rehearsal pot simmers without needing a server job', () => {
  const preview = { ...point, size: 36, direction: 'right', action: 'stir', phase: .5, frame: 1, steam: .8 };
  assert.equal(simmer({ cookingPreview: preview }).length, 1);
  assert.equal(simmer({ cookingPreview: { ...preview, action: 'prepare', steam: 0 } }).length, 0);
  assert.equal(simmer({ cookingPreview: null }).length, 0);
  assert.equal(simmer({ cookingPreview: preview, production: snapshot([job()]) }).length, 1,
    'a rehearsal next to a real recipe cannot stack the simmer');
});

test('every rain preset gently lowers wind, with a continuous dry-to-drizzle transition', () => {
  const windGain = rain => loops(buildWorldAudioFrame(scene, input({ rain })), 'weather.wind')[0].gain;
  assert.equal(windGain(0), 1);
  assert.ok(windGain(.1) < .85 && windGain(.1) > .75, 'drizzle has an audible but modest wind reduction');
  assert.ok(windGain(1) >= .65, 'heavy rain does not silence the independent wind layer');
  let previous = 1;
  for (let rain = .001; rain <= 1; rain += .001) {
    const gain = windGain(rain);
    assert.ok(gain <= previous && previous - gain < .008, 'no dry/rain threshold jump');
    previous = gain;
  }
});
