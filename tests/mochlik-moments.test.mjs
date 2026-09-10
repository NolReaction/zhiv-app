import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { createHabitat, decorationLevel, rainAt, depositedPosition, HOME, BUSH, SHELTER } = await vite.ssrLoadModule("/features/mochlik/habitat.ts");
const { pixelFrame } = await vite.ssrLoadModule("/features/mochlik/pixel-frame.ts");
after(() => vite.close());
const fresh = (kind = "butterfly") => { const world = createHabitat(); world.setInsects(kind); return world; };
function seek(world, condition, active = true, seconds = 900) {
  for (let i = 0; i < seconds * 40 && !condition(world.state); i++) {
    if (active && i % 80 === 0) world.notice();
    world.update(.025);
  }
  assert.ok(condition(world.state), `not reached: ${world.state.moment}/${world.state.activity}`);
}

test("a living session includes all moments and emotions, with both finds and continuous motion", () => {
  for (const kind of ["butterfly", "firefly"]) {
    const world = fresh(kind), moments = new Set(), activities = new Set(), found = new Set();
    let previous = { ...world.state.position }, previousProp = null;
    for (let i = 0; i < 900 * 40; i++) {
      if (i % 80 === 0) world.notice();
      world.update(.025); const s = world.state;
      moments.add(s.moment); activities.add(s.activity);
      if (s.activity === "show") found.add(s.prop);
      assert.ok(Math.hypot(s.position.x - previous.x, s.position.y - previous.y) < .012);
      assert.ok(s.position.x >= .14 && s.position.x <= .75 && s.position.y >= Math.min(HOME.y, BUSH.y, SHELTER.y) - 1e-9 && s.position.y <= .82);
      if (s.prop) {
        assert.ok(s.propPosition.x > .15 && s.propPosition.x < .8 && s.propPosition.y > .25 && s.propPosition.y < .85);
        if (previousProp && s.prop === previousProp.kind && s.activity !== "leaf-drift") {
          assert.ok(Math.hypot(s.propPosition.x - previousProp.x, s.propPosition.y - previousProp.y) < .04,
            `prop jumped during ${s.activity}`);
        }
        previousProp = { ...s.propPosition, kind: s.prop };
      } else previousProp = null;
      previous = { ...s.position };
      assert.equal(s.resting, false);
    }
    for (const moment of ["insects", "leaf", "find", "rain", "emotion"]) assert.ok(moments.has(moment), moment);
    if (kind === "firefly") assert.ok(moments.has("wonder")); else assert.equal(moments.has("wonder"), false);
    for (const activity of ["pickup", "toss", "catch", "carry", "place", "shelter", "shelter-peek", "show", "scratch", "yawn", "shake"]) assert.ok(activities.has(activity), activity);
    if (kind === "butterfly") assert.ok(activities.has("sneeze"));
    assert.deepEqual([...found].sort(), ["cone", "stone"]); assert.equal(world.state.leafDelivered, true);
    seek(world, s => s.activity === "sleep", false, 100); assert.equal(world.state.prop, null);
  }
});

test("leaf choreography catches two throws and delivers before inactivity sleep", () => {
  const world = fresh(); seek(world, s => s.moment === "leaf" && s.activity === "pickup");
  const activities = []; let previous = "";
  world.elapse(61);
  for (let i = 0; i < 100 * 40 && world.state.activity !== "sleep"; i++) {
    const a = world.state.activity; if (a !== previous) { activities.push(a); previous = a; }
    world.update(.025);
  }
  assert.deepEqual(activities.slice(0, 7), ["pickup", "toss", "catch", "toss", "catch", "carry", "place"]);
  assert.equal(world.state.leafDelivered, true); assert.equal(world.state.activity, "sleep");
  assert.equal(world.state.prop, null); assert.deepEqual(world.state.position, HOME);
});

