import assert from "node:assert/strict";
import test from "node:test";
import {
  approximately,
  browser,
  bushMask,
  bushParticleDraws,
  circlePoint,
  clearingBush,
  clearingBushPath,
  clearingHome,
  clearingHomePath,
  clearingPath,
  distanceBetween,
  dragMap,
  fixture,
  flush,
  livingHabitats,
  livingNavigation,
  mapProjection,
  modules,
  options,
  productionSite,
  quietClearing,
  residentFixture,
  sampleHero,
  sceneClock,
  sendWaterPointer,
  treeTouchFixture,
  waterEnergy,
  waterPhysicsFixture,
  waterPointer,
  waterRectangle
} from "./helpers/new-map-scene.mjs";


test("authored clearing routes move the rendered pet, its hit area and camera target together", async () => {
  const { mountHabitat, createMapEngine, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite, clearingActivityFrame } = await modules({ paths: [clearingPath] });
  const env = browser(); let scene, engine, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "walking-pet" }, canvas = env.surface();
    scene = mountHabitat(canvas, initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const home = scene.position(), clock = sceneClock(env);
    let previous = home, moved = false;
    for (let i = 0; i < 200 && probe.state.clearing.stage !== "activity"; i++) {
      clock.step();
      const current = scene.position();
      assert.ok(distanceBetween(current, previous) <= fixture.actor.size * .36 * .05 + 1e-8,
        "each visual frame moves at walking speed, including route corners and arrival");
      assert.ok(distanceBetween(current, home) <= fixture.actor.size * 1.6, "the actor stays near its clearing spawn");
      moved ||= distanceBetween(current, home) > 10;
      previous = current;
    }
    assert.equal(moved, true, "automatic life starts walking without DEV commands or a user tap");
    assert.equal(probe.state.clearing.stage, "activity", "the hero reaches the authored local destination");
    assert.deepEqual(scene.position(), { x: 605, y: 629 });
    const actorDraw = canvas.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
      && call.args[3] === fixture.actor.size && call.args[4] === fixture.actor.size);
    assert.ok(actorDraw, "the moving actor is painted");
    assert.equal(actorDraw.args[1] + fixture.actor.size / 2, scene.position().x,
      "sprite drawing uses the live position rather than the original Tiled spawn");
    const live = circlePoint(scene.position()), old = circlePoint(home);
    assert.equal(scene.hitPet(live.x, live.y), true, "the new position responds to touches");
    assert.equal(scene.hitPet(old.x, old.y), false, "the departed spawn is not an invisible touch target");
    canvas.calls.length = 0;
    const grooming = [0, 1, 2, 3].map(frame => pixelSprite("groom", "front", frame));
    clock.until(() => canvas.calls.some(call => call.method === "drawImage" && grooming.includes(call.args[0])),
      "each variant of the authored endpoint activity reaches the visible grooming sprite", 60);
    assert.deepEqual(scene.position(), { x: 605, y: 629 }, "the endpoint activity keeps its authored contact point");

    const world = env.surface(400);
    engine = await createMapEngine(world, initial, assert.fail, []);
    worldDevStore.patch({ paused: true });
    engine.control("pet");
    const projection = mapProjection(world), target = scene.position();
    approximately(projection.left + target.x * projection.zoom, 200, "find pet centers its current X");
    approximately(projection.top + target.y * projection.zoom, 200, "find pet centers its current Y");
    engine.control("overview");
    const tap = (point, pointerId) => {
      const event = { pointerId, pointerType: "touch", button: 0,
        clientX: point.x * 400 / fixture.width, clientY: point.y * 400 / fixture.height };
      world.events.get("pointerdown")({ ...event, type: "pointerdown" });
      world.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    tap(home, 1); assert.equal(clearingActivityFrame(probe.state.clearing).attention, false, "a map tap at the old spawn also misses");
    tap(target, 2); assert.equal(clearingActivityFrame(probe.state.clearing).attention, true, "a map tap finds and greets the relocated pet");
  } finally { engine?.dispose(); scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("greetings, reduced motion and hidden tabs pause an outing without catch-up jumps", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ paths: [clearingPath] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "interrupted-outing" }, activities = [];
    scene = mountHabitat(env.surface(), initial, { activity: value => activities.push(value), ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const home = scene.position(), clock = sceneClock(env);
    clock.until(() => distanceBetween(scene.position(), home) > 10, "the hero has left its spawn");
    const greetedAt = scene.position();
    scene.notice(); clock.advance(.8);
    assert.deepEqual(scene.position(), greetedAt, "greeting freezes translation at the actual location");
    assert.equal(activities.at(-1), "greet");
    clock.until(() => distanceBetween(scene.position(), greetedAt) > 0, "the finite greeting returns to its interrupted route", 80);
    assert.equal(activities.at(-1), "idle");
    assert.ok(distanceBetween(scene.position(), greetedAt) > 0 && distanceBetween(scene.position(), greetedAt) < 3,
      "the outing continues from the same spot after greeting");

    scene.configure({ ...initial, reducedMotion: true });
    const still = scene.position(), travelTime = probe.state.clearing.elapsed;
    clock.step(60_000);
    assert.deepEqual(scene.position(), still); assert.equal(probe.state.clearing.elapsed, travelTime);
    assert.equal(env.frames.size, 0);
    scene.configure(initial); clock.step(); clock.step();
    assert.ok(distanceBetween(scene.position(), still) > 0 && distanceBetween(scene.position(), still) < 1,
      "turning motion back on resumes one short frame without applying the hidden minute");

    for (const mode of ["paused", "backgrounded", "hidden"]) {
      if (mode === "hidden") env.visibility(true); else scene.configure({ ...initial, [mode]: true });
      const frozen = scene.position(), elapsed = probe.state.clearing.elapsed;
      assert.equal(env.frames.size, 0, `${mode} cancels the scene clock`);
      clock.step(60_000);
      assert.deepEqual(scene.position(), frozen, `${mode} keeps the live actor stationary`);
      assert.equal(probe.state.clearing.elapsed, elapsed);
      if (mode === "hidden") env.visibility(false); else scene.configure(initial);
      clock.step(); clock.step();
      assert.ok(distanceBetween(scene.position(), frozen) <= fixture.actor.size * .36 * .05 + 1e-8,
        `${mode} resumes without replaying the elapsed background time`);
    }
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("circle/world handoff preserves one walking clock, path progress and position", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ paths: [clearingPath] });
  const env = browser(), scenes = []; let probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "shared-outing" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const home = circle.position(), clock = sceneClock(env);
    clock.until(() => distanceBetween(circle.position(), home) > 8, "circle starts its short walk");
    const snapshot = structuredClone(probe.state.clearing);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    await flush();
    assert.deepEqual(probe.state.clearing, snapshot, "mounting a second view preserves the existing outing");
    assert.deepEqual(circle.position(), world.position()); assert.equal(env.frames.size, 1);
    clock.step();
    const before = probe.state.clearing.elapsed;
    clock.advance(.5);
    approximately(probe.state.clearing.elapsed - before, .5, "two mounted views advance exactly one active clock");
    assert.deepEqual(circle.position(), world.position());
    assert.notDeepEqual(circle.position(), home);
    circle.configure({ ...initial, backgrounded: true });
    const beforeReturn = structuredClone(probe.state.clearing);
    world.dispose(); circle.configure(initial); await flush();
    assert.deepEqual(probe.state.clearing, beforeReturn, "closing the world continues the circle from the same route progress");
    assert.equal(env.frames.size, 1);
    clock.step(); clock.step();
    assert.ok(probe.state.clearing.elapsed > beforeReturn.elapsed);
    assert.ok(distanceBetween(circle.position(), { x: beforeReturn.position.x, y: beforeReturn.position.y - fixture.actor.size / 2 }) < 1);
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV interaction requested away from home waits for a continuous return along the local path", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ paths: [clearingPath] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "return-before-life" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const home = scene.position(), clock = sceneClock(env);
    clock.until(() => distanceBetween(scene.position(), home) > 12, "the hero leaves home before the requested interaction");
    const requestedAt = scene.position();
    worldDevStore.triggerLife("mushroom");
    assert.deepEqual(scene.position(), requestedAt, "DEV does not teleport the hero back to its props");
    assert.equal(probe.state.pendingLife, "mushroom"); assert.equal(probe.state.life.routine, null);
    clock.step(); clock.step();
    assert.equal(probe.state.clearing.stage, "return");
    let previous = requestedAt, previousDistance = distanceBetween(previous, home);
    for (let i = 0; i < 160 && !probe.state.life.routine; i++) {
      clock.step();
      const current = scene.position(), remaining = distanceBetween(current, home);
      assert.ok(distanceBetween(current, previous) <= fixture.actor.size * .36 * .05 + 1e-8,
        "returning and final arrival retain bounded visual displacement");
      assert.ok(remaining <= previousDistance + 1e-8, "the character retraces the authored route towards home");
      if (remaining > .001) assert.equal(probe.state.life.routine, null, "the mushroom remains at home until the actor returns");
      previous = current; previousDistance = remaining;
    }
    assert.deepEqual(scene.position(), home);
    assert.equal(probe.state.pendingLife, null); assert.equal(probe.state.life.routine?.kind, "mushroom");
    clock.advance(1);
    assert.deepEqual(scene.position(), home, "interacting with a ground prop never resumes walking underneath it");
    assert.ok(probe.state.life.routine.elapsed > 0);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a tap wakes an outdoor nap without replaying the interrupted sleep afterwards", async () => {
  const rest = { ...clearingPath, id: "clearing-nap", activity: "rest", pauseSeconds: 20 };
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ paths: [rest] });
  const env = browser(); let scene;
  try {
    worldDevStore.patch(quietClearing);
    scene = mountHabitat(env.surface(), { ...options, view: "world", reducedMotion: false },
      { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite);
    clock.until(() => sample().hasPose("sleep"), "the authored rest route reaches a visible natural nap", 600);
    const sleepingAt = scene.position(), sleepingTouch = circlePoint(sleepingAt);
    assert.equal(scene.hitPet(sleepingTouch.x, sleepingTouch.y), true, "a sleeping body retains its touch target");
    scene.notice();
    const poses = new Set();
    for (let i = 0; i < 100; i++) {
      clock.step();
      const current = sample();
      for (const pose of ["drowsy", "stretch", "greet", "idle", "walk", "blink", "wonder"]) {
        if (current.hasPose(pose)) poses.add(pose);
      }
      assert.equal(current.hasPose("sleep"), false, "the interrupted nap cannot resume after the response");
    }
    assert.ok(poses.has("stretch"), "waking has a visible transition before ordinary activity");
    assert.ok(poses.has("walk") || poses.has("idle") || poses.has("wonder"), "the hero settles into awake behavior");
    assert.ok(distanceBetween(scene.position(), sleepingAt) < fixture.actor.size * 1.6, "waking stays on the clearing");
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("a DEV mushroom interaction cannot consume a prop while its hero is hidden", async () => {
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD } = await modules();
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, showHero: false });
    const initial = { ...options, view: "world", reducedMotion: false, presenceKey: "hidden-mushroom" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerLife("mushroom");
    const mushrooms = structuredClone(probe.state.life.mushrooms);
    assert.ok(mushrooms.length > 0, "the fixture has a real ground prop to interact with");
    clock.advance(3);
    for (const mushroom of mushrooms) {
      const current = probe.state.life.mushrooms.find(item => item.id === mushroom.id);
      assert.ok(current.growth >= mushroom.growth, "a hidden interaction cannot pick an unseen mushroom");
      assert.equal(current.regrowIn, 0);
    }
    assert.notEqual(probe.state.life.routine?.picked, true);
    worldDevStore.patch({ showHero: true });
    worldDevStore.triggerLife("mushroom");
    clock.advance(3);
    assert.equal(probe.state.life.routine?.picked, true, `the visible requested interaction still picks its prop normally: ${JSON.stringify({
      routine: probe.state.life.routine, pendingLife: probe.state.pendingLife, reason: probe.state.director.reason,
      stage: probe.state.clearing.stage, lifeElapsed: probe.state.life.elapsed, stageElapsed: probe.state.clearing.stageElapsed,
      elapsed: probe.state.elapsed, frames: env.frames.size, seed: probe.state.clearing.seed,
    })}`);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("tapping a held mushroom finishes putting it back before greeting and repeated taps do not restart cleanup", async () => {
  const { mountHabitat, worldDevStore, pixelSprite, connectForestSession, TILED_WORLD } = await modules();
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, view: "world", reducedMotion: false, presenceKey: "interrupted-mushroom" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite, true);
    worldDevStore.triggerLife("mushroom"); clock.advance(3);
    assert.equal(probe.state.life.routine?.picked, true);
    const id = probe.state.life.routine.mushroomId;
    assert.equal(sample().hasPose("hold"), true, "the actor visibly holds the uneaten mushroom");
    const beforeStill = sample();
    const heldRectangles = sample => sample.calls.slice(sample.calls.indexOf(sample.body) + 1)
      .filter(call => call.method === "fillRect");
    assert.ok(heldRectangles(beforeStill).length > 0, "the held prop is painted after the body");
    scene.configure({ ...initial, reducedMotion: true });
    clock.step(60_000);
    const frozen = sample();
    assert.equal(frozen.body.args[0], beforeStill.body.args[0], "reduced motion keeps the current holding pose");
    assert.deepEqual(heldRectangles(frozen), heldRectangles(beforeStill), "reduced motion freezes the held prop instead of hiding it");
    scene.configure(initial); clock.step();
    scene.notice();
    assert.equal(sample().hasPose("hold"), true, "the touch does not instantly discard the held object");
    for (let i = 0; i < 16; i++) { scene.notice(); clock.step(); }
    assert.equal(probe.state.life.routine, null, "repeat touches cannot keep restarting the finite put-back animation");
    const restored = probe.state.life.mushrooms.find(mushroom => mushroom.id === id);
    assert.equal(restored.growth, 1); assert.equal(restored.regrowIn, 0);
    const response = new Set();
    for (let i = 0; i < 32; i++) {
      const hero = sample();
      for (const pose of ["greet", "wonder", "jump", "blink", "idle"]) if (hero.hasPose(pose)) response.add(pose);
      clock.step();
    }
    assert.ok(response.has("greet") || response.has("wonder") || response.has("jump"), "the queued touch response runs after the prop is safe");
    assert.deepEqual(scene.position(), { x: fixture.actor.spawn.x, y: fixture.actor.spawn.y - fixture.actor.size / 2 });
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("only visible inactivity sends the hero indoors and a house tap wakes him while opening its menu", async () => {
  const { mountHabitat, createMapEngine, worldDevStore, pixelSprite } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let scene, engine;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, view: "world", reducedMotion: false, presenceKey: "natural-residence" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); env.finish(); await flush();
    const clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite);
    const spawn = scene.position();
    clock.advance(179);
    assert.ok(sample().body, "the character remains outdoors before three active minutes without taps");
    for (const mode of ["paused", "backgrounded", "hidden", "reducedMotion"]) {
      if (mode === "hidden") env.visibility(true); else scene.configure({ ...initial, [mode]: true });
      const before = scene.ambience().elapsed, position = scene.position();
      clock.step(300_000);
      assert.equal(scene.ambience().elapsed, before, `${mode} must not count as player inactivity`);
      assert.deepEqual(scene.position(), position);
      if (mode === "hidden") env.visibility(false); else scene.configure(initial);
      clock.step();
      assert.ok(sample().body, `${mode} cannot catch up to a hidden indoor sleep on resume`);
    }
    clock.until(() => !sample().body, "the actor walks to the authored entrance and disappears inside", 700);
    assert.deepEqual(scene.position(), { x: clearingHome.doorway.x, y: clearingHome.doorway.y - fixture.actor.size / 2 });
    const oldTouch = circlePoint({ x: spawn.x, y: fixture.actor.spawn.y - 1 });
    const housePoint = { x: 675, y: 610 }, houseTouch = circlePoint(housePoint);
    assert.equal(scene.hitPet(oldTouch.x, oldTouch.y), false, "the departed clearing position is not a ghost touch target");
    assert.equal(scene.hitPet(houseTouch.x, houseTouch.y), true, "the sleeping character can be reached through the house");

    const map = env.surface(400), places = [];
    engine = await createMapEngine(map, initial, place => places.push(place), []);
    engine.control("overview");
    const tap = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: housePoint.x * 400 / fixture.width, clientY: housePoint.y * 400 / fixture.height };
    map.events.get("pointerdown")({ ...tap, type: "pointerdown" });
    map.events.get("pointerup")({ ...tap, type: "pointerup" });
    assert.deepEqual(places, ["house"], "the house tap opens its object menu while the resident sleeps");
    assert.equal(sample().body, undefined, "the resident exits through the door rather than appearing instantly");
    engine.dispose(); engine = null;
    clock.until(() => Boolean(sample().body), "the house tap alone starts the resident's exit", 100);
    let previous = scene.position();
    const awakePoses = new Set();
    for (let i = 0; i < 240; i++) {
      if (i < 60) scene.notice();
      clock.step();
      const current = scene.position(), hero = sample();
      assert.ok(hero.body, "repeat taps cannot make the hero disappear back indoors");
      assert.equal(hero.hasPose("sleep"), false, "waking does not resume the former sleep");
      assert.equal(hero.hasPose("drowsy"), false, "after walking outside the resident stays standing instead of curling up again");
      assert.ok(distanceBetween(current, previous) <= fixture.actor.size * .36 * .05 + 1e-7,
        "returning from the doorway moves continuously without a spawn teleport");
      for (const pose of ["walk", "stretch", "greet", "idle", "blink", "wonder"]) if (hero.hasPose(pose)) awakePoses.add(pose);
      previous = current;
    }
    assert.ok(awakePoses.has("walk"), "wake-up includes actual movement out of the house");
    assert.ok(awakePoses.has("stretch") || awakePoses.has("greet"), "the character acknowledges the wake-up after coming outside");
    assert.deepEqual(scene.position(), spawn, "repeated taps do not pin the exit or prevent returning to the clearing");
  } finally { engine?.dispose(); scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("indoor sleep survives circle/world ownership handoff and a circle tap wakes the shared resident", async () => {
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(), scenes = [];
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "shared-residence" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    env.finish(); env.finish(); await flush();
    worldDevStore.triggerLife("home-sleep");
    const clock = sceneClock(env);
    clock.until(() => !sampleHero(world, env, pixelSprite).body, "DEV uses the same route and indoor sleep as automatic life", 500);
    const sleepingAt = world.position(), elapsed = world.ambience().elapsed;
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    await flush();
    assert.deepEqual(circle.position(), sleepingAt);
    assert.equal(sampleHero(circle, env, pixelSprite).body, undefined, "mounting a second view does not reveal the sleeping body");
    assert.equal(env.frames.size, 1, "both views retain a single active residence clock");
    world.dispose();
    await flush();
    assert.deepEqual(circle.position(), sleepingAt); assert.equal(circle.ambience().elapsed, elapsed);
    assert.equal(sampleHero(circle, env, pixelSprite).body, undefined, "returning to the circle preserves indoor sleep");
    const homeTouch = circlePoint({ x: 675, y: 610 });
    assert.equal(circle.hitPet(homeTouch.x, homeTouch.y), true, "the home in the circle remains a reachable wake target");
    circle.notice();
    clock.until(() => Boolean(sampleHero(circle, env, pixelSprite).body), "tapping the circle brings its resident outside", 100);
    clock.advance(4);
    assert.equal(sampleHero(circle, env, pixelSprite).hasPose("sleep"), false);
  } finally { scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

test("a home marker wakes its sleeping resident once, while camera movement and canceled gestures leave him asleep", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "home-marker-wake" };
    const canvas = env.surface(400), places = [], marker = Object.assign(env.surface(), {
      dataset: { objectId: "home", kind: "house" }, style: {},
    });
    const loading = createMapEngine(canvas, initial, place => places.push(place), [marker]);
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => probe.state.clearing.stage === "home-sleep", "the resident sleeps behind the home artwork", 600);
    engine.control("home"); engine.setSelectedObject("home");
    dragMap(canvas, 15, -10);
    assert.equal(probe.state.clearing.stage, "home-sleep", "camera controls, selection tracking and pan cannot wake the resident");
    const event = (pointerId = 1) => {
      const projection = mapProjection(canvas);
      return { pointerId, pointerType: "touch", button: 0,
        clientX: projection.left + clearingHome.anchor.x * projection.zoom,
        clientY: projection.top + clearingHome.anchor.y * projection.zoom };
    };
    let touch = event();
    marker.events.get("pointerdown")({ ...touch, type: "pointerdown" });
    marker.events.get("pointermove")({ ...touch, type: "pointermove", clientX: touch.clientX + 20 });
    marker.events.get("pointerup")({ ...touch, type: "pointerup", clientX: touch.clientX + 20 });
    canvas.flushFrame();
    touch = event();
    marker.events.get("pointerdown")({ ...touch, type: "pointerdown" });
    marker.events.get("pointercancel")({ ...touch, type: "pointercancel" });
    const second = { ...touch, pointerId: 2, clientX: touch.clientX + 40 };
    marker.events.get("pointerdown")({ ...touch, type: "pointerdown" });
    canvas.events.get("pointerdown")({ ...second, type: "pointerdown" });
    marker.events.get("pointerup")({ ...touch, type: "pointerup" });
    canvas.events.get("pointerup")({ ...second, type: "pointerup" });
    assert.equal(probe.state.clearing.stage, "home-sleep", "marker drag, cancellation and pinch cannot wake him");
    assert.deepEqual(places, []);
    touch = event();
    marker.events.get("pointerdown")({ ...touch, type: "pointerdown" });
    marker.events.get("pointerup")({ ...touch, type: "pointerup" });
    marker.events.get("lostpointercapture")({ ...touch, type: "lostpointercapture" });
    assert.deepEqual(places, ["house"], "the same deliberate tap opens the building exactly once");
    assert.equal(probe.state.clearing.stage, "exiting");
    clock.step();
    const progress = probe.state.clearing.doorProgress;
    engine.activateObject("home");
    assert.equal(probe.state.clearing.doorProgress, progress, "another activation cannot restart the exit");
    clock.until(() => probe.state.clearing.routeKind !== "home", "the resident finishes leaving the house", 600);
    const stage = probe.state.clearing.stage;
    engine.activateObject("home");
    assert.equal(probe.state.clearing.stage, stage, "an ordinary house menu does not interrupt an outdoor resident");
    assert.deepEqual(places, ["house", "house", "house"]);
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("home waking interrupts entry, respects hidden heroes, and supports a still circle without teleporting on ordinary menu reads", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "home-entry-wake" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "world", 0, 0, () => {});
    const clock = sceneClock(env);
    assert.equal(scene.wakeHomeResident(), false, "opening a home while its resident is outdoors has no attention side effect");
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => probe.state.clearing.stage === "entering", "the resident starts crossing the doorway", 600);
    const entering = scene.position();
    assert.equal(scene.wakeHomeResident(), true);
    assert.equal(probe.state.clearing.stage, "exiting");
    assert.deepEqual(scene.position(), entering, "an interrupted entry reverses at its current position");
    clock.until(() => probe.state.clearing.routeKind !== "home", "the interrupted entry returns outside", 600);
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => probe.state.clearing.stage === "home-sleep", "the resident can later sleep normally", 600);
    worldDevStore.patch({ showHero: false });
    assert.equal(scene.wakeHomeResident(), false);
    assert.equal(probe.state.clearing.stage, "home-sleep", "a hidden DEV hero is not moved by the building API");
    worldDevStore.patch({ showHero: true });
    scene.configure({ ...initial, reducedMotion: true });
    assert.equal(scene.wakeHomeResident(), true);
    assert.notEqual(probe.state.clearing.stage, "home-sleep", "reduced motion still brings the resident outside");
    assert.equal(scene.wakeHomeResident(), false, "an already-awake resident cannot restart a static response");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("hiding the home returns its sleeping resident outside even when automatic life is disabled", async () => {
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let scene;
  try {
    worldDevStore.patch(quietClearing);
    scene = mountHabitat(env.surface(), { ...options, view: "world", reducedMotion: false },
      { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); const houseImage = env.finish(); await flush();
    const spawn = scene.position(), clock = sceneClock(env), sample = () => sampleHero(scene, env, pixelSprite);
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => !sample().body, "the resident falls asleep inside the visible home", 500);
    worldDevStore.patch({ autoLife: false, showBuildings: false });
    assert.equal(sample().calls.some(call => call.method === "drawImage" && call.args[0] === houseImage), false,
      "the home is actually hidden by the development control");
    clock.until(() => Boolean(sample().body) && distanceBetween(scene.position(), spawn) < .001,
      "finishing the necessary exit must not depend on automatic life being enabled", 400);
    assert.equal(worldDevStore.getSnapshot().autoLife, false, "the cleanup does not change the user's development setting");
    const returnedAt = scene.position();
    clock.advance(10);
    assert.deepEqual(scene.position(), returnedAt, "after the safe return no new automatic walk begins");
    assert.ok(sample().body, "the character remains visible once his house disappears");
    assert.equal(sample().hasPose("sleep"), false);
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("a separate bush cutout moves to the foreground once without repainting the ground polygon", async () => {
  const { paintNewMap, worldDevStore } = await modules();
  const env = browser();
  try {
    const cutout = { id: "bush-cutout", image: "/test-bush.webp", bounds: { x: 565, y: 585, width: 80, height: 80 } };
    const bush = { ...clearingBush, imageId: cutout.id };
    const map = { ...fixture, terrain: [...fixture.terrain, cutout], bushes: [bush] };
    const groundImage = new Image(), bushImage = new Image();
    const images = new Map([[fixture.terrain[0].image, groundImage], [cutout.image, bushImage]]);
    for (const [label, bushFrame, reducedMotion, showHero, foreground, misplaced = false] of [
      ["idle", undefined, false, true, false],
      ["enter", { id: bush.id, occlude: true, rustle: 0 }, false, true, true],
      ["rustle", { id: bush.id, occlude: false, rustle: .8, elapsed: .5 }, false, true, false],
      ["still without encounter clock", { id: bush.id, occlude: false, rustle: .8 }, true, true, false],
      ["frozen encounter", { id: bush.id, occlude: true, rustle: .8, elapsed: .5 }, true, true, true],
      ["hidden hero", { id: bush.id, occlude: true, rustle: .8 }, false, false, false],
      ["misplaced image", { id: bush.id, occlude: true, rustle: .8 }, false, true, false, true],
    ]) {
      const surface = env.surface();
      paintNewMap(surface.context, images, { ...options, reducedMotion }, 20, false, 0, 0, {
        scene: misplaced ? { ...map, bushes: [{ ...bush, points: bush.points.map(point => ({ x: point.x + 100, y: point.y })) }] } : map,
        state: { ...worldDevStore.getSnapshot(), ...quietClearing, showHero, reducedMotion: reducedMotion ? "on" : "off" },
        clearing: { ...fixture.actor.spawn, pose: "idle", frame: 0, direction: "front", opacity: 1, bush: bushFrame },
      });
      const calls = surface.calls;
      const bodyIndex = calls.findIndex(call => call.method === "drawImage" && call.args.length === 5
        && call.args[0]?.width === 48 && call.args[0]?.height === 48);
      const groundDraws = calls.filter(call => call.method === "drawImage" && call.args[0] === groundImage);
      const bushDraws = calls.filter(call => call.method === "drawImage" && call.args[0] === bushImage);
      assert.equal(groundDraws.length, 1, `${label}: soil and actor are never erased by a second terrain crop`);
      assert.ok(bushDraws.length > 0, `${label}: the cutout remains visible`);
      if (foreground) {
        assert.ok(bodyIndex >= 0);
        assert.ok(bushDraws.every(call => calls.indexOf(call) > bodyIndex), `${label}: no static duplicate behind the moving leaves`);
      } else {
        if (label !== "rustle") assert.equal(bushDraws.length, 1, `${label}: the idle cutout belongs to the terrain pass`);
        if (showHero) assert.ok(bushDraws.every(call => calls.indexOf(call) < bodyIndex), `${label}: leaves stay behind the visible body`);
      }
    }
  } finally { worldDevStore.reset(); env.restore(); }
});

test("foliage insects stay behind an entering hero once in both cameras, while hand and air insects retain their pass", async () => {
  const { paintNewMap, worldDevStore } = await modules();
  const env=browser();
  try {
    const map={...fixture,bushes:[clearingBush]};
    for(const species of ["butterfly","firefly"]) for(const still of [false,true]) for(const view of ["circle","world"]) {
      const night=species==="firefly", support={x:600,y:622};
      const entity={id:"leaf",species,habitatId:"foliage",anchorId:"leaf",mode:"rest",x:600,y:622,size:1.5,
        phase:0,opacity:1,angle:0,vx:0,vy:0};
      const fauna={elapsed:20,dusk:Number(night),visibility:{butterflies:true,fireflies:true},encounter:null,
        habitats:[{id:"foliage",anchors:[{id:"leaf",position:support}]}],
        entities:[entity,{...entity,id:"air",anchorId:null,mode:"fly",x:603},
          {...entity,id:"hand",anchorId:null,mode:"perch",x:605}]};
      for(const occlude of [false,true]) {
        const surface=env.surface();
        paintNewMap(surface.context,new Map(),{...options,view,reducedMotion:still},20,false,0,Number(night),{
          scene:map,fauna,state:{...worldDevStore.getSnapshot(),weather:"clear",timeOfDay:night?"night":"day",
            butterflies:"on",fireflies:"on",birds:"off",reducedMotion:still?"on":"off"},
          clearing:{x:600,y:660,pose:"idle",frame:0,direction:"back",opacity:1,lift:5,
            bush:{id:clearingBush.id,occlude,rustle:0,occupied:true,elapsed:0,bursts:[]}},
        });
        const calls=surface.calls, body=calls.findIndex(call=>call.method==="drawImage"&&call.args[0]?.width===48&&call.args[0]?.height===48);
        assert.ok(body>=0);
        for(const x of [600,603,605]) {
          const draws=calls.map((call,i)=>call.method==="translate"&&call.args[0]===x&&call.args[1]===622?i:-1).filter(i=>i>=0);
          assert.equal(draws.length,1,`${species}/${view}/${still}: each actual insect paints once`);
          assert.equal(draws[0]<body,x===600&&!occlude,`${species}/${view}/${still}: only leaf-supported insects share rear foliage depth`);
        }
      }
    }
  } finally { worldDevStore.reset(); env.restore(); }
});

test("an interrupted basket stays in the paws during attention and a held DEV pose", async () => {
  const { paintNewMap, worldDevStore } = await modules();
  const env = browser();
  try {
    const foot = fixture.actor.spawn, images = new Map([[fixture.terrain[0].image, new Image()]]);
    const life = { mushrooms: [], campfires: [], routine: null, garden: { elapsed: 0, bushes: [], routine: null,
      basket: { position: { x: 700, y: 700 }, homePosition: { x: 700, y: 700 }, size: 14, berries: 3, capacity: 12, held: true } } };
    const before = JSON.stringify(life);
    for (const [reacting, pose] of [[false, "auto"], [true, "auto"], [false, "greet"]]) {
      const surface = env.surface();
      paintNewMap(surface.context, images, { ...options, reducedMotion: false }, 20, reacting, 0, 0, {
        scene: fixture, life, state: { ...worldDevStore.getSnapshot(), ...quietClearing, pose },
        clearing: { ...foot, pose: "idle", frame: 0, direction: "front", opacity: 1 },
      });
      const baskets = surface.calls.filter(call => call.method === "fillRect" && JSON.stringify(call.args) === "[-7,-8,14,7]");
      assert.equal(baskets.length, 1, "occupied paws retain exactly one basket instead of losing it during attention");
      assert.ok(surface.calls.some(call => call.method === "translate" && call.args[0] === foot.x && call.args[1] < foot.y),
        "the carried basket stays with the actor, not its old parking spot");
      assert.equal(JSON.stringify(life), before, "painting cannot place or consume the held basket");
    }
  } finally { worldDevStore.reset(); env.restore(); }
});

test("DEV bush interaction walks, jumps, hides and returns while automatic life stays disabled", async () => {
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD, pixelSprite, clearingActivityFrame } = await modules({
    bushes: [clearingBush], paths: [clearingBushPath],
  });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "dev-bush" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    assert.ok(probe.state.clearing.diagnostics.every(item => item.valid), JSON.stringify(probe.state.clearing.diagnostics));
    const spawn = scene.position(), clock = sceneClock(env), stages = new Set(), poses = new Set();
    worldDevStore.triggerLife("bush");
    assert.deepEqual(scene.position(), spawn, "requesting the scene cannot teleport to its target");
    let hidden = false, lifted = false, returned = false, foreground = false, particles = false;
    for (let index = 0; index < 500 && !returned; index++) {
      clock.step();
      const frame = clearingActivityFrame(probe.state.clearing), sample = sampleHero(scene, env, pixelSprite);
      stages.add(probe.state.clearing.stage);
      for (const pose of ["walk", "jump", "crouch", "shake", "blink"]) if (sample.hasPose(pose)) poses.add(pose);
      lifted ||= frame.lift > 0 && sample.hasPose("jump");
      assert.equal(Boolean(sample.body), frame.opacity > 0, `${probe.state.clearing.stage}: body drawing follows its physical visibility`);
      if (probe.state.clearing.stage !== "home") {
        assert.equal(frame.bush?.occlude, frame.opacity === 0, `${probe.state.clearing.stage}: a route cannot cover an actor that is still in front`);
      }
      if (probe.state.clearing.stage === "bush-hidden") {
        hidden = true;
        assert.equal(frame.opacity, 0, "the tucked actor is fully concealed inside the leaves");
      }
      if (frame.bush?.occlude) {
        foreground = true;
      }
      particles ||= bushParticleDraws(sample).length > 0;
      returned = hidden && probe.state.clearing.stage === "home";
    }
    assert.ok(returned && hidden && lifted && foreground, "the full rendered story includes lift, foliage occlusion, hiding and return");
    for (const stage of ["outbound", "bush-prepare", "bush-enter", "bush-hidden", "bush-exit", "bush-land", "return", "home"]) {
      assert.ok(stages.has(stage), `the scene must visit ${stage}`);
    }
    assert.ok(poses.has("walk") && poses.has("jump") && poses.has("shake"), "travel, jumping and shaking leaves off use distinct sprites");
    assert.ok(particles, "rummaging shakes visible berries out of the foliage");
    assert.deepEqual(scene.position(), spawn);
    assert.equal(worldDevStore.getSnapshot().autoLife, false);
    clock.advance(10);
    assert.deepEqual(scene.position(), spawn, "completing an explicit DEV request does not enable new automatic outings");
    assert.equal(clearingActivityFrame(probe.state.clearing).bush, undefined, "finite berry effects expire even when automatic life stays off");
    assert.equal(bushParticleDraws(sampleHero(scene, env, pixelSprite)).length, 0, "no berries remain permanently in the air");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("an occupied garden tap opens its menu and explicit attention starts a continuous exit", async () => {
  const { mountHabitat, createMapEngine, worldDevStore, connectForestSession, TILED_WORLD, pixelSprite } = await modules({
    bushes: [clearingBush], paths: [clearingBushPath],
  });
  const env = browser(); let scene, probe, engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "bush-touch", view: "world" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const spawn = scene.position(), clock = sceneClock(env), touch = circlePoint(clearingBush.hide);
    assert.equal(scene.hitPet(touch.x, touch.y), false, "an empty bush is not a ghost character touch target");
    worldDevStore.triggerLife("bush");
    clock.until(() => probe.state.clearing.stage === "outbound", "the request begins its authored approach", 20);
    assert.equal(bushMask(sampleHero(scene, env, pixelSprite), clearingBush, true), false,
      "the approach cannot place the entire crown above the character");
    assert.equal(scene.hitPet(touch.x, touch.y), false, "an approach mask does not make the still-empty bush an occupied touch target");
    clock.until(() => probe.state.clearing.stage === "bush-prepare", "the visible resident prepares beside the bush", 200);
    const preparing = circlePoint(scene.position());
    assert.equal(scene.hitVisiblePet(preparing.x, preparing.y), true,
      "the body remains reachable for interruption during preparation");
    clock.until(() => probe.state.clearing.stage === "bush-hidden", "the character enters the actual bush", 200);
    const hiddenSample = sampleHero(scene, env, pixelSprite);
    assert.equal(hiddenSample.body, undefined);
    assert.ok(bushMask(hiddenSample), "the leaves remain visible without a concealed body draw");
    assert.equal(scene.hitPet(touch.x, touch.y), true, "the authored foliage makes its hidden resident reachable");
    const hiddenBody = scene.position(), hiddenBodyTouch = circlePoint(hiddenBody);
    assert.equal(scene.hitVisiblePet(hiddenBodyTouch.x, hiddenBodyTouch.y), false,
      "body coordinates covered by the authored foliage do not become a visible hero target");
    const map = env.surface(400), places = [];
    engine = await createMapEngine(map, initial, place => places.push(place), []);
    engine.control("overview");
    const point = hiddenBody, event = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: point.x * 400 / fixture.width, clientY: point.y * 400 / fixture.height };
    map.events.get("pointerdown")({ ...event, type: "pointerdown" });
    map.events.get("pointerup")({ ...event, type: "pointerup" });
    assert.deepEqual(places, ["garden"], "authored garden geometry opens the same menu even with a hidden resident");
    assert.equal(probe.state.clearing.stage, "bush-hidden", "opening the garden menu preserves the resident's activity");
    engine.notice();
    assert.equal(probe.state.clearing.stage, "bush-exit", "explicit attention wakes the hidden resident");
    assert.ok(distanceBetween(scene.position(), spawn) > 10, "touch does not snap back to the clearing");
    engine.dispose(); engine = null;
    clock.until(() => probe.state.clearing.stage === "bush-land", "the pet physically leaves the foliage", 80);
    for (let index = 0; index < 160; index++) { scene.notice(); clock.step(); }
    assert.deepEqual(scene.position(), spawn, "even repeated touches finish the exit and return");
    assert.equal(scene.hitPet(touch.x, touch.y), false, "departing removes the occupied-bush touch target");
    assert.ok(sampleHero(scene, env, pixelSprite).body);
  } finally { engine?.dispose(); scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a hidden bush resident survives camera handoff and pause without restarting or revealing the actor", async () => {
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD, pixelSprite } = await modules({
    bushes: [clearingBush], paths: [clearingBushPath],
  });
  const env = browser(), scenes = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "shared-bush" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerLife("bush");
    clock.until(() => probe.state.clearing.stage === "bush-hidden", "circle reaches the hidden phase", 200);
    const snapshot = structuredClone(probe.state.clearing);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    await flush();
    assert.deepEqual(probe.state.clearing, snapshot, "opening the world preserves the exact scene phase");
    assert.equal(env.frames.size, 1);
    const circleSample = sampleHero(circle, env, pixelSprite), worldSample = sampleHero(world, env, pixelSprite);
    assert.equal(circleSample.body, undefined); assert.equal(worldSample.body, undefined);
    assert.ok(bushMask(circleSample)); assert.ok(bushMask(worldSample));
    const berries = bushParticleDraws(circleSample);
    assert.ok(berries.length, "handoff occurs with airborne berries, not only an empty effect clock");
    assert.deepEqual(bushParticleDraws(worldSample), berries, "both cameras share each berry's exact position");
    circle.configure({ ...initial, backgrounded: true });
    for (const mode of ["paused", "reducedMotion"]) {
      world.configure({ ...initial, view: "world", [mode]: true });
      const frozen = structuredClone(probe.state.clearing);
      const frozenSample = sampleHero(world, env, pixelSprite);
      clock.step(60_000);
      assert.deepEqual(probe.state.clearing, frozen, `${mode} cannot advance the bush choreography`);
      const stillSample = sampleHero(world, env, pixelSprite);
      assert.ok(bushMask(stillSample), `${mode} keeps the foliage visible`);
      assert.equal(stillSample.body, undefined, `${mode} keeps the actor fully concealed`);
      assert.deepEqual(bushParticleDraws(stillSample), bushParticleDraws(frozenSample), `${mode} freezes the falling berries`);
      assert.equal(frozenSample.body, undefined);
      world.configure({ ...initial, view: "world" }); clock.step();
    }
    const beforeReturn = structuredClone(probe.state.clearing);
    world.dispose(); circle.configure(initial); await flush();
    assert.deepEqual(probe.state.clearing, beforeReturn);
    const resumed = sampleHero(circle, env, pixelSprite);
    assert.equal(resumed.body, undefined); assert.ok(bushMask(resumed));
    clock.until(() => probe.state.clearing.stage === "home", "returning to the circle finishes the existing outing", 240);
    assert.ok(sampleHero(circle, env, pixelSprite).body);
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("water outlines are an independent DEV overlay above night lighting and redraw while paused", async () => {
  const rectangle = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
  const water = { surfaces: [{ id: "river", points: rectangle(900, 950, 100) }],
    exclusions: [{ id: "leaf", points: rectangle(930, 980, 10) }] };
  const { mountHabitat, worldDevStore } = await modules({ water });
  const env = browser(); let scene;
  try {
    worldDevStore.patch({ ...quietClearing, paused: true, timeOfDay: "night", debug: false, debugWater: false });
    const canvas = env.surface();
    scene = mountHabitat(canvas, options, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const sample = () => { const target = env.surface(); scene.paintWorld(target.context); return target.calls; };
    const colors = calls => calls.filter(call => call.method === "strokeStyle").map(call => call.args[0]);
    const generalBounds = calls => calls.some(call => call.method === "strokeRect"
      && call.args.join() === Object.values(fixture.focus).join());
    assert.equal(colors(sample()).includes("#58e5ff"), false);
    const before = canvas.calls.length;
    worldDevStore.patch({ debugWater: true });
    assert.ok(canvas.calls.length > before, "the new toggle redraws the paused circle without a frame loop");
    const outlined = sample();
    assert.ok(colors(outlined).includes("#58e5ff") && colors(outlined).includes("#ff997e"), "water and exclusions have distinct outlines");
    assert.equal(generalBounds(outlined), false, "water debugging does not enable all map markup");
    assert.ok(outlined.findIndex(call => call.method === "strokeStyle" && call.args[0] === "#58e5ff")
      > outlined.findIndex(call => call.method === "globalCompositeOperation" && call.args[0] === "multiply"),
    "night shading cannot hide the debug boundaries");
    worldDevStore.patch({ debugWater: false, debug: true });
    const marked = sample();
    assert.equal(colors(marked).includes("#58e5ff"), false);
    assert.equal(generalBounds(marked), true, "ordinary markup stays independently available");
    assert.equal(env.frames.size, 0);
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("a real insect is painted once through contact, camera handoff, pause and a reduced-motion tap", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } =
    await modules({ habitats: livingHabitats, navigation: livingNavigation });
  const env = browser(), scenes = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, butterflies: "on" });
    const initial = { ...options, reducedMotion: false, presenceKey: "persistent-visitor" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const ids = probe.state.fauna.entities.map(entity => entity.id), clock = sceneClock(env);
    worldDevStore.triggerLife("butterfly");
    clock.until(() => probe.state.fauna.encounter !== null, "a DEV request reserves a nearby real body");
    const partner = probe.state.fauna.entities.find(entity => entity.id === probe.state.fauna.encounter.entityId);
    const reservation = probe.state.fauna.encounter;
    clock.until(() => probe.state.fauna.encounter?.phase === "perch", "the individual physically reaches the paw");
    assert.equal(probe.state.life.routine, null);
    const contact = sampleHero(circle, env, pixelSprite);
    assert.equal(contact.hasPose("greet"), true);
    assert.equal(contact.calls.filter(call => call.method === "translate" && call.args[0] === partner.x && call.args[1] === partner.y).length, 1,
      "the ambient painter paints the reserved body exactly once");
    const atContact = structuredClone(probe.state.fauna);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world); await flush();
    assert.equal(env.frames.size, 1); assert.equal(probe.state.fauna.encounter, reservation);
    assert.deepEqual(probe.state.fauna, atContact, "mounting the other camera cannot advance or recreate the visitor");
    const otherContact = sampleHero(world, env, pixelSprite);
    assert.equal(otherContact.body.args[0], contact.body.args[0]);
    assert.equal(otherContact.calls.filter(call => call.method === "translate" && call.args[0] === partner.x && call.args[1] === partner.y).length, 1);
    worldDevStore.patch({ paused: true });
    const paused = structuredClone(probe.state); clock.step(60_000); assert.deepEqual(probe.state, paused);
    worldDevStore.patch({ paused: false, reducedMotion: "on" });
    const still = structuredClone(probe.state); clock.step(60_000); assert.deepEqual(probe.state, still);
    const coordinates = probe.state.fauna.entities.map(({ id, x, y }) => ({ id, x, y }));
    world.notice();
    assert.equal(probe.state.fauna.encounter, null);
    assert.deepEqual(probe.state.fauna.entities.map(({ id, x, y }) => ({ id, x, y })), coordinates,
      "a static greeting releases the paw constraint at the insect's exact world position");
    clock.step(60_000);
    assert.deepEqual(probe.state.fauna.entities.map(({ id, x, y }) => ({ id, x, y })), coordinates);
    worldDevStore.patch({ reducedMotion: "off" }); clock.advance(.1);
    assert.equal(partner.mode, "depart");
    assert.ok(distanceBetween(partner, coordinates.find(entity => entity.id === partner.id)) < 1.2);
    assert.deepEqual(probe.state.fauna.entities.map(entity => entity.id), ids);
    assert.equal(probe.state.fauna.entities.find(entity => entity.id === partner.id), partner);
    env.visibility(true); const hidden = structuredClone(probe.state); clock.step(60_000); assert.deepEqual(probe.state, hidden);
    env.visibility(false); world.dispose(); await flush();
    assert.equal(env.frames.size, 1); assert.equal(probe.state.fauna.entities.find(entity => entity.id === partner.id), partner);
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("visible taps let the same insect depart before the actor greets and repeated taps cannot restart release", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, clearingActivityFrame } = await modules({ habitats: livingHabitats });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, butterflies: "on" });
    const initial = { ...options, reducedMotion: false, presenceKey: "visitor-attention" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const clock = sceneClock(env); worldDevStore.triggerLife("butterfly");
    clock.until(() => probe.state.fauna.encounter?.phase === "perch", "the real butterfly reaches contact");
    const partner = probe.state.fauna.entities.find(entity => entity.id === probe.state.fauna.encounter.entityId);
    const point = { x: partner.x, y: partner.y }, feet = scene.position();
    scene.notice(); assert.equal(probe.state.pendingAttention, true);
    assert.deepEqual({ x: partner.x, y: partner.y }, point, "the tap does not teleport the perched body");
    for (let index = 0; index < 13; index++) { scene.notice(); clock.step(); }
    assert.equal(probe.state.fauna.encounter, null); assert.equal(probe.state.pendingAttention, false);
    assert.equal(partner.mode, "depart"); assert.equal(clearingActivityFrame(probe.state.clearing).attention, true);
    assert.deepEqual(scene.position(), feet);
    assert.equal(probe.state.life.routine, null);
    assert.equal(probe.state.fauna.entities.find(entity => entity.id === partner.id), partner);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV navigation comparison and independent living overlays redraw a paused scene without advancing it", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } =
    await modules({ navigation: livingNavigation, habitats: livingHabitats, paths: [clearingPath], mushrooms: [] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, presenceKey: "living-overlays" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    probe.state.life.leaf = null;
    const clock = sceneClock(env), home = scene.position();
    clock.until(() => probe.state.clearing.stage === "free-walk" && distanceBetween(scene.position(), home) > 3, "free movement begins");
    const beforeSwitch = scene.position(); worldDevStore.patch({ navigationMode: "routes" });
    assert.deepEqual(scene.position(), beforeSwitch);
    clock.until(() => !probe.state.clearing.navigationEnabled, "the DEV route mode takes effect after a physical return");
    assert.ok(distanceBetween(scene.position(), home) < 1);
    clock.until(() => probe.state.clearing.stage === "outbound", "the old authored route can still be compared");
    worldDevStore.patch({ navigationMode: "auto" });
    clock.until(() => probe.state.clearing.navigationEnabled, "free navigation can be restored safely");
    worldDevStore.patch({ paused: true, debugNavigation: true, debugFauna: false });
    const frozen = structuredClone(probe.state), nav = env.surface(); scene.paintWorld(nav.context);
    assert.ok(nav.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#78edb0"));
    assert.equal(nav.calls.some(call => call.method === "fillText" && String(call.args[0]).includes("test-flowers")), false);
    worldDevStore.patch({ debugNavigation: false, debugFauna: true });
    const fauna = env.surface(); scene.paintWorld(fauna.context);
    assert.ok(fauna.calls.some(call => call.method === "fillText" && String(call.args[0]).includes(probe.state.fauna.entities[0].id)));
    assert.equal(fauna.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#78edb0"), false);
    assert.deepEqual(probe.state, frozen); assert.equal(env.frames.size, 0);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("static night and DEV lighting edits update real firefly glow without advancing their bodies", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules({ habitats: livingHabitats });
  const env = browser(); let scene, probe;
  function glowFrame() {
    const base = env.surface().context, values = []; let fillStyle, alpha = 1;
    const context = new Proxy(base, {
      get(target, key) {
        if (key === "createRadialGradient") return () => ({ firefly: false,
          addColorStop(_at, color) { if (color === "rgba(225,246,147,.48)") this.firefly = true; } });
        if (key === "fill") return () => { if (fillStyle?.firefly) values.push(alpha); };
        return target[key];
      },
      set(target, key, value) {
        if (key === "fillStyle") fillStyle = value;
        if (key === "globalAlpha") alpha = value;
        target[key] = value; return true;
      },
    });
    scene.paintWorld(context); return values;
  }
  try {
    worldDevStore.patch({ ...quietClearing, timeOfDay: "auto", fireflies: "auto", autoLife: false });
    const initial = { ...options, dusk: true, presenceKey: "static-night-fireflies" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 1, () => {});
    const frozen = structuredClone(probe.state.fauna), night = glowFrame();
    assert.equal(night.length, 3); assert.ok(night.every(alpha => alpha > 0), "a first static night frame has luminous real insects");
    worldDevStore.patch({ timeOfDay: "day" });
    assert.deepEqual(glowFrame(), [], "daylight hides the nocturnal population entirely");
    worldDevStore.patch({ fireflies: "on" });
    assert.deepEqual(glowFrame(), [], "DEV on cannot show nocturnal insects during the day");
    worldDevStore.patch({ timeOfDay: "night" });
    assert.equal(glowFrame().length, 3); assert.ok(glowFrame().every(alpha => alpha > 0), "a frozen frame reflects the current night immediately");
    assert.deepEqual(probe.state.fauna, frozen); assert.equal(env.frames.size, 0);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("saved house progression selects both cameras, preserves memory and commits new geometry only with its artwork", async () => {
  const geometry = offset => ({
    bounds: { ...clearingHome.bounds, x: clearingHome.bounds.x + offset },
    anchor: { ...clearingHome.anchor, x: clearingHome.anchor.x + offset },
    entry: { ...clearingHome.entry, x: clearingHome.entry.x + offset },
    doorway: { ...clearingHome.doorway, x: clearingHome.doorway.x + offset },
    collision: clearingHome.collision.map(point => ({ ...point, x: point.x + offset })),
    hitArea: clearingHome.hitArea.map(point => ({ ...point, x: point.x + offset })),
  });
  const site = { ...clearingHome, initialLevel: 2, states: [1, 2].map(level => ({ level,
    label: `Level ${level}`, image: `/account-home-${level}.webp`, geometry: geometry((level - 1) * 50) })) };
  const navigation = { ...livingNavigation, areas: [{ id: "clearing", points: [
    { x: 570, y: 610 }, { x: 780, y: 610 }, { x: 780, y: 735 }, { x: 570, y: 735 },
  ] }] };
  const { mountHabitat, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore } = await modules({ sites: [site], navigation });
  const env = browser(), scenes = [], probes = [], saved = new Map();
  window.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  try {
    const initial = { ...options, presenceKey: "progression-scene", worldState: { houseLevel: 1 } };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    assert.deepEqual(env.requests, ["/test-ground.webp", "/account-home-1.webp"], "authored preview level cannot override the account");
    env.finish(); const first = env.finish(); await flush();
    const probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 1 }), "circle", 0, 0, () => {}); probes.push(probe);
    assert.equal(probe.state.memory.enabled, true);
    probe.state.clearing.behavior.mind.needs.energy = .42;
    const building = scene => {
      const surface = env.surface(); scene.paintWorld(surface.context);
      return surface.calls.findLast(call => call.method === "drawImage" && call.args[0] instanceof Image && call.args.length === 5).args;
    };
    const upgraded = { ...initial, worldState: { houseLevel: 2 } };
    circle.configure(upgraded); world.configure({ ...upgraded, view: "world" });
    assert.deepEqual(building(circle), [first, 620, 580, 80, 70], "an in-flight replacement never reveals unready geometry");
    assert.equal(probe.state.clearing.interactions.home.entry.x, 650);
    const second = env.finishPath("/account-home-2.webp"); await flush();
    const current = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 2 }), "circle", 0, 0, () => {}); probes.push(current);
    assert.equal(current.state.memory.enabled, true, "a legitimate upgrade keeps memory saving enabled");
    assert.equal(current.state.clearing.behavior.mind.needs.energy, .42, "geometry reconciliation preserves needs");
    assert.equal(current.state.clearing.interactions.home.entry.x, 700);
    assert.deepEqual(building(circle), [second, 670, 580, 80, 70]);
    assert.deepEqual(building(world), building(circle));
    worldDevStore.patch({ previewBuildings: true, levels: { home: 1 } }); await flush();
    assert.deepEqual(building(circle), [first, 620, 580, 80, 70], "an explicit preview overrides saved progression");
    worldDevStore.reset(); await flush();
    assert.deepEqual(building(circle), [second, 670, 580, 80, 70], "DEV reset returns to the saved account level");
  } finally { scenes.forEach(scene => scene.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("account house levels fall back to available art and explicit DEV can preview the authored initial level", async () => {
  const site = { ...clearingHome, states: [1, 3, 5].map(level => ({ level, label: `Level ${level}`, image: `/fallback-${level}.png` })) };
  const { accountSceneLevels, TILED_WORLD, WORLD_DEV_DEFAULTS } = await modules({ sites: [site] });
  assert.equal(accountSceneLevels(TILED_WORLD, 4, WORLD_DEV_DEFAULTS).home, 3);
  assert.equal(accountSceneLevels(TILED_WORLD, 99, WORLD_DEV_DEFAULTS).home, 5);
  for (const invalid of [NaN, Infinity, -1, 1.5, undefined]) assert.equal(accountSceneLevels(TILED_WORLD, invalid).home, 1);
  assert.equal(accountSceneLevels(TILED_WORLD, 5, { ...WORLD_DEV_DEFAULTS, previewBuildings: true }).home, 1);
});

test("confirmed economy levels include ruins, keep missing buildings authored and preserve home and DEV fallbacks", async () => {
  const sites = [clearingHome, productionSite("workshop", 380), productionSite("quarry", 800, [0, 1]), productionSite("lighthouse", 100)];
  const { accountSceneLevels, TILED_WORLD, WORLD_DEV_DEFAULTS } = await modules({ sites });
  const authored = { home: 1, workshop: 1, quarry: 1, lighthouse: 1 };
  assert.deepEqual(accountSceneLevels(TILED_WORLD, undefined, WORLD_DEV_DEFAULTS), authored);
  for (const level of [0, 1, 2, 5]) {
    const selected = accountSceneLevels(TILED_WORLD, 1, WORLD_DEV_DEFAULTS, { workshop: level, quarry: level, unplaced: 5 });
    assert.deepEqual(selected, { ...authored, workshop: Math.min(level, 2), quarry: Math.min(level, 1) });
  }
  for (const invalid of [NaN, Infinity, -1, 1.5, undefined]) {
    assert.deepEqual(accountSceneLevels(TILED_WORLD, 1, WORLD_DEV_DEFAULTS, { workshop: invalid, quarry: invalid }), authored);
  }
  const home = { ...clearingHome, states: [1, 3, 5].map(level => ({ level, label: `Home ${level}`, image: `/fallback-home-${level}.webp` })) };
  const scene = { ...TILED_WORLD, sites: [home, ...sites.slice(1)] };
  assert.equal(accountSceneLevels(scene, 3, WORLD_DEV_DEFAULTS, null).home, 3, "legacy house remains usable while economy is loading");
  assert.equal(accountSceneLevels(scene, 3, WORLD_DEV_DEFAULTS, { home: 5 }).home, 5, "confirmed economy wins over an older legacy snapshot");
  assert.equal(accountSceneLevels(scene, 3, WORLD_DEV_DEFAULTS, { home: 0 }).home, 1, "missing lower artwork keeps the earliest authored home");
  const economy = { home: 5, workshop: 2, quarry: 0 };
  assert.deepEqual(accountSceneLevels(scene, 3, { ...WORLD_DEV_DEFAULTS, previewBuildings: true }, economy), authored,
    "explicit DEV can preview initial levels even when they differ from confirmed progression");
  assert.deepEqual(accountSceneLevels(scene, 3, { ...WORLD_DEV_DEFAULTS, levels: { ...authored, workshop: 0 } }, economy),
    { ...authored, workshop: 0 }, "existing implicit DEV level selection retains priority");
  assert.deepEqual(accountSceneLevels(scene, 3, WORLD_DEV_DEFAULTS, { lighthouse: 2 }), { ...authored, home: 3, lighthouse: 2 },
    "the same rule supports a future confirmed building without inventing an economy for it");
});

test("confirmed production levels switch artwork and collision together in both views, preserving progress on load failure", async () => {
  const sites = [productionSite("workshop", 380), productionSite("quarry", 800, [0, 1])];
  const navigation = { ...livingNavigation, areas: [{ id: "production-clearing", points: [
    { x: 300, y: 200 }, { x: 1100, y: 200 }, { x: 1100, y: 1050 }, { x: 300, y: 1050 },
  ] }] };
  const { mountHabitat, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore, isWalkable } = await modules({ sites, navigation });
  const env = browser(), scenes = [], probes = [], images = new Map(), saved = new Map();
  window.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  try {
    const initial = { ...options, presenceKey: "production-account", economyBuildings: { workshop: 0, quarry: 0 } };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    const finish = (id, level, error = false) => {
      const path = `/account-${id}-${level}.webp`, image = env.finishPath(path, error);
      if (!error) images.set(path, image);
    };
    env.finishPath("/test-ground.webp"); finish("workshop", 0); finish("quarry", 0); await flush();
    const rendered = (scene, id) => {
      const surface = env.surface(); scene.paintWorld(surface.context);
      return surface.calls.filter(call => call.method === "drawImage" && call.args.length === 5)
        .find(call => [...images].some(([path, image]) => path.startsWith(`/account-${id}-`) && call.args[0] === image))?.args;
    };
    const check = (id, level) => {
      const geometry = sites.find(site => site.id === id).states.find(state => state.level === level).geometry;
      for (const scene of scenes) {
        assert.deepEqual(rendered(scene, id), [images.get(`/account-${id}-${level}.webp`), geometry.bounds.x, geometry.bounds.y, 80, 70]);
        assert.deepEqual(scene.siteAnchor(id), geometry.anchor);
        assert.equal(scene.hitSite({ x: geometry.bounds.x + 40, y: geometry.bounds.y + 20 }), id);
      }
    };
    check("workshop", 0); check("quarry", 0);
    const initialProbe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, initial.economyBuildings), "circle", 0, 0, () => {}); probes.push(initialProbe);
    initialProbe.state.clearing.behavior.mind.needs.energy = .42;
    const configure = buildings => {
      circle.configure({ ...initial, economyBuildings: buildings });
      world.configure({ ...initial, view: "world", economyBuildings: buildings });
    };
    configure({ workshop: 1, quarry: 1 });
    finish("workshop", 1); await flush();
    check("workshop", 0); check("quarry", 0);
    finish("quarry", 1); await flush();
    check("workshop", 1); check("quarry", 1);
    const current = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { workshop: 1, quarry: 1 }), "circle", 0, 0, () => {}); probes.push(current);
    assert.equal(current.state.memory.enabled, true, "confirmed production changes preserve account memory");
    assert.equal(current.state.clearing.behavior.mind.needs.energy, .42);
    assert.equal(isWalkable(current.state.clearing.navigation, { x: 440, y: 430 }), true, "the old workshop footprint is released");
    assert.equal(isWalkable(current.state.clearing.navigation, { x: 560, y: 430 }), false, "the confirmed workshop footprint blocks navigation");
    configure({ workshop: 2, quarry: 5 });
    finish("workshop", 2, true); await flush();
    check("workshop", 1); check("quarry", 1);
    assert.ok(worldDevStore.getSnapshot().artError);
    configure({ workshop: 2, quarry: 5 });
    finish("workshop", 2); await flush();
    check("workshop", 2); check("quarry", 1);
    const requests = env.requests.length;
    configure({ workshop: 5, quarry: 5 }); await flush();
    check("workshop", 2); check("quarry", 1);
    assert.equal(env.requests.length, requests, "higher confirmed levels never request unauthored artwork");
    worldDevStore.patch({ previewBuildings: true, levels: { workshop: 0, quarry: 0 } }); await flush();
    check("workshop", 0); check("quarry", 0);
    worldDevStore.reset(); await flush();
    check("workshop", 2); check("quarry", 1);
  } finally { scenes.forEach(scene => scene.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("map production clicks and accessible anchors follow only the loaded confirmed building level", async () => {
  const sites = [productionSite("workshop", 380), productionSite("quarry", 800, [0, 1])];
  const { createMapEngine } = await modules({ sites });
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), places = [], initial = { ...options, economyBuildings: { workshop: 0, quarry: 0 } };
    const anchors = sites.map(site => ({ dataset: { siteId: site.id, kind: site.id }, style: {} }));
    const loading = createMapEngine(canvas, initial, place => places.push(place), anchors);
    env.finish(); await flush(); env.finishPath("/account-workshop-0.webp"); env.finishPath("/account-quarry-0.webp"); engine = await loading;
    engine.control("overview");
    const tap = (x, y) => {
      const event = { pointerId: 1, pointerType: "mouse", button: 0, clientX: x * 400 / fixture.width, clientY: y * 400 / fixture.height };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    for (const site of sites) tap(440, site.bounds.y + 20);
    assert.deepEqual(places, ["workshop", "quarry"]);
    const previous = anchors.map(anchor => anchor.style.transform);
    engine.update({ ...initial, economyBuildings: { workshop: 1, quarry: 1 } });
    for (const site of sites) tap(560, site.bounds.y + 20);
    assert.equal(places.length, 2, "unloaded geometry cannot receive production clicks");
    assert.deepEqual(anchors.map(anchor => anchor.style.transform), previous);
    env.finishPath("/account-workshop-1.webp"); env.finishPath("/account-quarry-1.webp"); await flush();
    for (const site of sites) tap(440, site.bounds.y + 20);
    assert.equal(places.length, 2, "the old hit areas disappear after the confirmed replacement");
    for (const site of sites) tap(560, site.bounds.y + 20);
    assert.deepEqual(places, ["workshop", "quarry", "workshop", "quarry"]);
    anchors.forEach((anchor, index) => assert.notEqual(anchor.style.transform, previous[index]));
  } finally { engine?.dispose(); env.restore(); }
});

test("exploration hides the shared hero, releases carried props, advances ecology and returns on server time", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, pixelSprite, getForestObservation } = await modules({ habitats: livingHabitats });
  const env = browser(), scenes = [], saved = new Map(); let probe;
  window.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  try {
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "exploring-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    const basket = { position: { x: 680, y: 700 }, approach: { x: 660, y: 700 }, homePosition: { x: 680, y: 700 },
      homeApproach: { x: 660, y: 700 }, size: 14, berries: 3, capacity: 12, held: true };
    probe.state.life.garden.basket = basket;
    const journey = { id: "exploration-1", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(160_000).toISOString(), label: "Разведка лесной тропы" };
    const travelling = { ...initial, economyJourney: journey };
    const before = circle.position(), lifeBefore = probe.state.life.elapsed;
    circle.configure(travelling);
    const world = mountHabitat(env.surface(), { ...travelling, view: "world" }, callbacks); scenes.push(world); await flush();
    const heroElapsed = probe.state.clearing.elapsed, needs = structuredClone(probe.state.clearing.behavior.mind.needs);
    assert.equal(basket.held, false, "the basket is placed beside the actual feet before departure");
    assert.equal(basket.berries, 3, "departure cannot lose delivered fruit");
    for (const scene of [circle, world]) {
      assert.equal(sampleHero(scene, env, pixelSprite).body, undefined);
      assert.equal(scene.hitPet(.5, .5), false); scene.notice();
    }
    const clock = sceneClock(env); clock.advance(2);
    assert.equal(probe.state.reaction, 0, "tapping cannot spawn a second hero on the clearing");
    assert.equal(probe.state.clearing.elapsed, heroElapsed, "autonomous hero actions stay paused");
    assert.deepEqual(probe.state.clearing.behavior.mind.needs, needs);
    assert.deepEqual(circle.position(), before, "departure never writes an imaginary off-map position");
    assert.ok(probe.state.life.elapsed > lifeBefore, "mushrooms and forest ecology keep their clock");
    assert.ok(probe.state.fauna.elapsed > 0);
    assert.equal(probe.state.memory.enabled, true, "exploration is not a DEV memory override");
    assert.equal(getForestObservation(initial.presenceKey).activity, "В исследовании");
    probe.saveMemory();
    assert.equal([...saved.values()].some(value => value.includes("exploration-1")), false, "the cosmetic snapshot cannot own an economic job");
    world.configure({ ...travelling, view: "world", reducedMotion: true });
    circle.configure({ ...travelling, backgrounded: true });
    world.setTime(160_000);
    assert.ok(sampleHero(world, env, pixelSprite).body, "server completion returns the hero even without animation frames or a reward claim");
    assert.equal(probe.state.explorationId, null);
    assert.equal(probe.state.clearing.idleSeconds, 0);
    assert.equal(basket.berries, 3);
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); env.restore(); }
});

test("exploration server clock corrects backwards independently of the monotonic forest clock", async () => {
  const { mountHabitat, pixelSprite } = await modules();
  const env = browser(); let scene;
  try {
    const journey = { id: "corrected-clock", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(160_000).toISOString() };
    const initial = { ...options, serverNow: 1_000_000, economyJourney: journey };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    assert.ok(sampleHero(scene, env, pixelSprite).body, "initial inaccurate client time is ahead of the deadline");
    scene.setTime(110_000);
    assert.equal(sampleHero(scene, env, pixelSprite).body, undefined, "a server sample behind client time restores the real active exploration");
    scene.configure(initial);
    assert.equal(sampleHero(scene, env, pixelSprite).body, undefined, "visibility/configuration with an old sample cannot replace the newer server clock");
    scene.setTime(160_000);
    assert.ok(sampleHero(scene, env, pixelSprite).body, "authoritative completion returns the hero in reduced motion");
    scene.configure({ ...initial, serverNow: 120_000 });
    assert.equal(sampleHero(scene, env, pixelSprite).body, undefined, "configure also accepts a fresh authoritative correction");
  } finally { scene?.dispose(); env.restore(); }
});

test("map selection uses committed house geometry and home activation wakes a sleeping resident", async () => {
  const geometry = offset => ({
    bounds: { ...clearingHome.bounds, x: clearingHome.bounds.x + offset },
    anchor: { ...clearingHome.anchor, x: clearingHome.anchor.x + offset },
    entry: { ...clearingHome.entry, x: clearingHome.entry.x + offset },
    doorway: { ...clearingHome.doorway, x: clearingHome.doorway.x + offset },
    collision: clearingHome.collision.map(point => ({ ...point, x: point.x + offset })),
    hitArea: clearingHome.hitArea.map(point => ({ ...point, x: point.x + offset })),
  });
  const site = { ...clearingHome, states: [1, 2].map(level => ({ level, label: `Level ${level}`,
    image: `/click-home-${level}.webp`, geometry: geometry((level - 1) * 100) })) };
  const { createMapEngine, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore } = await modules({
    sites: [site], paths: [clearingHomePath],
  });
  const env = browser(); let engine, probe;
  try {
    const canvas = env.surface(400), places = [], selections = [], initial = { ...options, reducedMotion: false, presenceKey: "click-home", worldState: { houseLevel: 1 } };
    const anchor = { dataset: { objectId: "home", kind: "house" }, style: {} };
    const loading = createMapEngine(canvas, initial, place => places.push(place), [anchor], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/click-home-1.webp"); engine = await loading;
    engine.control("overview");
    const tap = (x, y) => {
      const event = { pointerId: 1, pointerType: "mouse", button: 0, clientX: x * 400 / fixture.width, clientY: y * 400 / fixture.height };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    tap(630, 600); assert.deepEqual(places, ["house"], "clicking the awake household opens construction");
    probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 1 }), "circle", 0, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerLife("home-sleep");
    clock.until(() => probe.state.clearing.stage === "home-sleep", "the hero reaches the authored home", 600);
    tap(630, 600);
    assert.deepEqual(places, ["house", "house"], "the same target opens the house menu while its resident sleeps");
    assert.equal(probe.state.clearing.stage, "exiting", "house activation wakes the resident without blocking construction");
    clock.until(() => probe.state.clearing.routeKind !== "home", "waking finishes the real exit", 600);
    const previousAnchor = anchor.style.transform;
    const previousSelection = selections.at(-1), selectionCount = selections.length;
    engine.update({ ...initial, worldState: { houseLevel: 2 } });
    assert.equal(anchor.style.transform, previousAnchor, "pending art cannot move the accessible shortcut either");
    assert.deepEqual(selections.at(-1), previousSelection, "pending art preserves the selected object's committed anchor");
    assert.equal(selections.length, selectionCount, "waiting for new art cannot publish a speculative selection");
    tap(730, 600); assert.equal(places.length, 2, "pending artwork cannot expose the new hit area");
    engine.setSelectedObject("home");
    env.finishPath("/click-home-2.webp"); await flush();
    assert.equal(selections.at(-1).objectId, "home");
    assert.notEqual(selections.at(-1).x, previousSelection.x, "selection follows the new anchor as its image commits");
    tap(630, 600); canvas.flushFrame(); assert.equal(places.length, 2, "the old hit area disappears with old art");
    assert.notEqual(anchor.style.transform, previousAnchor, "the shortcut follows committed geometry");
    tap(730, 600); assert.deepEqual(places, ["house", "house", "house"]);
    worldDevStore.patch({ showBuildings: false }); tap(730, 600);
    assert.equal(places.length, 3, "hidden buildings have no ghost click target");
    assert.equal(selections.at(-1), null, "hiding a selected building closes its map selection");
    assert.equal(engine.activateObject("home"), false, "a hidden shortcut cannot activate a removed target");
    assert.equal(places.length, 3);
    assert.equal(anchor.style.visibility, "hidden");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("economic garden uses wall time in both cameras and emits one harvest fallback across handoff", async () => {
  const bushes = [{ id: "economic-bush", points: [{ x: 602, y: 617 }, { x: 642, y: 617 }, { x: 642, y: 647 }, { x: 602, y: 647 }],
    entry: { x: 591, y: 650 }, hide: { x: 622, y: 643 } }];
  const { mountHabitat, connectForestSession, TILED_WORLD } = await modules({ bushes, navigation: livingNavigation });
  const env = browser(), views = [], events = [];
  let probe;
  try {
    const end = Date.parse("2026-10-04T12:00:00Z");
    const crop = { jobId: "crop-scene", startedAt: new Date(end - 600000).toISOString(), finishesAt: new Date(end).toISOString() };
    const request = { requestId: 1, jobId: crop.jobId };
    const initial = { ...options, serverNow: end, presenceKey: "garden-controller-account", economyGarden: crop,
      gardenHarvestRequest: request, onGardenHarvestEvent: event => events.push(event) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world);
    env.finishPath("/test-ground.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", end, 0, () => {});
    assert.equal(probe.state.life.garden.bushes[0].growth, 1);
    assert.equal(events.length, 1, "reduced motion emits once for the shared session");
    assert.equal(events[0].status, "unavailable");
    for (const view of views) view.paintWorld(env.surface().context);
    world.dispose(); await flush();
    circle.paintWorld(env.surface().context); await flush();
    assert.equal(events.length, 1, "camera handoff cannot restart the same request");
    circle.configure({ ...initial, serverNow: end - 300000, gardenHarvestRequest: null });
    assert.ok(Math.abs(probe.state.life.garden.bushes[0].growth - .49) < .0001, "a corrected server sample owns the displayed growth");
    circle.configure({ ...initial, economyGarden: null, gardenHarvestRequest: null });
    assert.equal(probe.state.life.garden.bushes[0].growth, 0, "claimed crop cannot survive as decorative berries");
  } finally { probe?.release(); views.forEach(view => view.dispose()); env.restore(); }
});

test("berry collection skips a distant walk and a fishing ending immediately in both cameras", async () => {
  const bushes = [{ id: "economic-bush", points: [{ x: 602, y: 617 }, { x: 642, y: 617 }, { x: 642, y: 647 }, { x: 602, y: 647 }],
    entry: { x: 591, y: 650 }, hide: { x: 622, y: 643 } }];
  const navigation = { ...livingNavigation, areas: [
    { id: "home-clearing", points: [{ x: 570, y: 610 }, { x: 660, y: 610 }, { x: 660, y: 735 }, { x: 570, y: 735 }] },
    { id: "far-path", points: [{ x: 650, y: 610 }, { x: 850, y: 610 }, { x: 850, y: 735 }, { x: 650, y: 735 }] },
  ] };
  const { mountHabitat, connectForestSession, forestJourneyFishingFrame, TILED_WORLD } = await modules({ bushes, navigation });
  for (const view of ["circle", "world"]) for (const activity of ["roaming", "returning", "fishing-ending"]) {
    const env = browser(), events = []; let habitat, probe;
    try {
      const end = Date.parse("2026-10-04T12:00:00Z");
      const crop = { jobId: "crop-away", startedAt: new Date(end - 600000).toISOString(), finishesAt: new Date(end).toISOString() };
      const initial = { ...options, view, reducedMotion: false, serverNow: end,
        presenceKey: `garden-away-${view}-${activity}`, economyGarden: crop, onGardenHarvestEvent: event => events.push(event) };
      habitat = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
      if (view === "circle" && activity === "roaming") env.finishPath("/test-ground.webp");
      await flush();
      probe = connectForestSession(initial.presenceKey, TILED_WORLD, view, end, 0, () => {});
      const state = probe.state, garden = state.life.garden;
      state.clearing.position = { x: 790, y: 700 }; state.clearing.stage = "clearing";
      const travel = { jobId: "finished-fishing", phase: activity === "returning" ? "returning" : "fishing",
        shore: { ...state.clearing.position }, home: { ...state.clearing.home }, scene: TILED_WORLD,
        finishesAt: end - 1, beganAt: state.clearing.elapsed, fishingAt: state.director.elapsed,
        waterTarget: { x: 830, y: 720 }, requested: false };
      if (activity !== "roaming") {
        state.explorationId = null; state.journeyTravel = travel;
        if (activity === "fishing-ending") travel.ending = { settleAt: state.director.elapsed + 1,
          endsAt: state.director.elapsed + 4, finishAge: 0, source: forestJourneyFishingFrame(state, TILED_WORLD) };
      }
      const position = { ...state.clearing.position }, basket = structuredClone(garden.basket);
      habitat.configure({ ...initial, gardenHarvestRequest: { requestId: 1, jobId: crop.jobId } });
      await flush();
      assert.deepEqual(events.map(event => event.status), ["unavailable"], `${view}/${activity}: no watchdog or tackle wait`);
      assert.equal(garden.harvest, null); assert.equal(garden.routine, null); assert.equal(state.pendingLife, null);
      assert.deepEqual(state.clearing.position, position); assert.deepEqual(garden.basket, basket);
      if (activity !== "roaming") assert.equal(state.journeyTravel, travel, "collection cannot cancel a cosmetic return");
      habitat.paintWorld(env.surface().context); await flush();
      assert.equal(events.length, 1, "repaint cannot repeat the fallback");
    } finally { probe?.release(); habitat?.dispose(); env.restore(); }
  }
});

test("background garden snapshots cannot cancel the owner's delivery and a removed job stops pending work", async () => {
  const bushes = [{ id: "economic-bush", points: [{ x: 602, y: 617 }, { x: 642, y: 617 }, { x: 642, y: 647 }, { x: 602, y: 647 }],
    entry: { x: 591, y: 650 }, hide: { x: 622, y: 643 } }];
  const { mountHabitat, connectForestSession, TILED_WORLD } = await modules({ bushes, navigation: livingNavigation });
  const env = browser(), views = [], events = []; let probe;
  try {
    const end = Date.parse("2026-10-04T12:00:00Z");
    const crop = { jobId: "crop-live", startedAt: new Date(end - 600000).toISOString(), finishesAt: new Date(end).toISOString() };
    const initial = { ...options, reducedMotion: false, serverNow: end, presenceKey: "garden-live-handoff", economyGarden: crop,
      gardenHarvestRequest: { requestId: 1, jobId: crop.jobId }, onGardenHarvestEvent: event => events.push(event) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finishPath("/test-ground.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", end, 0, () => {});
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.deepEqual(events.map(event => event.status), ["started"]);
    const garden = probe.state.life.garden;
    assert.equal(garden.harvest.phase, "pending");
    circle.configure({ ...initial, economyGarden: null, gardenHarvestRequest: null });
    circle.paintWorld(env.surface().context);
    assert.equal(garden.production.jobId, crop.jobId);
    assert.equal(garden.harvest.phase, "pending", "a background camera cannot invalidate its owner's accepted request");
    assert.equal(probe.state.pendingLife, "harvest-berries");
    // Simulate a persisted old/fallback routine whose transient request is gone.
    garden.harvest = null;
    garden.routine = { kind: "harvest-berries", bushId: "economic-bush", phase: "take-basket", elapsed: 0, totalElapsed: 1, carryingBasket: false };
    world.configure({ ...initial, view: "world", economyGarden: null, gardenHarvestRequest: null });
    assert.equal(garden.routine, null, "claim response must stop stale visual collection even without its request object");
    assert.equal(probe.state.pendingLife, null);
    assert.equal(garden.bushes[0].growth, 0);
    assert.ok(!events.some(event => event.status === "completed"));
  } finally { probe?.release(); views.forEach(view => view.dispose()); env.restore(); }
});

test("garden handoff waits through lease loading and confirmed lease refusal cancels visible work", async () => {
  const bushes = [{ id: "economic-bush", points: [{ x: 602, y: 617 }, { x: 642, y: 617 }, { x: 642, y: 647 }, { x: 602, y: 647 }],
    entry: { x: 591, y: 650 }, hide: { x: 622, y: 643 } }];
  const { mountHabitat, connectForestSession, TILED_WORLD } = await modules({ bushes, navigation: livingNavigation });
  const env = browser(), views = [], probes = [];
  try {
    for (const refused of [false, true]) {
      const timers = new Map(), events = []; let serial = 0, reads = 0, revision = 0, owned = false, delayedRead, savedSnapshot = null;
      const owner = refused ? "1234-ABCD-EFGJ" : "1234-ABCD-EFGH";
      const key = `zhiv:mochlik:presence:${owner}`, end = Date.parse("2026-10-04T12:00:00Z");
      const crop = { jobId: `crop-${owner}`, startedAt: new Date(end - 600000).toISOString(), finishesAt: new Date(end).toISOString() };
      const serverView = () => ({ ownerPublicId: owner, revision, snapshot: savedSnapshot, serverTime: new Date(end).toISOString(), updatedAt: null,
        lease: { owned: !refused && owned, token: !refused && owned ? "test-lease" : null,
          expiresAt: refused || owned ? new Date(end + 90_000).toISOString() : null } });
      const environment = { now: () => end, randomUUID: () => `00000000-0000-4000-8000-${(++serial).toString().padStart(12, "0")}`,
        setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
      const transport = { async read() {
        if (++reads > 1 && !refused) return new Promise(resolve => { delayedRead = resolve; });
        return serverView();
      }, async command(command) {
        if (command.action === "acquire") owned = true;
        if (command.action === "save") savedSnapshot = command.snapshot;
        if (command.action === "release") owned = false;
        revision++; return { state: serverView(), acceptedRevision: revision, replayed: false };
      } };
      const pump = async () => {
        for (let iteration = 0; iteration < 8; iteration++) {
          const next = [...timers].find(([, timer]) => timer.delay === 0);
          if (!next) break;
          timers.delete(next[0]); next[1].callback(); await flush();
        }
      };
      const probe = connectForestSession(key, TILED_WORLD, "circle", end, 0, () => {}, { sync: { environment, transport } }); probes.push(probe);
      if (refused) {
        probe.state.life.garden.production = crop;
        probe.state.life.garden.harvest = { request: { requestId: 1, jobId: crop.jobId }, phase: "running" };
        probe.state.life.garden.routine = { kind: "harvest-berries", bushId: "economic-bush", phase: "take-basket", elapsed: 0, totalElapsed: 1, carryingBasket: false };
      }
      const initial = { ...options, reducedMotion: false, serverNow: end, presenceKey: key, economyGarden: crop,
        gardenHarvestRequest: { requestId: 1, jobId: crop.jobId }, onGardenHarvestEvent: event => events.push(event) };
      const callbacks = { activity() {}, ready() {}, failure: assert.fail };
      const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
      if (!refused) env.finishPath("/test-ground.webp"); await flush();
      assert.deepEqual(events, [], "loading the lease cannot release an economic claim");
      await pump(); await flush();
      if (refused) {
        assert.equal(probe.state.memory.sync.mode, "other-device");
        assert.deepEqual(events.map(event => event.status), ["unavailable"]);
        assert.equal(probe.state.life.garden.routine, null, "real fallback cannot leave a basket pickup running");
        continue;
      }
      assert.deepEqual(events.map(event => event.status), ["started"]);
      const sameGarden = probe.state.life.garden, sameClearing = probe.state.clearing;
      const actualFeet = { ...sameClearing.position };
      circle.configure({ ...initial, backgrounded: true });
      const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
      assert.equal(probe.state.memory.sync.mode, "loading");
      assert.deepEqual(events.map(event => event.status), ["started"], "visible camera handoff is not an unavailable event");
      await pump();
      assert.equal(typeof delayedRead, "function");
      assert.ok(savedSnapshot, "handoff rereads a real saved forest snapshot");
      delayedRead(serverView()); await flush(); await pump(); await flush();
      assert.equal(probe.state.memory.sync.mode, "synced");
      assert.deepEqual(events.map(event => event.status), ["started"]);
      assert.equal(probe.state.life.garden, sameGarden, "same live lease preserves the actual delivery, not a restarted substitute");
      assert.equal(probe.state.clearing, sameClearing);
      assert.deepEqual(probe.state.clearing.position, actualFeet, "camera handoff never resets the feet");
      assert.equal(probe.state.life.garden.harvest.phase, "pending");
    }
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); env.restore(); }
});

test("water physics accepts wet taps and freezes disturbances during pause reduced motion and backgrounding", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(waterPhysicsFixture());
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, waterWind: "calm", waterFish: "off" });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "water-disturbances" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const wet = { x: 1030, y: 1030 };
    assert.equal(scene.disturbWater(wet), true);
    const water = probe.state.water;
    assert.ok(waterEnergy(water) > 0, "the real shared surface receives energy from a tap");
    const snapshot = structuredClone(water);
    for (const point of [{ x: 800, y: 1000 }, { x: 960, y: 960 }, { x: NaN, y: 1000 }]) {
      assert.equal(scene.disturbWater(point), false, "dry ground, exclusions and invalid coordinates reject impulses");
    }
    assert.deepEqual(water, snapshot);
    for (const change of [{ paused: true }, { reducedMotion: true }, { backgrounded: true }]) {
      scene.configure({ ...initial, ...change });
      assert.equal(scene.disturbWater(wet), false);
      env.tick(1000);
      assert.deepEqual(water, snapshot, "an inactive surface cannot accumulate input or simulation time");
    }
    scene.configure(initial); env.visibility(true);
    assert.equal(scene.disturbWater(wet), false);
    assert.deepEqual(water, snapshot);
    env.visibility(false);
    worldDevStore.patch({ waterSurface: false });
    assert.equal(scene.disturbWater(wet), false, "the water display switch also disables hidden tap simulation");
    assert.deepEqual(water, snapshot);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("water physics map gestures never splash until a single completed wet tap", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(waterPhysicsFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, waterWind: "calm", waterFish: "off" });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "water-map-input" };
    const canvas = env.surface(400), loading = createMapEngine(canvas, initial, assert.fail, []);
    env.finish(); await flush(); engine = await loading; engine.control("overview");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const before = structuredClone(probe.state.water), wet = { x: 1030, y: 1030 };
    let first = waterPointer(canvas, wet);
    sendWaterPointer(canvas, "pointerdown", first);
    sendWaterPointer(canvas, "pointermove", { ...first, clientX: first.clientX + 30 });
    sendWaterPointer(canvas, "pointerup", { ...first, clientX: first.clientX + 30 });
    engine.control("overview");
    for (const cancellation of ["pointercancel", "lostpointercapture"]) {
      first = waterPointer(canvas, wet);
      sendWaterPointer(canvas, "pointerdown", first); sendWaterPointer(canvas, cancellation, first);
    }
    first = waterPointer(canvas, wet);
    const second = { ...first, pointerId: 2, clientX: first.clientX + 20 };
    sendWaterPointer(canvas, "pointerdown", first); sendWaterPointer(canvas, "pointerdown", second);
    sendWaterPointer(canvas, "pointermove", { ...second, clientX: second.clientX + 10 });
    sendWaterPointer(canvas, "pointerup", first);
    sendWaterPointer(canvas, "pointerup", { ...second, clientX: second.clientX + 10 });
    engine.control("overview");
    assert.deepEqual(probe.state.water, before, "pan, pinch, cancellation and lost capture do not inject waves");
    for (const dry of [{ x: 800, y: 1000 }, { x: 960, y: 960 }]) {
      first = waterPointer(canvas, dry);
      sendWaterPointer(canvas, "pointerdown", first); sendWaterPointer(canvas, "pointerup", first);
    }
    assert.deepEqual(probe.state.water, before, "map projection respects both shorelines and WaterExclusions");
    first = waterPointer(canvas, wet);
    sendWaterPointer(canvas, "pointerdown", first); sendWaterPointer(canvas, "pointerup", first);
    assert.ok(waterEnergy(probe.state.water) > waterEnergy(before));
    assert.ok(probe.state.water.revision > (before?.revision ?? 0), "one completed tap reaches the shared solver");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("water physics yields taps to visible characters buildings and explicit markers", async () => {
  const authored = { ...residentFixture(), sites: [clearingHome], water: {
    // Wet pixels overlap the visible bodies while their authored feet and
    // navigation remain dry, as with a pier or a tall riverbank sprite.
    surfaces: [
      { id: "hero-water", points: waterRectangle(610, 630, 40, 20) },
      { id: "resident-water", points: waterRectangle(680, 675, 20, 15) },
      { id: "house-water", points: waterRectangle(640, 580, 60, 50) },
      { id: "marker-water", points: waterRectangle(640, 680, 20, 15) },
      { id: "open-water", points: waterRectangle(780, 780, 70) },
    ], exclusions: [],
  } };
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(authored);
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, waterWind: "calm", waterFish: "off" });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "water-input-priority" };
    const canvas = env.surface(400), places = [], residents = [];
    const marker = Object.assign(env.surface(), { dataset: { objectId: "home", kind: "house" }, style: {} });
    const loading = createMapEngine(canvas, initial, place => places.push(place), [marker], undefined, {},
      { onResident: resident => residents.push(resident) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading; engine.control("overview");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const before = structuredClone(probe.state.water);
    const tap = (x, y, target = canvas) => {
      const point = waterPointer(canvas, { x, y });
      sendWaterPointer(target, "pointerdown", point); sendWaterPointer(target, "pointerup", point);
    };
    tap(630, 642);
    assert.equal(probe.state.clearing.stage, "attention", "the visible hero receives his own tap");
    assert.equal(probe.state.pleskMind.noticePending, false);
    tap(690, 682);
    assert.deepEqual(residents, [], "a resident body tap keeps the map open without invoking the character menu");
    assert.equal(probe.state.pleskMind.noticePending, true, "the visible resident receives her own tap before the water behind her");
    tap(675, 600);
    assert.deepEqual(places, ["house"]);
    tap(650, 690, marker);
    assert.deepEqual(places, ["house", "house"], "the explicit marker activates even outside the building silhouette");
    assert.deepEqual(probe.state.water, before, "consumed interactions cannot also disturb the water behind them");
    tap(800, 800);
    assert.ok(waterEnergy(probe.state.water) > 0, "unclaimed water nearby remains interactive");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("water physics shares one clock across circle map paint and camera handoff", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(waterPhysicsFixture());
  const env = browser(), scenes = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, waterWind: "calm", waterFish: "off" });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "water-camera-handoff" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    assert.equal(circle.disturbWater({ x: 1030, y: 1030 }), true);
    const water = probe.state.water, clock = sceneClock(env); clock.step();
    const beforeMount = structuredClone(water);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world); await flush();
    assert.equal(probe.state.water, water, "camera creation keeps the existing surface object");
    assert.deepEqual(water, beforeMount, "camera creation neither resets nor advances existing waves");
    assert.equal(env.frames.size, 1, "one owner advances both views of the surface");
    const target = env.surface();
    for (let index = 0; index < 4; index++) { circle.paintWorld(target.context); world.paintWorld(target.context); }
    assert.deepEqual(water, beforeMount, "painting both cameras cannot step waves or apply fishing contacts");
    clock.step(); // The newly elected owner reanchors its RAF timestamp.
    const time = water.elapsed;
    clock.step();
    approximately(water.elapsed - time, .05, "two cameras advance one 50ms interval");
    const beforeReturn = structuredClone(water);
    world.dispose(); await flush();
    assert.equal(probe.state.water, water);
    assert.deepEqual(water, beforeReturn, "returning to the circle preserves energy and leaves exactly");
    clock.step(); clock.step();
    assert.ok(water.elapsed > beforeReturn.elapsed);
    circle.configure({ ...initial, paused: true });
    const paused = structuredClone(water); clock.advance(1);
    assert.deepEqual(water, paused);
    circle.configure({ ...initial, presenceKey: "water-other-account" });
    assert.deepEqual(water, paused, "switching accounts cannot apply the new account's clock to old waves");
  } finally { scenes.forEach(scene => scene.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("tree taps wait for a completed gesture and never repeat while holding panning pinching or cancelling", async t => {
  const { createMapEngine, worldDevStore, getAudioRuntime } = await modules(treeTouchFixture());
  const env = browser(); let engine;
  const events = [], runtime = getAudioRuntime();
  t.mock.method(runtime, "play", event => events.push(event));
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const canvas = env.surface(400), loading = createMapEngine(canvas,
      { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "tree-gestures" }, assert.fail, [], undefined, {}, { objectAnchorsEnabled: false });
    env.finish(); await flush(); engine = await loading; engine.control("overview");
    const point = { x: 810, y: 600 }, tap = () => waterPointer(canvas, point);
    let first = tap(); sendWaterPointer(canvas, "pointerdown", first);
    for (let frame = 0; frame < 8; frame++) canvas.flushFrame();
    assert.equal(events.length, 0, "holding the tree does not repeat a contact");
    sendWaterPointer(canvas, "pointermove", { ...first, clientX: first.clientX + 30 });
    sendWaterPointer(canvas, "pointerup", { ...first, clientX: first.clientX + 30 });
    engine.control("overview");
    for (const reason of ["pointercancel", "lostpointercapture"]) {
      first = tap(); sendWaterPointer(canvas, "pointerdown", first); sendWaterPointer(canvas, reason, first);
    }
    first = tap(); const second = { ...first, pointerId: 2, clientX: first.clientX + 20 };
    sendWaterPointer(canvas, "pointerdown", first); sendWaterPointer(canvas, "pointerdown", second);
    sendWaterPointer(canvas, "pointerup", first); sendWaterPointer(canvas, "pointerup", second);
    engine.control("overview");
    const rock = waterPointer(canvas, { x: 920, y: 600 });
    sendWaterPointer(canvas, "pointerdown", rock); sendWaterPointer(canvas, "pointerup", rock);
    assert.equal(events.length, 0, "gestures and occluders without an interaction zone stay silent");
    first = tap(); sendWaterPointer(canvas, "pointerdown", first); sendWaterPointer(canvas, "pointerup", first);
    assert.equal(events.length, 1); assert.equal(events[0].cueId, "action.tree.rustle");
    for (let repeat = 0; repeat < 8; repeat++) {
      sendWaterPointer(canvas, "pointerdown", first); sendWaterPointer(canvas, "pointerup", first);
    }
    assert.equal(events.length, 1, "rapid completed taps are bounded too");
  } finally { engine?.dispose(); runtime.dispose(); worldDevStore.reset(); env.restore(); }
});

test("tree contacts respect scene ownership pause and hidden state while reduced motion keeps only a quiet sound", async t => {
  const { mountHabitat, worldDevStore, getAudioRuntime } = await modules(treeTouchFixture());
  const env = browser(); let scene;
  const events = [], runtime = getAudioRuntime(); t.mock.method(runtime, "play", event => events.push(event));
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, view: "world", serverNow: 100_000, presenceKey: "tree-still" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const point = { x: 810, y: 600 };
    for (const next of [{ ...initial, paused: true }, { ...initial, backgrounded: true }, { ...initial, view: "circle" }]) {
      scene.configure(next); assert.equal(scene.disturbTree(point), false);
    }
    scene.configure(initial); env.visibility(true); assert.equal(scene.disturbTree(point), false);
    env.visibility(false);
    assert.equal(scene.disturbTree({ x: NaN, y: 600 }), false);
    assert.equal(scene.disturbTree({ x: 920, y: 600 }), false);
    assert.equal(events.length, 0);
    assert.equal(scene.disturbTree(point), true);
    assert.equal(events.length, 1); assert.equal(events[0].cueId, "action.tree.rustle");
    assert.equal(env.frames.size, 0, "reduced motion does not start a leaf animation loop");
    scene.dispose(); assert.equal(scene.disturbTree(point), false);
  } finally { scene?.dispose(); runtime.dispose(); worldDevStore.reset(); env.restore(); }
});
