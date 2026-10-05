import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { pleskSprite, pleskSpriteRig, PLESK_SPRITE_CACHE_LIMIT } = await vite.ssrLoadModule("/features/world/plesk-sprite.ts");
const { drawPleskResident, pleskFishingAnchors } = await vite.ssrLoadModule("/features/world/plesk-painter.ts");
const { pleskLocalPlaces } = await vite.ssrLoadModule("/features/world/plesk-resident.ts");
const { default: actualWorld } = await vite.ssrLoadModule("/features/world/tiled/forest.generated.json");
const { fishingTackleFrame, fishingPropsBounds, fishingCatchFrame, fishingBasketFishCenter, fishingBasketHandle, fishingReelHand, FISHING_PACK_RELEASE, FISHING_REEL_HANDOFF } = await vite.ssrLoadModule("/features/world/fishing-props.ts");
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
  for (const action of ["cast", "bite", "reel", "pack", "greet"]) {
    const frames = Array.from({ length: 8 }, (_, frame) => pleskSprite(action, "right", frame, frame / 7));
    assert.ok(new Set(frames.map(signature)).size >= 3, `${action} has distinct limb poses`);
  }
  const castStart = pleskSpriteRig(pleskSprite("cast", "right", 0, 0));
  const castEnd = pleskSpriteRig(pleskSprite("cast", "right", 7, 1));
  assert.ok(castEnd.grip.x > castStart.grip.x + 4, "a compact forearm follows the forward cast without crossing the muzzle");
  assert.ok(castStart.grip.y >= castStart.head.y + 10, "backswing hand stays below the face");
  const held = pleskSpriteRig(pleskSprite("pack", "right", 0, 0));
  const packed = pleskSpriteRig(pleskSprite("pack", "right", 7, 1));
  assert.ok(packed.heldFish.y > held.heldFish.y, "fish is physically lowered into the basket");
  const mouth = fishingBasketFishCenter(packed.basket, 48);
  assert.ok(Math.hypot(packed.heldFish.x - mouth.x, packed.heldFish.y - mouth.y) < .75, "fish lands at the actual basket mouth within pixel rounding");
  assert.deepEqual(packed.grip, held.grip, "the occupied rod stays in its own paw");
  assert.ok(Math.hypot(packed.basket.x - packed.heldFish.x, packed.basket.y - packed.heldFish.y) < 48 * .17);
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
  const draws = [], paths = [], strokes = [], palms = [], rectangles = [], events = [], translations = [], stack = []; let path = [];
  return { draws, paths, strokes, palms, rectangles, events, translations, imageSmoothingEnabled: true,
    save() { stack.push({ imageSmoothingEnabled: this.imageSmoothingEnabled }); }, restore() { Object.assign(this, stack.pop()); },
    drawImage(...args) { draws.push({ args, smoothing: this.imageSmoothingEnabled }); events.push("body"); },
    beginPath() { path = []; }, moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); },
    quadraticCurveTo() {}, ellipse() {}, arc() {}, closePath() {}, fill() {}, clip() {}, stroke() {
      paths.push(path); strokes.push({ path, width: this.lineWidth, color: this.strokeStyle, event: events.length }); events.push("prop");
    },
    fillRect(...args) { palms.push(args); rectangles.push({ args, color: this.fillStyle, event: events.length }); events.push("palm"); },
    translate(x, y) { translations.push({ x, y }); }, rotate() {}, scale() {},
  };
}
test("Pleska paints at her recorded ground contact and the rod starts at the articulated hand", () => {
  const frame = { x: 100, y: 160, size: 36, direction: "right", action: "cast", phase: .6, frame: 4,
    carryingFish: false, waterTarget: { x: 165, y: 180 } };
  const ctx = context(); drawPleskResident(ctx, frame, false);
  const { args: [sprite, x, y, width, height], smoothing } = ctx.draws[0], rig = pleskSpriteRig(sprite);
  assert.equal(y + rig.contact.bottom / 48 * height, frame.y); assert.equal(width, frame.size);
  assert.equal(smoothing, false); assert.equal(ctx.imageSmoothingEnabled, true);
  const expectedGrip = pleskFishingAnchors(frame, rig, false).grip;
  assert.deepEqual(ctx.translations[0], expectedGrip, "the shared rod renderer uses the articulated hand as its local origin");
  assert.equal(ctx.events.at(-1), "palm", "fingers paint over the handle, not below it");
  assert.ok(ctx.palms.some(([left, top, w, h]) => expectedGrip.x >= left && expectedGrip.x <= left + w
    && expectedGrip.y >= top && expectedGrip.y <= top + h), "opaque fingers physically clasp the grip");
  const bounds = fishingPropsBounds(frame);
  assert.ok(bounds.x <= x && bounds.y <= y);
  assert.ok(bounds.x + bounds.width >= frame.waterTarget.x + frame.size * .2);
  assert.ok(bounds.y + bounds.height >= frame.waterTarget.y + frame.size * .2);
});

