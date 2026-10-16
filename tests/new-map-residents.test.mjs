import assert from "node:assert/strict";
import test from "node:test";
import {
  approximately,
  browser,
  builderFixture,
  builderHomeFixture,
  builderMemoryServer,
  circlePoint,
  clearingHome,
  clearingHomePath,
  compactVillagerFixture,
  confirmedConstruction,
  confirmedVillagers,
  distanceBetween,
  distanceToContour,
  finishVillagerArtwork,
  fishingFixture,
  fixture,
  flush,
  livingNavigation,
  mapProjection,
  modules,
  options,
  quietClearing,
  residentFixture,
  sampleFishingHero,
  sampleHero,
  sceneClock,
  tradingFixture
} from "./helpers/new-map-scene.mjs";


test("stall taps open Plesk directly and queue one safe meeting, while camera gestures leave both actors alone", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(tradingFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "stall-meeting" };
    const canvas = env.surface(400), residents = [], selections = [];
    const loading = createMapEngine(canvas, initial, assert.fail, [], undefined, {}, {
      onResident: id => residents.push(id), onSelectionChange: value => selections.push(value),
    });
    env.finish(); await flush(); env.finishPath("/test-plesk-shop.webp"); engine = await loading;
    engine.control("overview");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.pleskMind, original = structuredClone(mind), feet = { ...probe.state.clearing.position };
    const touch = () => { const projection = mapProjection(canvas); return { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + 595 * projection.zoom, clientY: projection.top + 639 * projection.zoom }; };
    const send = (name, point) => canvas.events.get(name)({ ...point, type: name });
    let point = touch(); send("pointerdown", point); send("pointermove", { ...point, clientX: point.clientX + 30 });
    send("pointerup", { ...point, clientX: point.clientX + 30 }); engine.control("overview");
    point = touch(); send("pointerdown", point); send("pointercancel", point);
    const second = { ...point, pointerId: 2, clientX: point.clientX + 35 };
    send("pointerdown", point); send("pointerdown", second); send("pointermove", { ...second, clientX: second.clientX + 10 });
    send("pointerup", point); send("pointerup", { ...second, clientX: second.clientX + 10 }); engine.control("overview");
    assert.deepEqual(residents, []); assert.deepEqual(mind, original);
    assert.equal(probe.state.director.tradeVisit, null);

    point = touch(); send("pointerdown", point); send("pointerup", point);
    assert.deepEqual(residents, ["plesk"], "the existing shop opens immediately, without waiting for either actor");
    assert.ok(selections.every(value => value === null), "a merchant has no empty construction panel");
    assert.equal(mind.tradePending, true);
    assert.deepEqual(mind.position, original.position, "opening the shop never teleports the seller");
    assert.deepEqual(probe.state.clearing.position, feet);
    const visit = probe.state.director.tradeVisit;
    assert.equal(visit?.phase, "outbound");
    assert.equal(engine.activateObject("plesk-shop"), true, "keyboard activation uses the same shop interaction");
    assert.equal(probe.state.director.tradeVisit, visit, "repeated opens preserve the existing walk");
    assert.equal(probe.state.explorationId, null, "the visit is not an economic journey");
    const clock = sceneClock(env); clock.advance(.3);
    assert.notDeepEqual(probe.state.clearing.position, feet, "the free hero actually follows the requested route");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a still or busy scene keeps the merchant accessible without starting a customer walk", async () => {
  for (const mode of ["reduced-motion", "busy"]) {
    const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(tradingFixture());
    const env = browser(); let engine, probe;
    try {
      worldDevStore.patch({ ...quietClearing, autoLife: false });
      const initial = { ...options, reducedMotion: mode === "reduced-motion", serverNow: 100_000, presenceKey: `stall-${mode}`,
        ...(mode === "busy" ? { economyJourney: { id: "cave-job", routeId: "cave", startedAt: new Date(100_000).toISOString(),
          finishesAt: new Date(700_000).toISOString() } } : {}) };
      const places = [], canvas = env.surface(320);
      const loading = createMapEngine(canvas, initial, place => places.push(place), []);
      env.finish(); await flush(); env.finishPath("/test-plesk-shop.webp"); engine = await loading;
      probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
      const feet = { ...probe.state.clearing.position };
      assert.equal(engine.activateObject("plesk-shop"), true);
      assert.deepEqual(places, ["plesk-shop"], "engines without a resident callback use the merchant place fallback");
      assert.equal(probe.state.director.tradeVisit, null);
      assert.deepEqual(probe.state.clearing.position, feet);
      if (mode === "reduced-motion") assert.equal(probe.state.pleskMind.tradePending, false);
      else assert.equal(probe.state.explorationId, "cave-job", "opening the merchant preserves the server-owned job");
      worldDevStore.patch({ showBuildings: false });
      assert.equal(engine.activateObject("plesk-shop"), false);
      assert.deepEqual(places, ["plesk-shop"], "hidden stall art cannot create an invisible click target");
    } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
  }
});

test("stopping a shop walk with a hero greeting releases a free builder in a narrow passage", async () => {
  const rectangle = (x, y, width, height) => [{ x, y }, { x: x + width, y },
    { x: x + width, y: y + height }, { x, y: y + height }];
  const customer = { x: 810, y: 690 }, start = { x: 630, y: 690 };
  const authored = {
    actor: { spawn: { x: 680, y: 690 }, size: 50 },
    sites: [{ id: "plesk-shop", label: "Лавка Плёски", initialLevel: 1,
      bounds: { x: 800, y: 630, width: 50, height: 40 }, anchor: { x: 825, y: 666 }, entry: customer,
      hitArea: rectangle(800, 630, 50, 40), collision: rectangle(810, 640, 30, 20),
      states: [{ level: 1, label: "Лавка", image: "/test-plesk-shop.webp" }] }],
    destinations: [{ id: "plesk-fishing", position: { x: 550, y: 640 }, pauseSeconds: 15 },
      { id: "plesk-trade", siteId: "plesk-shop", position: { x: 600, y: 640 }, pauseSeconds: 10 },
      { id: "plesk-customer", siteId: "plesk-shop", position: customer, pauseSeconds: 10 }],
    water: { surfaces: [], exclusions: [] },
    navigation: { version: 1, cellSize: 5, areas: [
      { id: "room", points: rectangle(500, 600, 105, 180) },
      { id: "passage", points: rectangle(580, 670, 280, 40) }], obstacles: [], interests: [] },
  };
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, forgetForestSession, canTraverse, canStartClearingLife,
    residentClearance } = await modules(authored);
  const env = browser(), key = "shop-greeting-passage"; let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finishPath("/test-ground.webp"); env.finishPath("/test-plesk-shop.webp"); await flush();
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, builder = state.builderMind, clock = sceneClock(env);
    // Restore an already walking free resident. The actual tap/visit paths and
    // owner clock must handle his transient route, rather than a mock occupant.
    builder.position = { ...start }; builder.action = "walk";
    builder.target = { id: "idle-shopward", position: { ...customer }, lookAt: { x: 810, y: 680 } };
    builder.route = { points: [{ ...start }, { ...customer }], distances: [0, 180], length: 180,
      speedLimits: [1, 0], roundedCorners: 0, checks: 0 };
    const step = () => {
      const heroBefore = { ...state.clearing.position }, builderBefore = { ...builder.position };
      clock.step();
      assert.ok(distanceBetween(heroBefore, state.clearing.position) <= 50 * .36 * .05 + 1e-7, "a greeting cannot teleport the hero");
      assert.ok(distanceBetween(builderBefore, builder.position) <= 34 * .05 + 1e-7, "yielding uses the real builder walking speed");
      assert.ok(canTraverse(state.clearing.navigation, heroBefore, state.clearing.position));
      assert.ok(canTraverse(state.clearing.navigation, builderBefore, builder.position));
      assert.ok(distanceBetween(builder.position, state.clearing.position) >= residentClearance(40, 50) - 1e-7,
        "the owner clock preserves visible personal space");
    };
    scene.visitTradingPlace("plesk");
    assert.equal(state.director.tradeVisit?.phase, "outbound");
    const heroStart = { ...state.clearing.position }; step();
    assert.notDeepEqual(state.clearing.position, heroStart, "the shop walk begins before the player interrupts it");
    scene.notice();
    const stoppedHero = { ...state.clearing.position };
    assert.equal(state.director.tradeVisit, null); assert.equal(state.clearing.requestedPoint, null);
    assert.equal(state.social.current?.speaker, "mochlik");
    for (let frame = 0; frame < 100 && !builder.trafficWaiting; frame++) step();
    assert.equal(builder.trafficWaiting, true, "the cancelled shop walk now blocks the middle of the builder route");
    assert.ok(distanceBetween(builder.target.position, stoppedHero) > residentClearance(40, 50),
      "the idle goal is free, so giving up only occupied goals cannot release this pair");
    const blockedFeet = { ...builder.position };
    for (let frame = 0; frame < 160 && distanceBetween(builder.position, blockedFeet) < 8; frame++) {
      step(); assert.deepEqual(state.clearing.position, stoppedHero, "the waiting player is never pushed aside");
    }
    assert.ok(distanceBetween(builder.position, blockedFeet) >= 8, "a free builder must step back from a blocked passage within eight seconds");
    assert.equal(builder.job, null); assert.equal(state.social.meeting, null);
    const resumedBuilder = { ...builder.position };
    worldDevStore.patch({ autoLife: true });
    for (let frame = 0; frame < 100 && !canStartClearingLife(state.clearing); frame++) step();
    assert.ok(canStartClearingLife(state.clearing), "the bounded greeting releases the hero after its quiet interval");
    scene.visitTradingPlace("plesk");
    assert.equal(state.director.tradeVisit?.phase, "outbound", "a later public shop request can use the released hero");
    for (let frame = 0; frame < 400 && distanceBetween(state.clearing.position, customer) > .5; frame++) step();
    assert.ok(distanceBetween(state.clearing.position, customer) <= .5, "the hero resumes the requested shop route");
    assert.ok(distanceBetween(builder.position, resumedBuilder) > 8, "the other resident completes his escape while the hero resumes walking");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("Plesk taps use world coordinates, respect foreground masks and never trigger the main hero", async () => {
  for (const mode of ["visible", "hidden", "equal-depth"]) {
    const hidden = mode === "hidden", overrides = residentFixture();
    const tapPoint = mode === "equal-depth" ? { x: 630, y: 642 } : { x: 690, y: 682 };
    if (mode === "equal-depth") overrides.destinations[0].position = { x: 630, y: 660 };
    if (hidden) overrides.occluders.push({ id: "crown", frontY: 720, points: [
      { x: 670, y: 650 }, { x: 710, y: 650 }, { x: 710, y: 715 }, { x: 670, y: 715 },
    ] });
    const { createMapEngine, worldDevStore } = await modules(overrides);
    const env = browser(); let engine;
    try {
      worldDevStore.patch(quietClearing);
      const canvas = env.surface(400), residents = [], places = [];
      const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined, {},
        { onResident: id => residents.push(id) });
      env.finish(); await flush();
      assert.equal(env.pending.length, 0, "procedural residents need no downloaded artwork");
      engine = await loading; engine.control("overview");
      const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
        clientX: projection.left + tapPoint.x * projection.zoom, clientY: projection.top + tapPoint.y * projection.zoom };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
      assert.deepEqual(residents, hidden ? [] : ["plesk"]);
      assert.deepEqual(places, []);
      assert.equal(env.timers.size, hidden ? 0 : 1, "only a visible resident's own speech gets a finite expiry");
      assert.equal([...env.timers.values()].some(timer => timer.ms <= 1000), false,
        "resident taps cannot start the main hero's short gesture response");
      assert.ok(canvas.calls.some(call => call.method === "drawImage" && call.args[0]?.width === 48), "the pixel rig reaches the renderer");
    } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
  }
});

test("procedural resident is ready with the terrain and has no external sprite dependency", async () => {
  const { mountHabitat } = await modules(residentFixture());
  const env = browser(); let scene;
  try {
    let ready = 0;
    scene = mountHabitat(env.surface(), options, { activity() {}, ready: () => ready++, failure: assert.fail });
    env.finish(); await flush();
    assert.equal(ready, 1); assert.equal(scene.hitResident(690, 682), "plesk");
    assert.deepEqual(env.requests, ["/test-ground.webp"]);
    const canvas = env.surface(); scene.paintWorld(canvas.context);
    assert.ok(canvas.calls.some(call => call.method === "drawImage" && call.args[0]?.width === 48));
  } finally { scene?.dispose(); env.restore(); }
});

