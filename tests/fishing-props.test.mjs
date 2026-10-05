import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { fishingTackleFrame, fishingLineFrame, fishingPropsBounds, projectFishingRod, drawFishingProps, fishingRodAppearance, fishingCatchFrame, fishingBasketFishCenter, fishingReelHand, FISHING_PACK_RELEASE, FISHING_REEL_HANDOFF } = await vite.ssrLoadModule("/features/world/fishing-props.ts");
const { forestFishingHeroRig } = await vite.ssrLoadModule("/features/world/forest-fishing-painter.ts");
const { fishingShoreRig } = await vite.ssrLoadModule("/features/world/fishing-shore-rig.ts");
const { fishingWaterTarget, fishingDirection } = await vite.ssrLoadModule("/features/world/forest-fishing.ts");
const { default: actualWorld } = await vite.ssrLoadModule("/features/world/tiled/forest.generated.json");
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
      assert.ok(length >= frame.size * .5 && length <= frame.size * 1.5, "a projected elevated pole remains a substantial visible rod");
      assert.deepEqual(tackle.tip, projectFishingRod(frame, hand.grip, hand.rodElevation, hand.rodLength),
        "projection follows the water direction in the ground plane and a separate physical pole height");
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
        assert.deepEqual(fish.center, fishingBasketFishCenter(hands.basket, frame.size, hands.basketScale));
        assert.equal(fish.visible, false);
        assert.ok(Math.abs(fish.angle - (direction === "left" ? -Math.PI + .2 : -.2)) < 1e-9);
        assert.ok(Math.abs(fish.size - frame.size * .22 * hands.basketScale) < 1e-9);
      }
    }
  }
});

test("Mochlik carries his compact basket by the same physical handle in every facing", async () => {
  const {fishingBasketHandle}=await vite.ssrLoadModule('/features/world/fishing-props.ts');
  for(const direction of ['left','right','front','back'])for(const size of [36,56,120]){
    const frame={...base,size,direction,action:'walk',carryingFish:true,waterTarget:undefined};
    const rig=forestFishingHeroRig(frame,false);
    assert.deepEqual(rig.farHand,fishingBasketHandle(rig.basket,size,rig.basketScale));
  }
});

test("Mochlik's shore rod stays elevated through the backswing, strike and winding even with water below his feet", () => {
  for (const direction of ["front", "left", "right", "back"]) for (const action of ["idle", "cast", "fish", "bite", "reel", "catch", "pack", "rest"]) {
    for (let phase = 0; phase <= 1; phase += .025) {
      const frame = { ...base, direction, action, phase, waterTarget: { x: base.x, y: base.y + 60 } };
      const hands = forestFishingHeroRig(frame, false), rod = fishingTackleFrame(frame, false, hands);
      assert.deepEqual(rod.grip, hands.nearHand, "the winding/holding paw is never below an unattached handle");
      assert.ok(rod.tip.y < rod.grip.y - frame.size * .4, "close water cannot turn the pole into a downward stick");
      assert.equal(hands.bodyDirection, direction, "water below the feet does not force a sideways face");
      const line = fishingLineFrame(frame, false, hands, rod);
      assert.ok(line.width <= frame.size * .006, "the line remains lighter than the rod at every zoom");
      assert.ok(line.control.y - (rod.tip.y + rod.bobber.y) / 2 <= frame.size * .055 + 1e-9,
        "the waiting line cannot sag down like a rope");
    }
  }
});

test("Mochlik keeps his hands, rod and float continuous across every fishing gesture boundary", () => {
  const stages = ["rest", "idle", "cast", "fish", "bite", "reel", "catch", "pack", "rest"];
  for (const direction of ["front", "left", "right", "back"]) for (const rodId of ["reed_rod", "river_rod", "willow_rod"]) {
    for (let index = 1; index < stages.length; index++) {
      const before = { ...base, direction, rodId, action: stages[index - 1], phase: 1, carryingFish: true };
      const after = { ...before, action: stages[index], phase: 0 };
      const first = forestFishingHeroRig(before, false), next = forestFishingHeroRig(after, false);
      for (const key of ["nearHand", "farHand", "basket"]) {
        assert.ok(Math.hypot(first[key].x - next[key].x, first[key].y - next[key].y) < 1e-8,
          `${before.action} → ${after.action}: ${key} must not jump`);
      }
      const a = fishingTackleFrame(before, false, first), b = fishingTackleFrame(after, false, next);
      for (const key of ["tip", "bobber", "reel"]) {
        assert.ok(Math.hypot(a[key].x - b[key].x, a[key].y - b[key].y) < 1e-8,
          `${before.action} → ${after.action}: ${key} must not jump`);
      }
      const floatA = fishingLineFrame(before, false, first, a).float, floatB = fishingLineFrame(after, false, next, b).float;
      assert.ok(Math.hypot(floatA.x - floatB.x, floatA.y - floatB.y) < 1e-8,
        `${before.action} → ${after.action}: the float remains on its line`);
    }
  }
});

