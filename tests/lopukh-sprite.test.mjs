import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { lopukhSprite, lopukhSpriteRig, LOPUKH_SPRITE_CACHE_LIMIT } = await vite.ssrLoadModule("/features/world/characters/lopukh/lopukh-sprite.ts");
const { drawLopukhResident, lopukhRenderBounds, lopukhHitBounds } = await vite.ssrLoadModule("/features/world/characters/lopukh/lopukh-painter.ts");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
globalThis.document = { createElement(tag) {
  assert.equal(tag, "canvas");
  const result = { width: 0, height: 0, pixels: new Map() };
  const ctx = { fillStyle: "#000000", fillRect(x, y, width, height) {
    for (const value of [x, y, width, height]) assert.ok(Number.isInteger(value), "source artwork is integer-aligned");
    assert.match(this.fillStyle, /^#[0-9a-f]{6}$/i, "source artwork uses opaque colours");
    assert.ok(x >= 0 && y >= 0 && x + width <= result.width && y + height <= result.height,
      `no clipping: ${x},${y},${width},${height}`);
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) result.pixels.set(`${column}:${row}`, this.fillStyle);
  }, drawImage() { assert.fail("rabbit artwork must be procedural"); }, getImageData() { assert.fail("contacts do not need a GPU readback"); } };
  result.getContext = () => ctx; return result;
} };
after(async () => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  await vite.close();
});
const directions = ["front", "back", "left", "right"], actions = ["idle", "walk", "work", "carry", "unload", "inspect", "greet", "rest", "trade"];
const signature = sprite => JSON.stringify([...sprite.pixels].sort(([a], [b]) => a.localeCompare(b)));

test("every rabbit direction and gesture fits the pixel grid with a planted foot and short arms", () => {
  for (const action of actions) for (const direction of directions) for (let step = 0; step <= 32; step++) {
    const sprite = lopukhSprite(action, direction, step, step / 32), rig = lopukhSpriteRig(sprite);
    assert.equal(sprite.width, 48); assert.equal(sprite.height, 48); assert.ok(sprite.pixels.size > 490);
    const bottom = Math.max(...[...sprite.pixels.keys()].map(key => Number(key.split(":")[1]))) + 1;
    assert.equal(bottom, 45, `${action}/${direction}: ground contact is stable`);
    assert.equal(rig.contact.bottom, bottom); assert.ok(rig.feet.some(foot => foot.y === 43));
    for (const arm of rig.arms) assert.ok(Math.hypot(arm.palm.x - arm.shoulder.x, arm.palm.y - arm.shoulder.y) <= 8,
      `${action}/${direction}: the rabbit has short paws`);
    assert.deepEqual(rig.axe.grip, rig.arms.find(arm => arm.hand === "right").palm);
  }
});

test("folded ears, cream muzzle and the little round tail distinguish the four views", () => {
  const front = lopukhSprite("idle", "front", 0), back = lopukhSprite("idle", "back", 0);
  assert.notEqual(signature(front), signature(back));
  assert.ok([...front.pixels.values()].includes("#382e28"), "front has eyes");
  assert.ok(![...back.pixels.values()].includes("#382e28"), "back has no face");
  const columns = sprite => [...sprite.pixels.keys()].filter(key => Number(key.split(":")[1]) < 15)
    .reduce((result, key) => { const [x, y] = key.split(":").map(Number); result.set(x, Math.min(result.get(x) ?? 48, y)); return result; }, new Map());
  const ears = columns(front);
  assert.ok(ears.get(16) < ears.get(35), "one long upright ear, one visibly folded tip");
  const side = lopukhSprite("idle", "right", 0);
  assert.equal(side.pixels.get("11:35"), "#f1dbad", "cream tail shows behind the profile");
  for (const [key, color] of lopukhSprite("idle", "right", 0).pixels) {
    const [x, y] = key.split(":").map(Number);
    if (y < 28) assert.equal(lopukhSprite("idle", "left", 0).pixels.get(`${47 - x}:${y}`), color);
  }
});

