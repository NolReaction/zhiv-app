import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root, configFile: false, logLevel: 'silent', resolve: { alias: { '@': root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { projectForestShadow: project, createForestActorShadow: actor, prepareForestShadowGeometry: prepare, FOREST_SHADOW_GEOMETRY: limits }
  = await vite.ssrLoadModule('/features/world/environment/lighting/forest-shadow-geometry.ts');
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const caster = (points = rect(40, 30, 10, 10), height = 20, baseHeight = 0) => ({ id: 'house', points, height, baseHeight, opacity: 1, softness: 2 });
const sun = (x = 1, y = 0, elevation = 45) => ({ kind: 'directional', direction: { x, y }, elevation });
const lamp = (x = 0, y = 0, height = 30, radius = 100) => ({ kind: 'point', position: { x, y }, height, radius });
const bounds = pieces => {
  const points = pieces.flat();
  return { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
    top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
};
const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
function contains(pieces, point) {
  return pieces.some(piece => piece.every((a, index) => {
    const b = piece[(index + 1) % piece.length];
    return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) >= -1e-6;
  }));
}
function assertConvexFinite(pieces) {
  for (const piece of pieces) {
    assert.ok(piece.length >= 3);
    for (let index = 0; index < piece.length; index++) {
      const a = piece[index], b = piece[(index + 1) % piece.length], c = piece[(index + 2) % piece.length];
      assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
      assert.ok((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) >= -1e-5, 'uniform winding and convex pieces');
    }
  }
}

test('sun direction casts an extruded shadow away from the light and lower sun lengthens it', () => {
  const building = caster();
  const east = project(building, sun()), west = project(building, sun(-1));
  near(bounds(east).left, 20); near(bounds(east).right, 50);
  near(bounds(west).left, 40); near(bounds(west).right, 70);
  assert.ok(contains(east, { x: 25, y: 35 }));
  assert.ok(!contains(west, { x: 25, y: 35 }));
  assert.ok(bounds(project(building, sun(1, 0, 20))).left < bounds(east).left);
  near(bounds(project(building, sun(0, 1))).top, 30 - 20 * limits.groundCompression);
  near(bounds(project(building, sun(10))).left, bounds(east).left);
});

test('directional horizon and tall casters stay within the finite shadow budget', () => {
  const building = caster(undefined, 10000);
  const pieces = project(building, sun(1, 0, .001));
  assertConvexFinite(pieces);
  near(bounds(pieces).left, 40 - limits.maxDirectionalLength);
  for (const elevation of [0, -3, NaN, Infinity, 91]) assert.deepEqual(project(building, sun(1, 0, elevation)), []);
  assert.deepEqual(project(building, sun(0, 0)), []);
});

test('concave caster recesses remain open instead of being filled by a convex hull', () => {
  const concave = caster([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 15 },
    { x: 15, y: 15 }, { x: 15, y: 60 }, { x: 0, y: 60 }], 8);
  const pieces = project(concave, sun());
  assertConvexFinite(pieces);
  assert.ok(contains(pieces, { x: 5, y: 50 }));
  assert.ok(contains(pieces, { x: 50, y: 5 }));
  assert.ok(!contains(pieces, { x: 35, y: 35 }));
  const reversed = project({ ...concave, points: [...concave.points].reverse() }, sun());
  for (let x = -10; x < 70; x += 5) for (let y = -10; y < 70; y += 5) {
    assert.equal(contains(pieces, { x, y }), contains(reversed, { x, y }), `winding at ${x},${y}`);
  }
});

test('elevated receivers use only geometry above them and project into painted screen coordinates', () => {
  const building = caster();
  const pieces = project(building, sun(), 10);
  near(bounds(pieces).left, 30); near(bounds(pieces).right, 50);
  near(bounds(pieces).top, 20); near(bounds(pieces).bottom, 30);
  assert.deepEqual(project(building, sun(), 20), []);
  assert.deepEqual(project(building, sun(), 40), []);
  const floating = project(caster(undefined, 10, 10), sun());
  near(bounds(floating).left, 20); near(bounds(floating).right, 40);
  assert.ok(!contains(floating, { x: 48, y: 35 }), 'floating crown does not invent a ground-level solid trunk');
});

test('point light movement changes the shadow direction and obeys perspective projection', () => {
  const building = caster(rect(20, -5, 10, 10), 10);
  const west = project(building, lamp()), east = project(building, lamp(60));
  near(bounds(west).right, 45);
  near(bounds(east).left, 0);
  assert.ok(contains(west, { x: 40, y: 0 }));
  assert.ok(!contains(east, { x: 40, y: 0 }));
  assert.ok(contains(east, { x: 10, y: 0 }));
  const raised = project(building, lamp(), 5);
  near(bounds(raised).right, 37.5);
  near(bounds(raised).top, -11.25);
  assertConvexFinite(west); assertConvexFinite(east); assertConvexFinite(raised);
});

test('low point lights project tall objects to the light edge without explosions or reverse shadows', () => {
  const building = caster(rect(20, -5, 10, 10), 80), light = lamp(0, 0, 5);
  const pieces = project(building, light);
  assertConvexFinite(pieces);
  assert.ok(contains(pieces, { x: 95, y: 0 }), 'shadow reaches the outer illuminated area');
  assert.ok(!contains(pieces, { x: -30, y: 0 }));
  assert.ok(!contains(pieces, { x: 10, y: 0 }), 'space before the occluder stays lit');
  for (const point of pieces.flat()) assert.ok(Math.hypot(point.x, point.y) <= light.radius + 1e-6);
});

test('source inside solid caster blocks the whole finite light footprint', () => {
  const light = lamp(25, 0, 5, 70), pieces = project(caster(rect(20, -5, 10, 10), 30), light);
  assert.equal(pieces.length, 1);
  assertConvexFinite(pieces);
  assert.ok(contains(pieces, { x: 25, y: 0 }));
  assert.ok(contains(pieces, { x: -40, y: 0 }));
  assert.ok(contains(pieces, { x: 90, y: 0 }));
  for (const point of pieces.flat()) near(Math.hypot(point.x - 25, point.y), 70);
});

test('objects above a low source or entirely outside its radius cast no visible shadow', () => {
  assert.deepEqual(project(caster(rect(20, -5, 10, 10), 30, 10), lamp(0, 0, 5)), []);
  assert.deepEqual(project(caster(rect(120, -5, 10, 10)), lamp()), []);
  assert.deepEqual(project(caster(), lamp(0, 0, 5), 5), []);
  // Its vertices are outside, but its long edge crosses the light footprint.
  const crossing = project(caster(rect(20, -200, 10, 400), 80), lamp(0, 0, 5));
  assert.ok(contains(crossing, { x: 80, y: 0 }));
  assertConvexFinite(crossing);
});

test('nearly coincident source, high geometry and receiver planes produce bounded finite output', () => {
  const building = caster(rect(20, -5, 10, 10), 10000);
  for (const sourceX of [19.999999, 20, 20.000001, 25, 30, 30.000001]) {
    for (const height of [.001, 1, 10, 9999.999999, 10000, 10000.000001]) {
      const light = lamp(sourceX, 0, height);
      const pieces = project(building, light);
      assertConvexFinite(pieces);
      for (const point of pieces.flat()) assert.ok(Math.hypot(point.x - sourceX, point.y) <= light.radius + 1e-5);
    }
  }
});

test('translating geometry and source translates the same receiver shadow without mutation', () => {
  const building = caster(rect(20, -5, 10, 10), 30), delta = { x: 137, y: -64 };
  const original = structuredClone(building);
  Object.freeze(building); Object.freeze(building.points); building.points.forEach(Object.freeze);
  for (const source of [sun(1, 1), lamp(0, 0, 15)]) {
    const translated = { ...building, points: building.points.map(point => ({ x: point.x + delta.x, y: point.y + delta.y })) };
    const movedSource = source.kind === 'point' ? { ...source, position: { x: source.position.x + delta.x, y: source.position.y + delta.y } } : source;
    const first = project(building, source, 4), second = project(translated, movedSource, 4);
    assert.equal(first.length, second.length);
    first.forEach((piece, i) => {
      assert.equal(piece.length, second[i].length);
      piece.forEach((point, j) => { near(second[i][j].x, point.x + delta.x); near(second[i][j].y, point.y + delta.y); });
    });
  }
  assert.deepEqual(building, original);
});

test('invalid or degenerate geometry is inert and duplicate editor vertices are tolerated', () => {
  for (const broken of [caster([], 20), caster(rect(0, 0, 0, 0)), caster(undefined, 0), caster(undefined, -1),
    caster(undefined, Infinity), caster(undefined, 10, -1), caster([{ x: 0, y: 0 }, { x: 1, y: NaN }, { x: 2, y: 2 }])]) {
    assert.deepEqual(project(broken, sun()), []);
  }
  for (const light of [lamp(NaN), lamp(0, 0, Infinity), lamp(0, 0, 30, 0), lamp(0, 0, 30, Infinity)]) {
    assert.deepEqual(project(caster(), light), []);
  }
  assert.deepEqual(project(caster(), sun(), NaN), []);
  const duplicate = caster([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }]);
  assert.ok(contains(project(duplicate, sun()), { x: 5, y: 5 }));
});