test("the winding float lies on the exact curve painted for the thin shore line", () => {
  for (const action of ["reel", "catch"]) for (let phase = 0; phase < 1; phase += .025) {
    const frame = { ...base, action, phase }, hands = forestFishingHeroRig(frame, false);
    let recordingLine = false, fillStyle, start, control, end, float;
    const ctx = new Proxy({}, { get: (_target, key) => (...args) => {
      if (recordingLine) {
        if (key === "moveTo") start = args;
        if (key === "quadraticCurveTo") { control = args.slice(0, 2); end = args.slice(2); }
        if (key === "stroke") recordingLine = false;
      }
      if (key === "ellipse" && fillStyle === "#f7e6b9") float = args.slice(0, 2);
    }, set: (_target, key, value) => { if (key === "strokeStyle") recordingLine = value === "#cbd9cba8";
      if (key === "fillStyle") fillStyle = value; return true; } });
    drawFishingProps(ctx, frame, false, { ...hands, drawBasket: false });
    assert.ok(start && control && end && float, "the real painter must draw a line and its float");
    let closest = Infinity;
    for (let index = 0; index <= 1000; index++) {
      const t = index / 1000;
      const s = 1 - t;
      closest = Math.min(closest, Math.hypot(float[0] - (s * s * start[0] + 2 * s * t * control[0] + t * t * end[0]),
        float[1] - (s * s * start[1] + 2 * s * t * control[1] + t * t * end[1])));
    }
    assert.ok(closest < frame.size * .002, "the visible float cannot drift away from the painted fishing line");
  }
});

test("shore culling and occlusion bounds include the raised pole, airborne float and compact ground basket", () => {
  for (const direction of ["front", "back", "left", "right"]) for (const still of [false, true]) {
    for (const action of ["idle", "cast", "fish", "bite", "reel", "catch", "pack", "rest"]) {
      for (let phase = 0; phase <= 1; phase += .05) {
        const frame = { ...base, direction, action, phase, carryingFish: true };
        const hands = forestFishingHeroRig(frame, still), rod = fishingTackleFrame(frame, still, hands);
        const line = fishingLineFrame(frame, still, hands, rod), bounds = fishingPropsBounds(frame);
        const points = [rod.tip, rod.reel, rod.bobber, line.float, line.control, hands.nearHand, hands.farHand,
          { x: hands.basket.x - frame.size * .4 * hands.basketScale, y: hands.basket.y - frame.size * .4 * hands.basketScale },
          { x: hands.basket.x + frame.size * .4 * hands.basketScale, y: hands.basket.y + frame.size * .2 * hands.basketScale }];
        for (const point of points) assert.ok(point.x >= bounds.x + frame.size * .04 && point.x <= bounds.x + bounds.width - frame.size * .04
          && point.y >= bounds.y + frame.size * .04 && point.y <= bounds.y + bounds.height - frame.size * .04,
        `${direction}/${action}/${phase}/${still}: prop must remain within the camera/occluder bounds with paint padding`);
      }
    }
  }
});

test("a new cast's small water offset cannot swap Mochlik's occupied hands at rest → preparation", () => {
  const resting = { ...base, action: "rest", phase: 1, carryingFish: true, waterTarget: { x: base.x - 7, y: base.y + 60 } };
  const preparing = { ...resting, action: "idle", phase: 0, waterTarget: { x: base.x + 7, y: base.y + 60 } };
  const before = forestFishingHeroRig(resting, false), after = forestFishingHeroRig(preparing, false);
  for (const key of ["nearHand", "farHand", "basket"]) assert.deepEqual(before[key], after[key]);
  assert.deepEqual(fishingTackleFrame(resting, false, before).bobber, fishingTackleFrame(preparing, false, after).bobber);
});

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function shoreFrame(style, size) {
  const position = actualWorld.destinations.find(item => item.id === (style === "plesk" ? "plesk-fishing" : "fishing")).position;
  const waterTarget = fishingWaterTarget(actualWorld, position, size);
  assert.ok(waterTarget, "the actual map contains a safe fishing point");
  return { ...base, ...position, size, waterTarget, direction: fishingDirection(position, waterTarget), rodId: "willow_rod" };
}

