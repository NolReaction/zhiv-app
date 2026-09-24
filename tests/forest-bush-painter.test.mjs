import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { drawForestBush } = await vite.ssrLoadModule('/features/world/forest-bush-painter.ts');

function context() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (target, key) => key in target ? target[key] : (...args) => calls.push({ method: key, args }),
    set: (target, key, value) => { target[key] = value; return true; },
  });
  return { ctx, calls };
}
function fixture() {
  const bush = { id: 'clearing-bush', points: [{ x: 20, y: 15 }, { x: 66, y: 18 },
    { x: 58, y: 36 }, { x: 65, y: 62 }, { x: 24, y: 57 }], entry: { x: 70, y: 64 }, hide: { x: 42, y: 50 } };
  const scene = { width: 100, height: 100, bushes: [bush], terrain: [{ id: 'ground', image: '/ground.webp',
    bounds: { x: 0, y: 0, width: 100, height: 100 } }] };
  return { scene, bush, images: new Map([['/ground.webp', { naturalWidth: 200, naturalHeight: 200 }]]) };
}
function canvasDocument(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'), canvases = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() {
    const surface = context(), canvas = { width: 0, height: 0, ...surface, getContext: () => surface.ctx };
    canvases.push(canvas); return canvas;
  } } });
  try { run(canvases); } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document;
  }
}

test('foreground follows every authored concave vertex and reuses a small crop across cameras and frames', () => {
  canvasDocument(canvases => {
    const { scene, bush, images } = fixture(), a = context(), b = context();
    const frame = { id: bush.id, rustle: 0, occlude: true };
    drawForestBush(a.ctx, scene, images, frame, 0);
    drawForestBush(b.ctx, scene, images, frame, 10);
    assert.equal(canvases.length, 2, 'the foreground and inset leaves are shared by the two cameras');
    assert.ok(canvases[0].width < 130 && canvases[0].height < 130, 'texture covers just this bush');
    const vertices = a.calls.filter(call => ['moveTo', 'lineTo'].includes(call.method)).map(call => call.args);
    assert.deepEqual(vertices, bush.points.map(point => [point.x, point.y]));
    assert.ok(a.calls.findIndex(call => call.method === 'clip') < a.calls.findIndex(call => call.method === 'drawImage'));
    assert.equal(a.calls.find(call => call.method === 'drawImage').args[0], images.get('/ground.webp'));
    assert.equal(b.calls.find(call => call.method === 'drawImage').args[0], images.get('/ground.webp'));
    images.set('/ground.webp', { naturalWidth: 200, naturalHeight: 200 });
    drawForestBush(a.ctx, scene, images, frame);
    assert.equal(canvases.length, 4, 'replacement artwork invalidates the old crop');
  });
});

test('rustling deforms only clipped leaves and reduced motion retains a stationary foreground', () => {
  canvasDocument(canvases => {
    const { scene, bush, images } = fixture(), moving = context(), still = context();
    const frame = { id: bush.id, rustle: 1, occlude: true };
    drawForestBush(moving.ctx, scene, images, frame, .2);
    drawForestBush(still.ctx, scene, images, frame, 999, true);
    const transforms = moving.calls.filter(call => call.method === 'transform');
    assert.equal(transforms.length, 12);
    assert.ok(transforms.every(call => call.args.every(Number.isFinite)));
    const last = transforms.at(-1).args, bottom = Math.max(...bush.points.map(point => point.y));
    assert.ok(Math.abs(last[2] * bottom + last[4]) < 1e-9, 'the bottom foliage edge is anchored');
    assert.equal(still.calls.filter(call => call.method === 'transform').length, 0);
    assert.equal(still.calls.filter(call => call.method === 'drawImage').length, 1);
    assert.equal(canvases.length, 2);
  });
});

test('missing artwork is never cached and non-browser rendering still clips the original terrain', () => {
  const { scene, bush, images } = fixture(), surface = context();
  drawForestBush(surface.ctx, scene, images, null);
  drawForestBush(surface.ctx, scene, images, { id: bush.id, rustle: 0, occlude: false });
  drawForestBush(surface.ctx, scene, new Map(), { id: bush.id, rustle: 1, occlude: true });
  assert.deepEqual(surface.calls, []);
  assert.equal(typeof document, 'undefined');
  drawForestBush(surface.ctx, scene, images, { id: bush.id, rustle: 1, occlude: true }, NaN);
  assert.equal(surface.calls.filter(call => call.method === 'drawImage').length, 1);
  assert.equal(surface.calls.find(call => call.method === 'drawImage').args[0], images.get('/ground.webp'));
  assert.equal(surface.calls.filter(call => call.method === 'clip').length, 1);
});

test('paused encounters retain exact foliage deformation and falling berries despite a changed ambient clock', () => {
  canvasDocument(() => {
    const { scene, bush, images } = fixture(), playing = context(), paused = context();
    const frame = { id: bush.id, rustle: .8, occlude: true, elapsed: .72,
      bursts: [{ at: .2, strength: .9, seed: 183 }] };
    drawForestBush(playing.ctx, scene, images, frame, 50);
    drawForestBush(paused.ctx, scene, images, frame, 500, true);
    assert.deepEqual(paused.calls, playing.calls, 'local encounter time keeps every particle and leaf band stationary');
    assert.ok(playing.calls.some(call => call.method === 'ellipse'), 'berries and ground shadows are visible');
    const foregroundEnd = playing.calls.findLastIndex(call => call.method === 'drawImage');
    assert.ok(playing.calls.findIndex(call => call.method === 'ellipse') > foregroundEnd,
      'berries fall in front of the leaves, after leaving the polygon clip');
  });
});

test('berries settle after departure without masking the actor and disappear when their lifetime ends', () => {
  const { scene, bush, images } = fixture(), residual = context(), expired = context();
  const frame = { id: bush.id, rustle: 0, occlude: false, elapsed: 2.5,
    bursts: [{ at: 0, strength: 1, seed: 184 }] };
  drawForestBush(residual.ctx, scene, images, frame);
  assert.ok(residual.calls.some(call => call.method === 'ellipse'));
  assert.equal(residual.calls.filter(call => ['drawImage', 'clip'].includes(call.method)).length, 0,
    'settling particles cannot paint a stale foreground above a different actor pose');
  drawForestBush(expired.ctx, scene, images, { ...frame, elapsed: 3 });
  assert.deepEqual(expired.calls, []);
});