test("the rabbit has matching front cheeks and centred nose and teeth in every expression", () => {
  const cream = new Set(["#f1dbad", "#ffebc5"]);
  for (const action of actions) for (const frame of [0, 8, 24, 30]) {
    const sprite = lopukhSprite(action, "front", frame, .5), { head } = lopukhSpriteRig(sprite);
    for (let dy = 1; dy <= 6; dy++) for (let dx = 0; dx <= 9; dx++) {
      assert.equal(cream.has(sprite.pixels.get(`${head.x - dx}:${head.y + dy}`)),
        cream.has(sprite.pixels.get(`${head.x + dx}:${head.y + dy}`)), `${action}/${frame}/${dx}/${dy}: cheeks and chin share the nose axis`);
    }
    assert.equal(sprite.pixels.get(`${head.x}:${head.y + 2}`), "#cc957c", "the little pink nose is centred");
    assert.equal(sprite.pixels.get(`${head.x}:${head.y + 4}`), "#967044", "the mouth starts directly below the nose");
    const row = head.y - 1;
    if (action !== "rest" && !(action === "idle" && frame === 30)) {
      for (const x of [head.x - 5, head.x + 4]) assert.equal(sprite.pixels.get(`${x}:${row}`), "#382e28",
        "both pupils use the same height above the cheeks");
    }
  }
});

test("a small ear twitch has its own finite idle/greeting poses and stays within one pixel while walking", () => {
  for (const direction of directions) {
    const base = lopukhSprite("idle", direction, 0), twitch = lopukhSprite("idle", direction, 24);
    const a = lopukhSpriteRig(base), b = lopukhSpriteRig(twitch);
    assert.deepEqual(a.head, b.head, "the ear moves independently from breathing");
    assert.deepEqual(a.feet, b.feet);
    assert.notEqual(signature(base), signature(twitch));
    a.ears.forEach((ear, index) => {
      assert.ok(Math.abs(ear.x - b.ears[index].x) <= 1 && Math.abs(ear.y - b.ears[index].y) <= 1);
      assert.notDeepEqual(ear, b.ears[index]);
    });
    const greetingStart = lopukhSpriteRig(lopukhSprite("greet", direction, 0, 0));
    const greetingPeak = lopukhSpriteRig(lopukhSprite("greet", direction, 0, .5));
    const greetingEnd = lopukhSpriteRig(lopukhSprite("greet", direction, 0, 1));
    assert.notDeepEqual(greetingStart.ears, greetingPeak.ears);
    assert.deepEqual(greetingStart.ears, greetingEnd.ears, "ears return rather than snapping at a repeated greeting");
    const cycle = Array.from({ length: 16 }, (_, frame) => lopukhSpriteRig(lopukhSprite("walk", direction, frame)));
    cycle.forEach((rig, frame) => rig.ears.forEach((ear, index) => {
      const next = cycle[(frame + 1) % 16].ears[index];
      assert.ok(Math.abs(ear.x - next.x) <= 1 && Math.abs(ear.y - next.y) <= 1, "both ear tips follow a continuous walk loop");
    }));
    assert.deepEqual(lopukhSpriteRig(lopukhSprite("idle", direction, 24, .5, true)).ears,
      lopukhSpriteRig(lopukhSprite("idle", direction, 0, 0, true)).ears);
  }
});

test("walking alternates planted feet without stretching limbs or hiding the ears", () => {
  for (const direction of directions) for (const action of ["walk", "carry"]) {
    const poses = Array.from({ length: 16 }, (_, frame) => lopukhSprite(action, direction, frame));
    assert.ok(new Set(poses.map(signature)).size >= 5);
    assert.ok(new Set(poses.map(sprite => JSON.stringify(lopukhSpriteRig(sprite).feet))).size >= 3);
  }
  assert.notEqual(signature(lopukhSprite("idle", "front", 0)), signature(lopukhSprite("idle", "front", 8)));
  assert.notEqual(signature(lopukhSprite("idle", "front", 0)), signature(lopukhSprite("idle", "front", 30)));
});

test("the rabbit's sixteen-pose step moves each foot, head and held tool by at most one source pixel", () => {
  for (const action of ["walk", "carry"]) for (const direction of directions) {
    const rigs = Array.from({ length: 16 }, (_, frame) => lopukhSpriteRig(lopukhSprite(action, direction, frame)));
    const anchors = rig => [rig.head, ...rig.feet, ...rig.arms.map(arm => arm.palm), rig.axe.grip, rig.axe.head];
    for (let frame = 0; frame < 16; frame++) {
      const a = rigs[frame], b = rigs[(frame + 1) % 16];
      anchors(a).forEach((p, i) => {
        const q = anchors(b)[i];
        assert.ok(Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1, `${action}/${direction}/${frame}: no jump at a gait boundary`);
      });
      assert.equal(a.contact.bottom, b.contact.bottom);
    }
  }
});

