import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingTackleFrame, drawFishingProps, fishingRodAppearance, fishingCatchFrame, fishingBasketFishCenter, fishingReelHand, FISHING_PACK_RELEASE, FISHING_REEL_HANDOFF } = await vite.ssrLoadModule("/features/world/fishing-props.ts");
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
    for (const color of [appearance.shaft, appearance.highlight, appearance.handle, appearance.metal, appearance.wrap].filter(Boolean)) {
      assert.ok(painted.has(color), `${rodId} uses its own material colors`);
    }
    if (rodId !== "reed_rod") assert.ok(painted.has(appearance.reel));
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
    const catchFrame = { ...frame, action: "catch", carryingFish: true };
    const caught = forestFishingHeroRig(catchFrame, false);
    assert.ok((caught.grip.x - frame.x) * (caught.heldFish.x - frame.x) < 0);
    const fish = fishingCatchFrame(catchFrame, false, caught);
    assert.deepEqual(caught.farHand, fish.wrist);
    assert.ok(Math.hypot(caught.farHand.x - fish.center.x, caught.farHand.y - fish.center.y) >= fish.size * .219,
      "the paw supports the outline rather than covering the center of the fish");
  }
});

test("close front and back water targets cannot swing the pole inward across a resident's head", () => {
  for (const side of [-1, 1]) for (const action of ["cast", "fish", "bite", "reel"]) {
    const grip = { x: base.x + side * base.size * .25, y: base.y - base.size * .4 };
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

test("reeling winds beside the rod before handing off the unhooked fish", () => {
  for (const direction of ["front", "left", "right", "back"]) for (const rodId of ["reed_rod", "river_rod", "willow_rod"]) {
    const frame = { ...base, action: "reel", direction, rodId, phase: .4, outcome: "small", carryingFish: false };
    const hands = forestFishingHeroRig(frame, false), tackle = fishingTackleFrame(frame, false, hands);
    const crank = fishingReelHand(frame, false, hands);
    assert.deepEqual(hands.farHand, crank, "the free paw winds at the chosen rod's actual crank");
    assert.ok(Math.hypot(crank.x - tackle.reel.x, crank.y - tackle.reel.y) < frame.size * .15);
    const landing = fishingCatchFrame({ ...frame, phase: 1 }, false, forestFishingHeroRig({ ...frame, phase: 1 }, false));
    assert.ok(Math.abs(landing.center.x - frame.x) < frame.size * .1, "a hooked fish lands at the waist before being passed to the basket side");
    assert.ok(landing.center.y > frame.y - frame.size * .3, "the landing line stays below the face");
    const crankOffset = phase => {
      const settled = { ...frame, phase }, rig = forestFishingHeroRig(settled, false);
      const pole = fishingTackleFrame(settled, false, rig), point = fishingReelHand(settled, false, rig);
      const length = Math.hypot(pole.tip.x - pole.grip.x, pole.tip.y - pole.grip.y);
      const dx = (pole.tip.x - pole.grip.x) / length, dy = (pole.tip.y - pole.grip.y) / length;
      return [(point.x - pole.reel.x) * dx + (point.y - pole.reel.y) * dy,
        -(point.x - pole.reel.x) * dy + (point.y - pole.reel.y) * dx];
    };
    for (const phase of [FISHING_REEL_HANDOFF, .9, 1]) {
      crankOffset(phase).forEach((value, axis) => assert.ok(Math.abs(value - crankOffset(1)[axis]) < 1e-9,
        "the crank stops relative to the pole before the free paw leaves it"));
    }
    const caught = { ...frame, action: "catch", phase: .5, carryingFish: true }, rig = forestFishingHeroRig(caught, false);
    assert.equal(fishingCatchFrame(caught, false, rig).attached, false);
    assert.ok(Math.hypot(fishingTackleFrame(caught, false, rig).bobber.x - rig.farHand.x,
      fishingTackleFrame(caught, false, rig).bobber.y - rig.farHand.y) > frame.size * .2,
    "the released float retracts to the rod instead of following the fish into the paw");
  }
});

test("basket sides mask all species and the same mask settles before pack release", () => {
  const record = (frame, anchors) => {
    const clips = [], fishes = [], basketWalls = [], stack = [];
    let clipped = false, path = [];
    const ctx = new Proxy({}, { get: (_target, key) => (...args) => {
      if (key === "save") stack.push(clipped);
      if (key === "restore") clipped = stack.pop();
      if (key === "beginPath") path = [];
      if (key === "moveTo" || key === "lineTo") path.push(args);
      if (key === "clip") { clipped = true; clips.push(path); }
      if (key === "scale") fishes.push(clipped);
      if (key === "quadraticCurveTo" && args[3] > 0 && args[0] === 0) basketWalls.push(clipped);
    }, set: () => true });
    drawFishingProps(ctx, frame, false, anchors); return { clips, fishes, basketWalls };
  };
  for (const direction of ["front", "left", "right", "back"]) for (const species of ["fish", "fish_silverfin", "fish_reedperch", "fish_mooncarp"]) {
    const frame = { ...base, direction, species, action: "pack", carryingFish: true, phase: FISHING_PACK_RELEASE, basketFilled: true };
    const basket = { x: 0, y: 0 }, anchors = { basket, hideRod: true };
    const released = record(frame, anchors), entering = record({ ...frame, phase: FISHING_PACK_RELEASE - 1e-7, basketFilled: false }, anchors);
    assert.equal(released.fishes.length, 1); assert.deepEqual(released.fishes, [true]);
    assert.deepEqual(entering.fishes, [true], "only the single entering fish is masked");
    assert.ok(released.basketWalls.every(value => !value), "the basket wall itself is never clipped");
    const xs = released.clips[0].map(point => point[0]);
    assert.ok(Math.max(...xs) - Math.min(...xs) < base.size * .4, "no fish tail can paint outside either basket side");
    assert.equal(entering.clips[0].length, released.clips[0].length);
    entering.clips[0].forEach((point, index) => point.forEach((value, axis) =>
      assert.ok(Math.abs(value - released.clips[0][index][axis]) < 1e-8, "mask has no jump at release")));
  }
});


test("the last reel frame lands continuously in the supporting hand and the same rod stays held while packing", () => {
  for (const direction of ["front", "left", "right", "back"]) for (const catchScale of [.7, 1, 1.35, 1.5]) {
    const frame = { ...base, direction, catchScale, carryingFish: true, outcome: "small" };
    const end = { ...frame, action: "reel", phase: 1 }, start = { ...frame, action: "catch", phase: 0 };
    const reelHands = forestFishingHeroRig(end, false), catchHands = forestFishingHeroRig(start, false);
    const reel = fishingTackleFrame(end, false, reelHands), caught = fishingCatchFrame(start, false, catchHands);
    assert.deepEqual(reelHands.nearHand, catchHands.nearHand);
    assert.deepEqual(reelHands.farHand, catchHands.farHand);
    assert.ok(Math.abs(reel.bobber.x - caught.center.x) < 1e-9);
    assert.ok(Math.abs(reel.bobber.y + caught.size / 2 - caught.center.y) < 1e-9);
    assert.equal(caught.angle, -Math.PI / 2);
    assert.equal(caught.attached, true);
    const landed = { ...frame, action: "catch", phase: 1 }, packing = { ...frame, action: "pack", phase: 0 };
    const landedHands = forestFishingHeroRig(landed, false), packHands = forestFishingHeroRig(packing, false);
    assert.deepEqual(fishingCatchFrame(landed, false, landedHands).center, fishingCatchFrame(packing, false, packHands).center);
    assert.deepEqual(landedHands.grip, packHands.grip);
    for (const phase of [0, .3, FISHING_PACK_RELEASE - .0001, FISHING_PACK_RELEASE, 1]) {
      const pack = { ...packing, phase }, hands = forestFishingHeroRig(pack, false);
      const tackle = fishingTackleFrame(pack, false, hands), fish = fishingCatchFrame(pack, false, hands);
      assert.equal(tackle.visible, true, "packing cannot make the occupied rod disappear");
      assert.deepEqual(tackle.grip, hands.nearHand);
      if (phase >= FISHING_PACK_RELEASE) {
        assert.deepEqual(fish.center, fishingBasketFishCenter(hands.basket, frame.size));
        assert.equal(fish.visible, false);
        assert.ok(Math.abs(fish.angle - (direction === "left" ? -Math.PI + .2 : -.2)) < 1e-9);
        assert.ok(Math.abs(fish.size - frame.size * .22) < 1e-9);
      }
    }
  }
});

test("Mochlik carries the enlarged basket by the same physical handle in every facing", async () => {
  const {fishingBasketHandle}=await vite.ssrLoadModule('/features/world/fishing-props.ts');
  for(const direction of ['left','right','front','back'])for(const size of [36,56,120]){
    const frame={...base,size,direction,action:'walk',carryingFish:true,waterTarget:undefined};
    const rig=forestFishingHeroRig(frame,false);
    assert.deepEqual(rig.farHand,fishingBasketHandle(rig.basket,size));
  }
});
