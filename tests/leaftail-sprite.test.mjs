import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { leaftailSprite, leaftailSpriteRig, LEAFTAIL_SPRITE_CACHE_LIMIT } = await vite.ssrLoadModule("/features/world/characters/leaftail/leaftail-sprite.ts");
const { drawLeaftailResident, leaftailRenderBounds, leaftailHitBounds } = await vite.ssrLoadModule("/features/world/characters/leaftail/leaftail-painter.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
globalThis.document = { createElement(tag) {
  assert.equal(tag, "canvas");
  const result = { width: 0, height: 0, pixels: new Map() };
  const ctx = { fillStyle: "#000000", fillRect(x, y, width, height) {
    for (const value of [x, y, width, height]) assert.ok(Number.isInteger(value), "opaque integer pixels only");
    assert.match(this.fillStyle, /^#[0-9a-f]{6}$/i, "the sprite itself has no translucent blur");
    assert.ok(x >= 0 && y >= 0 && x + width <= result.width && y + height <= result.height,
      `no parcel, tail or limb clipping: ${x},${y},${width},${height}`);
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) result.pixels.set(`${column}:${row}`, this.fillStyle);
  }, drawImage() { assert.fail("Leaftail artwork must be procedural"); }, getImageData() { assert.fail("no GPU readback for contacts"); } };
  result.getContext = () => ctx; return result;
} };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  await vite.close();
});
const directions = ["front", "back", "left", "right"], actions = ["idle", "walk", "work", "carry", "inspect", "greet", "rest", "trade"];
const signature = sprite => JSON.stringify([...sprite.pixels].sort(([a], [b]) => a.localeCompare(b)));

test("every merchant pose is bounded, opaque and grounded on short paws", () => {
  for (const action of actions) for (const direction of directions) for (let step = 0; step <= 16; step++) {
    const sprite = leaftailSprite(action, direction, step, step / 16), rig = leaftailSpriteRig(sprite);
    assert.equal(sprite.width, 48); assert.equal(sprite.height, 48); assert.ok(sprite.pixels.size > 900);
    const bottom = Math.max(...[...sprite.pixels.keys()].map(key => Number(key.split(":")[1]))) + 1;
    assert.equal(bottom, 45); assert.equal(rig.contact.bottom, bottom); assert.ok(rig.feet.some(foot => foot.y === 43));
    for (const arm of rig.arms) assert.ok(Math.hypot(arm.palm.x - arm.shoulder.x, arm.palm.y - arm.shoulder.y) <= 8,
      `${action}/${direction}: no stretched human arm`);
    assert.deepEqual(rig.tool.grip, rig.arms.find(arm => arm.hand === "right").palm);
  }
});

test("his leaf-tail, warm face and tied goods remain distinct from all four directions", () => {
  for (const direction of directions) {
    const sprite = leaftailSprite("idle", direction, 0), colors = [...sprite.pixels.values()];
    assert.ok(colors.filter(color => ["#d89b40", "#edba5d", "#b77b36"].includes(color)).length > 190,
      `${direction}: the large veined leaf-tail is visible`);
    assert.ok(colors.includes("#6c8051"), "a subdued green trader's scarf");
    assert.equal(colors.includes("#352e24"), direction !== "back", "no face drawn on the back of his head");
  }
  const left = leaftailSprite("idle", "left", 0), right = leaftailSprite("idle", "right", 0);
  for (const [key, color] of right.pixels) {
    const [x, y] = key.split(":").map(Number);
    if (y < 28) assert.equal(left.pixels.get(`${47 - x}:${y}`), color, "profile head and tail mirror cleanly");
  }
  assert.equal(leaftailSpriteRig(left).tool.behindBody, true);
  assert.equal(leaftailSpriteRig(right).tool.behindBody, false);
});

