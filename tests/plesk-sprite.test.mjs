import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { pleskSprite, pleskSpriteRig, PLESK_SPRITE_CACHE_LIMIT } = await vite.ssrLoadModule("/features/world/plesk-sprite.ts");
const { drawPleskResident } = await vite.ssrLoadModule("/features/world/plesk-painter.ts");
const { fishingTackleFrame, fishingPropsBounds } = await vite.ssrLoadModule("/features/world/fishing-props.ts");
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
  assert.ok(castEnd.grip.x > castStart.grip.x + 4, "a compact forearm follows the forward cast without crossing the muzzle");
  assert.ok(castStart.grip.y >= castStart.head.y + 10, "backswing hand stays below the face");
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
  const draws = [], paths = [], palms = [], events = [], stack = []; let path = [];
  return { draws, paths, palms, events, imageSmoothingEnabled: true,
    save() { stack.push({ imageSmoothingEnabled: this.imageSmoothingEnabled }); }, restore() { Object.assign(this, stack.pop()); },
    drawImage(...args) { draws.push({ args, smoothing: this.imageSmoothingEnabled }); },
    beginPath() { path = []; }, moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); },
    quadraticCurveTo() {}, ellipse() {}, arc() {}, closePath() {}, fill() {}, stroke() { paths.push(path); events.push("prop"); },
    fillRect(...args) { palms.push(args); events.push("palm"); },
    translate() {}, rotate() {},
  };
}
test("Pleska paints at her recorded ground contact and the rod starts at the articulated hand", () => {
  const frame = { x: 100, y: 160, size: 36, direction: "right", action: "cast", phase: .6, frame: 4,
    carryingFish: false, waterTarget: { x: 165, y: 180 } };
  const ctx = context(); drawPleskResident(ctx, frame, false);
  const { args: [sprite, x, y, width, height], smoothing } = ctx.draws[0], rig = pleskSpriteRig(sprite);
  assert.equal(y + rig.contact.bottom / 48 * height, frame.y); assert.equal(width, frame.size);
  assert.equal(smoothing, false); assert.equal(ctx.imageSmoothingEnabled, true);
  const expectedGrip = { x: x + rig.grip.x / 48 * width, y: y + rig.grip.y / 48 * height };
  assert.deepEqual(ctx.paths[0][0], expectedGrip, "the rod is attached to the hand at every cast phase");
  assert.equal(ctx.events.at(-1), "palm", "fingers paint over the handle, not below it");
  assert.ok(ctx.palms.some(([left, top, w, h]) => expectedGrip.x >= left && expectedGrip.x <= left + w
    && expectedGrip.y >= top && expectedGrip.y <= top + h), "opaque fingers physically clasp the grip");
  const bounds = fishingPropsBounds(frame);
  assert.ok(bounds.x <= x && bounds.y <= y);
  assert.ok(bounds.x + bounds.width >= frame.waterTarget.x + frame.size * .2);
  assert.ok(bounds.y + bounds.height >= frame.waterTarget.y + frame.size * .2);
});

test("the round face keeps its short muzzle inside the skull and its clip on one anatomical temple", () => {
  const front = pleskSpriteRig(pleskSprite("idle", "front", 0));
  const back = pleskSpriteRig(pleskSprite("idle", "back", 0));
  assert.ok(front.flower.x > front.head.x && back.flower.x < back.head.x);
  const cream = new Set(["#eee2c4", "#fff0d0", "#c8bba0"]);
  for (const direction of ["left", "right"]) {
    const sprite = pleskSprite("idle", direction, 0), rig = pleskSpriteRig(sprite);
    const face = [...sprite.pixels].filter(([key, color]) => {
      const [, y] = key.split(":").map(Number); return cream.has(color) && y >= rig.head.y && y <= rig.head.y + 7;
    });
    assert.ok(face.length > 20);
    assert.ok(face.every(([key]) => Math.abs(Number(key.split(":")[0]) - rig.head.x) <= 11), "cream cheeks remain within the round head");
  }
  const right = pleskSpriteRig(pleskSprite("idle", "right", 0));
  const left = pleskSpriteRig(pleskSprite("idle", "left", 0));
  assert.ok(right.flower.x < right.head.x && left.flower.x < left.head.x,
    "the clip moves to the far side when she turns, rather than mirroring to the other anatomical temple");
});

