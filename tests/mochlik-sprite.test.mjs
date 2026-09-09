import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false } });
const { pixelSprite } = await vite.ssrLoadModule("/features/mochlik/pixel-sprite.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, "canvas");
    const pixels = new Map();
    const canvas = { width: 0, height: 0, pixels };
    const context = {
      fillStyle: "",
      fillRect(x, y, width, height) {
        assert.ok([x, y, width, height].every(Number.isFinite));
        assert.ok(width > 0 && height > 0);
        for (let row = Math.max(0, y); row < Math.min(canvas.height, y + height); row++) {
          for (let column = Math.max(0, x); column < Math.min(canvas.width, x + width); column++) {
            pixels.set(`${column}:${row}`, context.fillStyle);
          }
        }
      },
    };
    canvas.getContext = () => context;
    return canvas;
  },
};
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  await vite.close();
});

test("the tail follows facing and is visible on the rump, not beside the back", () => {
  const front = pixelSprite("walk", "front", 0).pixels;
  const back = pixelSprite("walk", "back", 0).pixels;
  const right = pixelSprite("walk", "right", 0).pixels;
  const left = pixelSprite("walk", "left", 0).pixels;
  assert.ok(front.has("41:35"));
  assert.ok(left.has("41:35"));
  assert.ok(right.has("6:35"));
  assert.equal(right.has("41:35"), false);
  assert.equal(back.has("41:35"), false);
  assert.equal(back.get("24:33"), "#a5ad58", "rear tail highlight must render over the body");
  for (let frame = 0; frame < 4; frame++) {
    assert.equal(pixelSprite("carry", "back", frame).pixels.has("41:35"), false);
    assert.notEqual(pixelSprite("carry", "back", frame).pixels.get("19:34"), "#f4e4ae", "holding hands must not show through the back");
  }
  assert.notDeepEqual(pixelSprite("walk", "back", 0).pixels, pixelSprite("walk", "back", 1).pixels);
});

test("headwear follows bending and stretching, and every pose stays a finite raster", () => {
  const appearance = { palette: "fern", head: "leaf_cap", neck: "berry_scarf" };
  const top = sprite => Math.min(...[...sprite.pixels].filter(([, color]) => color === "#9cb764").map(([point]) => Number(point.split(":")[1])));
  assert.equal(top(pixelSprite("idle", "front", 0, appearance)), 1);
  assert.equal(top(pixelSprite("reach", "front", 3, appearance)), 7);
  assert.equal(top(pixelSprite("stretch", "front", 0, appearance)), 0);
  const poses = ["idle", "walk", "blink", "sleep", "drowsy", "stretch", "crouch", "jump", "groom", "greet", "sniff", "reach", "hold", "chew", "swallow", "scratch", "yawn", "shake", "sneeze", "wonder", "carry", "toss", "present"];
  for (const pose of poses) for (const direction of ["front", "back", "left", "right"]) for (let frame = 0; frame < 4; frame++) {
    assert.ok(pixelSprite(pose, direction, frame, appearance).pixels.size > 200);
  }
});

test("sprite cache is bounded, reuses hot frames and normalizes frame input", () => {
  const first = pixelSprite("idle", "front", 0);
  assert.equal(first, pixelSprite("idle", "front", 4));
  assert.equal(first, pixelSprite("idle", "front", Number.NaN));
  assert.equal(pixelSprite("idle", "front", -1), pixelSprite("idle", "front", 3));
  const hot = pixelSprite("greet", "front", 0);
  for (let i = 0; i < 390; i++) {
    pixelSprite("walk", "back", 0, { palette: `test-${i}`, head: null, neck: null });
    assert.equal(pixelSprite("greet", "front", 0), hot);
  }
  assert.notEqual(pixelSprite("idle", "front", 0), first, "cold frames must be evicted instead of retaining every outfit forever");
});
