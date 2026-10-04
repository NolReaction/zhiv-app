import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { pleskSprite, pleskSpriteRig, PLESK_SPRITE_CACHE_LIMIT } = await vite.ssrLoadModule("/features/world/plesk-sprite.ts");
const { drawPleskResident } = await vite.ssrLoadModule("/features/world/plesk-painter.ts");
const { drawFishingProps, fishingPropsBounds } = await vite.ssrLoadModule("/features/world/fishing-props.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
function canvas() {
  const result = { width: 0, height: 0, pixels: new Map() }; let offset = 0, scale = 1;
  const ctx = {
    fillStyle: "#000", translate(x) { offset += x * scale; }, scale(x) { scale *= x; },
    fillRect(x, y, width, height) {
      for (const value of [x, y, width, height]) assert.ok(Number.isInteger(value), "integer pixels only");
      const a = x * scale + offset, b = (x + width) * scale + offset;
      for (let row = Math.max(0, y); row < Math.min(result.height, y + height); row++) {
        for (let column = Math.max(0, Math.min(a, b)); column < Math.min(result.width, Math.max(a, b)); column++) {
          result.pixels.set(`${column}:${row}`, this.fillStyle);
        }
      }
    },
    getImageData() { assert.fail("grounding cannot read a GPU canvas"); },
    drawImage() { assert.fail("the character body cannot depend on raster artwork"); },
  };
  result.getContext = () => ctx; return result;
}
globalThis.document = { createElement(tag) { assert.equal(tag, "canvas"); return canvas(); } };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  await vite.close();
});
const actions = ["idle", "walk", "cast", "fish", "bite", "reel", "catch", "pack", "trade", "rest", "greet"];
const signature = sprite => JSON.stringify([...sprite.pixels].sort(([a], [b]) => a.localeCompare(b)));

test("every procedural action has an opaque planted sole and usable hand anchors in all directions", () => {
  for (const action of actions) for (const direction of ["front", "back", "left", "right"]) for (let frame = 0; frame < 8; frame++) {
    const sprite = pleskSprite(action, direction, frame, frame / 7), rig = pleskSpriteRig(sprite);
    assert.equal(sprite.width, 48); assert.equal(sprite.height, 48); assert.ok(sprite.pixels.size > 450);
    const bottom = Math.max(...[...sprite.pixels.keys()].map(key => Number(key.split(":")[1]))) + 1;
    assert.equal(rig.contact.bottom, bottom, `${action}/${direction}/${frame} has no floating foot`);
    assert.equal(bottom, 45, "one foot stays planted throughout all poses");
    for (const anchor of [rig.grip, rig.heldFish, rig.basket]) {
      assert.ok(Number.isInteger(anchor.x) && Number.isInteger(anchor.y));
      assert.ok(anchor.x >= 0 && anchor.x <= 48 && anchor.y >= 0 && anchor.y <= 48);
    }
  }
});

test("walking changes legs, head and paddle tail across eight poses instead of translating a still image", () => {
  for (const direction of ["left", "right"]) {
    const sprites = Array.from({ length: 8 }, (_, frame) => pleskSprite("walk", direction, frame));
    assert.equal(new Set(sprites.map(signature)).size, 8);
    const rigs = sprites.map(pleskSpriteRig);
    assert.ok(new Set(rigs.map(rig => JSON.stringify(rig.feet))).size >= 5);
    assert.ok(new Set(rigs.map(rig => JSON.stringify(rig.tail))).size >= 4);
    assert.ok(new Set(rigs.map(rig => JSON.stringify(rig.head))).size >= 2);
  }
});

test("casting, reeling and packing articulate the hand which holds the matching prop", () => {
  for (const action of ["cast", "bite", "reel", "catch", "pack", "greet"]) {
    const frames = Array.from({ length: 8 }, (_, frame) => pleskSprite(action, "right", frame, frame / 7));
    assert.ok(new Set(frames.map(signature)).size >= 3, `${action} has distinct limb poses`);
  }
  const castStart = pleskSpriteRig(pleskSprite("cast", "right", 0, 0));
  const castEnd = pleskSpriteRig(pleskSprite("cast", "right", 7, 1));
  assert.ok(castEnd.grip.x > castStart.grip.x + 10, "hand follows the forward cast");
  const held = pleskSpriteRig(pleskSprite("pack", "right", 0, 0));
  const packed = pleskSpriteRig(pleskSprite("pack", "right", 7, 1));
  assert.ok(packed.heldFish.y > held.heldFish.y + 10, "fish is physically lowered into the basket");
  assert.ok(Math.hypot(packed.basket.x - packed.heldFish.x, packed.basket.y - packed.heldFish.y) < 6);
  assert.notEqual(signature(pleskSprite("idle", "front", 30)), signature(pleskSprite("idle", "front", 6)), "eyes blink independently");
});

