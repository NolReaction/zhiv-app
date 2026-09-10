import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { createHabitat, HOME, BUSH, FRONT, INACTIVITY_SECONDS } = await vite.ssrLoadModule("/features/mochlik/habitat.ts");
after(() => vite.close());
const advance = (world, seconds) => { for (let i = 0; i < Math.ceil(seconds / .025); i++) world.update(.025); };
function until(world, predicate, seconds = 150) {
  for (let i = 0; i < seconds * 40 && !predicate(world.state); i++) world.update(.025);
  assert.ok(predicate(world.state), `condition not reached: ${world.state.activity}`);
}
function sleeping() {
  const world = createHabitat(); world.invite("home");
  until(world, s => s.activity === "sleep"); return world;
}

test("autonomous bush play leads to persistent sleep after inactivity", () => {
  const world = createHabitat(), seen = new Set();
  for (let i = 0; i < 24_000; i++) {
    world.update(.025); seen.add(world.state.activity);
    assert.ok(world.state.position.x >= Math.min(.20, BUSH.x) && world.state.position.x <= .75);
    assert.ok(world.state.position.y >= Math.min(HOME.y, BUSH.y) - 1e-9 && world.state.position.y <= .82);
    if (world.state.activity === "sleep") {
      assert.equal(world.state.layer, "house"); assert.deepEqual(world.state.position, HOME);
    }
  }
  for (const action of ["idle", "walk", "sniff", "groom", "crouch", "jump", "hide", "peek", "emerge", "enter", "sleep"]) assert.ok(seen.has(action), action);
  assert.ok(world.state.distance > .5);
  assert.equal(world.state.activity, "sleep");
  assert.equal(world.state.eaten, 0, "new mushrooms mature after the first inactivity deadline");
});

test("idle sleep stays inside; a tap wakes slowly, exits, approaches, then returns", () => {
  const world = sleeping(); advance(world, 150);
  assert.equal(world.state.activity, "sleep"); assert.deepEqual(world.state.position, HOME);
  const started = world.state.elapsed; world.notice(); world.update(.025);
  assert.equal(world.state.activity, "wake"); assert.deepEqual(world.state.position, HOME);
  advance(world, 2); assert.equal(world.state.activity, "wake");
  until(world, s => s.activity === "greet");
  assert.ok(world.state.elapsed - started >= 8, "wake and walk must take several seconds");
  assert.deepEqual(world.state.position, FRONT); assert.equal(world.state.layer, "clearing");
  until(world, s => s.activity === "sleep"); assert.deepEqual(world.state.position, HOME);
});

test("rapid repeated taps cannot restart, extend or queue the active visit", () => {
  const single = sleeping(), flooded = sleeping(); single.notice(); flooded.notice();
  let sawVisit = false;
  for (let i = 0; i < 1800; i++) {
    flooded.notice(); single.update(.025); flooded.update(.025);
    const { inactiveFor: singleIdle, ...singleMotion } = single.state;
    const { inactiveFor: floodedIdle, ...floodedMotion } = flooded.state;
    assert.deepEqual(floodedMotion, singleMotion);
    assert.ok(floodedIdle <= singleIdle);
    sawVisit ||= single.state.visiting;
    if (sawVisit && !single.state.visiting) break;
  }
  assert.ok(sawVisit); assert.equal(single.state.visiting, false);
  assert.equal(flooded.notice(), false, "cooldown prevents immediate repeat visits");
});

test("taps during jumps and door transitions wait for safe completion without teleporting", () => {
  for (const activity of ["jump", "enter", "leave", "hide", "peek", "emerge"]) {
    const world = createHabitat();
    if (activity === "leave") { world.invite("home"); until(world, s => s.activity === "sleep"); world.notice(); }
    until(world, s => s.activity === activity); advance(world, .2);
    const before = { ...world.state.position }, previousTime = world.state.activityTime;
    world.notice(); world.update(.025);
    if (activity !== "hide") {
      assert.equal(world.state.activity, activity); assert.ok(world.state.activityTime > previousTime);
    }
    assert.ok(Math.hypot(world.state.position.x - before.x, world.state.position.y - before.y) < .005);
    until(world, s => s.activity === "greet"); assert.deepEqual(world.state.position, FRONT);
  }
});