test("rapid taps cannot restart pickup, throws, catching, presenting, sneezing or shaking", () => {
  const world = fresh(), required = new Set(["pickup", "toss", "catch", "show", "place", "sneeze", "shake"]);
  for (let i = 0; i < 500 * 40 && required.size; i++) {
    if (i % 80 === 0) world.notice(); world.update(.025);
    if (required.has(world.state.activity) && world.state.progress > .15 && world.state.progress < .7) {
      const before = structuredClone(world.state);
      for (let tap = 0; tap < 100; tap++) world.notice();
      assert.equal(world.state.activityTime, before.activityTime);
      assert.deepEqual(world.state.position, before.position); assert.deepEqual(world.state.propPosition, before.propPosition);
      assert.equal(world.state.discoveries, before.discoveries);
      world.update(.025); assert.ok(world.state.activityTime > before.activityTime);
      required.delete(before.activity);
    }
  }
  assert.equal(required.size, 0, [...required].join(", "));
});

test("long absence clears every new moment before sleep and preserves three-tap waking", () => {
  for (const moment of ["leaf", "find", "rain", "wonder", "emotion"]) {
    const world = fresh("firefly"); seek(world, s => s.moment === moment);
    world.elapse(300); world.restAfterAbsence();
    assert.equal(world.state.moment, null); assert.equal(world.state.prop, null); assert.equal(world.state.gathering, 0);
    assert.equal(world.state.activity, "sleep"); assert.deepEqual(world.state.position, HOME);
    world.notice(); world.update(.025); assert.equal(world.state.activity, "stir");
    world.notice(); world.update(.025); assert.equal(world.state.wakeTaps, 2);
    world.notice(); world.update(.025); assert.equal(world.state.activity, "wake");
    seek(world, s => s.activity === "greet", false, 40);
  }
});

test("night gathering fades safely at dawn and rain is decorative during sleep", () => {
  const world = fresh("firefly"); seek(world, s => s.activity === "wonder" && s.progress > .3);
  assert.ok(world.state.gathering > .8);
  const before = { ...world.state.position }, time = world.state.activityTime;
  world.setInsects("butterfly"); assert.deepEqual(world.state.position, before); assert.equal(world.state.activityTime, time);
  for (let i = 0; i < 160; i++) world.update(.025);
  assert.ok(world.state.gathering < .01);
  world.restAfterAbsence(); const position = { ...world.state.position };
  world.elapse(720 + 185 - world.state.ecologyTime % 720);
  assert.ok(world.state.rain > 0); world.setDecor(30); world.setInsects("firefly"); world.settle();
  assert.deepEqual(world.state.position, position); assert.equal(world.state.activity, "sleep"); assert.equal(world.state.wakeTapsNeeded, 3);
  for (const seconds of [0, 179, 220, 719, 720]) assert.equal(rainAt(seconds), 0);
  assert.equal(rainAt(190), 1); assert.equal(rainAt(910), 1);
});

test("reduced motion settles props once and preserves inactivity and decoration unlocks", () => {
  for (const moment of ["leaf", "find", "rain", "wonder", "emotion"]) {
    const world = fresh("firefly"); seek(world, s => s.moment === moment);
    world.settle(); const found = world.state.discoveries;
    assert.equal(world.state.prop, null); assert.equal(world.state.playing, false); assert.equal(world.state.moment, null);
    world.settle(); assert.equal(world.state.discoveries, found);
    world.elapse(61); world.settle(); assert.equal(world.state.activity, "sleep");
  }
  const world = fresh();
  world.notice(); world.settle(); assert.equal(world.state.activity, "balance");
  world.notice(); world.settle(); assert.equal(world.state.leafDelivered, true);
  world.notice(); world.settle(); assert.equal(world.state.keepsake, "cone");
  for (const [days, level] of [[0, 0], [2, 0], [3, 1], [6, 1], [7, 2], [13, 2], [14, 3], [29, 3], [30, 4]]) assert.equal(decorationLevel(days), level);
  for (const value of [-1, 3.5, NaN, Infinity]) assert.equal(decorationLevel(value), 0);
  world.setDecor(30); world.setDecor(0); assert.equal(world.state.decorLevel, 4);
  for (let i = 0; i < 100; i++) { world.notice(); world.settle(); }
  assert.equal(world.state.decorLevel, 4); assert.equal(fresh().state.decorLevel, 0);
});