test("coastal jobs keep the real hero visible through walking, fishing, camera handoff and return", async () => {
  const loaded = await modules(fishingFixture());
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } = loaded;
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "visible-fishing" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const home = { ...probe.state.clearing.position }, clock = sceneClock(env);
    const job = { id: "visible-shore-job", routeId: "shore", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    const traveling = { ...initial, economyJourney: job };
    circle.configure(traveling);
    assert.equal(probe.state.journeyTravel.phase, "leaving");
    clock.until(() => probe.state.journeyTravel.phase === "fishing", "the real actor reaches the shore", 500);
    assert.deepEqual(probe.state.clearing.position, { x: 690, y: 700 });
    assert.ok(sampleHero(circle, env, pixelSprite).body, "arrival cannot make the main hero disappear");
    const touch = circlePoint(circle.position());
    assert.equal(circle.hitPet(touch.x, touch.y), true, "visible fishing body participates in hit depth");
    circle.notice(); assert.equal(probe.state.reaction, 0, "a tap cannot interrupt a confirmed job");
    const world = mountHabitat(env.surface(), { ...traveling, view: "world" }, callbacks); views.push(world); await flush();
    assert.equal(env.frames.size, 1, "both cameras share the same fisherman clock");
    const firstPaint = sampleFishingHero(world, env, loaded, probe.state, TILED_WORLD), feet = { ...probe.state.clearing.position };
    assert.ok(firstPaint.hasPose("fish"), "the main pixel body uses its articulated fishing rig");
    clock.advance(5);
    const waiting = sampleFishingHero(world, env, loaded, probe.state, TILED_WORLD);
    assert.ok(waiting.hasPose("fish")); assert.deepEqual(probe.state.clearing.position, feet);
    assert.ok(waiting.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#d1b27c"), "the rod is painted in the same scene");
    world.configure({ ...traveling, view: "world", paused: true }); circle.configure({ ...traveling, backgrounded: true });
    const paused = probe.state.director.elapsed; clock.advance(10); assert.equal(probe.state.director.elapsed, paused);
    world.configure({ ...traveling, view: "world" }); clock.advance(1);
    assert.ok(probe.state.director.elapsed > paused);
    world.setTime(700_000);
    assert.equal(probe.state.journeyTravel.phase, "fishing");
    assert.ok(probe.state.journeyTravel.ending, "the server deadline first folds the visible tackle");
    assert.deepEqual(probe.state.clearing.position, feet);
    world.notice(); assert.equal(probe.state.reaction, 0, "a tap cannot steal the actor during cleanup");
    clock.until(() => probe.state.journeyTravel.phase === "returning", "cleanup finishes before walking home");
    clock.until(() => !probe.state.journeyTravel, "the same walker returns after the server deadline", 500);
    assert.deepEqual(probe.state.clearing.position, home);
    assert.ok(sampleHero(world, env, pixelSprite).body);
    assert.equal(job.finishesAt, new Date(700_000).toISOString(), "cosmetic animation cannot edit server timing");
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("restored coastal jobs show static fishing in reduced motion without an animation loop", async () => {
  const loaded = await modules(fishingFixture());
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } = loaded;
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const job = { id: "restored-shore", routeId: "shore_camp", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    scene = mountHabitat(env.surface(), { ...options, serverNow: 200_000, presenceKey: "restored-visible-fishing", economyJourney: job },
      { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession("restored-visible-fishing", TILED_WORLD, "circle", 200_000, 0, () => {});
    assert.equal(probe.state.journeyTravel.phase, "fishing");
    assert.deepEqual(probe.state.clearing.position, { x: 690, y: 700 });
    assert.ok(sampleFishingHero(scene, env, loaded, probe.state, TILED_WORLD, true).hasPose("fish"));
    assert.equal(env.frames.size, 0);
    const before = sampleFishingHero(scene, env, loaded, probe.state, TILED_WORLD, true).calls;
    env.tick(10_000);
    assert.deepEqual(sampleFishingHero(scene, env, loaded, probe.state, TILED_WORLD, true).calls, before);
    scene.setTime(700_000);
    assert.equal(probe.state.journeyTravel, undefined);
    assert.ok(sampleHero(scene, env, pixelSprite).body, "completion leaves a visible safe outdoor actor");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("confirmed cancellation reaches both mounted cameras and clears caught fish for active and ready trips", async () => {
  for (const ready of [false, true]) {
    const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, forestJourneyFishingFrame } = await modules(fishingFixture());
    const env = browser(), views = []; let probe;
    try {
      worldDevStore.patch({ ...quietClearing, autoLife: false });
      const job = { id: `cancel-mounted-${ready}`, routeId: "shore", rewards: { fish: 4 }, startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
      const initial = { ...options, reducedMotion: false, serverNow: 200_000, presenceKey: `cancel-fishing-${ready}`, economyJourney: job };
      const callbacks = { activity() {}, ready() {}, failure: assert.fail };
      const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
      env.finish(); await flush();
      probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 200_000, 0, () => {});
      const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
      const clock = sceneClock(env);
      const catchAt = 100_000 + (probe.state.journeyTravel.jobFishing.catches[0].at - 3) * 1000;
      world.setTime(catchAt); clock.advance(.05);
      assert.equal(forestJourneyFishingFrame(probe.state, TILED_WORLD).carryingFish, true);
      if (ready) { world.setTime(700_000); clock.advance(1); }
      const feet = { ...probe.state.clearing.position };
      const cancelled = { ...initial, economyJourney: null, serverNow: ready ? 701_000 : catchAt + 50, cancelledExplorations: [job.id] };
      circle.configure(cancelled); world.configure({ ...cancelled, view: "world" });
      assert.equal(probe.state.journeyTravel.cancelled, true);
      assert.deepEqual(probe.state.clearing.position, feet);
      if (!ready) assert.ok(probe.state.journeyTravel.ending, "an active cancellation completes its visible gesture first");
      clock.until(() => probe.state.journeyTravel.phase === "returning", "a cancelled catch finishes putting away its tackle");
      assert.equal(forestJourneyFishingFrame(probe.state, TILED_WORLD).carryingFish, false);
      assert.deepEqual(circle.position(), world.position());
      const beganAt = probe.state.journeyTravel.beganAt;
      world.configure({ ...cancelled, view: "world" });
      assert.equal(probe.state.journeyTravel.beganAt, beganAt, "a repeated receipt cannot restart the walk");
      const handoffFeet = { ...probe.state.clearing.position };
      world.dispose(); await flush();
      assert.deepEqual(probe.state.clearing.position, handoffFeet, "camera handoff preserves the cancelled return");
      clock.until(() => !probe.state.journeyTravel, "the empty-handed actor returns using the shared collision-safe walker", 500);
      assert.deepEqual(probe.state.clearing.position, probe.state.clearing.home);
    } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
  }
});

test("resident AI advances once across cameras, freezes at actual feet and survives read-only DEV pose overrides", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "resident-mind-handoff" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.pleskMind, clock = sceneClock(env);
    assert.ok(mind);
    mind.catchCount = 3; // A full local basket gives the real AI a reason to leave its pier.
    clock.until(() => mind.stage.action === "walk", "the resident chooses a safe delivery walk", 120);
    clock.advance(.5);
    assert.notDeepEqual(mind.position, { x: 690, y: 700 });
    const beforeMount = structuredClone(mind);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.strictEqual(probe.state.pleskMind, mind);
    assert.deepEqual(mind, beforeMount, "opening the map cannot reroll the resident's decision or reset her feet");
    assert.equal(env.frames.size, 1);
    for (let pass = 0; pass < 4; pass++) for (const view of [circle, world]) {
      view.paintWorld(env.surface().context);
      const point = view.inspectPoint("plesk"); view.hitResident(point.x, point.y);
    }
    assert.deepEqual(mind, beforeMount, "painting and hit-testing cannot advance needs, RNG or stage clocks");
    const beforeClock = mind.elapsed, sceneTime = probe.state.elapsed;
    clock.advance(.4);
    approximately(mind.elapsed - beforeClock, probe.state.elapsed - sceneTime, "two visible cameras advance one resident clock");
    const beforePreview = structuredClone(mind);
    worldDevStore.triggerResident("fish", true);
    assert.deepEqual(mind, beforePreview, "starting a DEV pose cannot rewind the natural AI");
    assert.deepEqual(world.inspectPoint("plesk"), { x: 690, y: 682 });
    clock.advance(.5);
    assert.ok(mind.elapsed > beforePreview.elapsed, "natural needs and route continue underneath a display-only pose");
    const afterPreview = structuredClone(mind);
    worldDevStore.patch({ residentPreview: null });
    assert.deepEqual(mind, afterPreview);
    assert.deepEqual(world.inspectPoint("plesk"), { x: mind.position.x, y: mind.position.y - 18 });
    circle.configure({ ...initial, backgrounded: true });
    world.configure({ ...initial, view: "world", paused: true });
    const frozen = structuredClone(mind); clock.advance(2);
    assert.deepEqual(mind, frozen);
    world.configure({ ...initial, view: "world", reducedMotion: true }); clock.advance(2);
    assert.deepEqual(mind, frozen, "reduced motion freezes the actual route position");
    assert.deepEqual(world.inspectPoint("plesk"), { x: frozen.position.x, y: frozen.position.y - 18 });
    world.configure({ ...initial, view: "world" }); clock.advance(.5);
    assert.ok(mind.elapsed > frozen.elapsed);
    const beforeReturn = structuredClone(mind);
    world.dispose(); circle.configure(initial);
    assert.deepEqual(mind, beforeReturn, "handoff back to the circle preserves the same mind");
    clock.advance(.5); assert.ok(mind.elapsed > beforeReturn.elapsed);
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("only a completed resident tap reaches her AI, while drags, pinch and canceled touches leave it alone", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "resident-attention" };
    const canvas = env.surface(400), residents = [];
    const loading = createMapEngine(canvas, initial, assert.fail, [], undefined, {}, { onResident: id => residents.push(id) });
    env.finish(); await flush(); engine = await loading; engine.control("overview");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.pleskMind, original = structuredClone(mind);
    const touch = () => { const projection = mapProjection(canvas); return { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + 690 * projection.zoom, clientY: projection.top + 682 * projection.zoom }; };
    const send = (name, point) => canvas.events.get(name)({ ...point, type: name });
    let first = touch(); send("pointerdown", first); send("pointermove", { ...first, clientX: first.clientX + 30 });
    send("pointerup", { ...first, clientX: first.clientX + 30 }); engine.control("overview");
    first = touch(); send("pointerdown", first); send("pointercancel", first);
    first = touch(); const second = { ...first, pointerId: 2, clientX: first.clientX + 35 };
    send("pointerdown", first); send("pointerdown", second); send("pointermove", { ...second, clientX: second.clientX + 10 });
    send("pointerup", first); send("pointerup", { ...second, clientX: second.clientX + 10 }); engine.control("overview");
    assert.deepEqual(residents, []);
    assert.deepEqual(mind, original, "camera gestures cannot queue social attention or advance resident AI");
    first = touch(); send("pointerdown", first); send("pointerup", first);
    assert.deepEqual(residents, ["plesk"]);
    assert.equal(mind.noticePending, true);
    const clock = sceneClock(env); clock.advance(.1);
    assert.equal(mind.stage.action, "greet");
    assert.equal(mind.noticePending, false);
    assert.equal(probe.state.reaction, 0, "the main hero does not receive the resident's tap");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV fishing rehearses the real trip, stops with a safe return and yields to confirmed jobs", async () => {
  const loaded = await modules(fishingFixture());
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, pixelSprite } = loaded;
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "dev-visible-fishing" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const home = { ...probe.state.clearing.position }, clock = sceneClock(env);
    worldDevStore.triggerScenario("fishing");
    assert.ok(probe.state.fishingPreview);
    assert.equal(probe.state.journeyTravel.phase, "leaving");
    assert.equal(probe.state.memory.enabled, false, "a rehearsal cannot save simulated account activity");
    clock.until(() => probe.state.journeyTravel.phase === "fishing", "DEV reaches the same real shore", 500);
    clock.advance(18);
    assert.ok(sampleFishingHero(scene, env, loaded, probe.state, TILED_WORLD).hasPose("present", "fish"));
    const atShore = { ...probe.state.clearing.position };
    worldDevStore.triggerLife("idle");
    assert.equal(probe.state.fishingPreview, undefined);
    assert.equal(probe.state.journeyTravel.phase, "fishing");
    assert.ok(probe.state.journeyTravel.ending, "DEV stopping uses the same catch cleanup as a confirmed journey");
    assert.deepEqual(probe.state.clearing.position, atShore, "stop never teleports home");
    clock.until(() => probe.state.journeyTravel.phase === "returning", "DEV stop finishes the current catch first");
    clock.until(() => !probe.state.journeyTravel, "DEV stop completes its return even with autoLife off", 500);
    assert.deepEqual(probe.state.clearing.position, home);
    const confirmed = { id: "confirmed-cave", routeId: "cave", startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    scene.configure({ ...initial, economyJourney: confirmed });
    worldDevStore.triggerScenario("fishing");
    assert.equal(probe.state.fishingPreview, undefined, "a local rehearsal cannot steal a server-owned actor");
    assert.equal(probe.state.explorationId, confirmed.id);
    assert.equal(sampleHero(scene, env, pixelSprite).body, undefined);
    scene.configure({ ...initial, economyJourney: confirmed, serverNow: 700_000 });
    assert.equal(probe.state.fishingPreview, undefined, "a rejected rehearsal is not queued behind a real job");
    assert.equal(probe.state.explorationId, null);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("Plesk DEV direction previews share time, camera point and body taps without moving the hero", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "dev-plesk-preview" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const home = { ...probe.state.clearing.position }, clock = sceneClock(env);
    worldDevStore.triggerResident("walk", true);
    const previewStarted = probe.state.residentPreview.startedAt;
    const center = circle.inspectPoint("plesk");
    assert.equal(circle.hitResident(center.x, center.y), "plesk");
    const paint = view => { const target = env.surface(); view.paintWorld(target.context); return target.calls; };
    const front = paint(circle);
    worldDevStore.patch({ residentDirection: "left" });
    const left = paint(circle);
    assert.notDeepEqual(left, front, "direction changes the resident's procedural body");
    assert.equal(probe.state.residentPreview.startedAt, previewStarted, "direction selection preserves the current preview clock");
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.deepEqual(paint(world), paint(circle));
    assert.deepEqual(world.inspectPoint("plesk"), center);
    assert.equal(world.hitResident(center.x, center.y), "plesk");
    clock.advance(.5);
    assert.notDeepEqual(paint(world), left, "walking frames advance through the shared renderer");
    assert.deepEqual(probe.state.clearing.position, home);
    assert.equal(probe.state.journeyTravel, undefined, "testing a resident does not start a player expedition");
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("premount Plesk preview keeps its camera target and animates after geometry replaces the session", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [1, 2].map(level => ({ level, label: `Level ${level}`, image: `/preview-home-${level}.webp` })) };
  const overrides = residentFixture();
  overrides.sites = [site];
  overrides.navigation = { ...livingNavigation, obstacles: [{ id: "level-one-stone", when: { siteId: "home", level: 1 },
    points: [{ x: 575, y: 615 }, { x: 585, y: 615 }, { x: 585, y: 625 }, { x: 575, y: 625 }] }] };
  const { createMapEngine, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore } = await modules(overrides);
  const env = browser(), probes = []; let engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    worldDevStore.triggerResident("walk", true);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "premount-resident" };
    const canvas = env.surface(400), loading = createMapEngine(canvas, initial, () => {}, []);
    env.finishPath("/test-ground.webp"); await flush(); env.finishPath("/preview-home-1.webp"); await flush(); engine = await loading;
    const currentProbe = level => {
      const probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: level }), "circle", 100_000, 0, () => {});
      probes.push(probe); return probe;
    };
    let probe = currentProbe(1);
    assert.ok(probe.state.residentPreview, "a preview selected before mounting gets a persistent start clock");
    const projection = mapProjection(canvas);
    approximately(projection.left + 690 * projection.zoom, 200, "the premount resident camera centers its actual x");
    approximately(projection.top + 682 * projection.zoom, 200, "the premount resident camera centers its body y");
    const residentSprite = () => canvas.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
      && call.args[0]?.width === 48 && call.args[0]?.height === 48)?.args[0];
    const clock = sceneClock(env), first = residentSprite(); clock.advance(.4);
    assert.notEqual(residentSprite(), first, "premount preview does not stay at frame zero");
    const previous = probe.state;
    worldDevStore.patch({ levels: { home: 2 } }); env.finishPath("/preview-home-2.webp"); await flush();
    probe = currentProbe(2);
    assert.notEqual(probe.state, previous, "the changed obstacle creates a new scene session");
    assert.ok(probe.state.residentPreview, "an existing DEV selection receives a start clock in the new geometry");
    const replaced = residentSprite(); clock.advance(.4);
    assert.notEqual(residentSprite(), replaced, "a geometry handoff cannot freeze the resident rehearsal");
  } finally { engine?.dispose(); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("premount DEV fishing starts the approach once and preserves the absolute shore camera", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(fishingFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false }); worldDevStore.triggerScenario("fishing");
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "premount-fishing" };
    const canvas = env.surface(400), loading = createMapEngine(canvas, initial, () => {}, []);
    env.finish(); await flush(); engine = await loading;
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    assert.equal(probe.state.journeyTravel.phase, "leaving", "the rehearsal demonstrates walking even on a fresh mount");
    const jobId = probe.state.journeyTravel.jobId, began = probe.state.fishingPreview.startedAt;
    const projection = mapProjection(canvas);
    approximately(projection.left + 690 * projection.zoom, 200, "premount camera centers shore x");
    approximately(projection.top + 682 * projection.zoom, 200, "premount camera centers shore body y");
    const clock = sceneClock(env); clock.advance(1);
    const feet = { ...probe.state.clearing.position };
    engine.update({ ...initial, paused: true }); engine.update(initial);
    assert.equal(probe.state.journeyTravel.jobId, jobId);
    assert.equal(probe.state.fishingPreview.startedAt, began, "resume consumes no second rehearsal event");
    assert.deepEqual(probe.state.clearing.position, feet);
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV cooking shares one clock across cameras and read-only renders, control edits and pauses never restart it", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, cookingPreviewFrame } = await modules({ navigation: livingNavigation });
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "cooking-two-cameras" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const clock = sceneClock(env), feet = { ...probe.state.clearing.position };
    worldDevStore.triggerCooking("sequence", true);
    assert.ok(probe.state.cookingPreview);
    assert.notEqual(probe.state.cookingPreview.startedAt, null);
    const started = { ...probe.state.cookingPreview };
    clock.advance(1);
    const first = cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview);
    assert.equal(first.action, "prepare"); assert.ok(first.phase > 0);
    const paint = view => { const target = env.surface(); view.paintWorld(target.context); return target.calls; };
    const beforeRead = structuredClone(probe.state);
    const firstPaint = paint(circle); paint(circle); circle.position(); circle.inspectPoint("pet"); circle.hitPet(.5, .5);
    assert.deepEqual(probe.state, beforeRead, "rendering and inspecting cannot consume or finish a cooking gesture");
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.deepEqual(probe.state.cookingPreview, started, "opening a second camera preserves the rehearsal start");
    assert.deepEqual(paint(world), firstPaint);
    worldDevStore.patch({ waterBreeze: false, waterFish: "off" });
    assert.deepEqual(probe.state.cookingPreview, started, "unrelated DEV preferences cannot replay the event");
    clock.step();
    const beforeClock = probe.state.elapsed;
    clock.advance(.5);
    approximately(probe.state.elapsed - beforeClock, .5, "two cameras advance a single shared cooking clock");
    assert.deepEqual(paint(world), paint(circle));
    assert.deepEqual(probe.state.clearing.position, feet, "cooking stays at the actual outdoor feet");
    worldDevStore.patch({ paused: true });
    const frozen = structuredClone(probe.state); clock.advance(2);
    assert.deepEqual(probe.state, frozen); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ paused: false, reducedMotion: "on" });
    const still = structuredClone(probe.state); clock.advance(2);
    assert.deepEqual(probe.state, still); assert.equal(env.frames.size, 0);
    const stillPaint = paint(world); assert.deepEqual(paint(circle), stillPaint);
    worldDevStore.patch({ reducedMotion: "off", cookingPreview: null });
    assert.equal(probe.state.cookingPreview, undefined);
    assert.equal(probe.state.clearing.frozen, false);
    assert.deepEqual(probe.state.clearing.position, feet, "cancel releases the visible actor without teleporting");
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("DEV cooking finishes once, repeats only explicitly and cannot create inventory or expedition progress", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, cookingPreviewFrame } = await modules({ navigation: livingNavigation });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "cooking-one-shot",
      onGardenHarvestEvent() { assert.fail("a cooking rehearsal cannot claim production"); } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const clock = sceneClock(env), basketBefore = structuredClone(probe.state.life.garden.basket);
    worldDevStore.triggerCooking("prepare");
    const firstId = probe.state.cookingPreview.id;
    assert.equal(probe.state.memory.enabled, false, "a rehearsal cannot save fake meals to account memory");
    clock.advance(7.5);
    assert.equal(probe.state.cookingPreview, undefined);
    assert.equal(probe.state.clearing.frozen, true, "automatic life remains deliberately disabled after the rehearsal ends");
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
    scene.configure({ ...initial, paused: true }); scene.configure(initial);
    assert.equal(probe.state.cookingPreview, undefined, "a consumed one-shot does not restart on resuming the view");
    worldDevStore.triggerCooking("prepare", true);
    assert.ok(probe.state.cookingPreview.id > firstId);
    clock.advance(15);
    assert.ok(probe.state.cookingPreview); assert.equal(probe.state.clearing.frozen, true);
    assert.equal(probe.state.journeyTravel, undefined); assert.ok(!probe.state.explorationId);
    assert.deepEqual(probe.state.life.garden.basket, basketBefore, "preview utensils cannot consume or refill the real berry basket");
    worldDevStore.triggerPose("greet");
    assert.equal(probe.state.cookingPreview, undefined, "a selected hero gesture immediately removes cooking props");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("confirmed expeditions interrupt cooking and a rejected rehearsal is never queued behind the real job", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, cookingPreviewFrame } = await modules(fishingFixture());
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "cooking-job-priority" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const clock = sceneClock(env);
    worldDevStore.triggerCooking("stir", true); clock.advance(.5);
    assert.ok(probe.state.cookingPreview);
    const confirmed = { id: "cooking-interrupted-by-shore", routeId: "shore", startedAt: new Date(100_000).toISOString(),
      finishesAt: new Date(700_000).toISOString() };
    scene.configure({ ...initial, economyJourney: confirmed });
    assert.equal(probe.state.cookingPreview, undefined, "the server-owned departure removes local props immediately");
    assert.equal(probe.state.journeyTravel.jobId, confirmed.id);
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
    const travel = probe.state.journeyTravel, feet = { ...probe.state.clearing.position };
    worldDevStore.triggerCooking("serve");
    assert.equal(probe.state.cookingPreview, undefined);
    assert.equal(probe.state.journeyTravel, travel); assert.deepEqual(probe.state.clearing.position, feet);
    scene.configure({ ...initial, economyJourney: null, cancelledExplorations: [confirmed.id] });
    clock.until(() => !probe.state.journeyTravel, "real cancellation completes its safe return", 500);
    assert.equal(probe.state.cookingPreview, undefined, "rejected cooking never starts after the expedition releases the actor");
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("cooking waits for outdoor feet and a real tap finishes the current cycle without replaying the request", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, cookingPreviewFrame, clearingActivityFrame } = await modules({ sites: [clearingHome], paths: [clearingHomePath] });
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch(quietClearing);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "cooking-indoor-exit" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    worldDevStore.triggerLife("home-sleep");
    const clock = sceneClock(env);
    clock.until(() => probe.state.clearing.stage === "home-sleep", "the actor reaches indoor sleep", 500);
    worldDevStore.patch({ autoLife: false });
    const indoorFeet = { ...probe.state.clearing.position };
    worldDevStore.triggerCooking("sequence", true);
    assert.ok(probe.state.cookingPreview);
    assert.equal(probe.state.cookingPreview.startedAt, null, "no utensils appear while the actor is indoors");
    assert.deepEqual(probe.state.clearing.position, indoorFeet, "the rehearsal requests the existing doorway exit without teleporting");
    assert.equal(cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview), null);
    clock.until(() => Boolean(probe.state.cookingPreview && probe.state.cookingPreview.startedAt !== null),
      "explicit doorway travel continues even with automatic life disabled", 300);
    const frame = cookingPreviewFrame(probe.state, worldDevStore.getSnapshot().cookingPreview);
    const actor = clearingActivityFrame(probe.state.clearing);
    assert.ok(frame); assert.equal(actor.opacity, 1); assert.ok(!actor.residing && !actor.lift);
    assert.ok(distanceBetween(probe.state.clearing.position, indoorFeet) > 0, "the actor actually left the indoor position");
    assert.deepEqual({ x: frame.x, y: frame.y }, probe.state.clearing.position);
    const startedAt = probe.state.cookingPreview.startedAt;
    scene.notice();
    assert.equal(probe.state.cookingPreview.startedAt, startedAt, "tap does not break the visible cooking gesture");
    const attentionAt = probe.state.cookingPreview.attentionAt;
    clock.advance(1); scene.notice();
    assert.equal(probe.state.cookingPreview.attentionAt, attentionAt, "repeat taps do not extend the cycle");
    clock.until(() => !probe.state.cookingPreview, "cooking completes before greeting", 650);
    clock.advance(1);
    assert.equal(probe.state.cookingPreview, undefined, "a tap does not leave the consumed preview queued for another start");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});