test("raising a paw bends two short arm segments instead of stretching a low elbow to the face", () => {
  const check = sprite => {
    const rig = pleskSpriteRig(sprite);
    assert.equal(rig.arms.length, 2);
    for (const { shoulder, elbow, palm } of rig.arms) {
      const upperArm = Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y);
      const forearm = Math.hypot(palm.x - elbow.x, palm.y - elbow.y);
      assert.ok(upperArm <= 7.1, `upper arm remains compact: ${upperArm}`);
      assert.ok(forearm <= 7.1, `forearm remains compact: ${forearm}`);
      assert.ok(Math.abs(upperArm - forearm) <= 1.5, "a joint cannot trade one short bone for an elongated forearm");
      assert.ok(rig.palms.some(hand => hand.position.x === palm.x && hand.position.y === palm.y),
        "props and foreground fingers use the actual reachable hand");
    }
  };
  for (const direction of ["front", "back", "left", "right"]) {
    for (const action of actions) for (let frame = 0; frame < 8; frame++) {
      const sprite = pleskSprite(action, direction, frame, frame / 7); check(sprite);
      if (action === "greet") {
        const rig = pleskSpriteRig(sprite), waving = rig.arms.at(-1);
        assert.ok(waving.palm.y >= rig.head.y + 5, "the paw waves beside the lower cheek, not above the head");
      }
    }
    for (const variation of ["check", "nibble", "struggle", "escape"]) for (let frame = 0; frame < 8; frame++) {
      check(pleskSprite("reel", direction, frame, frame / 7, false, { variation }));
    }
  }
});

test("the small temple flower leaves both complete inner ears visible in every facing", () => {
  const petals = new Set(["#efb5bb", "#ffe1d7", "#bd858f", "#e9c371"]);
  for (const direction of ["front", "back", "left", "right"]) for (const action of actions) {
    const sprite = pleskSprite(action, direction, 4, .5), rig = pleskSpriteRig(sprite);
    const flowerPixels = [...sprite.pixels].filter(([, color]) => petals.has(color));
    assert.ok(flowerPixels.length > 0 && flowerPixels.length <= 26, "a small clip, not an ear-sized blossom");
    for (const ear of rig.ears) {
      const x = ear.x - Number(direction === "left");
      let innerEar = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const color = sprite.pixels.get(`${x + dx}:${ear.y + dy}`);
        if (color === (direction === "back" ? "#536f78" : "#c7b5ad")) innerEar++;
        assert.equal(petals.has(color), false, "the flower never substitutes for the ear opening");
      }
      assert.ok(innerEar >= 5, `${action}/${direction} preserves a visible inner ear`);
    }
  }
});

test("line checking, timid nibbles, struggle and an escaped catch have their own grounded joint poses", () => {
  const poses = ["calm", "check", "nibble", "struggle", "escape"].map(variation => pleskSprite("reel", "right", 4, .6, false, { variation }));
  assert.equal(new Set(poses.map(signature)).size, 5);
  for (const sprite of poses) assert.equal(pleskSpriteRig(sprite).contact.bottom, 45);
  assert.equal(pleskSprite("fish", "right", 7, .8, true, { variation: "struggle" }),
    pleskSprite("fish", "right", 0, .1, true, { variation: "calm" }), "reduced motion suppresses the effort cycle");
});

test("a downward cast swings a full rod instead of shrinking it through the hand", () => {
  for (let step = 0; step <= 20; step++) {
    const frame = { x: 100, y: 160, size: 50, direction: "front", action: "cast", phase: step / 20, frame: 0,
      carryingFish: false, waterTarget: { x: 108, y: 211 } };
    const { grip, tip } = fishingTackleFrame(frame, false);
    const rodLength = Math.hypot(tip.x - grip.x, tip.y - grip.y);
    assert.ok(rodLength >= frame.size * .64, `visible rod at cast phase ${step / 20}`);
    assert.ok(rodLength <= frame.size * 1.2);
  }
});

test("held and casting rods stay outside Pleska's eyes and muzzle in each visible facing", () => {
  for (const direction of ["front", "left", "right"]) for (const action of ["idle", "walk", "cast", "fish", "catch", "greet"]) {
    for (const phase of [0, .25, .5, .75, 1]) {
      const sprite = pleskSprite(action, direction, 0, phase), body = pleskSpriteRig(sprite);
      const waterTarget = direction === "front" ? { x: 24, y: 105 }
        : direction === "right" ? { x: 95, y: 45 } : { x: -45, y: 45 };
      const tackle = fishingTackleFrame({ x: 24, y: 45, size: 48, direction, action, frame: 0, phase,
        carryingFish: false, waterTarget }, false, { grip: body.grip });
      const faceX = body.head.x + (direction === "right" ? 2 : direction === "left" ? -2 : 0);
      for (let i = 1; i <= 20; i++) {
        const x = tackle.grip.x + (tackle.tip.x - tackle.grip.x) * i / 20;
        const y = tackle.grip.y + (tackle.tip.y - tackle.grip.y) * i / 20;
        const insideFace = ((x - faceX) / 7) ** 2 + ((y - body.head.y - 1) / 6) ** 2 < 1;
        assert.equal(insideFace, false, `${action}/${direction}/${phase} keeps the face clear`);
      }
    }
  }
});