test("new emotions have distinct poses and bounded offsets", () => {
  const base = createHabitat().state;
  for (const activity of ["scratch", "yawn", "shake", "sneeze", "wonder", "carry", "toss", "show"]) {
    const frames = new Set();
    for (let i = 0; i < 40; i++) {
      const frame = pixelFrame({ ...base, activity, progress: i / 40, activityTime: i / 20, distance: i / 100 });
      assert.ok(Math.abs(frame.offsetX) < .03 && Math.abs(frame.offsetY) < .02);
      frames.add(frame.pose);
    }
    assert.ok(frames.has(activity === "show" ? "present" : activity), activity);
  }
});

test("delivery reaches the deposited anchor and a stopped shower releases the shelter", () => {
  for (const kind of ["leaf", "cone", "stone"]) {
    const world = fresh(); seek(world, s => s.prop === kind && s.activity === "place" && s.progress > .99);
    const target = depositedPosition(kind);
    assert.ok(Math.hypot(world.state.propPosition.x - target.x, world.state.propPosition.y - target.y) < .0001);
    seek(world, s => s.prop === null, false, 2);
    assert.equal(kind === "leaf" ? world.state.leafDelivered : world.state.keepsake, kind === "leaf" ? true : kind);
  }
  const world = fresh(); seek(world, s => s.activity === "shelter" && s.rain > 0);
  world.elapse(220 - world.state.ecologyTime % 720); world.notice(); world.update(.025);
  assert.equal(world.state.rain, 0); assert.equal(world.state.activity, "leave", "rain ends with an actual doorway exit");
  seek(world, s => s.activity === "shake", false, 12);
});

test("an individually granted garland does not unlock other decor, and props respect facing", async () => {
  const { propBehindBody, drawDecor } = await vite.ssrLoadModule("/features/mochlik/ambience.ts");
  const world = fresh(); world.setDecor(0, ["leaf_garland"]);
  assert.deepEqual(world.state.decorItems, ["leaf_garland"]);
  world.setDecor(0, []); assert.deepEqual(world.state.decorItems, ["leaf_garland"]);
  world.setDecor(3, []); assert.deepEqual(world.state.decorItems, ["leaf_garland", "flower"]);
  const state = { ...world.state, prop: "cone", activity: "carry", direction: "back" };
  assert.equal(propBehindBody(state), true);
  assert.equal(propBehindBody({ ...state, direction: "front" }), false);
  assert.equal(propBehindBody({ ...state, activity: "discover" }), false);
  const rectangles = [];
  drawDecor({ save() {}, restore() {}, translate() {}, fillRect(...rect) { rectangles.push(rect); } }, { ...world.state, decorItems: ["leaf_garland"] }, true);
  assert.ok(rectangles.length > 0);
  assert.ok(rectangles.every(([, y]) => y < 90), "only the garland is painted, not the bed, flower or keepsakes");
});

test("rain shelter enters the existing doorway and reduced motion preserves its depth", () => {
  const world = fresh();
  seek(world, state => state.moment === "rain" && state.activity === "enter");
  assert.equal(world.state.layer, "house");
  const before = { ...world.state.position };
  world.update(.025);
  assert.ok(Math.hypot(world.state.position.x - before.x, world.state.position.y - before.y) < .012);
  seek(world, state => state.activity === "shelter");
  assert.deepEqual(world.state.position, HOME);
  assert.equal(world.state.layer, "house");
  assert.equal(world.state.size, .118);
  world.settle();
  assert.deepEqual(world.state.position, HOME);
  assert.equal(world.state.layer, "house");
  assert.equal(world.state.size, .118);
  const still = pixelFrame({ ...world.state, activity: "shelter-peek", progress: .5 }, true);
  assert.equal(still.offsetX, 0);
});