test('actor helper follows moving feet with an independent elliptical footprint and vertical body', () => {
  const feet = { x: 50, y: 80 }, first = actor(feet, 6, 'mochlik'), second = actor({ x: 60, y: 90 }, 6, 'plesk');
  assert.equal(first.id, 'mochlik'); assert.equal(first.points.length, 8);
  near(first.height, 14.4); near(first.baseHeight, 0);
  first.points.forEach((point, index) => { near(second.points[index].x - point.x, 10); near(second.points[index].y - point.y, 10); });
  assert.deepEqual(feet, { x: 50, y: 80 });
  assertConvexFinite(project(first, lamp(20, 80, 8)));
});

test('one convex actor outline matches the original prism union for light movement, jumps and receivers', () => {
  for (const lift of [0, 7, 19]) for (const receiver of [0, 5, 24]) {
    const body = { ...actor({ x: 50, y: 80 }, 6, 'moving'), height: 24, baseHeight: lift };
    // A copied raw contour deliberately uses the general concave-capable path.
    const generic = { ...body, points: body.points.map(point => ({ ...point })) };
    for (const source of [sun(1, 0, 45), sun(-1, 1, 13), sun(0, 1, 80),
      lamp(20, 80, 8, 100), lamp(90, 60, 50, 100), lamp(50, 80, 10, 100), lamp(50, 80, 75, 100)]) {
      const fast = project(body, source, receiver), reference = project(generic, source, receiver);
      assert.ok(fast.length <= 1, 'an actor needs at most one convex disk clip');
      assertConvexFinite(fast);
      for (let x = -50; x <= 150; x += 5) for (let y = -30; y <= 180; y += 5) {
        const point = { x: x + .137, y: y + .271 };
        assert.equal(contains(fast, point), contains(reference, point),
          `${source.kind} lift=${lift} receiver=${receiver} at ${point.x},${point.y}`);
      }
    }
  }
});

test('prepared concave topology stays equivalent and mutable light coordinates invalidate its cached disk', () => {
  const building = caster([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 15 },
    { x: 15, y: 15 }, { x: 15, y: 60 }, { x: 0, y: 60 }], 30);
  const prepared = prepare(building.points), light = lamp(-20, -20, 15, 100);
  assert.deepEqual(project(building, light, 4, prepared), project(building, light, 4));
  const first = project(building, light, 4, prepared);
  light.position.x = 70; light.position.y = 10; light.radius = 80;
  const second = project(building, light, 4, prepared);
  assert.notDeepEqual(first, second);
  assert.deepEqual(second, project(building, { ...light, position: { ...light.position } }, 4));
  assertConvexFinite(second);
});

test('editing generated actor vertices invalidates its affine shortcut and preserves the edited contour', () => {
  const body = actor({ x: 50, y: 80 }, 6, 'edited');
  body.points[0].x -= 8;
  const plain = { ...body, points: body.points.map(point => ({ ...point })) };
  for (const source of [sun(-1, 1, 40), lamp(20, 70, 9)]) {
    assert.deepEqual(project(body, source), project(plain, source), 'edited actor geometry uses the same general projection as authored contours');
  }
});