test("the axe lifts once, strikes below the face, then returns to a calm resting grip", () => {
  for (const direction of directions) {
    const start = lopukhSpriteRig(lopukhSprite("work", direction, 0, 0));
    const lift = lopukhSpriteRig(lopukhSprite("work", direction, 0, .25));
    const strike = lopukhSpriteRig(lopukhSprite("work", direction, 0, .4375));
    assert.ok(lift.axe.head.y < start.axe.head.y - 5);
    assert.ok(strike.axe.head.y > lift.axe.head.y + 5);
    assert.deepEqual(start.feet, strike.feet);
    let previous;
    for (let phase = 0; phase <= 16; phase++) {
      const rig = lopukhSpriteRig(lopukhSprite("work", direction, 0, phase / 16));
      assert.ok(rig.axe.head.y - 3 >= rig.head.y + 8, "blade stays below the muzzle");
      assert.ok(Math.hypot(rig.axe.grip.x - rig.axe.head.x, rig.axe.grip.y - rig.axe.head.y) <= 7, `${direction}/${phase}: the handle stays in the paw ${JSON.stringify(rig.axe)}`);
      if (previous) assert.ok(Math.hypot(rig.axe.head.x - previous.x, rig.axe.head.y - previous.y) <= 4);
      previous = rig.axe.head;
      assert.equal(rig.axe.behindBody, direction === "left" || direction === "back");
    }
    for (const phase of [.75, .875, 1]) assert.deepEqual(lopukhSpriteRig(lopukhSprite("work", direction, 5000, phase)).axe, start.axe);
  }
});

test("carrying uses both paws on the log and puts the axe away", () => {
  for (const direction of directions) for (let frame = 0; frame < 8; frame++) {
    const rig = lopukhSpriteRig(lopukhSprite("carry", direction, frame));
    assert.equal(rig.axe.visible, false); assert.ok(rig.log);
    assert.deepEqual(rig.log.leftGrip, rig.arms.find(arm => arm.hand === "left").palm);
    assert.deepEqual(rig.log.rightGrip, rig.arms.find(arm => arm.hand === "right").palm);
    for (const palm of [rig.log.leftGrip, rig.log.rightGrip]) {
      assert.ok(Math.abs(palm.x - rig.log.center.x) <= 10); assert.equal(palm.y, rig.log.center.y + 1);
    }
  }
});

test("unloading lowers the log onto the ground once, releases both paws and keeps every sole planted", () => {
  for (const direction of directions) {
    const startSprite = lopukhSprite("unload", direction, 0, 0), start = lopukhSpriteRig(startSprite);
    const carry = lopukhSpriteRig(lopukhSprite("carry", direction, 0));
    assert.deepEqual(start.log, carry.log);
    assert.deepEqual(start.arms, carry.arms);
    let previous;
    for (let step = 0; step <= 32; step++) {
      const sprite = lopukhSprite("unload", direction, 0, step / 32), rig = lopukhSpriteRig(sprite);
      assert.equal(rig.axe.visible, false);
      assert.equal(rig.contact.bottom, 45);
      assert.deepEqual(rig.feet, start.feet);
      const bottom = Math.max(...[...sprite.pixels.keys()].map(key => Number(key.split(":")[1]))) + 1;
      assert.equal(bottom, 45, "the lowered log does not sink below the feet");
      if (previous) {
        assert.ok(rig.log.center.y >= previous.log.center.y, "delivery only lowers the log");
        for (const [a, b] of [[rig.head, previous.head], [rig.log.center, previous.log.center],
          ...rig.arms.map((arm, index) => [arm.palm, previous.arms[index].palm])])
          assert.ok(Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1, "one small pixel step per pose");
      }
      previous = rig;
    }
    assert.equal(previous.log.center.y, 40, "the visible end of the log settles on source row 44");
    assert.equal(previous.log.center.y - start.log.center.y, 4);
    assert.ok(previous.head.y > start.head.y, "a small crouch follows the weight down");
    for (const arm of previous.arms) {
      const held = arm.hand === "left" ? previous.log.leftGrip : previous.log.rightGrip;
      assert.ok(Math.hypot(arm.palm.x - held.x, arm.palm.y - held.y) >= 3, "the paws let go after contact");
    }
    assert.equal(lopukhSpriteRig(lopukhSprite("rest", direction, 0)).log, undefined, "rest has no phantom carried load");
    assert.equal(lopukhSprite("unload", direction, 32, 1, true), lopukhSprite("unload", direction, 0, 0, true));
  }
});