test("shore rasters omit old arms with separate bounded cache keys while ordinary poses keep their complete rig", () => {
  for (const action of ["idle", "cast", "fish", "bite", "reel", "catch", "pack", "rest"]) {
    const ordinary = pleskSprite(action, "right", 3, .4);
    const shore = pleskSprite(action, "right", 3, .4, false, undefined, { externalArms: true, lean: 1, crouch: 1 });
    assert.notStrictEqual(shore, ordinary); assert.notEqual(signature(shore), signature(ordinary));
    assert.equal(pleskSpriteRig(shore).arms.length, 0, "only the world arm painter owns a shore arm");
    assert.equal(pleskSpriteRig(ordinary).arms.length, 2);
    assert.equal(pleskSpriteRig(shore).contact.bottom, 45);
    assert.strictEqual(shore, pleskSprite(action, "right", 3, .4, false, undefined, { externalArms: true, lean: 1.2, crouch: 1.1 }),
      "body lean/compression use bounded integer buckets");
  }
  for (const action of ["walk", "trade", "greet"]) {
    const ordinary = pleskSprite(action, "front", 3, .4);
    const carried = pleskSprite(action, "front", 3, .4, false, { carryingBasket: true }, { externalArms: true, lean: 0, crouch: 0, basketScale: .8 });
    assert.equal(pleskSpriteRig(ordinary).arms.length, 2, "ordinary poses retain their raster arms");
    assert.equal(pleskSpriteRig(carried).arms.length, 0, "carried basket shares the compact world arms");
    assert.notStrictEqual(carried, ordinary);
  }
});

test("the actual pier painter casts down and stamps compact pixel paws on the rod, reel and caught fish", () => {
  const base = { x: 1214, y: 744, size: 36, direction: "front", frame: 0, carryingFish: false,
    waterTarget: pleskLocalPlaces(actualWorld).waterTarget, rodId: "willow_rod", outcome: "large", catchScale: 1.35, species: "fish_mooncarp" };
  assert.ok(base.waterTarget.y > base.y + base.size, "the authored pier casts downstream without moving its feet");
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), pixel = base.size / 48;
  for (const action of ["idle", "cast", "fish", "bite", "reel", "catch", "pack", "rest"]) for (let index = 0; index <= 20; index++) {
    const phase = index / 20, frame = { ...base, action, phase, frame: index % 8, carryingFish: ["catch", "pack"].includes(action) };
    const ctx = context(); drawPleskResident(ctx, frame, false);
    const [sprite, x, y, width, height] = ctx.draws[0].args, body = pleskSpriteRig(sprite);
    const rig = pleskFishingAnchors(frame, body, false), directed = { ...frame, direction: rig.bodyDirection };
    assert.equal(rig.bodyDirection, "front", "downstream water keeps the face turned toward the bottom of the pier");
    assert.equal(body.arms.length, 0);
    assert.equal(y + body.contact.bottom / 48 * height, base.y); assert.equal(width, base.size);
    assert.equal(ctx.strokes.filter(stroke => stroke.path.length === 3 && stroke.color === "#3c5258").length, 0,
      "a smooth bent tube cannot replace the pixel paws");
    const pixels = ctx.rectangles.filter(rect => rect.color === "#3c5258");
    assert.ok(pixels.some(rect => rect.event < ctx.events.indexOf("body")), "far paw paints behind the torso");
    assert.ok(pixels.some(rect => rect.event > ctx.events.indexOf("body")), "near paw paints in front of the torso");
    for (const { args: [left, top, w, h] } of pixels) {
      assert.equal(w, pixel * 3); assert.equal(h, pixel * 3);
      assert.ok(Math.abs((left - x) / pixel - Math.round((left - x) / pixel)) < 1e-9);
      assert.ok(Math.abs((top - y) / pixel - Math.round((top - y) / pixel)) < 1e-9);
    }
    for (const arm of [rig.farArm, rig.nearArm]) {
      assert.ok(arm.reachable, "the contact stays within the compact paw's reach");
      assert.ok(Math.abs(distance(arm.shoulder, arm.elbow) - base.size * .12) < 1e-9, "upper bone stays below six native pixels");
      assert.ok(Math.abs(distance(arm.elbow, arm.hand) - base.size * .13) < 1e-9, "forearm stays near six native pixels");
      assert.ok(arm.elbow.y < base.y - base.size * .12, "the elbow cannot hang beside the lower foot");
    }
    assert.ok(distance(rig.nearHand, fishingTackleFrame(directed, false, rig).grip) <= pixel, "visible paw clasps the actual handle");
    if (["cast", "fish", "bite"].includes(action) || action === "reel" && phase <= FISHING_REEL_HANDOFF) {
      const reel = fishingReelHand(directed, action !== "reel", rig);
      assert.ok(distance(rig.farHand, reel) <= pixel, `${action}/${phase}: supporting/reeling paw touches the reel within one native pixel`);
    }
    if (action === "catch" || action === "pack" && phase < FISHING_PACK_RELEASE) {
      assert.ok(distance(rig.farHand, fishingCatchFrame(directed, false, rig).wrist) <= pixel,
        "visible free paw holds the actual underside instead of disconnected fingers");
    }
    assert.ok(ctx.palms.some(([left, top, w, h]) => rig.grip.x >= left && rig.grip.x <= left + w
      && rig.grip.y >= top && rig.grip.y <= top + h), "foreground fingers cross the true handle");
    assert.ok(Number.isFinite(x));
  }
});