test("actual shores aim an elevated pole in the water's ground direction and keep both short arms in reach", () => {
  for (const style of ["mochlik", "plesk"]) for (const size of style === "plesk" ? [36] : [36, 50, 120]) {
    for (const action of ["idle", "cast", "fish", "bite", "reel", "catch", "pack", "rest"]) {
      for (const phase of [0, .2, .34, .5, .78, 1]) {
        const frame = { ...shoreFrame(style, size), action, phase, carryingFish: true };
        const rig = fishingShoreRig(frame, false, style), tackle = fishingTackleFrame(frame, false, rig);
        assert.equal(rig.bodyDirection, frame.direction, "front water cannot force a right-facing body");
        for (const arm of [rig.nearArm, rig.farArm]) {
          assert.ok(arm.reachable, `${style}/${size}/${action}/${phase}: a contact target cannot outrun the short paw`);
          assert.ok(Math.abs(distance(arm.shoulder, arm.elbow) - size * .21) < 1e-6);
          assert.ok(Math.abs(distance(arm.elbow, arm.hand) - size * .23) < 1e-6);
          assert.ok(distance(arm.shoulder, arm.hand) <= size * .44);
        }
        if (["fish", "bite", "reel"].includes(action)) {
          const planar = { x: tackle.tip.x - tackle.grip.x,
            y: tackle.tip.y - tackle.grip.y + size * rig.rodLength * Math.sin(rig.rodElevation) * 1.15 };
          const aim = { x: frame.waterTarget.x - tackle.grip.x, y: frame.waterTarget.y - frame.y };
          assert.ok(Math.abs(planar.x * aim.y - planar.y * aim.x) < 1e-6, "removing height recovers the authored ground aim");
          assert.ok(planar.x * aim.x + planar.y * aim.y > 0);
        }
        if (["cast", "fish", "bite"].includes(action)) assert.ok(distance(rig.farHand, fishingReelHand(frame, true, rig)) < 1e-6);
        if (action === "catch" || action === "pack" && phase < FISHING_PACK_RELEASE) {
          assert.ok(distance(rig.farHand, fishingCatchFrame(frame, false, rig).wrist) < 1e-6, "the supporting paw touches the actual fish outline");
        }
      }
    }
    const waiting = shoreFrame(style, size);
    assert.deepEqual(fishingShoreRig({ ...waiting, phase: .5 }, false, style).farShoulder,
      fishingShoreRig({ ...waiting, phase: .99 }, false, style).farShoulder,
      "the end of a wait never invokes the reel handoff or moves its shoulder across the torso");
  }
});

test("actual-map casts release from one fixed origin, then follow a continuous ballistic flight into the water", () => {
  for (const style of ["mochlik", "plesk"]) {
    const frame = { ...shoreFrame(style, style === "plesk" ? 36 : 50), action: "cast" };
    const samples = phase => {
      const posed = { ...frame, phase }, rig = fishingShoreRig(posed, false, style);
      return { rig, tackle: fishingTackleFrame(posed, false, rig) };
    };
    const release = samples(.34);
    assert.ok(distance(samples(.34 - 1e-6).tackle.bobber, release.tackle.bobber) < .001);
    assert.ok(distance(samples(.34 + 1e-6).tackle.bobber, release.tackle.bobber) < .001);
    for (const phase of [.4, .5, .78, 1]) {
      const { rig, tackle } = samples(phase), t = (phase - .34) / .66;
      assert.deepEqual(rig.castOrigin, release.rig.castOrigin, "the released lure is no longer dragged by the moving rod tip");
      assert.ok(Math.abs(tackle.bobber.x - (rig.castOrigin.x + (frame.waterTarget.x - rig.castOrigin.x) * t)) < 1e-6);
      assert.ok(Math.abs(tackle.bobber.y - (rig.castOrigin.y + (frame.waterTarget.y - rig.castOrigin.y) * t - t * (1 - t) * frame.size * 2.2)) < 1e-6);
    }
    assert.deepEqual(samples(1).tackle.bobber, frame.waterTarget);
  }
});

test("departure folds the exact visible cast or waiting line, then meets the basket-carrying travel pose", () => {
  for (const action of ["idle", "cast", "fish", "bite", "rest"]) for (const phase of [0, .2, .78, 1]) {
    const from = { ...shoreFrame("mochlik", 50), action, phase, carryingFish: false };
    const source = fishingShoreRig(from, false), tackle = fishingTackleFrame(from, false, source);
    const sourceLine = fishingLineFrame(from, false, source, tackle);
    const settling = { ...from, action: "rest", phase: 1, waterTarget: undefined, carryingBasket: true,
      settling: { from, phase: 0 } };
    const start = fishingShoreRig(settling, false), startTackle = fishingTackleFrame(settling, false, start);
    for (const key of ["nearHand", "farHand", "rodTip", "basket"]) assert.deepEqual(start[key], source[key]);
    assert.deepEqual(fishingLineFrame(settling, false, start, startTackle).float, sourceLine.float);
    const end = fishingShoreRig({ ...settling, settling: { from, phase: 1 } }, false);
    const walking = fishingShoreRig({ ...settling, action: "walk", frame: 0, settling: undefined }, false);
    for (const key of ["nearHand", "farHand", "rodTip", "basket"]) assert.deepEqual(end[key], walking[key]);
  }
});