test("all choreography remains continuous and long frame gaps are bounded", () => {
  const world = createHabitat(); let previous = { ...world.state.position };
  for (let i = 0; i < 18000; i++) {
    if (i % 237 === 0) world.notice();
    if (i % 1423 === 0) world.setLamp(!world.state.lampOn);
    world.update(i % 541 === 0 ? 600 : .025);
    assert.ok(Math.hypot(world.state.position.x - previous.x, world.state.position.y - previous.y) < .012);
    assert.ok(Number.isFinite(world.state.size) && world.state.size > .1 && world.state.size < .31);
    previous = { ...world.state.position };
  }
  const elapsed = world.state.elapsed; world.update(NaN); world.update(-4); world.update(Infinity); assert.equal(world.state.elapsed, elapsed);
});

test("bush and house invitations use complete routes and do not override a visit", () => {
  const world = createHabitat(); assert.equal(world.invite("home"), true);
  until(world, s => s.activity === "sleep"); assert.deepEqual(world.state.position, HOME);
  assert.equal(world.invite("bush"), true); until(world, s => s.activity === "hide");
  assert.equal(world.state.layer, "bush");
  world.notice(); until(world, s => s.visiting);
  assert.equal(world.invite("home"), false); assert.equal(world.invite("bush"), false);
  until(world, s => s.activity === "greet");
});

test("automatic lamp changes never wake, put to sleep or restart the animal", () => {
  const world = createHabitat();
  for (const activity of ["idle", "jump", "enter", "sleep"]) {
    until(world, s => s.activity === activity);
    const before = structuredClone(world.state); delete before.lampOn;
    for (const on of [false, true, false]) {
      world.setLamp(on);
      const { lampOn, ...after } = world.state;
      assert.equal(lampOn, on); assert.deepEqual(after, before);
    }
  }
  advance(world, 80); assert.equal(world.state.activity, "sleep");
  world.notice(); until(world, s => s.activity === "greet");
  assert.equal(world.state.lampOn, false); assert.equal(world.state.resting, false);
});

test("reduced motion supports explicit still wake and object changes", () => {
  const world = createHabitat(); world.invite("home"); world.settle();
  assert.equal(world.state.activity, "sleep"); assert.deepEqual(world.state.position, HOME);
  world.notice(); world.settle(); assert.equal(world.state.activity, "greet"); assert.deepEqual(world.state.position, FRONT);
  assert.equal(world.state.visiting, false);
  assert.equal(world.invite("home"), true); world.settle(); assert.equal(world.state.activity, "sleep");
  world.setLamp(true); world.settle(); assert.equal(world.state.activity, "sleep");
  world.notice(); world.settle(); assert.equal(world.state.activity, "greet");
  assert.equal(world.state.layer, "clearing");
  assert.equal(world.state.elapsed, 0);
  const quiet = createHabitat(); quiet.invite("bush"); quiet.settle(); assert.equal(quiet.state.layer, "bush");
});