test("brief greetings and checks return to the initial pose without moving the axe", () => {
  for (const direction of directions) for (const action of ["greet", "inspect", "trade"]) {
    const start = lopukhSprite(action, direction, 0, 0), middle = lopukhSprite(action, direction, 0, .5), end = lopukhSprite(action, direction, 0, 1);
    assert.equal(signature(start), signature(end));
    assert.deepEqual(lopukhSpriteRig(start).axe, lopukhSpriteRig(middle).axe);
    assert.deepEqual(lopukhSpriteRig(start).feet, lopukhSpriteRig(middle).feet);
    assert.notDeepEqual(lopukhSpriteRig(start).arms[0].palm, lopukhSpriteRig(middle).arms[0].palm);
  }
});

test("finite poses reuse cached canvases despite huge clocks, with bounded LRU retention", () => {
  for (const action of actions) {
    const still = lopukhSprite(action, "front", 0, 0, true);
    for (const frame of [-1, NaN, Infinity, 1e9]) assert.equal(lopukhSprite(action, "front", frame, .8, true), still);
  }
  assert.equal(lopukhSprite("walk", "left", 1), lopukhSprite("walk", "left", 320001));
  assert.equal(lopukhSprite("work", "right", NaN, NaN), lopukhSprite("work", "right", 0, 0));
  const first = lopukhSprite("idle", "front", 0), unique = new Set();
  for (const direction of directions) for (const action of ["work", "inspect", "greet", "trade"]) for (let step = 0; step <= 16; step++) unique.add(lopukhSprite(action, direction, 0, step / 16));
  assert.ok(unique.size > LOPUKH_SPRITE_CACHE_LIMIT);
  assert.notEqual(lopukhSprite("idle", "front", 0), first, "old canvases are evicted");
});

test("world painting anchors the feet and includes every pixel in render bounds", () => {
  const draws = [], stack = [], ctx = { globalAlpha: .8, imageSmoothingEnabled: true,
    save() { stack.push([this.imageSmoothingEnabled, this.globalAlpha]); }, restore() { [this.imageSmoothingEnabled, this.globalAlpha] = stack.pop(); },
    beginPath() {}, ellipse() {}, fill() {}, drawImage(...args) { draws.push({ args, smoothing: this.imageSmoothingEnabled, alpha: this.globalAlpha }); },
  };
  const frame = { id: "lopukh", x: 140, y: 210, size: 40, direction: "left", action: "work", frame: 2, phase: .4375, opacity: .5 };
  drawLopukhResident(ctx, frame, false);
  const { args: [sprite, x, y, width, height], smoothing, alpha } = draws[0];
  assert.equal(y + lopukhSpriteRig(sprite).contact.bottom / 48 * height, frame.y);
  assert.equal(x + width / 2, frame.x); assert.equal(smoothing, false); assert.equal(ctx.imageSmoothingEnabled, true);
  assert.equal(alpha, .4); assert.equal(ctx.globalAlpha, .8);
  const bounds = lopukhRenderBounds(frame), hit = lopukhHitBounds(frame);
  for (const key of sprite.pixels.keys()) {
    const [px, py] = key.split(":").map(Number);
    assert.ok(x + px / 48 * width >= bounds.x && x + (px + 1) / 48 * width <= bounds.x + bounds.width);
    assert.ok(y + py / 48 * height >= bounds.y && y + (py + 1) / 48 * height <= bounds.y + bounds.height);
  }
  assert.ok(hit.width < bounds.width);
  for (const value of [NaN, Infinity, 0, -1]) drawLopukhResident(ctx, { ...frame, size: value }, false);
  assert.equal(draws.length, 1);
});