test("production props use one confirmed job across both cameras, preserve ready until claim and reject stale background work", async () => {
  const campfires=[{ id: "clearing-campfire", position: { x: 680, y: 665 }, seat: { x: 640, y: 684 }, radius: 10 }];
  const { mountHabitat, connectForestSession, TILED_WORLD, forestProductionFrames } = await modules({ campfires, navigation: livingNavigation });
  const env=browser(), views=[]; let probe;
  try {
    const end=Date.parse("2026-10-05T12:00:00Z"), owner="1234-5678-ABCD";
    const production={ ownerPublicId:owner, revision:5, jobs:[{ id:"confirmed-dryer", stationId:"dryer", stationLevel:1,
      recipeId:"dry_berries", startedAt:new Date(end-7200000).toISOString(), finishesAt:new Date(end).toISOString() }] };
    const initial={ ...options, serverNow:end-1000, presenceKey:`zhiv:mochlik:presence:${owner}`, economyProduction:production };
    const callbacks={ activity() {}, ready() {}, failure:assert.fail };
    const circle=mountHabitat(env.surface(),initial,callbacks); views.push(circle);
    const world=mountHabitat(env.surface(),{ ...initial,view:"world" },callbacks); views.push(world);
    env.finishPath("/test-ground.webp"); await flush();
    probe=connectForestSession(initial.presenceKey,TILED_WORLD,"circle",end-1000,0,()=>{}, { persistence:false, sync:false });
    const state=probe.state, clearing=structuredClone(state.clearing), fire=structuredClone(state.life.campfires);
    assert.equal(state.economyProduction.revision,5);
    for (const view of views) {
      const surface=env.surface(); view.paintWorld(surface.context);
      assert.ok(surface.calls.some(call => call.method==="translate" && Math.abs(call.args[0]-680)<.01 && Math.abs(call.args[1]-(665-40*.13))<.01),"the installed real dryer job paints the anchored cooking prop");
    }
    const ready=forestProductionFrames(state.economyProduction,TILED_WORLD,{},end,0);
    assert.equal(ready[0].phase,"ready");
    world.setTime(end+1000); world.paintWorld(env.surface().context);
    assert.equal(state.economyProduction.jobs.length,1,"reaching the timer cannot claim or delete food");
    world.configure({ ...initial,view:"world",serverNow:end+1000,economyProduction:{ ...production,revision:6,jobs:[] } });
    circle.configure({ ...initial,backgrounded:true });
    assert.deepEqual(state.economyProduction.jobs,[],"a background circle cannot resurrect a claimed job");
    for (const view of views) {
      const surface=env.surface(); view.paintWorld(surface.context);
      assert.ok(!surface.calls.some(call => call.method==="translate" && Math.abs(call.args[0]-680)<.01 && Math.abs(call.args[1]-(665-40*.13))<.01),"both cameras stop drawing the claimed cooking prop");
    }
    world.dispose(); views.pop(); circle.configure(initial); await flush();
    assert.deepEqual(state.economyProduction.jobs,[],"camera handoff retains the removal revision");
    assert.deepEqual(state.life.campfires,fire,"cooking is a visual projection and does not kindle weather-owned fire state");
    assert.deepEqual(state.clearing,clearing,"a multi-hour job never forces the hero into cooking animation or movement");
  } finally { probe?.release(); views.forEach(view=>view.dispose()); env.restore(); }
});

test("quarry production keeps one visible work sign by day and night, including static or absent actor frames", async () => {
  const quarry={id:"quarry",label:"Шахта",initialLevel:1,bounds:{x:660,y:590,width:55,height:48},
    anchor:{x:688,y:638},entry:{x:680,y:640},doorway:{x:686,y:625},collision:[],hitArea:[],
    states:[{level:1,label:"Шахта",image:"/test-quarry.webp"}]};
  const {paintNewMap,TILED_WORLD,NEW_MAP_PET_SIZE,WORLD_DEV_DEFAULTS}=await modules({sites:[quarry]});
  const env=browser();
  try {
    const production={ownerPublicId:"worker",revision:1,jobs:[{id:"stone",stationId:"quarry",stationLevel:1,
      recipeId:"quarry_stone",startedAt:new Date(100_000).toISOString(),finishesAt:new Date(700_000).toISOString()}]};
    const cue={x:quarry.anchor.x,y:quarry.bounds.y-NEW_MAP_PET_SIZE*.12};
    const count=(now,still,night,mining=null,showBuildings=true,view="circle",jobs=production)=>{
      const surface=env.surface();
      paintNewMap(surface.context,new Map(),{...options,view,reducedMotion:still,economyProduction:jobs},7,false,now,night?1:0,
        {scene:TILED_WORLD,actorAway:true,mining,state:{...WORLD_DEV_DEFAULTS,showBuildings,timeOfDay:night?"night":"day"}});
      return surface.calls.filter(call=>call.method==="ellipse" && call.args[0]===cue.x && call.args[1]===cue.y).length;
    };
    const mining={...quarry.entry,size:NEW_MAP_PET_SIZE,opacity:0,scale:1,pose:"idle",frame:0,direction:"back",
      working:true,workCue:cue,doorway:quarry.doorway,elapsed:7};
    for(const still of [false,true]) for(const night of [false,true]) {
      assert.equal(count(200_000,still,night),1,"ordinary production has a sign even when another activity owns the hero");
      assert.equal(count(200_000,still,night,mining),1,"the worker and production must not draw duplicate signs");
      assert.equal(count(700_000,still,night),0,"finished jobs stop the work sign without requiring a claim");
      assert.equal(count(200_000,still,night,mining,true,"world"),0,"the full map has a production badge instead of a duplicate work sign");
      assert.equal(count(700_000,still,night,mining,true,"world"),0,"a ready production badge is not covered by the expedition's work sign");
      assert.equal(count(200_000,still,night,mining,true,"world",{...production,jobs:[]}),1,"an expedition without production keeps its map work sign");
    }
    assert.equal(count(99_999,false,false),0,"future jobs do not pretend to work early");
    assert.equal(count(200_000,false,false,mining,false),0,"hidden buildings have no orphan work sign");
    assert.equal(count(200_000,false,false,{...mining,working:false}),0,"the worker still on the road does not pretend to be inside");
  }finally{env.restore();}
});

test("unbuilt quarry art suppresses stale mining work signs in both cameras", async () => {
  const quarry={id:"quarry",label:"Шахта",initialLevel:0,bounds:{x:660,y:590,width:55,height:48},
    anchor:{x:688,y:638},entry:{x:680,y:640},doorway:{x:686,y:625},collision:[],hitArea:[],
    states:[{level:0,label:"Руины",image:"/test-quarry-ruins.webp"},{level:1,label:"Шахта",image:"/test-quarry-built.webp"}]};
  const {paintNewMap,TILED_WORLD,NEW_MAP_PET_SIZE,WORLD_DEV_DEFAULTS}=await modules({sites:[quarry]});
  const env=browser();
  try {
    const cue={x:quarry.anchor.x,y:quarry.bounds.y-NEW_MAP_PET_SIZE*.12};
    const mining={...quarry.entry,size:NEW_MAP_PET_SIZE,opacity:0,scale:1,pose:"idle",frame:0,direction:"back",
      working:true,workCue:cue,doorway:quarry.doorway,elapsed:7};
    for(const view of ["circle","world"]) for(const still of [false,true]) for(const level of [0,1]) {
      const surface=env.surface();
      paintNewMap(surface.context,new Map(),{...options,view,reducedMotion:still,economyBuildings:{quarry:level}},7,false,200_000,0,
        {scene:TILED_WORLD,actorAway:true,mining,state:WORLD_DEV_DEFAULTS});
      const signs=surface.calls.filter(call=>call.method==="ellipse" && call.args[0]===cue.x && call.args[1]===cue.y).length;
      assert.equal(signs,level,"a previously working frame cannot paint pickaxes over ruins");
    }
  }finally{env.restore()}
});

test("a camera with unbuilt quarry art keeps a saved mining job off map and replans only after built art commits", async () => {
  const quarry={id:"quarry",label:"Шахта",initialLevel:0,bounds:{x:660,y:590,width:55,height:48},
    anchor:{x:688,y:638},entry:{x:680,y:640},doorway:{x:686,y:625},collision:[],hitArea:[],
    states:[{level:0,label:"Руины",image:"/test-quarry-ruins.webp"},{level:1,label:"Шахта",image:"/test-quarry-built.webp"}]};
  const {mountHabitat,connectForestSession,TILED_WORLD,worldDevStore,forestJourneyActorAway}=await modules({
    ...fishingFixture(),sites:[quarry],destinations:[{id:"quarry",position:{x:674,y:649},pauseSeconds:15}]});
  const env=browser();let camera,probe;
  try {
    worldDevStore.patch({...quietClearing,autoLife:false});
    const journey={id:"paid-before-quarry-gate",routeId:"cave",startedAt:new Date(100_000).toISOString(),
      finishesAt:new Date(700_000).toISOString(),rewards:{stone:8,ore:4}},original=structuredClone(journey);
    const initial={...options,reducedMotion:false,serverNow:160_000,presenceKey:"quarry-ruins-saved-trip",
      economyBuildings:{quarry:0},economyJourney:journey};
    camera=mountHabitat(env.surface(),initial,{activity(){},ready(){},failure:assert.fail});
    env.finish();env.finish();await flush();
    probe=connectForestSession(initial.presenceKey,TILED_WORLD,"circle",160_000,0,()=>{});
    const feet={...probe.state.clearing.position};
    assert.equal(probe.state.journeyTravel,undefined,"the actual mounted controller receives unbuilt visual level");
    assert.equal(forestJourneyActorAway(probe.state,journey,160_000),true);
    camera.configure({...initial,economyBuildings:{quarry:1}});
    assert.equal(probe.state.journeyTravel,undefined,"a pending picture cannot create an invisible portal");
    env.finishPath("/test-quarry-built.webp");await flush();
    assert.equal(probe.state.journeyTravel.phase,"leaving");
    assert.deepEqual(probe.state.clearing.position,feet,"built art resumes the same trip without moving physical feet");
    assert.equal(forestJourneyActorAway(probe.state,journey,160_000),false);
    worldDevStore.patch({previewBuildings:true,levels:{quarry:0}});await flush();
    assert.equal(probe.state.journeyTravel,undefined);
    assert.equal(forestJourneyActorAway(probe.state,journey,160_000),true);
    assert.deepEqual(probe.state.clearing.position,feet);
    assert.deepEqual(journey,original);
  }finally{camera?.dispose();probe?.release();worldDevStore.reset();env.restore()}
});

