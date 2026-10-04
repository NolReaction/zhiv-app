import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingTackleFrame, drawFishingProps, fishingRodAppearance, FISHING_PACK_RELEASE } = await vite.ssrLoadModule("/features/world/fishing-props.ts");
const { forestFishingHeroRig } = await vite.ssrLoadModule("/features/world/forest-fishing-painter.ts");
const base = { x: 200, y: 200, size: 50, direction: "front", action: "fish", phase: .5, frame: 0,
  waterTarget: { x: 204, y: 247 }, carryingFish: false };

test("rod profiles are immutable paint-only variants with safe defaults and no cross-frame color leakage", () => {
  const ids = ["reed_rod", "river_rod", "willow_rod"];
  assert.strictEqual(fishingRodAppearance(), fishingRodAppearance("reed_rod"));
  for (const unknown of ["unknown", "__proto__", "constructor"]) {
    assert.strictEqual(fishingRodAppearance(unknown), fishingRodAppearance("reed_rod"));
  }
  const profiles = ids.map(fishingRodAppearance);
  assert.equal(new Set(profiles.map(item => item.shaft)).size, 3);
  assert.equal(profiles[0].wrap, null); assert.ok(profiles[1].wrap); assert.ok(profiles[2].wrap);
  for (const appearance of profiles) assert.equal(Object.isFrozen(appearance), true);
  for (const action of ["walk", "cast", "fish", "bite", "reel", "catch"]) {
    for (const direction of ["front", "left", "right", "back"]) for (const phase of [0, .3, .7, 1]) {
      const frame = { ...base, action, direction, phase }, reference = fishingTackleFrame(frame, false);
      for (const rodId of ids) assert.deepEqual(fishingTackleFrame({ ...frame, rodId }, false), reference,
        "changing tackle colors cannot alter the newly corrected hand/rod geometry");
    }
  }
  for (const rodId of [...ids, ...ids.toReversed()]) {
    const painted = new Set(), ctx = new Proxy({}, { get: () => () => {},
      set: (_target, key, value) => { if (key === "fillStyle" || key === "strokeStyle") painted.add(value); return true; } });
    drawFishingProps(ctx, { ...base, rodId }, false, { drawBasket: false });
    const appearance = fishingRodAppearance(rodId);
    for (const color of Object.values(appearance).filter(Boolean)) assert.ok(painted.has(color));
    for (const other of ids.filter(id => id !== rodId)) {
      const otherWrap = fishingRodAppearance(other).wrap;
      if (otherWrap) assert.equal(painted.has(otherWrap), false);
    }
  }
});

test("the rod stays attached to its hand with a real length through every downward casting frame", () => {
  for (const direction of ["front", "left", "right", "back"]) {
    for (let index = 0; index <= 100; index++) {
      const frame = { ...base, direction, action: "cast", phase: index / 100 };
      const hand = forestFishingHeroRig(frame, false), tackle = fishingTackleFrame(frame, false, hand);
      assert.deepEqual(tackle.grip, hand.nearHand);
      const length = Math.hypot(tackle.tip.x - tackle.grip.x, tackle.tip.y - tackle.grip.y);
      assert.ok(length >= frame.size * .679 && length <= frame.size * 1.001, "casting cannot shrink the rod into the palm");
      for (const point of [tackle.tip, tackle.reel, tackle.bobber]) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  }
});

test("carried rods stay outside the face and caught fish use the opposite free paw", () => {
  for (const direction of ["front", "left", "right", "back"]) {
    const frame = { ...base, direction, action: "idle", waterTarget: undefined };
    const hand = forestFishingHeroRig(frame, false), tackle = fishingTackleFrame(frame, false, hand);
    for (let sample = 0; sample <= 30; sample++) {
      const t = sample / 30, x = tackle.grip.x + (tackle.tip.x - tackle.grip.x) * t;
      const y = tackle.grip.y + (tackle.tip.y - tackle.grip.y) * t;
      const inFace = ((x - frame.x) / (frame.size * .3)) ** 2 + ((y - frame.y + frame.size * .56) / (frame.size * .25)) ** 2 < 1;
      assert.equal(inFace, false, "the idle pole cannot pass through eyes or muzzle");
    }
    const caught = forestFishingHeroRig({ ...frame, action: "catch", carryingFish: true }, false);
    assert.ok((caught.grip.x - frame.x) * (caught.heldFish.x - frame.x) < 0);
    assert.deepEqual(caught.farHand, caught.heldFish);
  }
});

test("close front and back water targets cannot swing the pole inward across a resident's head", () => {
  for (const side of [-1, 1]) for (const action of ["cast", "fish", "bite", "reel"]) {
    const grip = { x: base.x + side * base.size * .25, y: base.y - base.size * .27 };
    for (let index = 0; index <= 40; index++) {
      const tackle = fishingTackleFrame({ ...base, action, direction: side < 0 ? "back" : "front",
        phase: index / 40, waterTarget: { x: base.x, y: base.y + 10 } }, false, { grip });
      assert.ok((tackle.tip.x - grip.x) * side > 0, "the entire pole stays on the outside of its gripping paw");
      assert.deepEqual(tackle.grip, grip);
    }
  }
});

test("missed and large bites have different tension and never display a phantom catch", () => {
  const small = fishingTackleFrame({ ...base, action: "reel", phase: .45, outcome: "small" }, false);
  const large = fishingTackleFrame({ ...base, action: "reel", phase: .45, outcome: "large", variation: "struggle" }, false);
  const missed = fishingTackleFrame({ ...base, action: "reel", phase: .45, outcome: "miss", variation: "escape" }, false);
  assert.equal(small.hookedFish, true); assert.equal(large.hookedFish, true); assert.equal(missed.hookedFish, false);
  assert.ok(large.tension > small.tension); assert.ok(missed.tension < small.tension); assert.ok(missed.splash > 0);
  assert.notDeepEqual(large.bobber, small.bobber);
});

test("packing transfers one fish from hand to basket at the exact release point", () => {
  function fishBodies(frame) {
    const ellipses = [];
    const context = new Proxy({}, { get: (_target, key) => (...args) => { if (key === "ellipse") ellipses.push(args); }, set: () => true });
    drawFishingProps(context, frame, false);
    return ellipses.filter(args => args[0] === 0 && args[1] === 0 && Math.abs(args[3] / args[2] - .48) < 1e-8);
  }
  const packing = { ...base, action: "pack", carryingFish: true, outcome: "small", catchScale: 1 };
  assert.equal(fishBodies({ ...packing, phase: FISHING_PACK_RELEASE - .001, basketFilled: false }).length, 1);
  assert.equal(fishBodies({ ...packing, phase: FISHING_PACK_RELEASE, basketFilled: true }).length, 1);
  assert.equal(fishBodies({ ...packing, phase: .9, basketFilled: true }).length, 1);
  assert.equal(fishBodies({ ...packing, action: "catch", outcome: "miss", basketFilled: false }).length, 0);
});