test("walking plants alternating feet and carries goods without a sliding tail or face", () => {
  for (const direction of directions) {
    const poses = Array.from({ length: 16 }, (_, frame) => leaftailSprite("walk", direction, frame));
    assert.ok(new Set(poses.map(signature)).size >= 5);
    assert.ok(new Set(poses.map(sprite => JSON.stringify(leaftailSpriteRig(sprite).feet))).size >= 3);
  }
  assert.notEqual(signature(leaftailSprite("idle", "front", 0)), signature(leaftailSprite("idle", "front", 10)));
  assert.notEqual(signature(leaftailSprite("idle", "front", 0)), signature(leaftailSprite("idle", "front", 30)));
});

test("the merchant's eyes sit above two cream cheeks instead of inside a white mask", () => {
  const creams = new Set(["#f0dcac", "#fff0ca", "#d4b57e"]);
  for (const direction of ["front", "left", "right"]) for (const action of ["idle", "walk", "greet", "trade"]) {
    const sprite = leaftailSprite(action, direction, 3, .5), { head } = leaftailSpriteRig(sprite);
    const facingLeft = direction === "left";
    const sourceX = x => facingLeft ? 47 - x : x;
    const headX = facingLeft ? 47 - head.x : head.x;
    for (const eyeX of direction === "front" ? [headX - 5, headX + 5] : [headX + 3]) {
      assert.equal(sprite.pixels.get(`${sourceX(eyeX + 1)}:${head.y - 1}`), "#352e24", "the dark eye has a complete pupil");
      assert.equal(creams.has(sprite.pixels.get(`${sourceX(eyeX - 1)}:${head.y - 1}`)), false,
        "russet fur separates the eye from the muzzle");
    }
    const noseX = sourceX(headX + (direction === "front" ? 0 : 8));
    assert.equal(sprite.pixels.get(`${noseX}:${head.y + 3}`), "#352e24", "the small dark nose stays below the eyes");
    if (direction === "front") {
      assert.equal(sprite.pixels.get(`${head.x - 4}:${head.y + 4}`), "#fff0ca");
      assert.equal(sprite.pixels.get(`${head.x + 4}:${head.y + 4}`), "#fff0ca");
      assert.equal(sprite.pixels.get(`${head.x}:${head.y + 1}`), "#c77139", "the two cheeks leave a warm central nose bridge");
    }
  }
});

test("sixteen walking poses keep the head, feet, leaf-tail and goods within one pixel at the loop seam", () => {
  for (const direction of directions) {
    const rigs = Array.from({ length: 16 }, (_, frame) => leaftailSpriteRig(leaftailSprite("walk", direction, frame)));
    for (let frame = 0; frame < 16; frame++) {
      const a = rigs[frame], b = rigs[(frame + 1) % 16];
      const anchors = rig => [rig.head, ...rig.feet, rig.tail, rig.tool.grip, rig.tool.bundle];
      anchors(a).forEach((p, i) => {
        const q = anchors(b)[i];
        assert.ok(Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1, `${direction}/${frame}: no source-pixel jump`);
      });
      assert.equal(a.contact.bottom, b.contact.bottom);
    }
  }
});

test("an offer lifts a parcel once below the face, then settles without replaying", () => {
  for (const direction of directions) {
    const start = leaftailSprite("trade", direction, 0, 0), peak = leaftailSprite("trade", direction, 0, .375);
    const a = leaftailSpriteRig(start), b = leaftailSpriteRig(peak);
    assert.ok(b.tool.bundle.y < a.tool.bundle.y); assert.deepEqual(a.feet, b.feet);
    assert.notEqual(signature(start), signature(peak));
    for (let stage = 0; stage <= 16; stage++) {
      const rig = leaftailSpriteRig(leaftailSprite("trade", direction, 0, stage / 16));
      assert.ok(rig.tool.bundle.y - 4 >= rig.head.y + 8, "the parcel never crosses eyes or muzzle");
      if (direction === "front") assert.ok(rig.tool.coin.x + 2 < rig.head.x - 8, "the coin stays beside the cheek");
      if (direction === "right") assert.ok(rig.tool.coin.x - 2 >= rig.head.x + 9, "the coin stays beyond the profile muzzle");
    }
    for (const phase of [.8125, .875, 1]) for (const frame of [0, 17, 10000]) {
      assert.equal(signature(leaftailSprite("trade", direction, frame, phase)), signature(start));
    }
  }
});

