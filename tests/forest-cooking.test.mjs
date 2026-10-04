import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { forestCookingFrame, forestCookingBounds, FOREST_COOKING_ACTION_SECONDS, FOREST_COOKING_CYCLE_SECONDS } =
  await vite.ssrLoadModule("/features/world/forest-cooking.ts");
const { forestCookingHeroRig, drawForestCookingHero } = await vite.ssrLoadModule("/features/world/forest-cooking-painter.ts");
const actions = ["prepare", "stir", "taste", "serve"], directions = ["front", "left", "right", "back"];
const frame = (action, phase = .5, direction = "front") => ({ x: 200, y: 200, size: 36, action, phase, direction, frame: 0, steam: .5 });

test("the cooking rehearsal has four complete stages and independently replayable gestures", () => {
  let elapsed = 0;
  for (const action of actions) {
    assert.equal(forestCookingFrame(elapsed).action, action);
    assert.equal(forestCookingFrame(elapsed).phase, 0);
    const seconds = FOREST_COOKING_ACTION_SECONDS[action];
    assert.equal(forestCookingFrame(elapsed + seconds - .001).action, action);
    for (const time of [0, seconds * .5, seconds * .99]) {
      const actual = forestCookingFrame(time, false, action);
      assert.equal(actual.action, action);
      assert.ok(actual.phase >= 0 && actual.phase < 1);
      assert.ok(Number.isInteger(actual.frame) && actual.frame >= 0 && actual.frame < 4);
      const repeated = forestCookingFrame(time + seconds, false, action);
      assert.equal(repeated.action, actual.action); assert.equal(repeated.frame, actual.frame);
      assert.ok(Math.abs(repeated.phase - actual.phase) < 1e-10);
      assert.ok(Math.abs(repeated.steam - actual.steam) < 1e-10);
      assert.deepEqual(Object.keys(actual).sort(), ["action", "frame", "phase", "steam"], "frames cannot carry economic results");
    }
    elapsed += seconds;
  }
  assert.equal(elapsed, FOREST_COOKING_CYCLE_SECONDS);
  assert.deepEqual(forestCookingFrame(elapsed), forestCookingFrame(0));
});

test("reduced motion is stable for the selected stage and invalid clocks cannot corrupt the rig", () => {
  for (const action of [...actions, undefined]) {
    assert.deepEqual(forestCookingFrame(0, true, action), forestCookingFrame(1e12, true, action));
    assert.equal(forestCookingFrame(1, true, action).action, action ?? "stir");
  }
  for (const invalid of [NaN, Infinity, -Infinity, -100]) assert.deepEqual(forestCookingFrame(invalid), forestCookingFrame(0));
  const paused = forestCookingFrame(13);
  for (let index = 0; index < 8; index++) assert.deepEqual(forestCookingFrame(13), paused);
});

test("every cooking gesture uses short bent paws and continuous resting wrists at stage boundaries", () => {
  for (const direction of directions) {
    const rest = forestCookingHeroRig(frame("prepare", 0, direction));
    for (const action of actions) {
      for (const phase of [0, 1]) {
        const boundary = forestCookingHeroRig(frame(action, phase, direction));
        assert.deepEqual(boundary.near.hand, rest.near.hand);
        assert.deepEqual(boundary.far.hand, rest.far.hand);
      }
      for (let index = 0; index <= 100; index++) {
        const current = frame(action, index / 100, direction), rig = forestCookingHeroRig(current);
        for (const arm of [rig.near, rig.far]) {
          const reach = Math.hypot(arm.shoulder.x - arm.hand.x, arm.shoulder.y - arm.hand.y);
          const segments = Math.hypot(arm.shoulder.x - arm.elbow.x, arm.shoulder.y - arm.elbow.y)
            + Math.hypot(arm.elbow.x - arm.hand.x, arm.elbow.y - arm.hand.y);
          assert.ok(reach <= current.size * .19, "no gesture reaches farther than a small paw");
          assert.ok(segments <= current.size * .26, "an elbow cannot create a long hidden arm");
        }
        const bounds = forestCookingBounds(current);
        for (const point of [rig.pot, rig.board, rig.bowl, rig.toolTip, rig.near.hand, rig.far.hand]) {
          assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
          assert.ok(point.x >= bounds.x && point.x <= bounds.x + bounds.width);
          assert.ok(point.y >= bounds.y && point.y <= bounds.y + bounds.height);
        }
      }
    }
  }
});

test("a served bowl is supported by both paws, while knife and spoon stay within the nearby workspace", () => {
  for (const direction of directions) {
    const serving = forestCookingHeroRig(frame("serve", .5, direction));
    assert.ok(Math.abs(serving.near.hand.y - serving.bowl.y) < 1);
    assert.ok(Math.abs(serving.far.hand.y - serving.bowl.y) < 1);
    assert.ok((serving.near.hand.x - serving.bowl.x) * (serving.far.hand.x - serving.bowl.x) < 0);
    const stirring = forestCookingHeroRig(frame("stir", .5, direction));
    assert.ok(Math.hypot(stirring.toolTip.x - stirring.pot.x, stirring.toolTip.y - stirring.pot.y) <= 36 * .09);
    const cutting = forestCookingHeroRig(frame("prepare", .5, direction));
    assert.ok(Math.abs(cutting.toolTip.x - cutting.board.x) <= 36 * .13);
    assert.ok(Math.abs(cutting.toolTip.y - cutting.board.y) <= 36 * .08);
  }
});

test("the painter restores its caller and respects actual feet, wearables and finite prop geometry", () => {
  const previousDocument = globalThis.document, calls = [];
  const context = () => {
    const state = { globalAlpha: .7, imageSmoothingEnabled: true }, saved = [];
    return new Proxy(state, { get(target, key) {
      if (key in target) return target[key];
      if (key === "save") return () => saved.push({ ...target });
      if (key === "restore") return () => Object.assign(target, saved.pop());
      return (...args) => { calls.push({ key, args }); for (const number of args.filter(value => typeof value === "number")) assert.ok(Number.isFinite(number)); };
    } });
  };
  globalThis.document = { createElement: () => ({ width: 48, height: 48, getContext: context }) };
  try {
    for (const direction of directions) for (const action of actions) {
      const ctx = context(), current = frame(action, .5, direction);
      const before = JSON.stringify(current);
      drawForestCookingHero(ctx, current, { palette: "fern", head: "rain_hat", neck: "berry_scarf" }, false);
      assert.equal(JSON.stringify(current), before, "paint never owns the rehearsal clock");
      assert.equal(ctx.globalAlpha, .7); assert.equal(ctx.imageSmoothingEnabled, true);
    }
    assert.equal(calls.filter(call => call.key === "drawImage").length, 16, "the real cached Mochlik body is painted once per scene");
    const painted = calls.length;
    drawForestCookingHero(context(), { ...frame("stir"), size: NaN }, undefined, false);
    assert.equal(calls.length, painted);
  } finally { globalThis.document = previousDocument; }
});