test("source poses are normalized, stationary under reduced motion, reused and evicted from a bounded cache", () => {
  const resting = pleskSprite("fish", "right", 0, .5, true);
  for (const frame of [-1000, 8, 31, 100000, NaN, Infinity]) {
    assert.equal(pleskSprite("fish", "right", frame, .5, true), resting);
  }
  assert.equal(pleskSprite("walk", "left", 1), pleskSprite("walk", "left", 1 + 32 * 1000));
  const first = pleskSprite("idle", "front", 0);
  assert.equal(pleskSprite("idle", "front", 0), first);
  const unique = new Set();
  for (const direction of ["front", "back", "left", "right"]) for (let phase = 0; phase <= 12; phase++) for (let frame = 0; frame < 8; frame++) {
    unique.add(pleskSprite("cast", direction, frame, phase / 12));
  }
  assert.ok(unique.size > PLESK_SPRITE_CACHE_LIMIT);
  assert.notEqual(pleskSprite("idle", "front", 0), first, "old rasters are released instead of growing forever");
});

function context() {
  const draws = [], paths = [], stack = []; let path = [];
  return { draws, paths, imageSmoothingEnabled: true,
    save() { stack.push({ imageSmoothingEnabled: this.imageSmoothingEnabled }); }, restore() { Object.assign(this, stack.pop()); },
    drawImage(...args) { draws.push({ args, smoothing: this.imageSmoothingEnabled }); },
    beginPath() { path = []; }, moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); },
    quadraticCurveTo() {}, ellipse() {}, arc() {}, closePath() {}, fill() {}, stroke() { paths.push(path); },
    translate() {}, rotate() {},
  };
}
test("Plesk paints at his recorded ground contact and the rod starts at the articulated hand", () => {
  const frame = { x: 100, y: 160, size: 36, direction: "right", action: "cast", phase: .6, frame: 4,
    carryingFish: false, waterTarget: { x: 165, y: 180 } };
  const ctx = context(); drawPleskResident(ctx, frame, false);
  const { args: [sprite, x, y, width, height], smoothing } = ctx.draws[0], rig = pleskSpriteRig(sprite);
  assert.equal(y + rig.contact.bottom / 48 * height, frame.y); assert.equal(width, frame.size);
  assert.equal(smoothing, false); assert.equal(ctx.imageSmoothingEnabled, true);
  const expectedGrip = { x: x + rig.grip.x / 48 * width, y: y + rig.grip.y / 48 * height };
  assert.deepEqual(ctx.paths[0][0], expectedGrip, "the rod is attached to the hand at every cast phase");
  const bounds = fishingPropsBounds(frame);
  assert.ok(bounds.x <= x && bounds.y <= y);
  assert.ok(bounds.x + bounds.width >= frame.waterTarget.x + frame.size * .2);
  assert.ok(bounds.y + bounds.height >= frame.waterTarget.y + frame.size * .2);
});

test("a downward cast swings a full rod instead of shrinking it through the hand", () => {
  for (let step = 0; step <= 20; step++) {
    const ctx = context();
    const frame = { x: 100, y: 160, size: 50, direction: "front", action: "cast", phase: step / 20, frame: 0,
      carryingFish: false, waterTarget: { x: 108, y: 211 } };
    drawFishingProps(ctx, frame, false);
    const [grip, middle] = ctx.paths[0];
    const rodLength = Math.hypot(middle.x - grip.x, middle.y - grip.y) / .62;
    assert.ok(rodLength >= frame.size * .64, `visible rod at cast phase ${step / 20}`);
    assert.ok(rodLength <= frame.size * 1.2);
  }
});