test("ordinary quarry production walks from base, shares the miner across cameras and yields safely to an expedition", async () => {
  const quarry={id:"quarry",label:"Шахта",initialLevel:1,bounds:{x:660,y:590,width:55,height:48},
    anchor:{x:688,y:638},entry:{x:680,y:640},doorway:{x:686,y:625},collision:[],hitArea:[],
    states:[{level:1,label:"Шахта",image:"/test-quarry.webp"}]};
  const loaded=await modules({...fishingFixture(),sites:[quarry],destinations:[
    {id:"fishing",position:{x:690,y:700},pauseSeconds:15},
    {id:"quarry",position:{x:674,y:649},pauseSeconds:15}]});
  const {mountHabitat,connectForestSession,TILED_WORLD,worldDevStore,forestJourneyActorAway}=loaded;
  const env=browser(),views=[];let probe;
  try {
    worldDevStore.patch({...quietClearing,autoLife:false});
    const owner="mine-worker",production={ownerPublicId:owner,revision:1,jobs:[{id:"quarry-production",stationId:"quarry",stationLevel:1,
      recipeId:"quarry_stone",startedAt:new Date(100_000).toISOString(),finishesAt:new Date(700_000).toISOString()}]};
    const original=structuredClone(production),initial={...options,reducedMotion:false,serverNow:100_000,
      presenceKey:`zhiv:mochlik:presence:${owner}`,economyProduction:production};
    const callbacks={activity(){},ready(){},failure:assert.fail};
    const circle=mountHabitat(env.surface(),initial,callbacks);views.push(circle);
    env.finish();await flush();env.finish();await flush();
    probe=connectForestSession(initial.presenceKey,TILED_WORLD,"circle",100_000,0,()=>{});
    const clock=sceneClock(env),home={...probe.state.clearing.home};
    assert.equal(probe.state.journeyTravel.phase,"leaving","a first mounted production receipt still shows departure");
    assert.deepEqual(probe.state.clearing.position,home);
    clock.until(()=>probe.state.journeyTravel.phase==="working","ordinary stone production reaches the mine",1000);
    const feet={...probe.state.clearing.position},travel=probe.state.journeyTravel;
    const world=mountHabitat(env.surface(),{...initial,view:"world"},callbacks);views.push(world);await flush();
    assert.strictEqual(probe.state.journeyTravel,travel);assert.deepEqual(probe.state.clearing.position,feet);
    assert.equal(env.frames.size,1,"both cameras share the same worker clock");
    const painted=env.surface(),cue=probe.state.journeyTravel.mining.workCue;
    world.paintWorld(painted.context);
    assert.equal(painted.calls.filter(call=>call.method==="ellipse" && call.args[0]===cue.x && call.args[1]===cue.y).length,0,
      "the full map delegates this production roof to its screen-space timer badge");
    const expedition={id:"higher-priority-shore",routeId:"shore",startedAt:new Date(100_000).toISOString(),
      finishesAt:new Date(700_000).toISOString(),rewards:{fish:4}};
    const next={...initial,economyJourney:expedition};
    world.configure({...next,view:"world"});circle.configure({...next,backgrounded:true});
    assert.equal(probe.state.journeyTravel.phase,"exiting");assert.deepEqual(probe.state.clearing.position,feet);
    assert.equal(forestJourneyActorAway(probe.state,expedition,100_000),false);
    clock.until(()=>probe.state.journeyTravel?.phase==="fishing","the new expedition starts after a physical return from the mine",2000);
    assert.equal(probe.state.journeyTravel.jobId,expedition.id);
    assert.deepEqual(production,original,"a visual worker cannot alter production dates, output or claim state");
  }finally{views.forEach(view=>view.dispose());probe?.release();worldDevStore.reset();env.restore();}
});

test("main scene sends the builder home at night, paints shared sleep cues, and wakes him for daylight or construction", async () => {
  const authored = builderFixture(), home = builderHomeFixture(); authored.sites.push(home);
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, builderSleepIndicator, builderMindFrame,
    builderSpriteRig, builderLocalPlaces } = await modules(authored);
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, timeOfDay: "auto", autoLife: false });
    const owner = "builder-home-runtime", initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: `zhiv:mochlik:presence:${owner}`, economyConstruction: confirmedConstruction(owner, 0, []) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finishPath("/test-ground.webp"); env.finishPath("/test-builder-workshop.webp"); env.finishPath("/test-builder-home.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.builderMind, clock = sceneClock(env);
    assert.ok(builderLocalPlaces(TILED_WORLD).home, "the runtime uses a valid authored private doorway");
    assert.equal(mind.sleepPhase, "awake"); assert.equal(builderSleepIndicator(mind, TILED_WORLD), null);
    circle.configure({ ...initial, dusk: true });
    clock.until(() => mind.sleepPhase === "sleep", "the actual night transition walks the builder through his own door", 600);
    assert.deepEqual(mind.position, home.doorway);
    assert.equal(builderMindFrame(mind, TILED_WORLD, false), null, "the indoor builder has no exterior resident sprite");
    assert.ok(builderSleepIndicator(mind, TILED_WORLD));
    const sleeping = structuredClone(mind);
    const world = mountHabitat(env.surface(), { ...initial, dusk: true, view: "world" }, callbacks); views.push(world); await flush();
    assert.deepEqual(mind, sleeping, "opening the main map cannot replay the doorway crossing");
    assert.equal(env.frames.size, 1, "both cameras share the builder clock");
    const sampleSleep = view => {
      const target = env.surface(); view.paintWorld(target.context);
      assert.equal(target.calls.some(call => call.method === "drawImage" && builderSpriteRig(call.args[0])), false);
      assert.notEqual(view.hitResident(home.doorway.x, home.doorway.y - 20), "builder", "an indoor resident cannot intercept taps through his house");
      return target.calls.filter(call => call.method === "fillRect" && call.args[0] === home.doorway.x - 4
        && call.args[2] === 4 && call.args[3] === 1);
    };
    const circleCue = sampleSleep(circle), worldCue = sampleSleep(world);
    assert.ok(circleCue.length >= 2, "the shared painter draws a doorway sleep cue even without a resident sprite");
    assert.deepEqual(worldCue, circleCue, "circle and main map show the same sleep phase");
    assert.deepEqual(mind, sleeping, "painting and hit tests cannot progress indoor time");
    const configure = next => views.forEach((view, index) => view.configure({ ...next, view: index ? "world" : "circle" }));
    configure(initial);
    clock.until(() => mind.sleepPhase === "awake", "daylight lets the builder leave through the same doorway", 600);
    assert.equal(builderSleepIndicator(mind, TILED_WORLD), null);
    assert.ok(builderMindFrame(mind, TILED_WORLD, false));
    configure({ ...initial, dusk: true });
    clock.until(() => mind.sleepPhase === "sleep", "an idle builder returns home on the next night", 600);
    const feet = { ...mind.position }, construction = confirmedConstruction(owner, 1), original = structuredClone(construction);
    configure({ ...initial, dusk: true, economyConstruction: construction });
    assert.deepEqual(mind.position, feet, "a newly confirmed job wakes the builder without relocating indoor feet");
    assert.equal(mind.sleepPhase, "exit"); assert.equal(builderSleepIndicator(mind, TILED_WORLD), null);
    clock.until(() => mind.action === "work", "night construction leaves the house and reaches the assigned workshop", 800);
    assert.equal(mind.target.id, "workshop"); assert.equal(mind.sleepPhase, "awake");
    assert.deepEqual(construction, original, "the night visual cannot change construction dates or rewards");
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("builder work shares one route and clock across cameras; painting and hit tests cannot progress it", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, builderSpriteRig } = await modules(builderFixture());
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const construction = confirmedConstruction("builder-shared"), original = structuredClone(construction);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: "zhiv:mochlik:presence:builder-shared", economyConstruction: construction };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), { ...initial, economyConstruction: confirmedConstruction("builder-shared", 0, []) }, callbacks); views.push(circle);
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    circle.configure(initial);
    const mind = probe.state.builderMind, clock = sceneClock(env);
    assert.ok(mind); assert.equal(mind.job.id, "confirmed-workshop");
    assert.equal(mind.action, "walk");
    const first = { ...mind.position }; clock.advance(.5); assert.notDeepEqual(mind.position, first);
    const beforeMount = structuredClone(mind);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.strictEqual(probe.state.builderMind, mind); assert.deepEqual(mind, beforeMount);
    assert.equal(env.frames.size, 1, "two cameras elect one active clock");
    for (let pass = 0; pass < 4; pass++) for (const view of [circle, world]) {
      const painted = env.surface(); view.paintWorld(painted.context);
      assert.ok(painted.calls.some(call => call.method === "drawImage" && builderSpriteRig(call.args[0])), "the real builder sprite is painted");
      const point = view.inspectPoint("builder"); assert.ok(point); view.hitResident(point.x, point.y);
    }
    assert.deepEqual(mind, beforeMount, "sampling cannot advance builder route, action, or decisions");
    const elapsed = mind.elapsed, sharedElapsed = probe.state.elapsed;
    clock.advance(.4);
    approximately(mind.elapsed - elapsed, probe.state.elapsed - sharedElapsed, "one shared builder simulation step per world step");
    clock.until(() => mind.action === "work", "the builder reaches the confirmed workshop and starts working", 600);
    assert.equal(mind.target.id, "workshop");
    assert.equal(probe.state.explorationId, null, "construction does not assign an expedition to Mochlik");
    assert.deepEqual(construction, original, "the animation cannot edit a confirmed job or its timestamps");
    const handoff = structuredClone(mind); world.dispose(); circle.configure(initial);
    assert.deepEqual(mind, handoff, "returning to the circle preserves the builder at his work spot");
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("live builder detours around visible Mochlik, ignores a hidden body and shares the same yielding route across cameras", async () => {
  const authored = builderFixture(), workMarker = { x: 660, y: 660 };
  // Both route endpoints stay clear. The hero occupies the middle of the
  // otherwise straight, walkable approach to a valid wall-side work marker.
  authored.actor = { ...fixture.actor, spawn: { x: 625, y: 685 } };
  authored.destinations.push({ id: "builder-rest", position: { x: 590, y: 710 }, pauseSeconds: 5 },
    { id: "builder-work-workshop", position: workMarker, pauseSeconds: 5 });
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, forgetForestSession, residentClearance,
    canTraverseResidents, canTraverse } = await modules(authored);
  const env = browser(), views = [], probes = [], keys = [];
  try {
    for (const visible of [true, false]) {
      worldDevStore.patch({ ...quietClearing, autoLife: false, showHero: visible });
      const owner = `resident-traffic-${visible}`, key = `zhiv:mochlik:presence:${owner}`; keys.push(key);
      const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
        economyConstruction: confirmedConstruction(owner, 0, []) };
      const callbacks = { activity() {}, ready() {}, failure: assert.fail };
      const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
      if (visible) { env.finishPath("/test-ground.webp"); env.finishPath("/test-builder-workshop.webp"); }
      await flush();
      const probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(probe);
      const construction = confirmedConstruction(owner, 1), original = structuredClone(construction);
      circle.configure({ ...initial, economyConstruction: construction });
      const mind = probe.state.builderMind, hero = { ...probe.state.clearing.position }, clock = sceneClock(env);
      assert.equal(mind.action, "walk");
      const start = { ...mind.position }, target = { ...mind.target.position };
      assert.deepEqual(target, workMarker, "the fixture's close work marker remains the assigned goal");
      const neighbour = [{ id: "mochlik", position: hero, size: authored.actor.size }];
      assert.ok(canTraverseResidents(start, start, 40, neighbour, "builder"), "the departure point is clear");
      assert.ok(canTraverseResidents(target, target, 40, neighbour, "builder"), "the work endpoint is clear");
      assert.ok(canTraverse(probe.state.clearing.navigation, start, target), "static ground permits the direct approach");
      assert.equal(canTraverseResidents(start, target, 40, neighbour, "builder"), false,
        "the visible hero blocks the middle of the direct swept approach");
      let minGap = distanceBetween(start, hero), detoured = false, world;
      for (let frame = 0; frame < 600 && mind.action !== "work"; frame++) {
        const previous = { ...mind.position }; clock.step();
        minGap = Math.min(minGap, distanceBetween(mind.position, hero));
        assert.ok(distanceBetween(previous, mind.position) <= 34 * .05 + 1e-7, "yielding never pushes or teleports the builder");
        assert.deepEqual(probe.state.clearing.position, hero, "a stationary neighbour is never shoved out of the way");
        const cross = Math.abs((target.x - start.x) * (mind.position.y - start.y) - (target.y - start.y) * (mind.position.x - start.x));
        detoured ||= cross / distanceBetween(start, target) > 12;
        if (visible && detoured && !world) {
          const before = structuredClone(mind);
          world = mountHabitat(env.surface(), { ...initial, economyConstruction: construction, view: "world" }, callbacks);
          views.push(world); await flush();
          assert.strictEqual(probe.state.builderMind, mind);
          for (const view of [circle, world]) {
            view.paintWorld(env.surface().context); const point = view.inspectPoint("builder"); view.hitResident(point.x, point.y);
          }
          assert.deepEqual(mind, before, "camera ownership, paint and hit tests do not replay or advance a detour");
          assert.equal(env.frames.size, 1, "both views use one movement owner");
        }
      }
      assert.equal(mind.action, "work", "a reachable job remains reachable past the other resident");
      if (visible) {
        assert.ok(minGap >= residentClearance(40, authored.actor.size) - 1e-7, `visible bodies keep a useful gap throughout the trip: ${minGap}`);
        assert.equal(detoured, true, "the builder goes around a stationary neighbour instead of waiting forever");
        assert.ok(world, "the camera handoff occurs during the detour");
      } else assert.ok(minGap < 15, "a deliberately hidden hero does not leave an invisible obstacle");
      assert.deepEqual(construction, original, "traffic cannot change the economic construction order");
      world?.dispose(); circle.dispose(); probe.release(); forgetForestSession(key);
    }
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); keys.forEach(forgetForestSession); worldDevStore.reset(); env.restore(); }
});

