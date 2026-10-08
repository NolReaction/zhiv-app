import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { builderSprite, builderSpriteRig, BUILDER_SPRITE_CACHE_LIMIT } = await vite.ssrLoadModule("/features/world/characters/builder/builder-sprite.ts");
const { drawBuilderResident, builderRenderBounds, builderHitBounds } = await vite.ssrLoadModule("/features/world/characters/builder/builder-painter.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
globalThis.document = { createElement(tag) {
  assert.equal(tag, "canvas");
  const result = { width: 0, height: 0, pixels: new Map() };
  const ctx = { fillStyle: "#000000", fillRect(x, y, width, height) {
    for (const value of [x, y, width, height]) assert.ok(Number.isInteger(value), "opaque integer pixels only");
    assert.ok(x >= 0 && y >= 0 && x + width <= result.width && y + height <= result.height, "no tool or limb clipping");
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
      result.pixels.set(`${column}:${row}`, this.fillStyle);
    }
  }, drawImage() { assert.fail("builder artwork must be procedural"); }, getImageData() { assert.fail("no GPU readback for contacts"); } };
  result.getContext = () => ctx; return result;
} };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  await vite.close();
});
const directions = ["front", "back", "left", "right"], actions = ["idle", "walk", "work", "inspect", "finish", "greet"];
const signature = sprite => JSON.stringify([...sprite.pixels].sort(([a], [b]) => a.localeCompare(b)));

test("all builder poses fit the source canvas and keep an opaque foot planted", () => {
  for (const action of actions) for (const direction of directions) for (let step = 0; step <= 16; step++) {
    const sprite = builderSprite(action, direction, step, step / 16), rig = builderSpriteRig(sprite);
    assert.equal(sprite.width, 48); assert.equal(sprite.height, 48); assert.ok(sprite.pixels.size > 600);
    const bottom = Math.max(...[...sprite.pixels.keys()].map(key => Number(key.split(":")[1]))) + 1;
    assert.equal(bottom, 45); assert.equal(rig.contact.bottom, bottom);
    assert.ok(rig.feet.some(foot => foot.y === 43));
    for (const arm of rig.arms) assert.ok(Math.hypot(arm.palm.x - arm.shoulder.x, arm.palm.y - arm.shoulder.y) <= 8,
      `${action}/${direction}: no stretched arm`);
  }
});

test("walk moves the paws and planted feet while breathing and blinking remain subtle", () => {
  for (const direction of directions) {
    const poses = Array.from({ length: 8 }, (_, frame) => builderSprite("walk", direction, frame));
    assert.ok(new Set(poses.map(signature)).size >= 5);
    assert.ok(new Set(poses.map(sprite => JSON.stringify(builderSpriteRig(sprite).feet))).size >= 3);
  }
  assert.notEqual(signature(builderSprite("idle", "front", 0)), signature(builderSprite("idle", "front", 8)));
  assert.notEqual(signature(builderSprite("idle", "front", 0)), signature(builderSprite("idle", "front", 30)));
});

test("a work gesture lifts once, taps, returns, then rests without replaying during its final pause", () => {
  for (const direction of directions) {
    const start = builderSpriteRig(builderSprite("work", direction, 0, 0));
    const raised = builderSpriteRig(builderSprite("work", direction, 0, .25));
    const strike = builderSpriteRig(builderSprite("work", direction, 0, .4375));
    assert.ok(raised.mallet.grip.y < start.mallet.grip.y - 4);
    assert.ok(strike.mallet.head.y > raised.mallet.head.y + 5);
    assert.deepEqual(start.feet, strike.feet, "a working builder does not slide across the foundation");
    for (const phase of [.6875, .75, .875, 1]) for (const frame of [0, 5, 31, 5000]) {
      const rested = builderSpriteRig(builderSprite("work", direction, frame, phase));
      assert.deepEqual(rested.mallet, start.mallet);
      assert.deepEqual(rested.arms, start.arms);
    }
  }
});

test("the back has a pine-cone silhouette, with tools behind the body instead of across it", () => {
  const front = builderSprite("idle", "front", 0), back = builderSprite("idle", "back", 0);
  const toolPixels = sprite => [...sprite.pixels.values()].filter(color => ["#e0bf88", "#c5a16d"].includes(color)).length;
  assert.ok(toolPixels(front) > 10);
  assert.equal(toolPixels(back), 0, "the resting mallet is on the far side of the back");
  assert.equal(builderSpriteRig(back).mallet.behindBody, true);
  assert.ok(![...back.pixels.values()].includes("#342b25"), "no face painted on the back");
  assert.ok(toolPixels(builderSprite("work", "back", 0, .4375)) > 0, "only the short protruding head is visible on a tap");
});

test("checking the pouch and finishing nod once without swapping the mallet or sliding the feet", () => {
  for (const direction of directions) for (const action of ["inspect", "finish"]) {
    const start = builderSprite(action, direction, 0, 0), middle = builderSprite(action, direction, 0, .5);
    const end = builderSprite(action, direction, 0, 1);
    assert.equal(signature(start), signature(end), "a finite gesture returns to its resting pose");
    const a = builderSpriteRig(start), b = builderSpriteRig(middle);
    assert.deepEqual(a.mallet, b.mallet, "the right paw keeps the tool lowered");
    assert.deepEqual(a.feet, b.feet, "checking the result does not shift world feet");
    assert.notDeepEqual(a.arms[0].palm, b.arms[0].palm, "the free paw makes the gesture");
    assert.equal(b.head.y, a.head.y + 1, "only a small nod, no head bounce");
    if (direction === "back") assert.equal(signature(start), signature(middle), "the back occludes the chest gesture");
    else assert.notEqual(signature(start), signature(middle));
    for (const phase of [0, .5, 1]) assert.equal(builderSprite(action, direction, 1000, phase, true),
      builderSprite(action, direction, 0, 0, true), "reduced motion remains still");
  }
});

