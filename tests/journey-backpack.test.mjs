import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { pixelSprite, pixelSpriteContact } = await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts");
const { drawJourneyBackpack } = await vite.ssrLoadModule("/features/mochlik/journey-backpack.ts");
const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
globalThis.document = { createElement() {
  const pixels = new Map(), surface = { width: 48, height: 48, pixels };
  const context = { fillStyle: "", fillRect(x, y, w, h) {
    assert([x, y, w, h].every(Number.isInteger), "art stays on the integer pixel rig");
    for (let row = Math.max(0, y); row < Math.min(48, y + h); row++)
      for (let column = Math.max(0, x); column < Math.min(48, x + w); column++) pixels.set(`${column}:${row}`, this.fillStyle);
  } };
  return Object.assign(surface, { getContext: () => context });
} };
after(async () => {
  if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  await vite.close();
});
const region = (sprite, y0, y1) => [...sprite.pixels].filter(([key]) => {
  const y = Number(key.split(":")[1]); return y >= y0 && y < y1;
}).sort();

test("the worn pack preserves the face, planted paws and body contact in all walking frames", () => {
  for (const direction of ["front", "back", "left", "right"]) for (let frame = 0; frame < 4; frame++) {
    const plain = pixelSprite("walk", direction, frame), packed = pixelSprite("walk", direction, frame, undefined, { backpack: true });
    assert.notEqual(plain, packed, "the cache distinguishes worn and ordinary bodies");
    assert.strictEqual(packed, pixelSprite("walk", direction, frame + 4, undefined, { backpack: true }));
    assert.deepEqual(region(packed, 0, 25), region(plain, 0, 25), `${direction}/${frame}: face and ears`);
    assert.deepEqual(region(packed, 40, 48), region(plain, 40, 48), `${direction}/${frame}: feet`);
    assert.deepEqual(pixelSpriteContact(packed), pixelSpriteContact(plain), `${direction}/${frame}: grounding`);
    assert.notDeepEqual(region(packed, 25, 40), region(plain, 25, 40), `${direction}/${frame}: visible worn gear`);
  }
});

test("side silhouettes mirror onto the back, while the rear clasp follows the shoulder bob", () => {
  const draw = (direction, bob, layer) => {
    const calls = []; drawJourneyBackpack(direction, bob, layer, { rect: (...args) => calls.push(args) }); return calls;
  };
  const right = draw("right", 0, "behind"), left = draw("left", 0, "behind");
  assert.deepEqual(left, right.map(([x, y, w, h, color]) => [48 - x - w, y, w, h, color]));
  assert(right.every(([x, , w]) => x + w <= 18), "right-facing pack stays behind the torso");
  assert.deepEqual(draw("back", -1, "front"), draw("back", 0, "front").map(([x, y, ...rest]) => [x, y - 1, ...rest]));
  assert.deepEqual(draw("front", 0, "behind"), [], "the front view cannot show a second bag through the belly");
  assert(draw("front", 0, "front").every(([, y]) => y >= 31), "straps start below the face");
});

test("expedition gear never leaks into sleeping, fishing or held-prop poses", () => {
  for (const pose of ["sleep", "drowsy", "fish", "fishing-walk", "carry", "reach", "hold"])
    assert.strictEqual(pixelSprite(pose, "right", 0, undefined, { backpack: true }), pixelSprite(pose, "right", 0));
  const appearance = { palette: "berest_birch_moss", head: "berest_trail_hat", neck: "berest_lantern_scarf" };
  const sprite = pixelSprite("walk", "back", 0, appearance, { backpack: true });
  assert.equal(sprite.pixels.get("30:38"), "#819986", "the wardrobe shoulder bag does not duplicate the expedition pack");
});