test("counting, inspecting and greeting use finite gestures with a stable foot contact", () => {
  for (const direction of directions) for (const action of ["work", "inspect", "greet"]) {
    const start = leaftailSprite(action, direction, 0, 0), mid = leaftailSprite(action, direction, 0, .375), end = leaftailSprite(action, direction, 0, 1);
    assert.equal(signature(start), signature(end)); assert.notDeepEqual(leaftailSpriteRig(start).arms, leaftailSpriteRig(mid).arms);
    assert.deepEqual(leaftailSpriteRig(start).feet, leaftailSpriteRig(mid).feet);
  }
  const rest = leaftailSprite("rest", "front", 20);
  assert.notEqual(signature(rest), signature(leaftailSprite("idle", "front", 0)));
  assert.equal(signature(leaftailSprite("carry", "front", 0)), signature(leaftailSprite("carry", "front", 17)),
    "the deliberate carrying pose does not pretend to walk while stationary");
});

test("reduced motion and corrupt clocks stay steady while the finite LRU evicts old poses", () => {
  for (const action of actions) for (const direction of directions) {
    const still = leaftailSprite(action, direction, 0, 0, true);
    for (const frame of [8, 1000, -15, NaN, Infinity]) assert.equal(leaftailSprite(action, direction, frame, .7, true), still);
  }
  assert.equal(leaftailSprite("walk", "left", 1), leaftailSprite("walk", "left", 320001));
  assert.equal(leaftailSprite("work", "right", NaN, NaN), leaftailSprite("work", "right", 0, 0));
  const first = leaftailSprite("idle", "front", 0), unique = new Set();
  for (const direction of directions) for (const action of ["work", "trade", "inspect", "greet"]) for (let step = 0; step <= 16; step++) {
    unique.add(leaftailSprite(action, direction, 0, step / 16));
  }
  assert.ok(unique.size > LEAFTAIL_SPRITE_CACHE_LIMIT); assert.notEqual(leaftailSprite("idle", "front", 0), first);
});

test("world painting includes the whole tail in dirty bounds and restores alpha and smoothing", () => {
  const draws = [], stack = [], ctx = { imageSmoothingEnabled: true, globalAlpha: .8,
    save() { stack.push([this.imageSmoothingEnabled, this.globalAlpha]); }, restore() { [this.imageSmoothingEnabled, this.globalAlpha] = stack.pop(); },
    beginPath() {}, ellipse() {}, fill() {}, drawImage(...args) { draws.push({ args, smoothing: this.imageSmoothingEnabled, alpha: this.globalAlpha }); },
  };
  const frame = { id: "leaftail", x: 140, y: 210, size: 48, direction: "left", action: "trade", frame: 2, phase: .375, opacity: .5 };
  drawLeaftailResident(ctx, frame, false);
  const { args: [sprite, x, y, width, height], smoothing, alpha } = draws[0];
  assert.equal(y + leaftailSpriteRig(sprite).contact.bottom / 48 * height, frame.y);
  assert.equal(x + width / 2, frame.x); assert.equal(smoothing, false); assert.equal(alpha, .4);
  assert.equal(ctx.imageSmoothingEnabled, true); assert.equal(ctx.globalAlpha, .8);
  const bounds = leaftailRenderBounds(frame), hit = leaftailHitBounds(frame);
  for (const key of sprite.pixels.keys()) {
    const [px, py] = key.split(":").map(Number);
    assert.ok(x + px / 48 * width >= bounds.x && x + (px + 1) / 48 * width <= bounds.x + bounds.width);
    assert.ok(y + py / 48 * height >= bounds.y && y + (py + 1) / 48 * height <= bounds.y + bounds.height);
  }
  assert.ok(hit.width < bounds.width, "an empty gap next to the leaf-tail is not a body hit");
  for (const value of [NaN, Infinity, 0, -1]) drawLeaftailResident(ctx, { ...frame, size: value }, false);
  assert.equal(draws.length, 1);
});