test("turning keeps the mallet in the right paw and puts the far arm behind the body", () => {
  for (const action of actions) for (let phase = 0; phase <= 16; phase++) {
    for (const direction of directions) {
      const rig = builderSpriteRig(builderSprite(action, direction, 3, phase / 16));
      assert.deepEqual(rig.mallet.grip, rig.arms.find(arm => arm.hand === "right").palm,
        `${action}/${direction}: a turn does not hand the tool to the other paw`);
      assert.equal(rig.mallet.behindBody, direction === "back" || direction === "left");
    }
    const left = builderSprite(action, "left", 3, phase / 16), right = builderSprite(action, "right", 3, phase / 16);
    // Only the body/face mirrors. The dominant hand changes its depth, so a
    // whole-canvas mirror would put the mallet back in the wrong hand.
    for (const [key, color] of right.pixels) {
      const [x, y] = key.split(":").map(Number);
      if (y < 28) assert.equal(left.pixels.get(`${47 - x}:${y}`), color);
    }
    const a = builderSpriteRig(left), b = builderSpriteRig(right);
    assert.deepEqual(a.feet, b.feet.map(({ x, y }) => ({ x: 47 - x, y })));
    assert.equal(a.mallet.grip.x, 47 - b.mallet.grip.x); assert.equal(a.mallet.grip.y, b.mallet.grip.y);
  }
});

test("the mallet stays below the profile's muzzle and moves continuously with its grip", () => {
  for (const direction of ["left", "right"]) for (const action of actions) {
    let previous;
    for (let phase = 0; phase <= 16; phase++) {
      const sprite = builderSprite(action, direction, 0, phase / 16), rig = builderSpriteRig(sprite);
      assert.ok(rig.mallet.head.y - 2 >= rig.head.y + 8, `${action}/${direction}: no head in front of the face`);
      assert.ok(Math.hypot(rig.mallet.grip.x - rig.mallet.head.x, rig.mallet.grip.y - rig.mallet.head.y) <= 6,
        "the short handle stays attached to the paw");
      if (previous) assert.ok(Math.hypot(rig.mallet.head.x - previous.x, rig.mallet.head.y - previous.y) <= 4,
        "no sudden reversal between adjacent swing stages");
      previous = rig.mallet.head;
    }
  }
});

test("reduced motion, invalid frames and finite pose caching do not grow with the world clock", () => {
  const still = builderSprite("work", "front", 0, 0, true);
  for (const frame of [8, 1000, -15, NaN, Infinity]) assert.equal(builderSprite("work", "front", frame, .7, true), still);
  assert.equal(builderSprite("walk", "left", 1), builderSprite("walk", "left", 1 + 320000));
  assert.equal(builderSprite("work", "right", NaN, NaN), builderSprite("work", "right", 0, 0));
  const first = builderSprite("idle", "front", 0), unique = new Set();
  for (const direction of directions) for (const action of ["work", "inspect", "finish", "greet"]) for (let step = 0; step <= 16; step++) {
    unique.add(builderSprite(action, direction, 0, step / 16));
  }
  for (const direction of directions) for (let frame = 0; frame < 32; frame++) unique.add(builderSprite("walk", direction, frame));
  // More than the cache limit exists across these actions, while world clocks
  // sharing a pose reuse the same canvas instead of creating another bitmap.
  for (const direction of directions) for (let frame = 0; frame < 32; frame++) unique.add(builderSprite("idle", direction, frame));
  assert.ok(unique.size > BUILDER_SPRITE_CACHE_LIMIT);
  assert.notEqual(builderSprite("idle", "front", 0), first);
});

test("world painting uses source contacts, bounded props and restores canvas smoothing", () => {
  const draws = [], stack = [], ctx = { imageSmoothingEnabled: true,
    save() { stack.push(this.imageSmoothingEnabled); }, restore() { this.imageSmoothingEnabled = stack.pop(); },
    beginPath() {}, ellipse() {}, fill() {}, drawImage(...args) { draws.push({ args, smoothing: this.imageSmoothingEnabled }); },
  };
  const frame = { id: "builder", x: 140, y: 210, size: 40, direction: "left", action: "work", frame: 2, phase: .4375 };
  drawBuilderResident(ctx, frame, false);
  const { args: [sprite, x, y, width, height], smoothing } = draws[0];
  assert.equal(y + builderSpriteRig(sprite).contact.bottom / 48 * height, frame.y);
  assert.equal(x + width / 2, frame.x); assert.equal(smoothing, false); assert.equal(ctx.imageSmoothingEnabled, true);
  const bounds = builderRenderBounds(frame), hit = builderHitBounds(frame);
  for (const key of sprite.pixels.keys()) {
    const [px, py] = key.split(":").map(Number);
    assert.ok(x + px / 48 * width >= bounds.x && x + (px + 1) / 48 * width <= bounds.x + bounds.width);
    assert.ok(y + py / 48 * height >= bounds.y && y + (py + 1) / 48 * height <= bounds.y + bounds.height);
  }
  assert.ok(hit.width < bounds.width, "a tap on the tool's far end is not a body hit");
  for (const value of [NaN, Infinity, 0, -1]) drawBuilderResident(ctx, { ...frame, size: value }, false);
  assert.equal(draws.length, 1);
});