test("2D rendering and pet controls never write to accounts or record game taps", async () => {
  for (const path of ["features/mochlik/habitat.ts", "features/mochlik/scene.ts", "features/mochlik/mochlik-terrarium.tsx"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /registerTap\(|recordGameTap\(|createCheckIn\(|fetch\(|from ["']three["']|WebGLRenderer/);
  }
  const app = await readFile(new URL("../features/check-in/check-in-app.tsx", import.meta.url), "utf8");
  const handler = app.slice(app.indexOf("function handleGameAreaPointerDown"), app.indexOf("function handlePrimaryPointerDown"));
  assert.ok(handler.indexOf("data-pet-interaction") < handler.indexOf("registerTap("));
  assert.match(handler, /data-pet-interaction/);
  assert.equal((app.match(/setMochlikWakeSignal\(value => value \+ 1\)/g) ?? []).length, 1);
  const sink = app.slice(app.indexOf("const registerTap ="), app.indexOf("const registerTap =") + 170);
  assert.match(sink, /setMochlikWakeSignal/);
});


test("inactivity has a deadline and sleep never expires while the lamp is on", () => {
  const world = createHabitat(); advance(world, INACTIVITY_SECONDS - 1);
  assert.equal(world.state.resting, false); assert.notEqual(world.state.activity, "sleep");
  until(world, s => s.activity === "sleep", 25);
  assert.ok(world.state.inactiveFor >= INACTIVITY_SECONDS);
  assert.equal(world.state.lampOn, true);
  advance(world, 600); assert.equal(world.state.activity, "sleep");
  world.notice(); world.update(.025); assert.equal(world.state.activity, "wake");
  until(world, s => s.activity === "greet");
  assert.deepEqual(world.state.position, FRONT);
  until(world, s => !s.visiting); advance(world, 8);
  assert.notEqual(world.state.activity, "sleep");
});

test("continued taps keep Mochlik awake, including taps coalesced during a visit", () => {
  const world = createHabitat();
  for (let i = 0; i < 16000; i++) {
    if (i % 20 === 0) world.notice();
    world.update(.025);
    assert.ok(world.state.inactiveFor < 1);
    assert.equal(world.state.resting, false);
    assert.notEqual(world.state.activity, "sleep");
  }
  until(world, s => s.activity === "sleep", 85);
});

test("mushrooms mature, are consumed once after approach, and regrow", () => {
  const world = createHabitat();
  assert.equal(world.invite("mushrooms"), false);
  world.elapse(80); assert.equal(world.state.mushrooms[0].growth, 1);
  assert.equal(world.invite("mushrooms"), true);
  until(world, s => s.activity === "eat");
  const id = world.state.feedingId, mushroom = world.state.mushrooms[id];
  assert.ok(Math.abs(world.state.position.x - mushroom.position.x) < .001);
  assert.equal(world.state.eaten, 0); advance(world, 1); assert.equal(mushroom.growth, 1);
  until(world, s => s.eaten === 1); assert.equal(mushroom.growth, 0);
  until(world, s => s.activity !== "eat"); assert.equal(world.state.feedingId, null);
  assert.equal(world.state.eaten, 1);
  world.elapse(mushroom.growSeconds / 2); assert.ok(mushroom.growth > .49 && mushroom.growth < .51);
  world.elapse(mushroom.growSeconds); assert.equal(mushroom.growth, 1);
});

test("background time ages the ecology without moving or teleporting the animal", () => {
  const world = createHabitat(); advance(world, 10);
  const before = { ...world.state.position }, elapsed = world.state.elapsed;
  world.elapse(3600);
  assert.deepEqual(world.state.position, before); assert.equal(world.state.elapsed, elapsed);
  assert.equal(world.state.resting, true); assert.ok(world.state.mushrooms.every(item => item.growth === 1));
  until(world, s => s.activity === "sleep", 30);
  world.notice(); until(world, s => s.activity === "greet");
});

test("a wake request during the last part of eating consumes just one mushroom", () => {
  const world = createHabitat(); world.elapse(80); world.invite("mushrooms");
  until(world, s => s.activity === "eat"); world.notice(); world.update(.025);
  assert.equal(world.state.activity, "eat");
  until(world, s => s.activity === "greet");
  assert.equal(world.state.eaten, 1); assert.equal(world.state.feedingId, null);
});

test("foliage envelopes meet continuously and jump direction is preserved", async () => {
  const { pixelFrame } = await vite.ssrLoadModule("/features/mochlik/pixel-frame.ts");
  const base = createHabitat().state;
  const at = (activity, progress) => pixelFrame({ ...base, activity, progress, direction: "back", layer: "bush" });
  for (const [left, lp, right, rp] of [["jump", 1, "hide", 0], ["hide", 1, "peek", 0], ["peek", 1, "hide", 0], ["hide", 1, "emerge", 0]]) {
    const a = at(left, lp), b = at(right, rp);
    assert.ok(Math.abs(a.opacity - b.opacity) < 1e-10);
    assert.ok(Math.abs(a.sink - b.sink) < 1e-10);
  }
  assert.equal(at("jump", .5).direction, "back");
  assert.equal(at("hide", .5).opacity, 0);
  assert.equal(at("peek", .5).opacity, 1);
  assert.equal(at("emerge", 1).opacity, 1); assert.equal(at("emerge", 1).sink, 0);
});


test("a mushroom invitation selects the clicked patch and rejects an unripe patch", () => {
  const world = createHabitat(); world.elapse(80);
  assert.equal(world.invite("mushrooms", 2), false);
  world.elapse(80); assert.equal(world.invite("mushrooms", 2), true);
  until(world, s => s.activity === "eat"); assert.equal(world.state.feedingId, 2);
  until(world, s => s.eaten === 1); assert.equal(world.state.mushrooms[2].growth, 0);
  assert.equal(world.state.mushrooms[0].growth, 1);
});


test("enabling reduced motion during a visit settles it and still allows idle sleep", () => {
  const world = sleeping(); world.notice(); until(world, s => s.activity === "approach");
  world.settle(); assert.equal(world.state.visiting, false); assert.equal(world.state.activity, "greet");
  world.elapse(INACTIVITY_SECONDS + 1); world.settle();
  assert.equal(world.state.activity, "sleep"); assert.deepEqual(world.state.position, HOME);
});


test("bush exits never displace the pet below its ground anchor", async () => {
  const { pixelFrame } = await vite.ssrLoadModule("/features/mochlik/pixel-frame.ts");
  const world = createHabitat(); until(world, s => s.activity === "emerge");
  const startY = world.state.position.y;
  while (world.state.activity === "emerge") {
    const frame = pixelFrame(world.state);
    assert.equal(frame.sink, 0);
    if (world.state.progress < .4) assert.ok(world.state.position.y - world.state.lift <= startY + .001);
    world.update(.025);
  }
});

test("feeding reaches, lifts the same mushroom, bites three times, then swallows", async () => {
  const { feedingFrame, CONSUMED_PROGRESS } = await vite.ssrLoadModule("/features/mochlik/feeding.ts");
  const { pixelFrame } = await vite.ssrLoadModule("/features/mochlik/pixel-frame.ts");
  const world = createHabitat(); world.elapse(80); world.invite("mushrooms");
  until(world, s => s.activity === "eat");
  const phases = new Set(), poses = new Set(), bites = new Set();
  while (world.state.activity === "eat") {
    const food = feedingFrame(world.state.progress);
    phases.add(food.phase); poses.add(pixelFrame(world.state).pose); bites.add(food.bites);
    assert.equal(world.state.eaten, world.state.progress >= CONSUMED_PROGRESS ? 1 : 0);
    if (!food.lifted) assert.equal(food.lift, 0);
    world.update(.025);
  }
  assert.deepEqual([...phases], ["reach", "lift", "chew", "swallow"]);
  assert.deepEqual([...poses], ["reach", "hold", "chew", "swallow"]);
  assert.deepEqual([...bites], [0, 1, 2, 3]);
  assert.equal(world.state.eaten, 1);
  assert.deepEqual(world.state.mushrooms.map(item => item.growSeconds), [70, 100, 130]);
});

test("day and dusk use the profile timezone including DST and midnight", async () => {
  const { habitatLighting } = await vite.ssrLoadModule("/features/mochlik/lighting.ts");
  const at = (time, zone) => habitatLighting(Date.parse(time), zone);
  assert.deepEqual(at("2026-09-08T15:59:00Z", "Europe/Moscow"), { dusk: false, lampOn: false });
  assert.deepEqual(at("2026-09-08T16:00:00Z", "Europe/Moscow"), { dusk: true, lampOn: true });
  assert.deepEqual(at("2026-09-08T16:00:00Z", "America/New_York"), { dusk: false, lampOn: false });
  assert.equal(at("2026-09-08T03:59:00Z", "Europe/Moscow").dusk, true);
  assert.equal(at("2026-09-08T04:00:00Z", "Europe/Moscow").dusk, false);
  assert.equal(at("2026-09-08T21:00:00Z", "Europe/Moscow").lampOn, true);
  assert.equal(at("2026-01-08T17:30:00Z", "Europe/Berlin").dusk, false);
  assert.equal(at("2026-07-08T17:30:00Z", "Europe/Berlin").dusk, true);
  assert.deepEqual(at("2026-09-08T12:00:00Z", "invalid"), { dusk: false, lampOn: false });
});

test("butterfly and firefly play completes a continuous chase, jump, perch and release", () => {
  for (const kind of ["butterfly", "firefly"]) {
    const world = createHabitat(); world.setInsects(kind); world.notice();
    const seen = new Set(); let previous = { ...world.state.position }, insect = { ...world.state.insectPosition };
    for (let i = 0; i < 1200; i++) {
      world.notice(); world.update(.025); seen.add(world.state.activity);
      assert.ok(Math.hypot(world.state.position.x - previous.x, world.state.position.y - previous.y) < .012);
      assert.ok(Math.hypot(world.state.insectPosition.x - insect.x, world.state.insectPosition.y - insect.y) < .03);
      previous = { ...world.state.position }; insect = { ...world.state.insectPosition };
      if (world.state.playing) assert.equal(world.invite("home"), false);
    }
    for (const activity of ["watch", "chase", "crouch", "pounce", "balance", "release", "groom"]) assert.ok(seen.has(activity), activity);
    assert.equal(world.state.insectKind, kind); assert.equal(world.state.resting, false);
    until(world, s => s.activity === "sleep", 90);
  }
});

test("insects play autonomously and light changes preserve a jump and its focus", () => {
  const world = createHabitat(); world.setInsects("butterfly");
  until(world, s => s.activity === "pounce"); advance(world, .3);
  const { insectKind, ...before } = structuredClone(world.state); assert.equal(insectKind, "butterfly");
  world.setInsects("firefly");
  const { insectKind: afterKind, ...after } = world.state;
  assert.equal(afterKind, "firefly"); assert.deepEqual(after, before);
  until(world, s => s.activity === "release");
});

test("long absence cancels old routes and requires three taps without spontaneous waking", () => {
  for (const activity of ["jump", "eat", "approach", "pounce"]) {
    const world = createHabitat();
    if (activity === "eat") { world.elapse(80); world.invite("mushrooms"); }
    if (activity === "approach") world.notice();
    if (activity === "pounce") { world.setInsects("firefly"); world.notice(); }
    until(world, s => s.activity === activity);
    const eaten = world.state.eaten;
    world.elapse(300); world.restAfterAbsence();
    assert.equal(world.state.activity, "sleep"); assert.deepEqual(world.state.position, HOME);
    assert.equal(world.state.feedingId, null); assert.equal(world.state.playing, false); assert.equal(world.state.visiting, false);
    world.notice(); advance(world, 40); assert.equal(world.state.activity, "sleep"); assert.equal(world.state.wakeTaps, 1);
    world.notice(); advance(world, 40); assert.equal(world.state.activity, "sleep"); assert.equal(world.state.wakeTaps, 2);
    world.notice(); world.update(.025); assert.equal(world.state.activity, "wake");
    until(world, s => s.activity === "greet"); assert.equal(world.state.eaten, eaten);
  }
});

test("deep waking and insect play work with still scenes and batched rapid taps", () => {
  const world = createHabitat(); world.setInsects("butterfly"); world.restAfterAbsence();
  world.notice(); world.settle(); assert.equal(world.state.activity, "sleep"); assert.equal(world.state.wakeTaps, 1);
  world.notice(); world.settle(); assert.equal(world.state.activity, "sleep"); assert.equal(world.state.wakeTaps, 2);
  world.notice(); world.settle(); assert.equal(world.state.activity, "greet");
  world.notice(); world.settle(); assert.equal(world.state.activity, "balance");
  world.elapse(61); world.settle(); assert.equal(world.state.activity, "sleep");
  world.restAfterAbsence(); for (let i = 0; i < 3; i++) world.notice();
  world.update(.025); assert.equal(world.state.activity, "wake");
});

test("presence handles the five-minute boundary, invalid clocks, corruption and denied storage", async () => {
  const { decodePresence, readPresence, writePresence } = await vite.ssrLoadModule("/features/mochlik/presence.ts");
  const now = 1_000_000;
  const saved = seconds => JSON.stringify({ seenAt: now - seconds * 1000, inactiveFor: 0, resting: false, deepSleep: false });
  assert.equal(decodePresence(saved(299), now).deepSleep, false);
  assert.equal(decodePresence(saved(300), now).deepSleep, true);
  assert.equal(decodePresence(saved(10), now).resting, false);
  assert.equal(decodePresence(saved(61), now).resting, true);
  for (const raw of [null, "{", "null", "{}", saved(-10), JSON.stringify({ seenAt: 0 })]) assert.equal(decodePresence(raw, now), null);
  assert.equal(readPresence("no-window", now), null);
  assert.doesNotThrow(() => writePresence("no-window", { seenAt: now, inactiveFor: 0, resting: false, deepSleep: false }));
});