test("cold home construction leaves room for Mochlik to enter, sleep and return without crossing the builder", async () => {
  const workMarker = { x: 610, y: 640 };
  const authored = { ...residentFixture(), sites: [clearingHome], paths: [clearingHomePath],
    destinations: [...residentFixture().destinations,
      { id: "builder-work-home", position: workMarker, pauseSeconds: 5 }] };
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, clearingActivityFrame, residentClearance } = await modules(authored);
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const owner = "builder-home-access", construction = confirmedConstruction(owner);
    construction.jobs[0].stationId = "home";
    const initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: `zhiv:mochlik:presence:${owner}`, economyConstruction: construction };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finishPath("/test-ground.webp"); env.finishPath("/test-residence.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, builder = state.builderMind, workingFeet = { ...builder.position }, spawn = { ...state.clearing.position };
    assert.equal(builder.action, "work", "an existing house improvement restores the worker directly at the site");
    assert.deepEqual(workingFeet, workMarker, "the close wall-side marker keeps the doorway flow independent of random roaming destinations");
    const clearance = residentClearance(40, TILED_WORLD.actor.size);
    assert.ok(distanceBetween(builder.position, spawn) >= clearance - 1e-7, "restoring a job cannot put the builder on the house owner's spawn");
    const clock = sceneClock(env);
    const step = () => {
      clock.step();
      const hero = clearingActivityFrame(state.clearing);
      if (hero.opacity > .05) assert.ok(distanceBetween(builder.position, hero) >= clearance - 1e-7, "the house approach remains clear of the visible worker");
      assert.deepEqual(builder.position, workingFeet, "entering the home does not displace the working builder");
    };
    worldDevStore.triggerLife("home-sleep");
    for (let frame = 0; frame < 600 && state.clearing.stage !== "home-sleep"; frame++) step();
    assert.equal(state.clearing.stage, "home-sleep", "building does not block the resident's doorway");
    scene.notice();
    const returned = () => state.clearing.routeKind === "clearing" && !state.clearing.activeInteraction
      && clearingActivityFrame(state.clearing).opacity === 1 && distanceBetween(state.clearing.position, clearingHome.entry) >= 12;
    for (let frame = 0; frame < 600 && !returned(); frame++) step();
    assert.notEqual(state.clearing.stage, "home-sleep");
    assert.ok(returned(), `the resident also returns to the clearing while construction continues: ${JSON.stringify({
      hero: state.clearing.position, builder: builder.position, stage: state.clearing.stage,
      reason: state.clearing.behavior.reason })}`);
    assert.equal(builder.action, "work");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("construction removals fence stale cameras and changing accounts cannot inherit another owner's builder job", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(builderFixture());
  const env = browser(), views = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const old = confirmedConstruction("builder-fence", 5), initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: "zhiv:mochlik:presence:builder-fence", economyConstruction: old };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    const probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(probe);
    assert.equal(probe.state.builderMind.job.id, old.jobs[0].id);
    const removed = confirmedConstruction("builder-fence", 6, []);
    const world = mountHabitat(env.surface(), { ...initial, view: "world", economyConstruction: removed }, callbacks); views.push(world); await flush();
    assert.equal(probe.state.economyConstruction.revision, 6); assert.equal(probe.state.builderMind.job, null);
    circle.configure(initial);
    assert.equal(probe.state.economyConstruction.revision, 6); assert.equal(probe.state.builderMind.job, null, "the background camera cannot resurrect collected construction");
    const beforeOwnerChange = structuredClone(probe.state.builderMind);
    const other = { ...initial, presenceKey: "zhiv:mochlik:presence:builder-other", view: "world" };
    world.configure(other);
    const next = connectForestSession(other.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(next);
    assert.notStrictEqual(next.state.builderMind, probe.state.builderMind);
    assert.equal(next.state.economyConstruction, undefined, "a mismatched cached account snapshot is rejected");
    assert.equal(next.state.builderMind.job, null);
    assert.deepEqual(probe.state.builderMind, beforeOwnerChange, "switching accounts cannot mutate the preceding resident");
    const accepted = confirmedConstruction("builder-other", 1);
    world.configure({ ...other, economyConstruction: accepted });
    assert.equal(next.state.builderMind.job.id, accepted.jobs[0].id);
    accepted.jobs[0].stationId = "quarry";
    assert.equal(next.state.economyConstruction.jobs[0].stationId, "workshop", "accepted account data is copied at the boundary");
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("reduced motion and hidden views freeze builder feet while confirmed completion can still refresh", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(builderFixture());
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: "zhiv:mochlik:presence:builder-frozen", economyConstruction: confirmedConstruction("builder-frozen") };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const mind = probe.state.builderMind, clock = sceneClock(env); clock.advance(.5);
    scene.configure({ ...initial, reducedMotion: true, serverNow: 800_000 });
    const feet = { ...mind.position }, elapsed = mind.elapsed;
    assert.equal(mind.ready, true, "the server deadline is independent of the paused cosmetic clock");
    clock.advance(2); assert.deepEqual(mind.position, feet); assert.equal(mind.elapsed, elapsed);
    assert.deepEqual(scene.inspectPoint("builder"), { x: feet.x, y: feet.y - 20 });
    scene.configure({ ...initial, serverNow: 800_000, backgrounded: true });
    const backgrounded = structuredClone(mind); clock.advance(2); assert.deepEqual(mind, backgrounded);
    scene.configure({ ...initial, serverNow: 800_000 }); env.visibility(true);
    const hidden = structuredClone(mind); clock.advance(2); assert.deepEqual(mind, hidden);
    env.visibility(false); clock.advance(.5); assert.ok(mind.elapsed > hidden.elapsed, "visibility resumes the same resident");
    assert.equal(mind.job.id, "confirmed-workshop", "an expired but unclaimed build remains assigned");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("builder taps open his conversation without touching Pleska or Mochlik; camera gestures stay inert", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "builder-taps" };
    const canvas = env.surface(400), residents = [];
    const loading = createMapEngine(canvas, initial, assert.fail, [], undefined, {}, { onResident: id => residents.push(id) });
    env.finish(); await flush(); engine = await loading; engine.control("overview");
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const builder = probe.state.builderMind, seller = structuredClone(probe.state.pleskMind);
    const touch = () => { const projection = mapProjection(canvas); return { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + builder.position.x * projection.zoom, clientY: projection.top + (builder.position.y - 20) * projection.zoom }; };
    const send = (name, point) => canvas.events.get(name)({ ...point, type: name });
    const before = structuredClone(builder); let point = touch();
    send("pointerdown", point); send("pointermove", { ...point, clientX: point.clientX + 30 }); send("pointerup", { ...point, clientX: point.clientX + 30 }); engine.control("overview");
    point = touch(); send("pointerdown", point); send("pointercancel", point);
    const second = { ...point, pointerId: 2, clientX: point.clientX + 35 };
    send("pointerdown", point); send("pointerdown", second); send("pointermove", { ...second, clientX: second.clientX + 10 });
    send("pointerup", point); send("pointerup", { ...second, clientX: second.clientX + 10 }); engine.control("overview");
    assert.deepEqual(residents, []); assert.deepEqual(builder, before);
    point = touch(); send("pointerdown", point); send("pointerup", point);
    assert.deepEqual(residents, ["builder"]); assert.equal(builder.noticePending, true);
    assert.deepEqual(probe.state.pleskMind, seller); assert.equal(probe.state.reaction, 0);
    const clock = sceneClock(env); clock.advance(.1); assert.equal(builder.action, "greet");
    assert.deepEqual(probe.state.pleskMind.position, seller.position, "a builder greeting cannot move the merchant");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a loaded geometry handoff clones builder progress and a late camera joins without rewinding it", async () => {
  const authored = builderFixture(), site = authored.sites[0], shift = -10;
  site.states.push({ level: 2, label: "Большая мастерская", image: "/test-builder-workshop-2.webp", geometry: {
    bounds: { ...site.bounds, x: site.bounds.x + shift }, anchor: { ...site.anchor, x: site.anchor.x + shift },
    entry: { ...site.entry, x: site.entry.x + shift },
    hitArea: site.hitArea.map(point => ({ ...point, x: point.x + shift })),
    collision: site.collision.map(point => ({ ...point, x: point.x + shift })),
  } });
  const { mountHabitat, connectForestSession, previewWorldScene, TILED_WORLD, worldDevStore } = await modules(authored);
  const env = browser(), views = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, economyBuildings: { workshop: 1 },
      presenceKey: "zhiv:mochlik:presence:builder-geometry", economyConstruction: confirmedConstruction("builder-geometry", 5) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    const oldProbe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { workshop: 1 }), "circle", 100_000, 0, () => {}); probes.push(oldProbe);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    const clock = sceneClock(env); clock.advance(.5);
    const oldMind = oldProbe.state.builderMind, beforeLoad = structuredClone(oldMind);
    const completed = { ...initial, view: "world", economyBuildings: { workshop: 2 },
      economyConstruction: confirmedConstruction("builder-geometry", 6, []) };
    world.configure(completed); assert.deepEqual(oldMind.position, beforeLoad.position, "pending art does not teleport the worker");
    env.finishPath("/test-builder-workshop-2.webp"); await flush();
    const newProbe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { workshop: 2 }), "circle", 100_000, 0, () => {}); probes.push(newProbe);
    const newMind = newProbe.state.builderMind;
    assert.notStrictEqual(newMind, oldMind, "different geometry sessions cannot mutate one builder object");
    assert.deepEqual(newMind.position, beforeLoad.position, "the committed footprint retains the worker's current feet");
    assert.equal(newMind.job, null); assert.equal(newProbe.state.economyConstruction.revision, 6);
    world.configure({ ...completed, paused: true });
    circle.configure(initial);
    const frozen = structuredClone(newMind); clock.advance(.5);
    assert.deepEqual(newMind, frozen, "a stale active circle cannot move the paused builder on the new map");
    world.configure(completed); clock.advance(.5);
    const beforeJoin = structuredClone(newMind);
    circle.configure({ ...completed, view: "circle" }); await flush();
    assert.strictEqual(newProbe.state.builderMind, newMind, "late camera does not replace the existing map builder");
    assert.deepEqual(newMind, beforeJoin, "joining preserves the newer job fence, clock and feet");
    assert.equal(newMind.job, null); assert.equal(env.frames.size, 1);
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("unmounting the final tab canvas retains Mochlik, Pleska and builder without an idle clock or remount teleport", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, forgetForestSession, worldDevStore } = await modules(builderFixture());
  const env = browser(), views = []; let probe;
  const initial = { ...options, reducedMotion: false, serverNow: 100_000,
    presenceKey: "zhiv:mochlik:presence:tab-retention", economyConstruction: confirmedConstruction("tab-retention") };
  try {
    worldDevStore.reset();
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    let scene = mountHabitat(env.surface(), { ...initial, economyConstruction: confirmedConstruction("tab-retention", 0, []) }, callbacks); views.push(scene);
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    scene.configure(initial);
    const state = probe.state, clock = sceneClock(env);
    clock.advance(1.5);
    const clearing = state.clearing, plesk = state.pleskMind, builder = state.builderMind;
    assert.ok(builder.elapsed > 0); assert.ok(plesk.elapsed > 0);
    assert.notDeepEqual(builder.position, builder.route.points[0], "the builder is already on his real route");
    for (const view of ["world", "circle"]) {
      const feet = { hero: { ...clearing.position }, plesk: { ...plesk.position }, builder: { ...builder.position } };
      const age = state.elapsed, pleskAge = plesk.elapsed, builderAge = builder.elapsed;
      const route = builder.route, builderDistance = builder.distance, pleskStage = plesk.stage;
      probe.release(); probe = null;
      scene.dispose(); await flush();
      assert.equal(env.frames.size, 0, "no canvas means no autonomous or catch-up RAF");
      env.tick(3_600_000);
      assert.equal(state.elapsed, age);
      scene = mountHabitat(env.surface(), { ...initial, view }, callbacks); views.push(scene); await flush();
      probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
      assert.strictEqual(probe.state, state, "the gap had zero members, but the ordinary tab retains its session");
      assert.strictEqual(state.clearing, clearing); assert.strictEqual(state.pleskMind, plesk); assert.strictEqual(state.builderMind, builder);
      assert.deepEqual({ hero: clearing.position, plesk: plesk.position, builder: builder.position }, feet);
      assert.equal(plesk.elapsed, pleskAge); assert.equal(builder.elapsed, builderAge);
      assert.strictEqual(builder.route, route); assert.equal(builder.distance, builderDistance); assert.strictEqual(plesk.stage, pleskStage);
      assert.equal(env.frames.size, 1, "one camera reacquires one clock");
      env.tick(3_600_100); assert.equal(state.elapsed, age, "first resumed RAF reanchors time instead of simulating the inactive hour");
    }
    const active = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(active); await flush();
    assert.equal(env.frames.size, 1, "an extra mounted camera shares the same clock");
  } finally {
    forgetForestSession(initial.presenceKey);
    views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore();
  }
});