test("shore arms freeze under reduced motion, back-facing arms stay behind, and wildlife retains the original palm", () => {
  const base = { x: 1214, y: 744, size: 36, direction: "front", action: "reel", phase: .2, frame: 1,
    carryingFish: false, waterTarget: { x: 1214, y: 700 }, outcome: "large", variation: "struggle" };
  const first = context(), later = context(); drawPleskResident(first, base, true); drawPleskResident(later, { ...base, phase: .9, frame: 7 }, true);
  assert.deepEqual(first.draws, later.draws); assert.deepEqual(first.paths, later.paths); assert.deepEqual(first.palms, later.palms);
  for (const ctx of [first, later]) for (const rect of ctx.rectangles.filter(item => item.color === "#3c5258")) {
    assert.ok(rect.event < ctx.events.indexOf("body"), "both pixel paws belong behind the back-facing body");
  }
  const wildlife = context(); drawPleskResident(wildlife, { ...base, action: "greet", wildlife: true }, false);
  assert.equal(pleskSpriteRig(wildlife.draws[0].args[0]).arms.length, 2);
});

test("a completed deposit rests once, then prepares the next cast without resetting the paws or rod", () => {
  const base = { x: 1214, y: 744, size: 36, direction: "front", frame: 0,
    waterTarget: pleskLocalPlaces(actualWorld).waterTarget, carryingFish: false, basketFilled: true };
  const anchors = frame => {
    const ctx = context(); drawPleskResident(ctx, frame, false);
    return pleskFishingAnchors(frame, pleskSpriteRig(ctx.draws[0].args[0]), false);
  };
  for (const [before, after] of [
    [{ action: "pack", phase: 1 }, { action: "idle", phase: 0 }],
    [{ action: "idle", phase: 1 }, { action: "idle", phase: 0, variation: "check" }],
    [{ action: "idle", phase: 1, variation: "check" }, { action: "cast", phase: 0 }],
  ]) {
    const first = anchors({ ...base, ...before }), next = anchors({ ...base, ...after });
    for (const key of ["nearHand", "farHand", "basket", "rodTip"]) assert.deepEqual(first[key], next[key], `${before.action} → ${after.action}: ${key}`);
  }
  const paused = anchors({ ...base, action: "idle", phase: 1 });
  const preparing = anchors({ ...base, action: "idle", phase: 1, variation: "check" });
  assert.ok(preparing.grip.y < paused.grip.y, "only the check stage starts the new backswing");
});

