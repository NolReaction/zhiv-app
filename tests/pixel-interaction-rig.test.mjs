import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false } });
const { pixelSprite } = await vite.ssrLoadModule('/features/mochlik/pixel-sprite.ts');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
function canvas() {
  const pixels = new Map(), surface = { width: 48, height: 48, pixels };
  const ctx = { fillStyle: '', fillRect(x, y, width, height) {
    for (let row = Math.max(0, Math.floor(y)); row < Math.min(surface.height, Math.ceil(y + height)); row++)
      for (let column = Math.max(0, Math.floor(x)); column < Math.min(surface.width, Math.ceil(x + width)); column++)
        pixels.set(`${column}:${row}`, this.fillStyle);
  } };
  return Object.assign(surface, { getContext: () => ctx });
}
globalThis.document = { createElement: canvas };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
  await vite.close();
});
const region = (sprite, firstRow, endRow) => [...sprite.pixels].filter(([key]) => {
  const y = Number(key.split(':')[1]); return y >= firstRow && y < endRow;
}).sort();

test('externally animated interaction arms preserve the normal face and expressive eyes', () => {
  for (const pose of ['idle', 'carry', 'reach', 'hold', 'chew']) for (const direction of ['front', 'left', 'right', 'back']) {
    const ordinary = pixelSprite(pose, direction, 0), interaction = pixelSprite(pose, direction, 0, undefined, { gardening: true });
    assert.deepEqual(region(interaction, 0, 24), region(ordinary, 0, 24), `${pose}/${direction}: arms never rewrite the face`);
  }
});

test('continuous interaction crouch is quantized for cache, finite, and keeps the planted feet', () => {
  const neutral = pixelSprite('idle', 'front', 0, undefined, { gardening: true, crouch: 0 });
  const bent = pixelSprite('idle', 'front', 0, undefined, { gardening: true, crouch: 6 });
  assert.equal(bent, pixelSprite('idle', 'front', 0, undefined, { gardening: true, crouch: 20 }));
  assert.equal(neutral, pixelSprite('idle', 'front', 0, undefined, { gardening: true, crouch: -20 }));
  assert.equal(bent, pixelSprite('idle', 'front', 0, undefined, { gardening: true, crouch: 5.8 }));
  assert.deepEqual(region(neutral, 40, 48), region(bent, 40, 48), 'crouching does not move the sole');
  assert.notDeepEqual(region(neutral, 10, 27), region(bent, 10, 27), 'the face bends down');
  assert.equal(pixelSprite('idle', 'front', 0, undefined, { gardening: true, crouch: NaN }),
    pixelSprite('idle', 'front', 0, undefined, { gardening: true }), 'invalid override uses the regular pose');
});