test("confirmed construction geometry keeps builder feet through server hydration, then walks home", async () => {
  const authored = builderFixture(), site = authored.sites[0];
  site.states.push({ level: 2, label: "Большая мастерская", image: "/test-builder-workshop-2.webp", geometry: {
    bounds: { ...site.bounds, x: site.bounds.x - 10 }, anchor: { ...site.anchor, x: site.anchor.x - 10 },
    entry: { ...site.entry, x: site.entry.x - 10 },
    hitArea: site.hitArea.map(point => ({ ...point, x: point.x - 10 })),
    collision: site.collision.map(point => ({ ...point, x: point.x - 10 })),
  } });
  const { mountHabitat, connectForestSession, forgetForestSession, previewWorldScene, TILED_WORLD, ApiError } = await modules(authored);
  const env = browser(), views = [], probes = [];
  try {
    for (const mode of ["claim", "speedup", "speedup-on-route"]) {
      const owner = mode === "claim" ? "1234-ABCD-EFGH" : mode === "speedup" ? "1234-ABCD-EFGJ" : "1234-ABCD-EFGK";
      const key = `zhiv:mochlik:presence:${owner}`, timers = new Map();
      let now = 100_000, serial = 0, revision = 0, holder = null, token = null, savedSnapshot = null;
      const uuid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, "0")}`;
      const environment = { now: () => now, randomUUID: uuid,
        setTimeout(callback, delay) { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; },
        clearTimeout(id) { timers.delete(id); } };
      const serverView = client => ({ ownerPublicId: owner, revision, snapshot: structuredClone(savedSnapshot),
        serverTime: new Date(now).toISOString(), updatedAt: null,
        lease: { owned: holder === client, token: holder === client ? token : null,
          expiresAt: holder ? new Date(now + 90_000).toISOString() : null } });
      const reject = code => { throw new ApiError(code, 409, { code, message: code }); };
      const transport = { async read(_owner, client) { return serverView(client); }, async command(command) {
        if (command.expectedRevision !== revision) reject("FOREST_MEMORY_REVISION_CONFLICT");
        if (command.action === "acquire") {
          if (holder && holder !== command.clientId) reject("FOREST_MEMORY_ACTIVE_ELSEWHERE");
          holder = command.clientId; token = uuid();
        } else {
          if (holder !== command.clientId || token !== command.leaseToken) reject("FOREST_MEMORY_LEASE_LOST");
          if (command.action === "save") savedSnapshot = structuredClone(command.snapshot);
          else { holder = null; token = null; }
        }
        revision++; return { state: serverView(command.clientId), acceptedRevision: revision, replayed: false };
      } };
      const pump = async (ms = 0) => {
        const until = now + ms;
        for (let limit = 0; ; limit++) {
          assert.ok(limit < 100, "lease handoff settles without a request loop"); await flush();
          const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          now = next[1].at; timers.delete(next[0]); next[1].callback();
        }
        now = until; await flush();
      };
      const sourceMap = previewWorldScene(TILED_WORLD, { workshop: 1 });
      const source = connectForestSession(key, sourceMap, "circle", now, 0, () => {}, { sync: { environment, transport } }); probes.push(source);
      const construction = confirmedConstruction(owner, 5);
      const initial = { ...options, reducedMotion: false, serverNow: now, presenceKey: key,
        economyBuildings: { workshop: 1 }, economyConstruction: construction };
      const callbacks = { activity() {}, ready() {}, failure: assert.fail };
      const empty = { ...initial, economyConstruction: confirmedConstruction(owner, 4, []) };
      const circle = mountHabitat(env.surface(), { ...empty, backgrounded: true }, callbacks); views.push(circle);
      const world = mountHabitat(env.surface(), { ...empty, view: "world" }, callbacks); views.push(world);
      if (mode === "claim") { env.finishPath("/test-ground.webp"); env.finishPath("/test-builder-workshop.webp"); }
      await flush(); await pump();
      assert.equal(source.state.memory.sync.mode, "synced");
      world.configure({ ...initial, view: "world" });
      circle.configure({ ...initial, backgrounded: true });
      const clock = sceneClock(env);
      if (mode === "speedup-on-route") clock.advance(.5);
      else clock.until(() => source.state.builderMind.action === "work", "worker reaches the job before confirmed completion", 600);
      const feet = { ...source.state.builderMind.position };
      assert.ok(source.state.builderMind.elapsed > 0);
      assert.ok(mode !== "speedup-on-route" || source.state.builderMind.route, "instant finish may arrive during approach");
      if (mode === "claim") {
        world.configure({ ...initial, view: "world", serverNow: 800_000 });
        assert.equal(source.state.builderMind.ready, true);
      }
      source.saveMemory(); await pump(); assert.ok(savedSnapshot, "the replacement session receives real authoritative forest memory");
      const targetMap = previewWorldScene(TILED_WORLD, { workshop: 2 });
      const target = connectForestSession(key, targetMap, "circle", now, 0, () => {}, { sync: { environment, transport } }); probes.push(target);
      const completed = { ...initial, view: "world", serverNow: mode === "claim" ? 800_000 : 100_000,
        economyBuildings: { workshop: 2 }, economyConstruction: confirmedConstruction(owner, 6, []) };
      world.configure(completed);
      if (mode === "claim") env.finishPath("/test-builder-workshop-2.webp");
      await flush();
      assert.deepEqual(target.state.builderMind.position, feet, "artwork changes never relocate the worker");
      const beforeHydration = target.state.builderMind;
      await pump(15_000);
      assert.equal(target.state.memory.sync.mode, "synced");
      assert.notEqual(target.state.builderMind, beforeHydration, "the regression exercises asynchronous server hydration");
      const current = target.state.builderMind;
      assert.deepEqual(current.position, feet, "server memory has no NPC position and must not teleport him to rest");
      assert.equal(current.job, null); assert.equal(target.state.economyConstruction.revision, 6);
      assert.equal(current.action, mode === "speedup-on-route" ? "walk" : "finish");
      assert.ok(current.route, "a fresh return route is built from the visible feet after hydration");
      assert.deepEqual(current.route.points[0], feet);
      const atHandoff = structuredClone(current);
      circle.configure({ ...completed, view: "circle", backgrounded: true }); await flush();
      assert.deepEqual(target.state.builderMind, atHandoff, "the late second camera cannot rewind the builder or replay completion");
      clock.advance(2);
      assert.notDeepEqual(current.position, feet, "the same worker visibly walks back after his completion nod");
      assert.ok(distanceBetween(current.position, feet) <= 34 * 2, "there is no hidden return teleport");
      world.dispose(); circle.dispose(); source.release(); target.release(); forgetForestSession(key); await pump();
    }
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); env.restore(); }
});

test("returning to a visible map resumes its single world clock after gameplay presence is renewed", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, ApiError, setGamePresence } = await modules(builderFixture());
  const env = browser(), views = []; let probe;
  const owner = "3234-ABCD-EFGH", key = `zhiv:mochlik:presence:${owner}`, server = builderMemoryServer(owner, ApiError);
  let inactive = false, rejected = 0;
  const requirePresence = () => {
    if (!inactive) return;
    rejected++;
    throw new ApiError("GAME_SESSION_INACTIVE", 409, { code: "GAME_SESSION_INACTIVE", message: "GAME_SESSION_INACTIVE" });
  };
  const transport = {
    async read(...args) { requirePresence(); return server.transport.read(...args); },
    async command(...args) { requirePresence(); return server.transport.command(...args); },
  };
  try {
    setGamePresence("before-window-switch");
    probe = connectForestSession(key, TILED_WORLD, "circle", server.now(), 0, () => {},
      { sync: { environment: server.environment, transport }, awaitBuilderConstruction: true });
    const initial = { ...options, reducedMotion: false, serverNow: server.now(), presenceKey: key,
      economyConstruction: confirmedConstruction(owner) };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), { ...initial, backgrounded: true }, callbacks); views.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world);
    env.finishPath("/test-ground.webp"); env.finishPath("/test-builder-workshop.webp");
    await flush(); await server.pump();
    const state = probe.state, clock = sceneClock(env); clock.advance(.5);
    assert.equal(state.memory.sync.mode, "synced");
    assert.ok(state.elapsed > 0); assert.ok(state.builderMind.elapsed > 0); assert.ok(state.pleskMind.elapsed > 0);
    assert.equal(env.frames.size, 1, "the map owns the clock while the mounted circle stays in the background");

    env.visibility(true); await server.pump();
    assert.equal(env.frames.size, 0, "a hidden window stops the scene clock");
    setGamePresence(null); inactive = true;
    env.visibility(false); await server.pump();
    assert.ok(rejected > 0, "the scene returns before the gameplay session has reconnected");
    assert.equal(state.memory.sync.mode, "offline");
    const frozen = state.elapsed; clock.step(60_000);
    assert.equal(state.elapsed, frozen);
    world.configure({ ...initial, view: "world", serverNow: server.now() }); await server.pump();
    assert.equal(env.frames.size, 0, "an economic snapshot does not bypass the missing authoritative lease");

    inactive = false; setGamePresence("after-window-switch"); await server.pump();
    assert.equal(state.memory.sync.mode, "synced", "new gameplay presence wakes the retained scene without remounting it");
    assert.equal(env.frames.size, 1, "lease recovery restarts exactly one simulation RAF");
    const resumed = { world: state.elapsed, builder: state.builderMind.elapsed, plesk: state.pleskMind.elapsed };
    clock.step(); assert.equal(state.elapsed, resumed.world, "the first frame reanchors time instead of simulating the hidden minute");
    clock.advance(.3);
    assert.ok(state.elapsed > resumed.world, "the world clock runs again");
    assert.ok(state.builderMind.elapsed > resumed.builder, "the builder resumes");
    assert.ok(state.pleskMind.elapsed > resumed.plesk, "Pleska resumes");
    assert.equal(env.frames.size, 1);
  } finally {
    views.forEach(view => view.dispose()); probe?.release(); forgetForestSession(key); await server.pump();
    setGamePresence(null); env.restore();
  }
});

test("cold reentry restores confirmed builder work at its site before delayed forest memory, including ready and reduced motion", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, ApiError } = await modules(builderFixture());
  const env = browser(), views = [], probes = [], keys = [];
  try {
    for (const [index, mode] of ["active", "delayed-active", "ready-static"].entries()) {
      const owner = ["2234-ABCD-EFGH", "2234-ABCD-EFGJ", "2234-ABCD-EFGK"][index];
      const key = `zhiv:mochlik:presence:${owner}`, server = builderMemoryServer(owner, ApiError); keys.push(key);
      const sync = { environment: server.environment, transport: server.transport };
      const source = connectForestSession(key, TILED_WORLD, "circle", server.now(), 0, () => {}, { sync, awaitBuilderConstruction: true }); probes.push(source);
      const construction = confirmedConstruction(owner, 5), original = structuredClone(construction);
      const initial = { ...options, reducedMotion: false, serverNow: server.now(), presenceKey: key, economyConstruction: construction };
      const callbacks = { activity() {}, ready() {}, failure: assert.fail };
      const before = mountHabitat(env.surface(), initial, callbacks); views.push(before);
      if (index === 0) { env.finishPath("/test-ground.webp"); env.finishPath("/test-builder-workshop.webp"); }
      await flush(); await server.pump();
      assert.equal(source.state.memory.sync.mode, "synced");
      const clock = sceneClock(env);
      clock.until(() => source.state.builderMind.action === "work", "the source builder reached his actual work spot", 300);
      clock.advance(.5);
      const workingFeet = { ...source.state.builderMind.position };
      await server.pump(5_000);
      before.configure({ ...initial, serverNow: server.now() });
      source.saveMemory(); await server.pump(); assert.ok(server.snapshot());
      const previousState = source.state;
      before.dispose(); source.release(); forgetForestSession(key); await server.pump();
      assert.equal(env.frames.size, 0, "a cold reload has no retained scene clock");
      await server.pump(mode === "ready-static" ? 695_000 : 1_000);
      server.holdReads();
      const returned = connectForestSession(key, TILED_WORLD, "circle", server.now(), 0, () => {}, { sync, awaitBuilderConstruction: true }); probes.push(returned);
      assert.notStrictEqual(returned.state, previousState, "this is a new cold session, not the in-page tab cache");
      const reentry = { ...initial, serverNow: server.now(), reducedMotion: mode === "ready-static",
        economyConstruction: mode === "active" ? construction : null };
      const after = mountHabitat(env.surface(), reentry, callbacks); views.push(after); await flush();
      if (mode !== "active") {
        after.configure({ ...reentry, economyConstruction: confirmedConstruction("WRNG-ABCD-EFGH", 999) });
        assert.equal(returned.state.economyConstruction, undefined, "another account cannot consume initialization");
        assert.equal(returned.state.builderMind.job, null);
        after.configure({ ...reentry, economyConstruction: construction });
      }
      assert.deepEqual(returned.state.builderMind.position, workingFeet, "confirmed existing work does not replay a trip from map center");
      assert.equal(returned.state.builderMind.route, null);
      assert.equal(returned.state.builderMind.action, mode === "ready-static" ? "idle" : "work");
      assert.equal(returned.state.builderMind.ready, mode === "ready-static");
      server.releaseReads(); await server.pump();
      assert.equal(returned.state.memory.sync.mode, "synced");
      assert.deepEqual(returned.state.builderMind.position, workingFeet, "late authoritative forest hydration keeps restored work feet");
      assert.equal(returned.state.builderMind.route, null);
      const confirmed = { ...reentry, economyConstruction: construction };
      const samePage = returned.state, feet = { ...samePage.builderMind.position };
      returned.release(); after.dispose(); await server.pump();
      const tab = mountHabitat(env.surface(), { ...confirmed, view: "world" }, callbacks); views.push(tab); await flush();
      const tabProbe = connectForestSession(key, TILED_WORLD, "circle", server.now(), 0, () => {}, { sync, awaitBuilderConstruction: true }); probes.push(tabProbe);
      assert.strictEqual(tabProbe.state, samePage, "ordinary tab remount still keeps the existing session");
      assert.deepEqual(tabProbe.state.builderMind.position, feet);
      assert.deepEqual(construction, original, "restoring the visual work cannot mutate confirmed dates or rewards");
      tab.dispose(); tabProbe.release(); forgetForestSession(key); await server.pump();
    }
  } finally {
    views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); keys.forEach(forgetForestSession); env.restore();
  }
});

test("a construction first confirmed in an already open scene walks from the visible feet even after a delayed response", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore } = await modules(builderFixture());
  const env = browser(); let scene, probe;
  const owner = "live-builder-delay", key = `zhiv:mochlik:presence:${owner}`;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
      economyConstruction: confirmedConstruction(owner, 5, []) };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finishPath("/test-ground.webp"); env.finishPath("/test-builder-workshop.webp"); await flush();
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const clock = sceneClock(env); clock.advance(.5);
    const mind = probe.state.builderMind, feet = { ...mind.position };
    const construction = confirmedConstruction(owner, 6);
    construction.jobs[0].startedAt = new Date(110_000).toISOString();
    scene.configure({ ...initial, serverNow: 150_000, economyConstruction: construction });
    assert.deepEqual(mind.position, feet, "a delayed new receipt is not a cold reentry restoration");
    assert.equal(mind.action, "walk"); assert.ok(mind.route);
    clock.advance(.5); assert.notDeepEqual(mind.position, feet);
    const onRoute = { ...mind.position };
    scene.configure({ ...initial, serverNow: 150_000, economyConstruction: confirmedConstruction(owner, 7, []) });
    scene.configure({ ...initial, serverNow: 150_000, economyConstruction: construction });
    assert.deepEqual(mind.position, onRoute, "stale snapshots cannot replay initialization or rewind feet");
    assert.equal(mind.job, null); assert.equal(probe.state.economyConstruction.revision, 7);
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("delayed first economy and upgraded artwork restore builder to the actual displayed construction site", async () => {
  const authored = builderFixture(), site = authored.sites[0], shift = 70;
  site.states.push({ level: 2, label: "Большая мастерская", image: "/test-builder-workshop-2.webp", geometry: {
    bounds: { ...site.bounds, x: site.bounds.x + shift }, anchor: { ...site.anchor, x: site.anchor.x + shift },
    entry: { ...site.entry, x: site.entry.x + shift },
    hitArea: site.hitArea.map(point => ({ ...point, x: point.x + shift })),
    collision: site.collision.map(point => ({ ...point, x: point.x + shift })),
  } });
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, previewWorldScene, builderSpriteRig,
    residentClearance, canTraverseResidents, BUILDER_NAVIGATION_LIMITS } = await modules(authored);
  const env = browser(); let scene, probe;
  const owner = "cold-high-level", key = `zhiv:mochlik:presence:${owner}`;
  try {
    const initial = { ...options, serverNow: 400_000, presenceKey: key, economyConstruction: null };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finishPath("/test-ground.webp"); env.finishPath("/test-builder-workshop.webp"); await flush();
    const unloaded = env.surface(); scene.paintWorld(unloaded.context);
    assert.equal(unloaded.calls.some(call => call.method === "drawImage" && builderSpriteRig(call.args[0])), false,
      "loading the economy does not flash a builder in the map center");
    const construction = confirmedConstruction(owner, 12); construction.jobs[0].targetLevel = 3;
    scene.configure({ ...initial, economyBuildings: { workshop: 2 }, economyConstruction: construction });
    assert.ok(env.pending.some(request => request.path === "/test-builder-workshop-2.webp"));
    env.finishPath("/test-builder-workshop-2.webp"); await flush();
    const actual = previewWorldScene(TILED_WORLD, { workshop: 2 });
    probe = connectForestSession(key, actual, "circle", 400_000, 0, () => {});
    const mind = probe.state.builderMind;
    assert.strictEqual(mind.scene, actual);
    assert.equal(mind.action, "work"); assert.equal(mind.route, null);
    assert.deepEqual(mind.target.lookAt, actual.sites[0].anchor, "work faces the newly loaded building, not its old default art");
    const actualSite = actual.sites[0], doorway = actualSite.doorway ?? actualSite.entry;
    assert.ok(distanceBetween(mind.position, actualSite.entry) >= residentClearance(40, actual.actor.size) - 1e-7,
      "restored work leaves room at the authoritative higher-level entrance");
    assert.ok(canTraverseResidents(actualSite.entry, doorway, actual.actor.size,
      [{ id: "builder", position: mind.position, size: 40 }], "mochlik"), "the doorway approach remains clear of the restored worker");
    assert.ok(distanceToContour(mind.position, actualSite.collision) <= BUILDER_NAVIGATION_LIMITS.workReach,
      "restored work remains within reach of the authoritative higher-level facade");
    assert.deepEqual(scene.inspectPoint("builder"), { x: mind.position.x, y: mind.position.y - 20 });
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); env.restore(); }
});

test("map speech uses a transparent surface that follows DPR resizing and clears after expiry", async () => {
  const { createMapEngine } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), speech = env.surface(400);
    const loading = createMapEngine(canvas, options, () => {}, [], undefined, {}, {}, speech);
    env.finish(); engine = await loading;
    assert.deepEqual([speech.width, speech.height], [800, 800]);
    assert.ok(speech.calls.some(call => call.method === "clearRect" && call.args[2] === 400));
    assert.equal(speech.calls.some(call => call.method === "drawImage"), false, "the speech surface stays transparent outside bubbles");
    canvas.calls.length = 0; speech.calls.length = 0;
    engine.notice();
    assert.ok(speech.calls.some(call => call.method === "fillText" && call.args[0] === "Мохлик"));
    assert.equal(canvas.calls.some(call => call.method === "fillText" && call.args[0] === "Мохлик"), false,
      "the world canvas cannot leave the speech underneath DOM building hints");
    canvas.clientWidth = 360; canvas.clientHeight = 640; window.devicePixelRatio = 1.5;
    speech.calls.length = 0;
    env.resize(canvas);
    assert.deepEqual([speech.width, speech.height], [540, 960]);
    assert.deepEqual(speech.calls.findLast(call => call.method === "setTransform").args, [1.5, 0, 0, 1.5, 0, 0]);
    assert.ok(speech.calls.some(call => call.method === "clearRect" && call.args[2] === 360 && call.args[3] === 640));
    assert.ok(speech.calls.some(call => call.method === "fillText" && call.args[0] === "Мохлик"), "resizing preserves the active reply");
    for (const id of [...env.timers.keys()]) env.fireTimer(id);
    speech.calls.length = 0; engine.update(options);
    assert.ok(speech.calls.some(call => call.method === "clearRect" && call.args[2] === 360 && call.args[3] === 640));
    assert.equal(speech.calls.some(call => call.method === "fillText"), false, "expired bubbles leave no stale glyphs above hints");
    assert.equal(env.frames.size, 0, "reduced motion still uses finite expiry timers");
    engine.dispose();
    assert.deepEqual(speech.calls.at(-1), { method: "clearRect", args: [0, 0, 540, 960] });
  } finally { engine?.dispose(); env.restore(); }
});

test("resident speech is shared across cameras, bounded under taps and read-only during paint and hit sampling", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "social-shared-cameras" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail }, canvas = env.surface();
    const circle = mountHabitat(canvas, initial, callbacks); views.push(circle);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    circle.noticeResident("builder");
    const social = probe.state.social;
    assert.equal(social.current?.speaker, "builder");
    const clock = sceneClock(env); clock.advance(.3);
    assert.ok(canvas.calls.some(call => call.method === "fillText" && call.args[0] === "Шишколап"),
      "the visible circle actually paints the character's speech label");
    const beforeHandoff = structuredClone(social);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); views.push(world); await flush();
    assert.strictEqual(probe.state.social, social);
    assert.deepEqual(social, beforeHandoff, "opening another camera does not replay a line or consume its duration");
    assert.equal(env.frames.size, 1, "only the elected camera advances the shared conversation");
    const feet = { ...probe.state.builderMind.position }, snapshot = structuredClone(social);
    for (let pass = 0; pass < 12; pass++) {
      for (const view of [circle, world]) {
        const frames = view.speechFrames(); assert.equal(frames.length, 1);
        assert.equal(frames[0].text, snapshot.current.text);
        frames[0].text = "renderer-local edit"; frames[0].anchor.x = -1;
        view.paintWorld(env.surface().context);
        const point = view.inspectPoint("builder"); view.hitResident(point.x, point.y);
      }
      circle.noticeResident("plesk"); world.noticeResident("builder");
    }
    assert.deepEqual(social, snapshot, "sampling and repeated taps cannot enqueue, replace or prolong a bubble");
    assert.deepEqual(probe.state.builderMind.position, feet);
    assert.deepEqual(circle.speechFrames(), world.speechFrames());
    const elapsed = social.elapsed, speechAge = social.current.elapsed, worldElapsed = probe.state.elapsed;
    clock.advance(.5);
    approximately(social.elapsed - elapsed, probe.state.elapsed - worldElapsed, "speech has one simulation clock");
    approximately(social.current.elapsed - speechAge, probe.state.elapsed - worldElapsed, "both renderers consume one shared line age");
    world.dispose(); circle.configure(initial); await flush();
    assert.equal(probe.state.social.sequence, snapshot.sequence, "returning to the circle preserves the current line");
    clock.advance(5);
    assert.equal(social.current, null); assert.equal(social.queue.length, 0);
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("reduced-motion resident speech expires with one finite timer and tap spam cannot extend it", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, serverNow: 100_000, presenceKey: "social-static-expiry" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const feet = { ...probe.state.builderMind.position };
    scene.noticeResident("builder");
    const original = structuredClone(probe.state.social.current), timers = [...env.timers.keys()];
    assert.equal(original?.speaker, "builder"); assert.equal(timers.length, 1);
    assert.equal(env.frames.size, 0, "speech does not enable a reduced-motion animation loop");
    for (let pass = 0; pass < 30; pass++) { scene.noticeResident("builder"); scene.noticeResident("plesk"); }
    assert.deepEqual({ ...probe.state.social.current, elapsed: original.elapsed }, original);
    assert.ok(probe.state.social.current.elapsed >= original.elapsed, "only elapsed wall time can age a static line");
    assert.deepEqual([...env.timers.keys()], timers);
    env.fireTimer(timers[0]);
    assert.equal(probe.state.social.current, null); assert.deepEqual(scene.speechFrames(), []);
    assert.deepEqual(probe.state.builderMind.position, feet);
    assert.equal(env.timers.size, 0); assert.equal(env.frames.size, 0);
    scene.dispose(); assert.equal(env.timers.size, 0);
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("a delayed speech font repaints static glyph metrics once without advancing dialogue or reviving a disposed canvas", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore } = await modules(residentFixture());
  const env = browser(), views = []; let probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const requests = []; let resolveFont, fontReady = false, glyphsUsingReadyFont = 0;
    const pendingFont = new Promise(resolve => { resolveFont = resolve; });
    document.fonts = { load(font, text) { requests.push({ font, text }); return pendingFont; } };
    const canvas = env.surface(), disposedCanvas = env.surface();
    canvas.context.measureText = text => {
      if (fontReady) glyphsUsingReadyFont++;
      return { width: String(text).length * (fontReady ? 11 : 3) };
    };
    const initial = { ...options, serverNow: 100_000, presenceKey: "social-static-font" };
    let rendered = 0, disposedRendered = 0;
    const scene = mountHabitat(canvas, initial, { activity() {}, ready() {}, failure: assert.fail, rendered() { rendered++; } }); views.push(scene);
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    scene.noticeResident("builder");
    assert.equal(probe.state.social.current?.speaker, "builder");
    assert.ok(canvas.calls.some(call => call.method === "fillText"), "the fallback face can show a reply before the font arrives");
    const second = mountHabitat(disposedCanvas, initial, {
      activity() {}, ready() {}, failure: assert.fail, rendered() { disposedRendered++; },
    }); views.push(second); await flush(); second.dispose();
    assert.equal(requests.length, 1, "both canvas mounts share one local font request");
    assert.match(requests[0].font, /Zhiv Residents/); assert.match(requests[0].text, /Мохлик/);
    const snapshot = structuredClone({ social: probe.state.social, elapsed: probe.state.elapsed,
      hero: probe.state.clearing.position, builder: probe.state.builderMind.position });
    const timers = [...env.timers.keys()], before = rendered, deadBefore = disposedRendered;
    const callsBefore = canvas.calls.length, deadCallsBefore = disposedCanvas.calls.length;
    const oldTextWidth = canvas.calls.findLast(call => call.method === "fillText").args[3];
    fontReady = true; resolveFont([{}]); await flush();
    assert.equal(rendered, before + 1, "font readiness invalidates the still canvas exactly once");
    assert.ok(glyphsUsingReadyFont > 0, "the repaint measures real loaded glyphs rather than retaining fallback line widths");
    const repainted = canvas.calls.slice(callsBefore);
    assert.equal(repainted.filter(call => call.method === "clearRect").length, 1);
    assert.notEqual(repainted.findLast(call => call.method === "fillText").args[3], oldTextWidth,
      "the speech layout adapts to the changed font metrics");
    assert.deepEqual({ social: probe.state.social, elapsed: probe.state.elapsed,
      hero: probe.state.clearing.position, builder: probe.state.builderMind.position }, snapshot,
    "loading a font cannot replay a line, age a conversation, or move either character");
    assert.deepEqual([...env.timers.keys()], timers, "font readiness does not extend the existing speech expiry");
    assert.equal(env.frames.size, 0, "a still canvas does not acquire an animation loop to load its font");
    assert.equal(disposedRendered, deadBefore); assert.equal(disposedCanvas.calls.length, deadCallsBefore,
      "the same delayed completion cannot repaint a disposed surface");
    await flush(); assert.equal(rendered, before + 1, "there is no repeated font-readiness redraw");
  } finally { views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("an optional builder visit walks from real feet and yields immediately to construction or explicit controls", async () => {
  const authored = builderFixture();
  authored.destinations.push({ id: "builder-rest", position: { x: 700, y: 640 }, pauseSeconds: 10 });
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, forgetForestSession } = await modules(authored);
  const env = browser(), views = [], probes = [];
  try {
    for (const mode of ["construction", "manual", "hidden"]) {
      worldDevStore.patch({ ...quietClearing, autoLife: true, pose: "auto", showHero: true });
      const owner = `social-interrupt-${mode}`, key = `zhiv:mochlik:presence:${owner}`;
      const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
        economyConstruction: confirmedConstruction(owner, 0, []) };
      const scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail }); views.push(scene);
      if (mode === "construction") { env.finishPath("/test-ground.webp"); env.finishPath("/test-builder-workshop.webp"); }
      await flush();
      const probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(probe);
      const mind = probe.state.builderMind, social = probe.state.social, feet = { ...mind.position }, hero = { ...probe.state.clearing.position };
      social.nextEncounterAt = social.elapsed;
      const clock = sceneClock(env);
      clock.until(() => social.meeting?.phase === "approach", "a free builder can decide to visit a free neighbour", 40);
      assert.ok(mind.socialVisit); assert.ok(mind.route);
      assert.ok(distanceBetween(mind.position, feet) < 2, "planning a conversation never relocates feet");
      clock.advance(.2);
      assert.ok(distanceBetween(mind.position, feet) > 0 && distanceBetween(mind.position, feet) <= 34 * .3,
        "the normal navigation owner performs the approach at walking speed");
      assert.deepEqual(probe.state.clearing.position, hero, "the visitor does not push its future partner");
      const beforeInterrupt = { ...mind.position };
      if (mode === "construction") {
        const construction = confirmedConstruction(owner, 1), original = structuredClone(construction);
        scene.configure({ ...initial, economyConstruction: construction });
        assert.equal(mind.job?.id, "confirmed-workshop"); assert.equal(mind.target?.id, "workshop");
        assert.deepEqual(construction, original, "conversation preemption cannot alter economic dates or rewards");
      } else worldDevStore.patch(mode === "manual" ? { pose: "greet" } : { showHero: false });
      assert.equal(social.meeting, null); assert.equal(social.current, null); assert.equal(social.queue.length, 0);
      assert.equal(mind.socialVisit, null); assert.deepEqual(mind.position, beforeInterrupt, "cancellation never teleports the visitor home");
      scene.dispose(); probe.release(); forgetForestSession(key);
    }
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); worldDevStore.reset(); env.restore(); }
});

test("authoritative forest-memory rehydration drops speech and visits without saving or replaying dialogue", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, ApiError } = await modules(residentFixture());
  const env = browser(), key = "zhiv:mochlik:presence:3234-ABCD-EFGH"; let scene, probe;
  try {
    const server = builderMemoryServer("3234-ABCD-EFGH", ApiError);
    probe = connectForestSession(key, TILED_WORLD, "circle", server.now(), 0, () => {},
      { sync: { environment: server.environment, transport: server.transport } });
    scene = mountHabitat(env.surface(), { ...options, serverNow: server.now(), presenceKey: key },
      { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); await server.pump();
    assert.equal(probe.state.memory.sync.mode, "synced");
    scene.noticeResident("builder");
    const before = probe.state.social;
    assert.equal(before.current?.speaker, "builder");
    probe.saveMemory(); await server.pump();
    const saved = server.snapshot(); assert.ok(saved);
    assert.equal(JSON.stringify(saved).includes(before.current.text), false, "speech never enters the persistent memory payload");
    assert.equal(Object.hasOwn(saved, "social"), false);
    server.refence(); probe.saveMemory(); await server.pump(500);
    assert.equal(probe.state.memory.sync.mode, "synced");
    assert.notStrictEqual(probe.state.social, before, "a real CAS conflict forced an authoritative memory application");
    assert.equal(probe.state.social.current, null); assert.equal(probe.state.social.meeting, null);
    assert.equal(probe.state.builderMind.socialVisit, null); assert.deepEqual(scene.speechFrames(), []);
    assert.equal(env.timers.size, 0, "hydration cancels the old reduced-motion speech expiry");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); env.restore(); }
});

test("a voluntary map conversation preserves a complete script and releases both neighbours after its finite exchange", async () => {
  const { createMapEngine, connectForestSession, TILED_WORLD, worldDevStore, FOREST_CONVERSATIONS } = await modules(residentFixture());
  const env = browser(); let engine, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "social-complete-exchange" };
    const canvas = env.surface(400), loading = createMapEngine(canvas, initial, assert.fail, []);
    env.finish(); engine = await loading;
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    // Isolate the neighbour encounter from unrelated random walks. The social
    // director still uses real navigation, occupancy, shared clocks and paint.
    probe.state.clearing.waitSeconds = 60; probe.state.director.nextDecisionAt = 60;
    probe.state.social.nextEncounterAt = probe.state.social.elapsed;
    const social = probe.state.social, hero = { ...probe.state.clearing.position }, clock = sceneClock(env);
    clock.until(() => social.meeting?.phase === "talk", "a visitor arrives before anyone speaks", 160);
    const lines = [], ids = new Set();
    for (let pass = 0; pass < 720 && social.meeting; pass++) {
      if (social.current && !ids.has(social.current.id)) { ids.add(social.current.id); lines.push({ ...social.current }); }
      assert.deepEqual(probe.state.clearing.position, hero, "the brief exchange holds the listener without moving its feet");
      assert.ok(distanceBetween(probe.state.builderMind.position, hero) >= 24, "the conversation preserves a visible body gap");
      clock.step();
    }
    const script = FOREST_CONVERSATIONS.find(topic => topic.id === social.topicHistory.at(-1));
    assert.deepEqual(lines.map(({ speaker, text }) => ({ speaker, text })), script.lines);
    assert.ok(lines.length >= 4 && lines.length <= 6);
    assert.equal(social.meeting, null); assert.equal(social.current, null); assert.equal(social.queue.length, 0);
    assert.equal(probe.state.builderMind.socialVisit, null, "the visit cannot reserve the builder after the last reply");
    const labels = new Set(canvas.calls.filter(call => call.method === "fillText").map(call => call.args[0]));
    assert.ok(labels.has("Шишколап") && labels.has("Мохлик"), "the full map paints both turns above their visible speakers");
    assert.ok(social.nextEncounterAt > social.elapsed + 60, "a conversation is followed by a substantial quiet interval");
  } finally { engine?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});


test("Mochlik and Plesk hold only their live conversation and a manual shop visit preempts it", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, FOREST_CONVERSATIONS } = await modules(tradingFixture());
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "social-mochlik-plesk-runtime" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.finishPath("/test-plesk-shop.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, plesk = state.pleskMind, social = state.social;
    state.builderMind = null;
    state.director.nextDecisionAt = 120;
    plesk.intent = "look"; plesk.stage = { ...plesk.stage, action: "idle", duration: .15 }; plesk.age = 0; plesk.queue = [];
    social.nextEncounterAt = social.elapsed;
    const heroFeet = { ...state.clearing.position }, pleskFeet = { ...plesk.position }, clock = sceneClock(env);
    clock.until(() => social.meeting?.phase === "talk", "nearby free Mochlik and Plesk start a real map conversation", 20);
    assert.equal(social.meeting.guest, "mochlik"); assert.equal(social.meeting.host, "plesk");
    const heldAge = plesk.age, heroAge = state.clearing.stageElapsed, spoken = [], seen = new Set();
    for (let pass = 0; pass < 720 && social.meeting; pass++) {
      if (social.current && !seen.has(social.current.id)) { seen.add(social.current.id); spoken.push({ speaker: social.current.speaker, text: social.current.text }); }
      assert.deepEqual(plesk.position, pleskFeet); assert.deepEqual(state.clearing.position, heroFeet);
      assert.equal(plesk.age, heldAge, "socialHold prevents a nearly complete idle stage from turning into fishing");
      assert.equal(state.clearing.stageElapsed, heroAge, "the actual director holds Mochlik during his own exchange");
      clock.step();
    }
    assert.equal(social.meeting, null);
    const script = FOREST_CONVERSATIONS.find(topic => topic.id === social.topicHistory.at(-1));
    assert.equal(script.pair, "mochlik-plesk"); assert.deepEqual(spoken, script.lines);
    // Start another finite exchange to exercise the public manual-shop action,
    // rather than toggling the social state or calling its cancellation helper.
    plesk.intent = "look"; plesk.stage = { ...plesk.stage, action: "idle", duration: 60 }; plesk.age = 0; plesk.queue = [];
    state.clearing.waitSeconds = 60; state.director.nextDecisionAt = state.elapsed + 60;
    social.nextEncounterAt = social.elapsed;
    clock.until(() => social.meeting?.phase === "talk", "the next requested quiet opportunity starts", 20);
    scene.visitTradingPlace("plesk");
    assert.equal(social.meeting, null); assert.equal(social.queue.length, 0); assert.equal(social.current, null);
    assert.equal(plesk.tradePending, true);
    assert.equal(state.director.tradeVisit?.phase, "outbound", "the optional chat cannot make a manual trip to the stall fail its blocked gate");
    const ageBefore = plesk.age;
    clock.advance(.2);
    assert.ok(plesk.age > ageBefore || plesk.intent === "trade", "Plesk resumes her finite stage after the hold is released");
    assert.ok(distanceBetween(state.clearing.position, heroFeet) > 0, "Mochlik follows the explicit shop route after cancellation");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("Plesk and the builder finish their live exchange while uninvolved Mochlik keeps his route", async () => {
  const { mountHabitat, connectForestSession, TILED_WORLD, worldDevStore, FOREST_CONVERSATIONS, requestClearingPoint } = await modules(residentFixture());
  const env = browser(); let scene, probe;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "social-builder-plesk-runtime" };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, plesk = state.pleskMind, builder = state.builderMind, social = state.social;
    state.director.nextDecisionAt = 120;
    builder.position = { x: 660, y: 680 }; builder.route = null; builder.target = null; builder.wait = 60; builder.action = "idle";
    plesk.intent = "look"; plesk.stage = { ...plesk.stage, action: "idle", duration: 60 }; plesk.age = 0; plesk.queue = [];
    const heroFeet = { ...state.clearing.position }, pleskFeet = { ...plesk.position };
    assert.equal(requestClearingPoint(state.clearing, { x: 590, y: 660 }), true);
    social.nextEncounterAt = social.elapsed;
    const clock = sceneClock(env);
    clock.until(() => social.meeting?.phase === "talk", "the real builder visits idle Plesk while Mochlik has his own route", 160);
    assert.equal(social.meeting.guest, "builder"); assert.equal(social.meeting.host, "plesk");
    const heldAge = plesk.age, builderFeet = { ...builder.position }, heroAtTalk = { ...state.clearing.position }, spoken = [], seen = new Set();
    plesk.stage.duration = heldAge + .1;
    for (let pass = 0; pass < 720 && social.meeting; pass++) {
      if (social.current && !seen.has(social.current.id)) { seen.add(social.current.id); spoken.push({ speaker: social.current.speaker, text: social.current.text }); }
      assert.deepEqual(plesk.position, pleskFeet); assert.deepEqual(builder.position, builderFeet);
      assert.equal(plesk.age, heldAge, "Plesk stays in the accepted conversation instead of restarting her AI stage");
      clock.step();
    }
    const script = FOREST_CONVERSATIONS.find(topic => topic.id === social.topicHistory.at(-1));
    assert.equal(script.pair, "builder-plesk"); assert.deepEqual(spoken, script.lines);
    assert.equal(social.meeting, null); assert.equal(builder.socialVisit, null);
    assert.ok(distanceBetween(state.clearing.position, heroFeet) > 30);
    assert.ok(distanceBetween(state.clearing.position, heroAtTalk) > 10, "a Plesk-builder chat cannot apply Mochlik's social hold");
  } finally { scene?.dispose(); probe?.release(); worldDevStore.reset(); env.restore(); }
});


test("builder DEV playback shares cameras, retains real work and restores natural animation after cancellation", async () => {
  const { mountHabitat, createMapEngine, connectForestSession, TILED_WORLD, worldDevStore, builderSpriteRig } = await modules(builderFixture());
  const env = browser(), views = []; let probe, engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    worldDevStore.triggerBuilder("work", true);
    const construction = confirmedConstruction("dev-builder-preview"), original = structuredClone(construction);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000,
      presenceKey: "zhiv:mochlik:presence:dev-builder-preview", economyConstruction: construction };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle);
    env.finish(); await flush(); env.finishPath("/test-builder-workshop.webp"); await flush();
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, mind = state.builderMind, clock = sceneClock(env);
    const paint = view => {
      const surface = env.surface(); view.paintWorld(surface.context);
      return surface.calls.find(call => call.method === "drawImage" && builderSpriteRig(call.args[0]))?.args[0];
    };
    assert.ok(state.builderPreview, "premount selection receives a shared start time");
    assert.equal(state.memory.enabled, false, "manual playback cannot persist synthetic activity");
    const startedAt = state.builderPreview.startedAt, originalMind = structuredClone(mind);
    const front = paint(circle);
    worldDevStore.patch({ builderDirection: "back" });
    assert.notEqual(paint(circle), front, "the procedural sprite visibly turns");
    assert.deepEqual(mind, originalMind, "direction changes cannot turn natural AI, move feet or change the order");
    assert.equal(state.builderPreview.startedAt, startedAt);
    const canvas = env.surface(400), loading = createMapEngine(canvas, { ...initial, view: "world" }, () => {}, []);
    await flush(); engine = await loading;
    assert.equal(env.frames.size, 2, "map painter and shared scene owner each have one clock");
    const target = circle.inspectPoint("builder"), projection = mapProjection(canvas);
    approximately(projection.left + target.x * projection.zoom, 200, "selected builder camera survives opening the map");
    approximately(projection.top + target.y * projection.zoom, 200, "camera uses actual builder body position");
    assert.equal(state.builderPreview.startedAt, startedAt);
    clock.advance(.4);
    assert.ok(state.elapsed > startedAt);
    assert.equal(mind.job.id, construction.jobs[0].id);
    worldDevStore.triggerBuilder("finish", true);
    const beforeSample = structuredClone(mind);
    for (let i = 0; i < 4; i++) { paint(circle); circle.inspectPoint("builder"); }
    assert.deepEqual(mind, beforeSample, "finish preview and read-only samples do not complete the real job");
    assert.deepEqual(construction, original);
    worldDevStore.patch({ builderPreview: null });
    assert.equal(state.builderPreview, undefined);
    assert.equal(mind.job.id, construction.jobs[0].id);
    const restored = paint(circle); assert.ok(restored);
    assert.deepEqual(mind, beforeSample, "stop resumes the current actual task without restarting it");
  } finally { engine?.dispose(); views.forEach(view => view.dispose()); probe?.release(); worldDevStore.reset(); env.restore(); }
});

test("new villagers require confirmed account access, the claimed quarry and an enabled map introduction", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore, isWalkable, canTraverse } = await modules(compactVillagerFixture());
  const env = browser(); let scene, probe;
  const owner = "villagers-unlock", key = `zhiv:mochlik:presence:${owner}`;
  let completed = 0;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyBuildings: { quarry: 1 }, economyResidents: null,
      residentArrival: { seen: false, enabled: false, onComplete: () => completed++ } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env), miner = () => state.villagers.residents.kamneshmyg;
    assert.equal(miner().available, false); assert.equal(scene.inspectPoint("kamneshmyg"), null);
    scene.configure({ ...initial, economyResidents: confirmedVillagers("another-account", 50) });
    clock.advance(.3); assert.equal(state.economyResidents, undefined); assert.equal(miner().available, false);
    scene.configure({ ...initial, economyResidents: confirmedVillagers(owner, 1, 0) });
    clock.advance(.3); assert.equal(miner().available, false, "a construction timer or visible preview does not replace a claimed level");
    const confirmed = confirmedVillagers(owner, 2), original = structuredClone(confirmed);
    const unlocked = { ...initial, economyResidents: confirmed };
    scene.configure(unlocked); clock.advance(.3);
    assert.equal(miner().available, false); assert.equal(state.villagers.arrivalPhase, "waiting");
    assert.equal(completed, 0); assert.equal(env.timers.size, 0, "no ready timer silently completes the introduction");
    const enabled = { ...unlocked, residentArrival: { ...initial.residentArrival, enabled: true } };
    scene.configure(enabled);
    assert.equal(state.villagers.arrivalPhase, "running"); assert.equal(miner().available, true);
    const start = { ...miner().position }, navigation = state.clearing.navigation;
    assert.ok(start.y < TILED_WORLD.sites.find(site => site.id === "quarry").entry.y - 150, "the visible miner really starts at the north edge");
    assert.ok(isWalkable(navigation, start)); assert.deepEqual(scene.residentArrivalPoint(), { ...start, size: 42 });
    let previous = start;
    clock.until(() => {
      const position = miner().position;
      assert.ok(canTraverse(navigation, previous, position), "the executed approach stays outside authored physical obstacles");
      assert.ok(distanceBetween(previous, position) <= 99 * .05 + 1e-7, "the approach cannot teleport between frames");
      previous = { ...position }; return state.villagers.arrivalPhase === "greeting";
    }, "the northern run physically reaches the quarry before greeting", 600);
    assert.equal(completed, 0); assert.equal(miner().action, "greet");
    clock.advance(1); assert.equal(completed, 0, "the greeting is shown before acknowledgement");
    clock.until(() => state.villagers.arrivalPhase === "complete", "the finite greeting completes", 100);
    await flush(); assert.equal(completed, 1); assert.equal(scene.residentArrivalPoint(), null);
    scene.configure(enabled); clock.advance(1); await flush(); assert.equal(completed, 1, "reconfiguration and ordinary frames cannot repeat completion");
    assert.deepEqual(confirmed, original, "the cosmetic introduction never rewrites the confirmed economy");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("new villagers freeze their arrival while paused, hidden, in the circle or behind a disabled presentation", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore } = await modules(compactVillagerFixture());
  const env = browser(), views = []; let probe;
  const owner = "villagers-presentation", key = `zhiv:mochlik:presence:${owner}`;
  let completed = 0;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key,
      economyBuildings: { quarry: 1 }, economyResidents: confirmedVillagers(owner),
      residentArrival: { seen: false, enabled: true, onComplete: () => completed++ } };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); views.push(circle); await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, clock = sceneClock(env);
    clock.advance(1); assert.equal(state.villagers.residents.kamneshmyg.available, false, "the circle cannot start the full-map arrival");
    const mapOptions = { ...initial, view: "world" }, world = mountHabitat(env.surface(), mapOptions, callbacks); views.push(world);
    await finishVillagerArtwork(env); clock.advance(.5);
    const miner = state.villagers.residents.kamneshmyg;
    assert.equal(state.villagers.arrivalPhase, "running"); assert.ok(miner.elapsed > 0);
    const assertFrozen = (snapshot, reason) => {
      assert.deepEqual(miner, snapshot, reason); assert.equal(completed, 0);
    };
    world.configure({ ...mapOptions, paused: true }); await flush();
    let frozen = structuredClone(miner); clock.advance(1); assertFrozen(frozen, "circle ownership cannot advance the paused map introduction");
    world.configure({ ...mapOptions, backgrounded: true }); await flush();
    frozen = structuredClone(miner); clock.advance(1); assertFrozen(frozen, "backgrounding cannot consume a run or acknowledgement");
    world.configure(mapOptions); await flush(); clock.advance(.2);
    env.visibility(true); frozen = structuredClone(miner); clock.advance(1); assertFrozen(frozen, "a hidden page has no arrival clock");
    env.visibility(false); await flush();
    const disabled = { ...mapOptions, residentArrival: { ...initial.residentArrival, enabled: false } };
    world.configure(disabled); frozen = structuredClone(miner); clock.advance(1); assertFrozen(frozen, "closing the introduction holds its exact route progress");
    world.configure({ ...disabled, reducedMotion: true }); await flush();
    assertFrozen(frozen, "reduced motion cannot skip an introduction whose presentation is disabled");
    world.configure({ ...mapOptions, reducedMotion: true }); await flush();
    assert.equal(state.villagers.arrivalPhase, "complete"); assert.equal(miner.route, null); assert.equal(completed, 1);
    circle.configure({ ...initial, reducedMotion: true }); await flush(); assert.equal(completed, 1, "a second static camera cannot write a second acknowledgement");
  } finally { views.forEach(view => view.dispose()); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});

test("new villagers do not start or acknowledge arrival without the authoritative simulation lease", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, ApiError } = await modules(compactVillagerFixture());
  const env = browser(); let scene, probe;
  const owner = "3234-ABCD-EFGH", key = `zhiv:mochlik:presence:${owner}`, server = builderMemoryServer(owner, ApiError);
  let refuse = true, completed = 0;
  const transport = { read: (...args) => server.transport.read(...args), async command(command) {
    if (refuse && command.action === "acquire") throw new ApiError("FOREST_MEMORY_ACTIVE_ELSEWHERE", 409,
      { code: "FOREST_MEMORY_ACTIVE_ELSEWHERE", message: "FOREST_MEMORY_ACTIVE_ELSEWHERE" });
    return server.transport.command(command);
  } };
  try {
    probe = connectForestSession(key, TILED_WORLD, "circle", server.now(), 0, () => {},
      { sync: { environment: server.environment, transport } });
    const initial = { ...options, view: "world", serverNow: server.now(), presenceKey: key,
      economyBuildings: { quarry: 1 }, economyResidents: confirmedVillagers(owner),
      residentArrival: { seen: false, enabled: true, onComplete: () => completed++ } };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    await finishVillagerArtwork(env); await server.pump();
    const state = probe.state;
    assert.equal(state.memory.sync.mode, "other-device"); assert.equal(state.villagers.residents.kamneshmyg.available, false);
    const waiting = structuredClone(state.villagers); const clock = sceneClock(env); clock.advance(5);
    scene.configure(initial); await server.pump();
    assert.deepEqual(state.villagers, waiting, "a confirmed quarry and reduced-motion option cannot bypass lease refusal");
    assert.equal(completed, 0); assert.equal(env.frames.size, 0);
    refuse = false; probe.takeOverMemory(); await server.pump(); await flush();
    assert.equal(state.memory.sync.mode, "synced"); assert.equal(state.villagers.arrivalPhase, "complete");
    assert.equal(completed, 1, "the enabled static introduction acknowledges only after real ownership is granted");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); await server.pump(); env.restore(); }
});

test("new villagers own confirmed quarry work while the compatibility path keeps its original Mochlik projection", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore } = await modules(compactVillagerFixture());
  const env = browser(), views = [], probes = [], keys = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const job = { id: "quarry-owned-job", stationId: "quarry", stationLevel: 1, recipeId: "quarry_stone",
      startedAt: new Date(100_000).toISOString(), finishesAt: new Date(700_000).toISOString() };
    const owner = "villagers-worker", key = `zhiv:mochlik:presence:${owner}`; keys.push(key);
    const access = confirmedVillagers(owner, 1, 1, [job]), original = structuredClone(access);
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: key, economyBuildings: { quarry: 1 },
      economyProduction: access.production, economyResidents: access, residentArrival: { seen: true, enabled: false, onComplete: assert.fail } };
    const scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail }); views.push(scene);
    await finishVillagerArtwork(env);
    const probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(probe);
    const state = probe.state, home = { ...state.clearing.position }, clock = sceneClock(env);
    clock.advance(1);
    assert.equal(state.villagers.residents.kamneshmyg.job, true); assert.equal(state.villagers.residents.kamneshmyg.action, "work");
    assert.equal(state.journeyTravel?.mining, undefined); assert.equal(state.explorationId ?? null, null);
    assert.deepEqual(state.clearing.position, home, "ordinary stone production leaves Mochlik in the clearing");
    assert.deepEqual(access, original);
    scene.dispose(); probe.release(); forgetForestSession(key);
    const legacyOwner = "villagers-worker-compat", legacyKey = `zhiv:mochlik:presence:${legacyOwner}`; keys.push(legacyKey);
    const compatibility = { ...initial, presenceKey: legacyKey, economyResidents: undefined, residentArrival: undefined,
      economyProduction: { ownerPublicId: legacyOwner, revision: 1, jobs: [job] } };
    const legacy = mountHabitat(env.surface(), compatibility, { activity() {}, ready() {}, failure: assert.fail }); views.push(legacy);
    await finishVillagerArtwork(env);
    const legacyProbe = connectForestSession(legacyKey, TILED_WORLD, "circle", 100_000, 0, () => {}); probes.push(legacyProbe);
    assert.equal(legacyProbe.state.villagers.residents.kamneshmyg.available, false);
    assert.equal(legacyProbe.state.journeyTravel?.jobId, `production:${job.id}`);
    assert.equal(legacyProbe.state.journeyTravel?.phase, "leaving", "callers without resident projection retain the legacy work journey");
  } finally { views.forEach(view => view.dispose()); probes.forEach(probe => probe.release()); keys.forEach(forgetForestSession); worldDevStore.reset(); env.restore(); }
});

test("new villagers keep a new resident host available when the real social loop changes both partners to greet", async () => {
  const { mountHabitat, connectForestSession, forgetForestSession, TILED_WORLD, worldDevStore, FOREST_CONVERSATIONS } = await modules(compactVillagerFixture());
  const env = browser(); let scene, probe;
  const owner = "villagers-social-host", key = `zhiv:mochlik:presence:${owner}`;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: true });
    const initial = { ...options, reducedMotion: false, view: "world", serverNow: 100_000, presenceKey: key,
      economyResidents: confirmedVillagers(owner, 1, 0) };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail }); await finishVillagerArtwork(env);
    probe = connectForestSession(key, TILED_WORLD, "circle", 100_000, 0, () => {});
    const state = probe.state, social = state.social, guest = state.villagers.residents.lopukh, host = state.villagers.residents.leaftail;
    guest.position = { x: 680, y: 690 }; host.position = { x: 735, y: 690 };
    for (const mind of [guest, host]) { mind.route = null; mind.action = "idle"; mind.wait = 60; }
    // Begin at the natural approach→talk boundary, using a real authored script;
    // the scene must keep the host eligible after its first greet animation.
    const script = FOREST_CONVERSATIONS.find(topic => ["lopukh-leaftail", "leaftail-lopukh"].includes(topic.pair));
    assert.ok(script);
    guest.socialVisit = { targetId: host.id, anchor: { ...host.position } };
    social.meeting = { anchor: { ...host.position }, guestAnchor: { ...guest.position }, host: host.id, guest: guest.id,
      visit: "resident", phase: "talk", age: 0 };
    social.topicHistory.push(script.id); social.current = { id: "resident-script-start", ...script.lines[0], elapsed: 0, duration: 3.8, origin: "ambient" };
    social.queue = script.lines.slice(1).map(line => ({ ...line })); social.nextEncounterAt = 10_000;
    state.clearing.waitSeconds = 60; state.director.nextDecisionAt = 60;
    const clock = sceneClock(env); clock.advance(.1);
    assert.equal(host.action, "greet"); assert.equal(guest.action, "greet"); assert.ok(social.meeting);
    const first = social.current.id; clock.advance(.2);
    assert.ok(social.meeting, "greet remains a live conversation host on the next real runtime frame");
    assert.equal(social.current.id, first); assert.ok(social.current.elapsed > 0); assert.ok(scene.speechFrames().length > 0);
    const lines = new Map([[social.current.id, { speaker: social.current.speaker, text: social.current.text }]]);
    for (let pass = 0; pass < 650 && social.meeting; pass++) {
      if (social.current) lines.set(social.current.id, { speaker: social.current.speaker, text: social.current.text });
      clock.step();
    }
    assert.equal(social.meeting, null); assert.equal(social.current, null); assert.equal(guest.socialVisit, null);
    assert.deepEqual([...lines.values()], script.lines, "all authored replies survive the host's greeting pose and finish normally");
  } finally { scene?.dispose(); probe?.release(); forgetForestSession(key); worldDevStore.reset(); env.restore(); }
});