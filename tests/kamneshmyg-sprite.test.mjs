import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { kamneshmygSprite, kamneshmygSpriteRig, KAMNESHMYG_SPRITE_CACHE_LIMIT } = await vite.ssrLoadModule("/features/world/characters/kamneshmyg/kamneshmyg-sprite.ts");
const { drawKamneshmygResident, kamneshmygRenderBounds, kamneshmygHitBounds } = await vite.ssrLoadModule("/features/world/characters/kamneshmyg/kamneshmyg-painter.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
globalThis.document = { createElement(tag) {
  assert.equal(tag, "canvas");
  const sprite = { width: 0, height: 0, pixels: new Map() };
  const ctx = { fillStyle: "#000000", fillRect(x, y, width, height) {
    assert.ok([x, y, width, height].every(Number.isInteger), "opaque integer source pixels only");
    assert.match(this.fillStyle, /^#[\da-f]{6}$/i);
    assert.ok(x >= 0 && y >= 0 && x + width <= sprite.width && y + height <= sprite.height, "no clipped pickaxe, ears or feet");
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) sprite.pixels.set(`${xx}:${yy}`, this.fillStyle);
  }, drawImage() { assert.fail("the miner is code-drawn, without raster assets"); }, getImageData() { assert.fail("contact comes from the rig without readback"); } };
  sprite.getContext = () => ctx; return sprite;
} };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  await vite.close();
});
const directions = ["front", "back", "left", "right"];
const actions = ["idle", "walk", "work", "carry", "inspect", "greet", "rest", "trade"];
const signature = sprite => JSON.stringify([...sprite.pixels].sort(([a], [b]) => a.localeCompare(b)));

test("all miner actions and views stay on their 48-pixel grid with planted broad paws", () => {
  for (const action of actions) for (const direction of directions) for (let step = 0; step <= 16; step++) {
    const sprite = kamneshmygSprite(action, direction, step, step / 16), rig = kamneshmygSpriteRig(sprite);
    assert.equal(sprite.width, 48); assert.equal(sprite.height, 48); assert.ok(sprite.pixels.size > 650);
    assert.equal(Math.max(...[...sprite.pixels.keys()].map(key => Number(key.split(":")[1]))) + 1, 45);
    assert.equal(rig.contact.bottom, 45); assert.ok(rig.feet.some(foot => foot.y === 43));
    assert.ok(rig.contact.left >= 0 && rig.contact.right <= 48);
    for (const arm of rig.arms) assert.ok(Math.hypot(arm.palm.x - arm.shoulder.x, arm.palm.y - arm.shoulder.y) <= 13,
      `${action}/${direction}: a short miner paw never stretches across the whole body`);
  }
});

test("four directions are distinct, with a lamp facing forward and no eyes on the back", () => {
  const sprites = directions.map(direction => kamneshmygSprite("idle", direction, 0));
  assert.equal(new Set(sprites.map(signature)).size, 4);
  const [front, back, left, right] = sprites;
  assert.ok([...front.pixels.values()].includes("#fff1b4"));
  assert.ok(![...back.pixels.values()].includes("#fff1b4"));
  assert.ok(![...back.pixels.values()].includes("#29343a"));
  for (const [key, color] of right.pixels) {
    const [x, y] = key.split(":").map(Number);
    if (y < 29) assert.equal(left.pixels.get(`${47 - x}:${y}`), color, "the head and helmet turn without changing identity");
  }
});

test("walk and loaded walk have several grounded steps while idle breathing and blinking stay subtle", () => {
  for (const action of ["walk", "carry"]) for (const direction of directions) {
    const poses = Array.from({ length: 16 }, (_, frame) => kamneshmygSprite(action, direction, frame));
    assert.ok(new Set(poses.map(signature)).size >= 5);
    assert.ok(new Set(poses.map(sprite => JSON.stringify(kamneshmygSpriteRig(sprite).feet))).size >= 3);
  }
  assert.notEqual(signature(kamneshmygSprite("idle", "front", 0)), signature(kamneshmygSprite("idle", "front", 8)));
  assert.notEqual(signature(kamneshmygSprite("idle", "front", 0)), signature(kamneshmygSprite("idle", "front", 30)));
  assert.notEqual(signature(kamneshmygSprite("carry", "front", 0)), signature(kamneshmygSprite("walk", "front", 0)));
});

