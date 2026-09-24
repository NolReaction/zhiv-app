import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { forestBushParticles, FOREST_BUSH_PARTICLE_SECONDS } = await vite.ssrLoadModule('/features/world/forest-bush-particles.ts');
const bush = { id: 'authored', points: [{ x: 10, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 },
  { x: 58, y: 80 }, { x: 58, y: 37 }, { x: 34, y: 37 }, { x: 34, y: 80 }, { x: 10, y: 80 }],
entry: { x: 85, y: 90 }, hide: { x: 70, y: 60 } };
const bursts = [{ at: .5, strength: 1, seed: 21 }];
const sample = time => forestBushParticles(bush, time, bursts);

test('emission follows actual concave foliage and changes across deterministic encounter seeds', () => {
  const origins = [];
  for (let seed = 1; seed <= 25; seed++) {
    const particles = forestBushParticles(bush, .04, [{ at: 0, strength: 1, seed }]);
    assert.ok(particles.length);
    for (const particle of particles) {
      assert.ok(particle.x > 10 && particle.x < 80 && particle.y > 20 && particle.y < 80);
      assert.ok(particle.y < 37 || particle.x < 34 || particle.x > 58, 'no berry is born in the empty notch');
      origins.push([particle.x, particle.y]);
    }
  }
  assert.ok(new Set(origins.map(JSON.stringify)).size > 10, 'each encounter uses fresh locations');
  const current = sample(1.2);
  sample(2.9); sample(.6);
  assert.deepEqual(sample(1.2), current, 'sampling another camera or a later time does not mutate any emitter');
});

test('berries travel continuously, bounce above the ground, settle and fade with a finite lifetime', () => {
  let previous, wasDescending = false, rebounds = 0;
  for (let step = 8; step < 300; step++) {
    const time = step / 100, particles = forestBushParticles(bush, time, [{ at: 0, strength: 1, seed: 21 }]);
    const particle = particles[0];
    assert.ok(particle && particle.kind === 'berry');
    assert.ok(particles.length <= 4, 'one burst contains a few berries and at most one leaf');
    for (const item of particles) {
      assert.ok(Object.entries(item).filter(([key]) => key !== 'kind').every(([, value]) => Number.isFinite(value)));
      assert.ok(item.y <= item.groundY + 1e-9, 'particles never sink through the ground');
      assert.ok(item.opacity >= 0 && item.opacity <= 1);
    }
    if (previous) {
      assert.ok(Math.hypot(particle.x - previous.x, particle.y - previous.y) < 2,
        'impact, rebounds and roll remain continuous');
      if (wasDescending && particle.y < previous.y - .001) rebounds++;
      wasDescending = particle.y > previous.y + .001;
    }
    previous = particle;
  }
  assert.ok(rebounds >= 1, 'at least the first bounce is visible');
  assert.equal(previous.y, previous.groundY, 'berries settle before fading out');
  assert.ok(previous.opacity < .01);
  assert.deepEqual(forestBushParticles(bush, FOREST_BUSH_PARTICLE_SECONDS, [{ at: 0, strength: 1, seed: 21 }]), []);
});

test('moving and scaling authored foliage carries particle trajectories along with it', () => {
  const transform = point => ({ x: point.x * 1.2 + 321, y: point.y * 1.2 - 88 });
  const transformed = { ...bush, points: bush.points.map(transform), entry: transform(bush.entry), hide: transform(bush.hide) };
  for (const time of [.7, 1.3, 2.8]) {
    const original = sample(time), moved = forestBushParticles(transformed, time, bursts);
    assert.equal(moved.length, original.length);
    original.forEach((particle, index) => {
      const expected = transform(particle);
      assert.ok(Math.abs(expected.x - moved[index].x) < 1e-7);
      assert.ok(Math.abs(expected.y - moved[index].y) < 1e-7);
    });
  }
});

test('future or invalid events are silent and manual event lists cannot create unbounded particles', () => {
  assert.deepEqual(sample(.4), []);
  assert.deepEqual(sample(Infinity), []);
  assert.deepEqual(forestBushParticles({ ...bush, points: [] }, 1, bursts), []);
  assert.deepEqual(forestBushParticles(bush, 1, [{ at: NaN, strength: 1, seed: 3 }, { at: .5, strength: NaN, seed: 1 }]), []);
  assert.ok(forestBushParticles(bush, 1, Array.from({ length: 100 }, (_, seed) => ({ at: .5, strength: 1, seed }))).length <= 16);
});