test("Pleska's ground basket rim clears her painted torso instead of covering the chest and paws", () => {
  const base = { x: 1214, y: 744, size: 36, direction: "front", frame: 0,
    waterTarget: pleskLocalPlaces(actualWorld).waterTarget, species: "fish_mooncarp", catchScale: 1.35, outcome: "large" };
  for (const action of ["fish", "catch", "pack", "idle"]) for (const phase of [0, .2, .5, .67, 1]) {
    const frame = { ...base, action, phase, carryingFish: ["catch", "pack"].includes(action) };
    const ctx = context(); drawPleskResident(ctx, frame, false);
    const [sprite, originX] = ctx.draws[0].args, body = pleskSpriteRig(sprite);
    const anchors = pleskFishingAnchors(frame, body, false), pixel = frame.size / 48;
    const torsoRight = Math.max(...[...sprite.pixels.keys()].map(key => key.split(":").map(Number))
      .filter(([, y]) => y >= 30 && y <= 41).map(([x]) => originX + (x + 1) * pixel));
    const rimLeft = anchors.basket.x - frame.size * .4 * anchors.basketScale * .525;
    assert.ok(rimLeft >= torsoRight + pixel * .5, `${action}/${phase}: the widest painted rim must leave a visible half-pixel gap`);
    assert.ok(anchors.farArm.reachable && anchors.nearArm.reachable, "moving the basket cannot disconnect its supporting paw");
  }
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


test("Pleska keeps her rod in the same paw and supports the fish below its outline throughout catch and pack", () => {
  for (const direction of ["front", "right", "back", "left"]) for (const outcome of ["small", "large"]) {
    const motion = { outcome, variation: outcome === "large" ? "struggle" : "calm" };
    const reel = pleskSpriteRig(pleskSprite("reel", direction, 7, 1, false, motion));
    const caught = pleskSpriteRig(pleskSprite("catch", direction, 0, 0, false, motion));
    assert.deepEqual(reel.grip, caught.grip, "reeling settles to the same held rod at the catch boundary");
    assert.deepEqual(reel.heldFish, caught.heldFish);
    for (const action of ["catch", "pack"]) for (let index = 0; index <= 12; index++) {
      const phase = index / 12;
      const body = pleskSpriteRig(pleskSprite(action, direction, Math.min(7, Math.floor(phase * 8)), phase, false, motion));
      assert.deepEqual(body.grip, caught.grip, "no rod hand swap or disappearance while transferring the fish");
      const fish = fishingCatchFrame({ x: 24, y: 45, size: 48, direction, action, phase, frame: 0,
        carryingFish: true, ...motion }, false, body);
      if (action === "catch" || phase < FISHING_PACK_RELEASE) {
        const supporting = body.arms[0].palm;
        assert.ok(Math.hypot(supporting.x - fish.wrist.x, supporting.y - fish.wrist.y) <= 1.1,
          `${direction} ${action} supporting paw follows the rotated underside`);
      }
    }
  }
});


test("a carried basket hangs from Pleska's paw, sways with her step, and has its own cached pose", () => {
  for (const direction of ["front", "right", "back", "left"]) for (const action of ["walk", "idle", "greet"]) {
    const positions = new Set();
    for (let frame = 0; frame < 8; frame++) {
      const empty = pleskSprite(action, direction, frame, frame / 7);
      const carried = pleskSprite(action, direction, frame, frame / 7, false, { carryingBasket: true });
      assert.notStrictEqual(carried, empty, "carrying a basket cannot reuse the rod-holding raster");
      assert.strictEqual(carried, pleskSprite(action, direction, frame, frame / 7, false, { carryingBasket: true }));
      const rig = pleskSpriteRig(carried), handle = fishingBasketHandle(rig.basket, 48), hand = rig.basketPalm;
      assert.ok(Math.hypot(hand.x - handle.x, hand.y - handle.y) <= .51, `${direction}/${action}/${frame} clasps the handle within pixel rounding`);
      assert.equal(rig.contact.bottom, 45);
      assert.ok(rig.basket.y + 48 * .27 * .43 < rig.contact.bottom, "a carried basket clears the ground");
      const side = direction === "left" || direction === "right";
      const emptyArm = rig.arms[side ? 0 : 1];
      if (action !== "greet") assert.ok(emptyArm.palm.y > emptyArm.shoulder.y, "the empty opposite paw hangs naturally");
      if (side) assert.ok((rig.basket.x - rig.head.x) * (direction === "left" ? -1 : 1) > 0,
        "the visible arm carries the basket ahead of the body, never behind the tail");
      for (const arm of rig.arms) {
        assert.ok(Math.hypot(arm.elbow.x - arm.shoulder.x, arm.elbow.y - arm.shoulder.y) <= 7.1);
        assert.ok(Math.hypot(arm.palm.x - arm.elbow.x, arm.palm.y - arm.elbow.y) <= 7.1);
      }
      positions.add(JSON.stringify(rig.basket));
    }
    assert.equal(positions.size > 1, action === "walk", "only actual steps swing the carried basket");
    const still = pleskSprite(action, direction, 0, 0, true, { carryingBasket: true });
    for (const frame of [2, 7, 10000]) assert.strictEqual(pleskSprite(action, direction, frame, .9, true, { carryingBasket: true }), still);
  }
  assert.strictEqual(pleskSprite("fish", "front", 3, .5, false, { carryingBasket: true }),
    pleskSprite("fish", "front", 3, .5), "the carrying flag does not replace an active fishing pose");
});

test("Pleska carries and sets down one compact basket with short paws and no rod in each direction", () => {
  for (const direction of ["front", "right", "back", "left"]) for (const action of ["walk", "idle", "greet", "trade"]) {
    const frame = { x: 100, y: 160, size: 36, direction, action, phase: .4, frame: 3,
      carryingFish: true, basketFilled: true };
    const ctx = context(); drawPleskResident(ctx, frame, false);
    const [sprite] = ctx.draws[0].args, body = pleskSpriteRig(sprite), scale = frame.size / 48;
    const anchors = pleskFishingAnchors(frame, body, false), { grip, basket } = anchors;
    const handle = fishingBasketHandle(basket, frame.size, anchors.basketScale);
    assert.equal(anchors.basketScale, .8, "shore, carrying and trading use one basket size");
    assert.equal(body.arms.length, 0); assert.ok(anchors.farArm.reachable && anchors.nearArm.reachable);
    assert.equal(ctx.translations.some(point => Math.hypot(point.x - grip.x, point.y - grip.y) < .01), false,
      "the carried basket suppresses rod painting instead of leaving a pole in the other paw");
    if (action !== "trade") {
      assert.ok(Math.hypot(anchors.farHand.x - handle.x, anchors.farHand.y - handle.y) < 1e-9,
        "the real paw carries the handle rather than floating fingers");
      assert.ok(ctx.palms.slice(-2).every(([left, top, width, height]) => Math.abs(left - handle.x) <= scale * 1.01
        && width === scale && top < handle.y && top + height > handle.y));
      assert.equal(ctx.events.at(-1), "palm", "fingers clasp the painted handle from the foreground");
    }
    assert.equal(fishingTackleFrame(frame, false, { grip, basket, hideRod: true }).visible, false);
  }
});


function recordedFish(frame, still = false) {
  const ctx = context(), fish = [], transforms = []; let matrix = [1, 0, 0, 1, 0, 0];
  const save = ctx.save, restore = ctx.restore;
  ctx.save = function () { transforms.push([...matrix]); save.call(this); };
  ctx.restore = function () { matrix = transforms.pop(); restore.call(this); };
  ctx.translate = (x, y) => { matrix[4] += matrix[0] * x + matrix[2] * y; matrix[5] += matrix[1] * x + matrix[3] * y; };
  ctx.scale = (x, y) => { matrix[0] *= x; matrix[1] *= x; matrix[2] *= y; matrix[3] *= y; };
  ctx.rotate = angle => {
    const [a, b, c, d] = matrix, cos = Math.cos(angle), sin = Math.sin(angle);
    matrix[0] = a * cos + c * sin; matrix[1] = b * cos + d * sin;
    matrix[2] = c * cos - a * sin; matrix[3] = d * cos - b * sin;
  };
  ctx.ellipse = (x, y, rx, ry) => {
    if (x === 0 && y === 0 && rx === .5 && ry === .24) {
      fish.push({ x: matrix[4], y: matrix[5], size: Math.hypot(matrix[0], matrix[1]), angle: Math.atan2(matrix[1], matrix[0]) });
    }
  };
  drawPleskResident(ctx, frame, still);
  return { fish, rig: pleskSpriteRig(ctx.draws[0].args[0]) };
}

test("the actual Pleska painter moves smoothly into the exact basket center at every size and facing", () => {
  const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  for (const direction of ["front", "right", "back", "left"]) for (const size of [36, 50, 120]) {
    const base = { x: 200, y: 220, size, direction, frame: 0, carryingFish: true, basketFilled: false,
      species: "fish", catchScale: 1, outcome: "small", waterTarget: { x: direction === "left" ? 145 : 255, y: 185 } };
    const caught = recordedFish({ ...base, action: "catch", phase: 1 }).fish[0];
    const packedStart = recordedFish({ ...base, action: "pack", phase: 0 }).fish[0];
    assert.ok(gap(caught, packedStart) < 1e-10, "catch1 → pack0 has no position jump");
    assert.ok(Math.abs(caught.angle - packedStart.angle) < 1e-10);
    assert.ok(Math.abs(caught.size - packedStart.size) < 1e-10);
    let beforeRelease;
    for (const phase of [0, .123, .314, .4, .4001, .6123, FISHING_PACK_RELEASE - 1e-8, FISHING_PACK_RELEASE, .73, 1]) {
      const frame = { ...base, action: "pack", phase, basketFilled: phase >= FISHING_PACK_RELEASE };
      const painted = recordedFish(frame), anchors = pleskFishingAnchors(frame, painted.rig, false);
      assert.equal(painted.fish.length, 1, "the deposited fish replaces the held fish exactly once");
      const endpoint = fishingBasketFishCenter(anchors.basket, size, anchors.basketScale);
      const part = Math.min(1, phase / FISHING_PACK_RELEASE), eased = part * part * (3 - 2 * part);
      const expected = { x: packedStart.x + (endpoint.x - packedStart.x) * eased,
        y: packedStart.y + (endpoint.y - packedStart.y) * eased - Math.sin(eased * Math.PI) * size * .04 };
      assert.ok(gap(painted.fish[0], expected) < 1e-10, `${direction}/H${size}/phase${phase} uses continuous raw phase`);
      assert.ok(gap(painted.fish[0], fishingCatchFrame(frame, false, anchors).center) < 1e-10,
        "painted fish and supporting fingers share the same center");
      if (phase === FISHING_PACK_RELEASE - 1e-8) beforeRelease = painted.fish[0];
      if (phase === FISHING_PACK_RELEASE) {
        assert.ok(gap(painted.fish[0], beforeRelease) < 1e-9, "held → stored fish shares its exact position even when mirrored");
        assert.ok(Math.abs(painted.fish[0].size - beforeRelease.size) < 1e-9);
        assert.ok(Math.abs(painted.fish[0].angle - beforeRelease.angle) < 1e-9);
      }
    }
    const stillFirst = recordedFish({ ...base, action: "pack", phase: .12 }, true).fish[0];
    const stillLater = recordedFish({ ...base, action: "pack", phase: .93, frame: 7 }, true).fish[0];
    assert.deepEqual(stillFirst, stillLater, "reduced motion freezes the same continuous pose");
  }
});

test("the live map gives Pleska real daytime and nighttime visitors with exact palm contacts", async () => {
  const {TILED_WORLD:world}=await vite.ssrLoadModule('/features/world/presentation.ts');
  const {createForestFauna,advanceForestFauna,residentFaunaEncounter}=await vite.ssrLoadModule('/features/world/forest-fauna.ts');
  const {createPleskMind,advancePleskMind,pleskMindFrame}=await vite.ssrLoadModule('/features/world/plesk-mind.ts');
  const {pleskWildlifeHand}=await vite.ssrLoadModule('/features/world/plesk-painter.ts');
  for(const dusk of [0,1]){
    const fauna=createForestFauna(world),mind=createPleskMind(world),ids=fauna.entities.map(e=>e.id),contacts=new Set();
    for(let t=0;t<900;t+=.1){
      const active=residentFaunaEncounter(fauna,'plesk'),pause=!!active&&!['release','interrupt'].includes(active.phase);
      const feet={...mind.position};advancePleskMind(mind,world,.1,{dusk,rain:0,wildlife:pause});
      if(pause)assert.deepEqual(mind.position,feet);
      const r=pleskMindFrame(mind,world,false),hand=pleskWildlifeHand(r);
      advanceForestFauna(fauna,.1,{dusk,rain:0,visitors:[{...r,hand,
        available:(!r.carryingFish||r.action==='rest')&&['idle','rest','greet'].includes(r.action)}]});
      const visit=residentFaunaEncounter(fauna,'plesk');
      if(visit?.phase==='perch'){
        const e=fauna.entities.find(e=>e.id===visit.entityId);contacts.add(visit.token);
        assert.equal(e.species,dusk?'firefly':'butterfly');
        assert.ok(Math.hypot(e.x-hand.x,e.y-hand.y)<.7);
      }
    }
    assert.ok(contacts.size>0,`dusk=${dusk} must actually reach her paw`);
    assert.deepEqual(fauna.entities.map(e=>e.id),ids);
  }
});