test("the sixteen-pose miner gait never jumps a head, paw or pickaxe joint, including the wrap", () => {
  for (const action of ["walk", "carry"]) for (const direction of directions) {
    const rigs = Array.from({ length: 16 }, (_, frame) => kamneshmygSpriteRig(kamneshmygSprite(action, direction, frame)));
    const anchors = rig => [rig.head, ...rig.feet, ...rig.arms.map(arm => arm.palm), rig.tool.grip, rig.tool.head];
    for (let frame = 0; frame < 16; frame++) {
      const a = rigs[frame], b = rigs[(frame + 1) % 16];
      anchors(a).forEach((p, i) => {
        const q = anchors(b)[i];
        assert.ok(Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1,
          `${action}/${direction}/${frame}: a heavy miner takes a continuous short step`);
      });
      assert.equal(a.contact.bottom, b.contact.bottom);
    }
  }
});

test("the pickaxe lifts once and returns, keeping two hands on its shaft and both feet planted", () => {
  for (const direction of directions) {
    const start = kamneshmygSpriteRig(kamneshmygSprite("work", direction, 0, 0));
    const raised = kamneshmygSpriteRig(kamneshmygSprite("work", direction, 0, .25));
    const struck = kamneshmygSpriteRig(kamneshmygSprite("work", direction, 0, .4375));
    assert.ok(raised.tool.head.y < start.tool.head.y - 5);
    assert.ok(struck.tool.head.y > raised.tool.head.y + 5);
    assert.deepEqual(start.feet, struck.feet, "work does not drift across the quarry");
    let previous;
    for (let step = 0; step <= 16; step++) {
      const rig = kamneshmygSpriteRig(kamneshmygSprite("work", direction, 0, step / 16));
      const right = rig.arms.find(arm => arm.hand === "right").palm;
      const left = rig.arms.find(arm => arm.hand === "left").palm;
      assert.equal(rig.tool.held, true); assert.deepEqual(right, rig.tool.grip);
      const dx = right.x - rig.tool.head.x, dy = right.y - rig.tool.head.y;
      const distanceFromShaft = Math.abs(dx * (left.y - right.y) - dy * (left.x - right.x)) / Math.hypot(dx, dy);
      assert.ok(distanceFromShaft <= .7, "the second paw holds the same shaft, not empty air");
      assert.ok(Math.hypot(right.x - left.x, right.y - left.y) <= 5);
      if (previous) assert.ok(Math.hypot(rig.tool.head.x - previous.x, rig.tool.head.y - previous.y) <= 4, "short continuous arc");
      if (direction === "left" || direction === "right") assert.ok(rig.tool.head.y - 2 >= rig.head.y + 8, "no pickaxe across the muzzle");
      previous = rig.tool.head;
    }
    for (const phase of [.6875, .75, .875, 1]) {
      const rested = kamneshmygSpriteRig(kamneshmygSprite("work", direction, 25000, phase));
      assert.deepEqual(rested.tool, start.tool); assert.deepEqual(rested.arms, start.arms);
    }
  }
});

test("turning keeps the right hand on its tool, and carrying stows it instead of adding a third hand", () => {
  for (const action of actions) for (const direction of directions) {
    const rig = kamneshmygSpriteRig(kamneshmygSprite(action, direction, 2, .5));
    if (action === "carry" || action === "rest") {
      assert.equal(rig.tool.held, false); assert.equal(rig.tool.behindBody, true);
      assert.notDeepEqual(rig.tool.grip, rig.arms[1].palm);
    } else {
      assert.equal(rig.tool.held, true); assert.deepEqual(rig.tool.grip, rig.arms.find(arm => arm.hand === "right").palm);
      assert.equal(rig.tool.behindBody, direction === "left" || direction === "back");
    }
  }
  for (const direction of directions) for (const action of ["inspect", "greet", "trade"]) {
    const start = kamneshmygSpriteRig(kamneshmygSprite(action, direction, 0, 0));
    const middle = kamneshmygSpriteRig(kamneshmygSprite(action, direction, 0, .5));
    assert.deepEqual(start.tool, middle.tool, "the free hand gestures, while the pickaxe stays lowered");
    assert.deepEqual(start.feet, middle.feet); assert.notDeepEqual(start.arms[0].palm, middle.arms[0].palm);
  }
});

test("reduced motion and finite pose cache are independent of long or invalid clocks", () => {
  for (const action of actions) for (const direction of directions) {
    const still = kamneshmygSprite(action, direction, 0, 0, true);
    for (const frame of [18, 100000, -4, NaN, Infinity]) assert.equal(kamneshmygSprite(action, direction, frame, .8, true), still);
  }
  assert.equal(kamneshmygSprite("walk", "left", 1), kamneshmygSprite("walk", "left", 320001));
  assert.equal(kamneshmygSprite("work", "right", NaN, NaN), kamneshmygSprite("work", "right", 0, 0));
  const first = kamneshmygSprite("idle", "front", 0), unique = new Set();
  for (const action of actions) for (const direction of directions) for (let frame = 0; frame < 32; frame++) {
    unique.add(kamneshmygSprite(action, direction, frame, frame / 31));
  }
  assert.ok(unique.size > KAMNESHMYG_SPRITE_CACHE_LIMIT);
  assert.notEqual(kamneshmygSprite("idle", "front", 0), first, "old poses are evicted instead of keeping every canvas");
});

test("world painting uses the planted contact and contains every pixel in its render bounds", () => {
  const draws = [], stack = [], ctx = { imageSmoothingEnabled: true, globalAlpha: .8,
    save() { stack.push([this.imageSmoothingEnabled, this.globalAlpha]); }, restore() { [this.imageSmoothingEnabled, this.globalAlpha] = stack.pop(); },
    beginPath() {}, ellipse() {}, fill() {}, drawImage(...args) { draws.push({ args, smoothing: this.imageSmoothingEnabled, alpha: this.globalAlpha }); },
  };
  const frame = { id: "kamneshmyg", x: 140, y: 210, size: 44, direction: "right", action: "work", frame: 2, phase: .4375, opacity: .5 };
  drawKamneshmygResident(ctx, frame, false);
  const { args: [sprite, x, y, width, height], smoothing, alpha } = draws[0];
  assert.equal(y + kamneshmygSpriteRig(sprite).contact.bottom / 48 * height, frame.y);
  assert.equal(x + width / 2, frame.x); assert.equal(smoothing, false); assert.equal(alpha, .4);
  assert.equal(ctx.imageSmoothingEnabled, true); assert.equal(ctx.globalAlpha, .8);
  const bounds = kamneshmygRenderBounds(frame), hit = kamneshmygHitBounds(frame);
  for (const key of sprite.pixels.keys()) {
    const [px, py] = key.split(":").map(Number);
    assert.ok(x + px / 48 * width >= bounds.x && x + (px + 1) / 48 * width <= bounds.x + bounds.width);
    assert.ok(y + py / 48 * height >= bounds.y && y + (py + 1) / 48 * height <= bounds.y + bounds.height);
  }
  assert.ok(hit.width < bounds.width, "the far metal tip is not the body hit area");
  for (const value of [NaN, Infinity, 0, -1]) drawKamneshmygResident(ctx, { ...frame, size: value }, false);
  assert.equal(draws.length, 1);
});
