import assert from "node:assert/strict";
import test from "node:test";
import {
  approximately,
  browser,
  builderHomeFixture,
  circlePoint,
  clearingBush,
  clearingHome,
  dragMap,
  fixture,
  flush,
  livingHabitats,
  livingNavigation,
  mapProjection,
  modules,
  options,
  quietClearing,
  sceneClock,
  sourceAndDestination
} from "./helpers/new-map-scene.mjs";


test("new circle and world paint the same 2560px source in 1254 logical units and use the new focus", async () => {
  const { mountHabitat, TILED_WORLD, NEW_MAP_FOCUS, NEW_MAP_SPAWN, NEW_MAP_SIZE } = await modules();
  const env = browser(); let scene;
  try {
    const circle = env.surface(), fullWorld = env.surface();
    let ready = 0;
    scene = mountHabitat(circle, options, { activity() {}, ready: () => ready++, failure: assert.fail });
    const image = env.finish(); await flush();
    assert.equal(ready, 1);
    assert.deepEqual(env.requests, [TILED_WORLD.terrain[0].image], "no preview, home detail, boat or overlay assets load");
    assert.equal(circle.width, 640, "the circle keeps its DPR 2 backing resolution");
    scene.paintWorld(fullWorld.context);
    const groundCalls = target => target.calls.filter(call => call.method === "drawImage" && call.args[0] === image);
    const sourceToWorld = [image, 0, 0, 2560, 2560, 0, 0, 1254, 1254];
    assert.equal(NEW_MAP_SIZE, 1254);
    assert.deepEqual(sourceAndDestination(groundCalls(circle).at(-1).args), sourceToWorld);
    assert.deepEqual(sourceAndDestination(groundCalls(fullWorld).at(-1).args), sourceToWorld);
    assert.ok(circle.calls.some(call => call.method === "setTransform" && call.args[0] === 640 / NEW_MAP_FOCUS.width
      && call.args[3] === 640 / NEW_MAP_FOCUS.height));
    assert.ok(circle.calls.some(call => call.method === "translate" && call.args[0] === -NEW_MAP_FOCUS.x && call.args[1] === -NEW_MAP_FOCUS.y));
    const at = scene.position();
    assert.equal(at.x, NEW_MAP_SPAWN.x);
    scene.moveTo(.1, .1); scene.invite("home"); scene.invite("bush");
    assert.deepEqual(scene.position(), at, "old movement destinations cannot move the clean scene actor");
    const ambience = scene.ambience();
    assert.deepEqual({ ...ambience, rain: 0 }, { elapsed: 0, ecologyTime: 0, rain: 0, dusk: 0 });
    assert.ok(ambience.rain >= 0 && ambience.rain <= .42, "reduced motion keeps a bounded static weather sample");
  } finally { scene?.dispose(); env.restore(); }
});

test("new scene pauses, resumes, reacts without reduced-motion RAF, and releases timers and observers", async () => {
  const { mountHabitat } = await modules();
  const env = browser(); let scene;
  try {
    const canvas = env.surface(); let activity;
    const animated = { ...options, reducedMotion: false };
    scene = mountHabitat(canvas, animated, { activity: value => { activity = value; }, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    assert.equal(env.frames.size, 1); env.tick(100); env.tick(134);
    assert.ok(scene.ambience().elapsed > 0);
    scene.configure({ ...animated, paused: true });
    const frozen = canvas.calls.length, elapsed = scene.ambience().elapsed;
    scene.notice(); env.tick(168);
    assert.equal(canvas.calls.length, frozen); assert.equal(scene.ambience().elapsed, elapsed); assert.equal(env.frames.size, 0);
    scene.configure({ ...animated, backgrounded: true }); assert.equal(env.frames.size, 0);
    scene.configure(animated); assert.equal(env.frames.size, 1);
    scene.configure(options); assert.equal(env.frames.size, 0);
    scene.notice(); assert.equal(activity, "greet"); assert.equal(env.frames.size, 0);
    assert.ok(env.timers.size >= 1 && env.timers.size <= 2, "reaction and speech each use at most one finite expiry without an animation loop");
    const reactionExpiry = [...env.timers].find(([, timer]) => timer.ms <= 1000)?.[0];
    assert.notEqual(reactionExpiry, undefined); env.fireTimer(reactionExpiry);
    assert.equal(activity, "idle"); assert.equal(env.frames.size, 0);
    for (const id of [...env.timers.keys()]) env.fireTimer(id);
    assert.equal(env.timers.size, 0, "speech also finishes without leaving a polling timer");
    scene.notice(); assert.equal(env.timers.size, 1);
    scene.dispose(); scene.configure(animated); scene.notice();
    assert.equal(env.observed(), 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  } finally { scene?.dispose(); env.restore(); }
});

test("circle and world share atmospheric time and smoothly transition from day to night", async () => {
  const { mountHabitat } = await modules();
  const env = browser(), scenes = [];
  try {
    const animated = { ...options, reducedMotion: false, serverNow: 100_000 };
    const circle = env.surface(), world = env.surface();
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    scenes.push(mountHabitat(circle, animated, callbacks), mountHabitat(world, { ...animated, view: "world" }, callbacks));
    env.finish(); await flush();
    assert.equal(env.frames.size, 2);
    const samplePaint = scene => {
      const surface = env.surface(); scene.paintWorld(surface.context); return surface.calls;
    };
    const initialPaint = samplePaint(scenes[0]);
    assert.deepEqual(samplePaint(scenes[1]), initialPaint, "both cameras receive identical world-space effects");
    env.tick(100); env.tick(134);
    assert.equal(scenes[0].ambience().ecologyTime, 100.034);
    assert.deepEqual(scenes[0].ambience(), scenes[1].ambience());
    assert.notDeepEqual(samplePaint(scenes[0]), initialPaint, "the atmosphere moves with the shared clock");
    assert.deepEqual(samplePaint(scenes[0]), samplePaint(scenes[1]));
    scenes.forEach((scene, index) => scene.configure({ ...animated, dusk: true, view: index ? "world" : "circle" }));
    assert.equal(scenes[0].ambience().dusk, 0, "changing the target does not flash immediately to night");
    env.tick(200); env.tick(250);
    assert.ok(scenes[0].ambience().dusk > 0 && scenes[0].ambience().dusk < 1);
    assert.deepEqual(scenes[0].ambience(), scenes[1].ambience());
    assert.deepEqual(samplePaint(scenes[0]), samplePaint(scenes[1]));
    const before = scenes[0].ambience(); env.tick(5_000);
    assert.ok(Math.abs(scenes[0].ambience().elapsed - before.elapsed - .05) < 1e-10,
      "long frame gaps use the existing step cap");
    const paints = circle.calls.length + world.calls.length;
    scenes.forEach(scene => scene.setTime(240_000));
    assert.equal(circle.calls.length + world.calls.length, paints, "clock samples do not trigger an extra paint");
    assert.equal(scenes[0].ambience().ecologyTime, 240);
    assert.deepEqual(scenes[0].ambience(), scenes[1].ambience());
  } finally { scenes.forEach(scene => scene.dispose()); env.restore(); }
});

test("paused and hidden scenes buffer time until active and reduced motion stays still", async () => {
  const { mountHabitat } = await modules();
  const env = browser(); let scene;
  try {
    const animated = { ...options, reducedMotion: false, serverNow: 100_000 }, canvas = env.surface();
    scene = mountHabitat(canvas, animated, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.tick(100); env.tick(134);
    scene.configure({ ...animated, paused: true, dusk: true });
    const frozen = scene.ambience(), paints = canvas.calls.length;
    scene.setTime(200_000); scene.setTime(Number.NaN); scene.setTime(Number.POSITIVE_INFINITY);
    scene.notice(); env.tick(200);
    assert.deepEqual(scene.ambience(), frozen); assert.equal(canvas.calls.length, paints);
    assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
    scene.configure({ ...animated, backgrounded: true, dusk: true }); scene.setTime(300_000);
    assert.deepEqual(scene.ambience(), frozen); assert.equal(env.frames.size, 0);
    document.hidden = true; scene.configure({ ...animated, dusk: true });
    assert.deepEqual(scene.ambience(), frozen); assert.equal(env.frames.size, 0);
    document.hidden = false; scene.configure({ ...animated, dusk: true });
    assert.equal(scene.ambience().ecologyTime, 300);
    assert.equal(scene.ambience().elapsed, frozen.elapsed); assert.equal(scene.ambience().dusk, frozen.dusk);
    assert.equal(env.frames.size, 1);
    scene.configure({ ...animated, dusk: true, reducedMotion: true });
    assert.equal(scene.ambience().dusk, 1); assert.equal(scene.ambience().ecologyTime, 0);
    assert.equal(env.frames.size, 0);
    const still = env.surface(), again = env.surface(); scene.paintWorld(still.context);
    scene.setTime(400_000); env.tick(50_000); scene.paintWorld(again.context);
    assert.deepEqual(again.calls, still.calls, "reduced motion freezes atmospheric positions and weather");
    scene.configure({ ...animated, dusk: true });
    assert.equal(scene.ambience().ecologyTime, 400, "the latest clock sample survives reduced motion");
    scene.dispose(); const disposed = scene.ambience(); scene.setTime(500_000); scene.configure(animated); scene.notice();
    assert.deepEqual(scene.ambience(), disposed);
    assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0); assert.equal(env.observed(), 0);
  } finally { scene?.dispose(); env.restore(); }
});

test("stale configuration samples cannot replace a newer active or pending clock", async () => {
  const { mountHabitat } = await modules();
  const env = browser(); let scene;
  try {
    const initial = { ...options, reducedMotion: false, serverNow: 100_000 };
    scene = mountHabitat(env.surface(), initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    scene.setTime(200_000); scene.configure(initial);
    assert.equal(scene.ambience().ecologyTime, 200, "visibility may reapply the unchanged initial options");
    const withoutSample = { ...initial }; delete withoutSample.serverNow;
    scene.configure(withoutSample); scene.configure(initial);
    assert.equal(scene.ambience().ecologyTime, 200, "omitting a sample does not make the old sample fresh again");
    scene.configure({ ...initial, paused: true }); scene.setTime(300_000);
    scene.configure({ ...initial, paused: true });
    assert.equal(scene.ambience().ecologyTime, 200, "a paused clock retains its visible state");
    scene.configure(initial);
    assert.equal(scene.ambience().ecologyTime, 300, "resuming applies the pending sample, not the stale configuration");
    scene.configure({ ...initial, serverNow: 400_000 });
    assert.equal(scene.ambience().ecologyTime, 400, "an explicitly changed configuration sample is accepted");
    scene.configure({ ...initial, paused: true, serverNow: 500_000 });
    assert.equal(scene.ambience().ecologyTime, 400);
    scene.configure({ ...initial, serverNow: 500_000 });
    assert.equal(scene.ambience().ecologyTime, 500, "a new explicit sample can also wait for resume");
  } finally { scene?.dispose(); env.restore(); }
});

test("failed new artwork reaches the failure callback and a fresh mount retries", async () => {
  const { mountHabitat, TILED_WORLD } = await modules();
  const env = browser(); let scene;
  try {
    let ready = 0; const failures = [];
    const callbacks = { activity() {}, ready: () => ready++, failure: error => failures.push(error) };
    scene = mountHabitat(env.surface(), options, callbacks);
    env.finish(true); await flush();
    assert.equal(ready, 0); assert.equal(failures.length, 1); assert.ok(failures[0] instanceof Error);
    assert.equal(env.observed(), 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
    scene = mountHabitat(env.surface(), options, callbacks);
    assert.deepEqual(env.requests, [TILED_WORLD.terrain[0].image, TILED_WORLD.terrain[0].image]);
    env.finish(); await flush();
    assert.equal(ready, 1); assert.equal(failures.length, 1);
  } finally { scene?.dispose(); env.restore(); }
});

test("disposing during new artwork loading prevents late callbacks and animation", async () => {
  const { mountHabitat } = await modules();
  const env = browser(); let scene;
  try {
    let callbacks = 0;
    const canvas = env.surface();
    scene = mountHabitat(canvas, { ...options, reducedMotion: false }, {
      activity: () => callbacks++, ready: () => callbacks++, failure: () => callbacks++, rendered: () => callbacks++,
    });
    scene.dispose(); const before = canvas.calls.length;
    env.finish(); await flush();
    assert.equal(callbacks, 0); assert.equal(canvas.calls.length, before);
    assert.equal(env.observed(), 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  } finally { scene?.dispose(); env.restore(); }
});

test("initial circle becomes ready before optional off-focus artwork starts and still scenes redraw when it arrives", async () => {
  const home = { id: "home", label: "Дом", bounds: { x: 600, y: 580, width: 80, height: 80 },
    anchor: { x: 640, y: 660 }, entry: { x: 640, y: 675 }, hitArea: [], collision: [], initialLevel: 1,
    states: [{ level: 1, label: "Дом", image: "/progressive-home.webp" }] };
  const shore = { id: "shore", image: "/progressive-shore.webp", bounds: { x: 20, y: 20, width: 80, height: 80 } };
  const { mountHabitat } = await modules({ terrain: [...fixture.terrain, shore], sites: [home] });
  const env = browser(); let scene;
  try {
    const canvas = env.surface(); let ready = 0, rendered = 0, requestsAtReady;
    scene = mountHabitat(canvas, { ...options, paused: true }, { activity() {}, failure: assert.fail,
      ready() { ready++; requestsAtReady = [...env.requests]; }, rendered() { rendered++; } });
    assert.deepEqual(env.requests, ["/test-ground.webp", "/progressive-home.webp"]);
    env.finishPath("/test-ground.webp"); await flush(); assert.equal(ready, 0, "the visible home is required");
    env.finishPath("/progressive-home.webp"); await flush();
    assert.equal(ready, 1); assert.deepEqual(requestsAtReady, ["/test-ground.webp", "/progressive-home.webp"]);
    assert.equal(env.pending[0].path, shore.image); assert.equal(env.pending[0].image.fetchPriority, "low");
    const before = rendered, image = env.finishPath(shore.image); await flush();
    assert.ok(rendered > before, "a paused reduced-motion view repaints without starting a clock");
    assert.equal(env.frames.size, 0); assert.equal(ready, 1);
    const full = env.surface(); scene.paintWorld(full.context);
    assert.ok(full.calls.some(call => call.method === "drawImage" && call.args[0] === image));
  } finally { scene?.dispose(); env.restore(); }
});

test("optional artwork failure keeps the circle usable and full-map entry waits for its fresh retry", async () => {
  const remote = { id: "remote", image: "/progressive-retry.webp", bounds: { x: 20, y: 20, width: 80, height: 80 } };
  const { mountHabitat } = await modules({ terrain: [...fixture.terrain, remote] });
  const env = browser(), scenes = [];
  try {
    let circleReady = 0, worldReady = 0;
    scenes.push(mountHabitat(env.surface(), options, { activity() {}, ready: () => circleReady++, failure: assert.fail }));
    env.finishPath("/test-ground.webp"); await flush(); assert.equal(circleReady, 1);
    env.finishPath(remote.image, true); await flush(); assert.equal(circleReady, 1);
    const world = env.surface();
    scenes.push(mountHabitat(world, { ...options, view: "world" }, { activity() {}, ready: () => worldReady++, failure: assert.fail }));
    await flush(); assert.equal(worldReady, 0, "world readiness must not inherit a partial circle");
    assert.equal(env.requests.filter(path => path === remote.image).length, 2, "failed optional cache entries are retried");
    assert.equal(env.pending[0].image.fetchPriority, "high");
    env.finishPath(remote.image); await flush(); assert.equal(worldReady, 1);
    assert.equal(circleReady, 1);
  } finally { scenes.forEach(scene => scene.dispose()); env.restore(); }
});

test("disposing a ready circle prevents optional artwork completions from repainting or reporting failure", async () => {
  const remote = { id: "remote", image: "/progressive-disposed.webp", bounds: { x: 20, y: 20, width: 80, height: 80 } };
  const { mountHabitat } = await modules({ terrain: [...fixture.terrain, remote] });
  const env = browser(); let scene;
  try {
    let ready = 0, rendered = 0;
    scene = mountHabitat(env.surface(), options, { activity() {}, ready: () => ready++, rendered: () => rendered++, failure: assert.fail });
    env.finishPath("/test-ground.webp"); await flush(); assert.equal(ready, 1);
    scene.dispose(); const before = rendered;
    env.finishPath(remote.image); await flush();
    assert.equal(rendered, before); assert.equal(ready, 1); assert.equal(env.frames.size, 0); assert.equal(env.observed(), 0);
  } finally { scene?.dispose(); env.restore(); }
});

test("changing a pending initial circle to world scope requires all artwork before ready", async () => {
  const remote = { id: "remote", image: "/progressive-world-scope.webp", bounds: { x: 20, y: 20, width: 80, height: 80 } };
  const { mountHabitat } = await modules({ terrain: [...fixture.terrain, remote] });
  const env = browser(); let scene;
  try {
    let ready = 0;
    scene = mountHabitat(env.surface(), options, { activity() {}, ready: () => ready++, failure: assert.fail });
    scene.configure({ ...options, view: "world" });
    assert.deepEqual(env.requests, ["/test-ground.webp", remote.image]);
    assert.equal(env.pending.find(request => request.path === remote.image).image.fetchPriority, "high");
    env.finishPath("/test-ground.webp"); await flush(); assert.equal(ready, 0);
    env.finishPath(remote.image); await flush(); assert.equal(ready, 1);
  } finally { scene?.dispose(); env.restore(); }
});

test("subsequent geometry replacements await complete artwork even while initial background artwork is pending", async () => {
  const remote = { id: "remote", image: "/progressive-atomic-remote.webp", bounds: { x: 20, y: 20, width: 80, height: 80 } };
  const geometry = x => ({ bounds: { x, y: 580, width: 80, height: 80 }, anchor: { x: x + 40, y: 660 },
    entry: { x: x + 40, y: 675 }, hitArea: [], collision: [] });
  const home = { id: "home", label: "Дом", ...geometry(600), initialLevel: 1,
    states: [1, 2].map(level => ({ level, label: String(level), image: `/progressive-atomic-home-${level}.webp`, geometry: geometry(600 + (level - 1) * 40) })) };
  const { mountHabitat } = await modules({ terrain: [...fixture.terrain, remote], sites: [home] });
  const env = browser(); let scene;
  try {
    const canvas = env.surface(); let ready = 0;
    scene = mountHabitat(canvas, options, { activity() {}, ready: () => ready++, failure: assert.fail });
    env.finishPath("/test-ground.webp"); const first = env.finishPath(home.states[0].image); await flush();
    assert.equal(ready, 1);
    scene.configure({ ...options, economyBuildings: { home: 2 } });
    const second = env.finishPath(home.states[1].image); await flush();
    const building = () => canvas.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
      && [first, second].includes(call.args[0])).args;
    assert.deepEqual(building(), [first, 600, 580, 80, 80], "pending remote artwork retains the full previous geometry");
    env.finishPath(remote.image); await flush();
    assert.deepEqual(building(), [second, 640, 580, 80, 80]); assert.equal(ready, 1);
  } finally { scene?.dispose(); env.restore(); }
});

test("new map ignores old place hit areas while camera controls and pet taps remain live", async () => {
  const { createMapEngine, TILED_WORLD, NEW_MAP_SIZE, NEW_MAP_SPAWN, NEW_MAP_PET_SIZE } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), places = [], anchor = { dataset: { kind: "house", x: 672, y: 569 }, style: {} };
    const loading = createMapEngine(canvas, options, place => places.push(place), [anchor]);
    env.finish(); engine = await loading;
    assert.deepEqual(env.requests, [TILED_WORLD.terrain[0].image]); assert.equal(anchor.style.visibility, "hidden");
    assert.equal(env.frames.size, 0);
    engine.control("overview");
    function tap(x, y) {
      const event = { pointerId: 1, pointerType: "mouse", button: 0, clientX: x * 400 / NEW_MAP_SIZE, clientY: y * 400 / NEW_MAP_SIZE };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    }
    // Interior points of the former house, cave and river must never open their old panels.
    for (const point of [[667, 612], [162, 197], [1016, 1015]]) tap(...point);
    assert.deepEqual(places, []);
    tap(NEW_MAP_SPAWN.x, NEW_MAP_SPAWN.y - NEW_MAP_PET_SIZE / 2);
    assert.equal(env.timers.size, 2, "tapping the stationary pet starts finite gesture and speech expiries");
    const before = canvas.calls.length; let prevented = 0;
    canvas.events.get("wheel")({ clientX: 200, clientY: 200, deltaY: -150, preventDefault() { prevented++; } });
    canvas.events.get("keydown")({ key: "ArrowRight", preventDefault() { prevented++; } });
    canvas.events.get("keydown")({ key: "Home", preventDefault() { prevented++; } });
    assert.equal(prevented, 3); assert.ok(canvas.calls.length > before);
    assert.deepEqual(places, []);
    engine.dispose(); assert.equal(canvas.events.size, 0);
    assert.equal(env.observed(), 0); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  } finally { engine?.dispose(); env.restore(); }
});

test("authored buildings and planned ruins open their place without selecting during a drag", async () => {
  const sites = ["workshop", "quarry", "bridge", "lighthouse"].map((id, index) => {
    const x = 100 + index * 240, y = 180;
    const points = [{ x, y }, { x: x + 120, y }, { x: x + 120, y: y + 100 }, { x, y: y + 100 }];
    return { id, label: id, initialLevel: 0, bounds: { x, y, width: 120, height: 100 },
      anchor: { x: x + 60, y: y + 100 }, entry: { x: x + 60, y: y + 110 }, hitArea: points, collision: [],
      states: [{ level: 0, label: id, image: `/click-${id}.webp` }] };
  });
  // These four synthetic rectangles do not share the real map's tree positions.
  // Its current crowns must not consume taps intended for the fixture's ruins.
  const { createMapEngine, worldDevStore } = await modules({ sites, occluders: [], treeInteractions: [] });
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), places = [];
    const anchors = sites.slice(0, 2).map(site => ({ dataset: { siteId: site.id, kind: site.id, x: site.anchor.x, y: site.anchor.y }, style: {} }));
    const loading = createMapEngine(canvas, options, place => places.push(place), anchors);
    env.finish(); await flush();
    for (const site of sites) env.finishPath(site.states[0].image);
    engine = await loading;
    engine.control("overview");
    for (const anchor of anchors) {
      assert.equal(anchor.style.visibility, "visible");
      assert.match(anchor.style.transform, /^translate\(/);
    }
    const tap = site => {
      const event = { pointerId: 1, pointerType: "mouse", button: 0,
        clientX: site.anchor.x * 400 / fixture.width, clientY: (site.anchor.y - 50) * 400 / fixture.height };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    sites.forEach(tap);
    assert.deepEqual(places, ["workshop", "quarry", "bridge", "lighthouse"]);
    dragMap(canvas, 45, 0);
    assert.deepEqual(places, ["workshop", "quarry", "bridge", "lighthouse"], "panning does not select a place");
    worldDevStore.patch({ showBuildings: false });
    sites.forEach(tap);
    assert.deepEqual(places, ["workshop", "quarry", "bridge", "lighthouse"]);
    for (const anchor of anchors) assert.equal(anchor.style.visibility, "hidden");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("map object selection tracks projected anchors through camera changes and deduplicates unchanged pixels", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const anchor = { dataset: { objectId: "home", kind: "house" }, style: {} };
    const loading = createMapEngine(canvas, options, (place, selection) => places.push({ place, selection }), [anchor], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const expectedSelection = () => {
      const projection = mapProjection(canvas);
      return { objectId: "home", place: "house", x: Math.round(projection.left + clearingHome.anchor.x * projection.zoom),
        y: Math.round(projection.top + clearingHome.anchor.y * projection.zoom),
        viewportWidth: canvas.clientWidth, viewportHeight: canvas.clientHeight };
    };
    engine.setSelectedObject("home");
    assert.deepEqual(selections, [expectedSelection()]);
    assert.deepEqual(places, [], "tracking an object does not open its menu again");
    assert.equal(engine.activateObject("home"), true);
    assert.deepEqual(places, [{ place: "house", selection: expectedSelection() }]);
    assert.equal(selections.length, 1, "activation at the same pixel does not duplicate the coordinate update");
    engine.setSelectedObject("home"); engine.update(options);
    assert.equal(selections.length, 1, "repeated selection and scene redraws keep the same coordinate sample");

    engine.control("home");
    assert.deepEqual(selections.at(-1), expectedSelection());
    assert.notDeepEqual(selections.at(-1), selections[0], "zooming moves the anchor rather than leaving a stale screen point");
    const beforePan = selections.at(-1);
    dragMap(canvas, 12, -18);
    assert.deepEqual(selections.at(-1), expectedSelection());
    assert.equal(selections.at(-1).x, beforePan.x + 12);
    assert.equal(selections.at(-1).y, beforePan.y - 18);
    assert.equal(places.length, 1, "camera movement only updates the existing selection");
    const beforeTinyZoom = selections.length;
    canvas.events.get("wheel")({ clientX: 200, clientY: 200, deltaY: .000001, preventDefault() {} });
    assert.equal(selections.length, beforeTinyZoom, "subpixel changes are rounded before coordinate notifications");

    canvas.clientWidth = 520; canvas.clientHeight = 420; env.resize(canvas);
    assert.deepEqual(selections.at(-1), expectedSelection(), "resize updates the anchor and popup viewport together");
    const event = { pointerId: 1, pointerType: "touch", button: 0, clientX: 8, clientY: 8 };
    canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
    canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    assert.equal(selections.at(-1), null, "a blank map tap closes the selected menu");
    const cleared = selections.length;
    engine.setSelectedObject(null);
    assert.equal(selections.length, cleared, "repeated closing does not emit duplicate null selections");
    assert.equal(places.length, 1);

    engine.setSelectedObject("home");
    dragMap(canvas, -10_000, -10_000);
    assert.equal(selections.at(-1), null, "panning the selected anchor outside the viewport closes the menu");
    assert.equal(places.length, 1, "offscreen closing cannot reactivate the object");
    assert.equal(engine.activateObject("home"), true, "explicit activation brings an offscreen target back into view");
    const centered = selections.at(-1);
    assert.deepEqual(centered, expectedSelection(), "the reopened menu uses the newly centered camera projection");
    assert.ok(centered.x >= 0 && centered.x <= canvas.clientWidth && centered.y >= 0 && centered.y <= canvas.clientHeight,
      "explicit activation places the target anchor inside the current viewport");
    assert.equal(places.length, 2, "centering activates the requested place exactly once");
    assert.deepEqual(places.at(-1), { place: "house", selection: centered });
    assert.equal(engine.activateObject("missing-object"), false);
    assert.equal(places.length, 2, "unknown object IDs do not fall back to an unrelated place");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("onboarding camera outlines the live station without opening it and follows manual touch gestures", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(393, 665), places = [], selections = [];
    const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined,
      { top: { offsetHeight: 110 }, bottom: { offsetHeight: 75 } },
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.setGuidePlace("house", 230);
    const outline = () => {
      const stroke = canvas.calls.findLastIndex(call => call.method === "strokeStyle" && call.args[0] === "#183d27");
      const start = canvas.calls.slice(0, stroke).findLastIndex(call => call.method === "beginPath");
      return canvas.calls.slice(start, stroke).filter(call => ["moveTo", "lineTo"].includes(call.method)).map(call => call.args);
    };
    const projectedContour = () => {
      const projection = mapProjection(canvas);
      return clearingHome.hitArea.map(point => [projection.left + point.x * projection.zoom, projection.top + point.y * projection.zoom]);
    };
    const assertOutline = () => outline().forEach((point, index) => point.forEach((value, axis) =>
      approximately(value, projectedContour()[index][axis], "guide tracks the station's actual contour")));
    assertOutline();
    assert.ok(outline().every(([x, y]) => x >= 0 && x <= 393 && y > 110 && y < 665 - 230),
      "the station fits between the top HUD and the measured phone coach");
    assert.deepEqual(places, []); assert.deepEqual(selections, [], "camera guidance does not select or activate a station");
    const first = outline();
    dragMap(canvas, 18, -12);
    assertOutline(); assert.notDeepEqual(outline(), first);
    const panned = mapProjection(canvas);
    engine.setGuidePlace("house", 230);
    assert.deepEqual(mapProjection(canvas), panned, "repeated guide updates do not undo the player's pan");
    engine.setGuidePlace("house", 250);
    assert.deepEqual(mapProjection(canvas), panned, "coach resizing also respects a manually moved camera");
    canvas.events.get("wheel")({ clientX: 170, clientY: 220, deltaY: 70, preventDefault() {} }); canvas.flushFrame();
    assertOutline();
    assert.deepEqual(places, [], "pan and zoom keep the real menu closed");
    canvas.calls.length = 0;
    engine.setGuidePlace(null);
    assert.equal(canvas.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#183d27"), false,
      "leaving the lesson removes the outline even in reduced motion");
    engine.setGuidePlace("house", 230);
    const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + 660 * projection.zoom, clientY: projection.top + 620 * projection.zoom };
    canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
    canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    assert.deepEqual(places, ["house"], "the actual outlined map area stays manually tappable");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("construction anchors follow live map projection without repeated React notifications on idle redraws", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), samples = [], top = { offsetHeight: 40 }, bottom = { offsetHeight: 40 };
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, { top, bottom },
      { onObjectAnchorsChange: anchors => samples.push(anchors) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const expected = () => {
      const projection = mapProjection(canvas);
      const xs = clearingHome.hitArea.map(point => point.x), ys = clearingHome.hitArea.map(point => point.y);
      return { objectId: "home", place: "house", x: Math.round(projection.left + (Math.min(...xs) + Math.max(...xs)) / 2 * projection.zoom),
        y: Math.round(projection.top + Math.min(...ys) * projection.zoom - 10), pointerOffset: 0 };
    };
    assert.deepEqual(samples.at(-1), [expected()]);
    const idleCount = samples.length;
    engine.update(options); engine.control("overview");
    assert.equal(samples.length, idleCount, "unchanged projected pixels do not notify React every frame");
    engine.control("home");
    assert.deepEqual(samples.at(-1), [expected()]);
    const beforePan = samples.at(-1)[0];
    dragMap(canvas, 12, 18);
    assert.deepEqual(samples.at(-1), [expected()]);
    assert.equal(samples.at(-1)[0].x, beforePan.x + 12);
    assert.equal(samples.at(-1)[0].y, beforePan.y + 18);
    canvas.clientWidth = 520; canvas.clientHeight = 600; env.resize(canvas);
    assert.deepEqual(samples.at(-1), [expected()], "resize updates visible construction anchors immediately");
    worldDevStore.patch({ showBuildings: false });
    assert.deepEqual(samples.at(-1), [], "hidden site artwork removes its timer anchor too");
    worldDevStore.patch({ showBuildings: true });
    assert.deepEqual(samples.at(-1), [expected()]);
    top.offsetHeight = canvas.clientHeight; env.resize(top);
    assert.deepEqual(samples.at(-1), [], "measured HUD changes hide covered timers");
    top.offsetHeight = 40; env.resize(top);
    assert.deepEqual(samples.at(-1), [expected()]);
    dragMap(canvas, -10_000, -10_000);
    assert.deepEqual(samples.at(-1), [], "an offscreen building never leaves a timer pinned to the edge");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("shared workshop marker height refreshes paused anchors without repaint or top HUD overlap", async () => {
  const workshop = { ...clearingHome, id: "workshop", label: "Мастерская" };
  const { createMapEngine, worldDevStore } = await modules({ sites: [workshop] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), samples = [], top = { offsetHeight: 40 }, bottom = { offsetHeight: 40 };
    let markerHeight = 44;
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, { top, bottom }, {
      onObjectAnchorsChange: anchors => samples.push(anchors),
      objectMarkerHeight: place => place === "workshop" ? markerHeight : 44,
    });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const [original] = samples.at(-1);
    assert.equal(original.place, "workshop");
    top.offsetHeight = original.y - 66; env.resize(top);
    assert.deepEqual(samples.at(-1), [original], "one 44px section fits below the measured HUD");
    engine.update({ ...options, paused: true });
    const painted = canvas.calls.length, frames = env.frames.size;
    markerHeight = 88; engine.refreshObjectAnchors();
    assert.deepEqual(samples.at(-1), [], "adding the second section cannot extend behind the HUD");
    markerHeight = 44; engine.refreshObjectAnchors();
    assert.deepEqual(samples.at(-1), [original], "a completed queue restores the smaller badge immediately while paused");
    assert.equal(canvas.calls.length, painted, "a footprint change projects UI anchors without repainting or moving the forest");
    assert.equal(env.frames.size, frames, "the refresh does not start a reduced-motion animation loop");
    const notifications = samples.length;
    engine.refreshObjectAnchors(); assert.equal(samples.length, notifications, "unchanged anchors remain deduplicated");
    env.visibility(true); markerHeight = 88; engine.refreshObjectAnchors();
    assert.equal(samples.length, notifications, "a hidden view buffers the footprint change");
    env.visibility(false); assert.deepEqual(samples.at(-1), [], "the visible view adopts the buffered height before presenting its badge");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("map object selection ignores drag pinch and canceled pointers before a real tap", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const projection = mapProjection(canvas), point = { x: 650, y: 610 };
    const first = { pointerId: 1, pointerType: "touch", button: 0,
      clientX: projection.left + point.x * projection.zoom, clientY: projection.top + point.y * projection.zoom };
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...first, type: "pointermove", clientX: first.clientX + 30 });
    canvas.events.get("pointerup")({ ...first, type: "pointerup", clientX: first.clientX + 30 });
    const second = { ...first, pointerId: 2, clientX: first.clientX + 30 };
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointerdown")({ ...second, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...second, type: "pointermove", clientX: first.clientX + 40 });
    canvas.events.get("pointerup")({ ...first, type: "pointerup" });
    canvas.events.get("pointerup")({ ...second, type: "pointerup", clientX: first.clientX + 40 });
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointercancel")({ ...first, type: "pointercancel" });
    assert.deepEqual(places, []); assert.deepEqual(selections, [], "gestures cannot open an object menu");

    engine.control("overview");
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointerup")({ ...first, type: "pointerup" });
    assert.deepEqual(places, ["house"]);
    assert.equal(selections.at(-1).objectId, "home", "a single completed tap uses authored object geometry");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("visible hero taps take priority over overlapping garden and house menu geometry", async () => {
  const bush = { ...clearingBush, hide: { x: 630, y: 645 },
    points: [{ x: 610, y: 620 }, { x: 640, y: 620 }, { x: 640, y: 690 }, { x: 610, y: 690 }] };
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome], bushes: [bush] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const tap = (x, y) => {
      const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
        clientX: projection.left + x * projection.zoom, clientY: projection.top + y * projection.zoom };
      canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    tap(fixture.actor.spawn.x, fixture.actor.spawn.y - fixture.actor.size / 2);
    assert.equal(env.timers.size, 2, "touching the visible body starts finite attention and speech responses");
    assert.deepEqual(places, [], "the overlapped object's footprint does not intercept a visible hero tap");
    assert.deepEqual(selections, []);
    tap(620, 680);
    assert.deepEqual(places, ["garden"], "the garden's authored area away from the hero still opens its menu");
    assert.equal(selections.at(-1).objectId, bush.id);
    tap(675, 600);
    assert.deepEqual(places, ["garden", "house"], "the house's area away from the hero still opens its menu");
    assert.equal(selections.at(-1).objectId, "home");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("foreground contours let hidden hero taps reach buildings while visible portions keep their response", async () => {
  for (const partial of [false, true]) {
    const mask = { id: "roof", frontY: 670, when: { siteId: "home", level: 1 }, points: [
      { x: 610, y: 600 }, { x: partial ? 630 : 650, y: 600 },
      { x: partial ? 630 : 650, y: 670 }, { x: 610, y: 670 },
    ] };
    const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome], occluders: [mask] });
    const env = browser(); let engine;
    try {
      worldDevStore.patch(quietClearing);
      const canvas = env.surface(400), places = [], selections = [];
      const loading = createMapEngine(canvas, options, place => places.push(place), [], undefined, {},
        { onSelectionChange: selection => selections.push(selection) });
      env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
      engine.control("overview");
      const tap = (x, y) => {
        const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
          clientX: projection.left + x * projection.zoom, clientY: projection.top + y * projection.zoom };
        canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
        canvas.events.get("pointerup")({ ...event, type: "pointerup" });
      };
      tap(625, 642);
      assert.equal(env.timers.size, 0, "a hidden part cannot start the hero's attention response");
      assert.deepEqual(places, ["house"], "the visible building receives the tap above a hidden hero");
      assert.equal(selections.at(-1).objectId, "home");
      if (partial) {
        tap(635, 642);
        assert.equal(env.timers.size, 2, "the still-visible part of the body remains tappable with finite speech and gesture");
        assert.deepEqual(places, ["house"]);
        assert.equal(selections.at(-1), null, "the hero's visible response takes priority over the building");
      }
    } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
  }
});

test("builder-home canopy blocks hidden artwork taps while exposed walls and explicit status controls remain clickable", async () => {
  const site = { ...builderHomeFixture(), anchor: { x: 675, y: 655 } };
  const canopy = { id: "builder-home-tree", frontY: 670, points: [
    { x: 660, y: 610 }, { x: 680, y: 610 }, { x: 680, y: 665 }, { x: 660, y: 665 },
  ] };
  const { createMapEngine, worldDevStore } = await modules({ sites: [site], occluders: [canopy] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const marker = Object.assign(env.surface(), { dataset: { objectId: site.id, kind: "builder-home" }, style: {} });
    const loading = createMapEngine(canvas, options, place => places.push(place), [marker], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-builder-home.webp"); engine = await loading;
    engine.control("overview");
    const tap = (point, target = canvas) => {
      const projection = mapProjection(canvas), event = { pointerId: 1, pointerType: "touch", button: 0,
        clientX: projection.left + point.x * projection.zoom, clientY: projection.top + point.y * projection.zoom };
      target.events.get("pointerdown")({ ...event, type: "pointerdown" });
      target.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    tap({ x: 675, y: 635 });
    assert.deepEqual(places, [], "the map engine must apply scene occlusion before opening an authored building hit area");
    assert.deepEqual(selections, []);
    tap({ x: 700, y: 645 });
    assert.deepEqual(places, ["builder-home"], "the exposed part of the same house keeps its menu");
    assert.equal(selections.at(-1).objectId, site.id);
    tap(site.anchor);
    assert.deepEqual(places, ["builder-home"], "a canopy-covered anchor cannot bypass visual hit masking");
    assert.equal(selections.at(-1), null, "a hidden artwork tap closes the previous selection");
    tap(site.anchor, marker);
    assert.deepEqual(places, ["builder-home", "builder-home"], "the separately visible status control still activates its explicit object ID");
    assert.equal(selections.at(-1).objectId, site.id);
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("object marker native touch capture opens once and preserves marker-origin drag pinch and cancellation", async () => {
  const site = { ...clearingHome, anchor: { x: 650, y: 700 } };
  const { createMapEngine, worldDevStore } = await modules({ sites: [site] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), places = [], selections = [];
    const marker = Object.assign(env.surface(), { dataset: { objectId: "home", kind: "house" }, style: {} });
    const markerEvents = marker.events;
    const loading = createMapEngine(canvas, options, place => places.push(place), [marker], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("home");
    const markerEvent = () => {
      const projection = mapProjection(canvas);
      return { pointerId: 1, pointerType: "touch", button: 0,
        clientX: projection.left + site.anchor.x * projection.zoom,
        clientY: projection.top + site.anchor.y * projection.zoom };
    };
    const first = markerEvent();
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointerup")({ ...first, type: "pointerup" });
    assert.deepEqual(places, [], "the marker anchor is deliberately outside the building hit polygon");
    assert.equal(typeof markerEvents.get("pointerdown"), "function");
    markerEvents.get("pointerdown")({ ...first, type: "pointerdown" });
    assert.equal(marker.hasPointerCapture(first.pointerId), true, "the original button retains native touch capture");
    assert.equal(canvas.hasPointerCapture(first.pointerId), false, "touch capture is not transferred to a sibling");
    markerEvents.get("pointerup")({ ...first, type: "pointerup" });
    markerEvents.get("lostpointercapture")({ ...first, type: "lostpointercapture" });
    canvas.events.get("pointerup")({ ...first, type: "pointerup" });
    assert.equal(marker.hasPointerCapture(first.pointerId), false);
    assert.deepEqual(places, ["house"], "a marker-origin tap activates its ID exactly once outside the polygon");
    assert.equal(selections.at(-1).objectId, "home");

    const drag = markerEvent(), beforeDrag = mapProjection(canvas);
    markerEvents.get("pointerdown")({ ...drag, type: "pointerdown" });
    markerEvents.get("pointermove")({ ...drag, type: "pointermove", clientX: drag.clientX + 25 });
    markerEvents.get("pointerup")({ ...drag, type: "pointerup", clientX: drag.clientX + 25 });
    canvas.flushFrame();
    assert.notDeepEqual(mapProjection(canvas), beforeDrag, "a marker-origin drag pans the same camera");
    assert.deepEqual(places, ["house"], "dragging from a marker does not activate it");
    const pinch = markerEvent(), second = { ...pinch, pointerId: 2, clientX: pinch.clientX + 30 };
    markerEvents.get("pointerdown")({ ...pinch, type: "pointerdown" });
    canvas.events.get("pointerdown")({ ...second, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...second, type: "pointermove", clientX: second.clientX + 15 });
    markerEvents.get("pointerup")({ ...pinch, type: "pointerup" });
    canvas.events.get("pointerup")({ ...second, type: "pointerup", clientX: second.clientX + 15 });
    const cancel = markerEvent();
    markerEvents.get("pointerdown")({ ...cancel, type: "pointerdown" });
    markerEvents.get("pointercancel")({ ...cancel, type: "pointercancel" });
    canvas.flushFrame();
    assert.deepEqual(places, ["house"], "marker-origin pinch and cancellation cannot open a menu");
    assert.equal(marker.hasPointerCapture(1), false); assert.equal(canvas.hasPointerCapture(2), false);
    engine.dispose(); engine = null;
    assert.equal(markerEvents.size, 0, "disposing the engine removes marker-origin pointer listeners");
    assert.equal(canvas.events.size, 0);
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("pointer bursts share the next animation frame and read layout once per gesture", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), samples = [];
    let rectReads = 0, markerWrites = 0;
    const readRect = canvas.getBoundingClientRect;
    canvas.getBoundingClientRect = function () { rectReads++; return readRect.call(this); };
    const marker = { dataset: { objectId: "home", kind: "house" }, style: new Proxy({}, {
      set(target, key, value) { markerWrites++; target[key] = value; return true; },
    }) };
    const loading = createMapEngine(canvas, options, assert.fail, [marker], undefined, {},
      { onObjectAnchorsChange: anchors => samples.push(anchors) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("home"); canvas.flushFrame();
    const initial = mapProjection(canvas), paints = () => canvas.calls.filter(call => call.method === "fillRect"
      && call.args[0] === 0 && call.args[1] === 0
      && call.args[2] === canvas.clientWidth && call.args[3] === canvas.clientHeight).length;
    const before = paints(), beforeSamples = samples.length, beforeWrites = markerWrites;
    const event = { pointerId: 1, pointerType: "touch", button: 0, clientX: 200, clientY: 200 };
    canvas.events.get("pointerdown")({ ...event, type: "pointerdown" });
    for (let step = 1; step <= 120; step++) canvas.events.get("pointermove")({ ...event, type: "pointermove", clientX: 200 + step / 4 });
    assert.equal(paints(), before, "120 move packets do not each repaint the world");
    assert.equal(samples.length, beforeSamples, "construction anchor updates also wait for presentation");
    assert.equal(markerWrites, beforeWrites, "the high-rate input path does not mutate DOM marker transforms");
    assert.equal(rectReads, 1, "no synchronous layout read follows marker writes during pan");
    canvas.flushFrame();
    assert.equal(paints(), before + 1, "one browser frame paints the latest camera");
    approximately(mapProjection(canvas).left, initial.left + 30, "the camera keeps all movement rather than discarding input");
    assert.equal(samples.length, beforeSamples + 1);
    canvas.events.get("pointermove")({ ...event, type: "pointermove", clientX: 235 });
    canvas.events.get("pointerup")({ ...event, type: "pointerup", clientX: 235 });
    assert.equal(rectReads, 1, "pointerup reuses the same gesture viewport");
    assert.equal(paints(), before + 1);
    canvas.flushFrame();
    assert.equal(paints(), before + 2);
    approximately(mapProjection(canvas).left, initial.left + 35, "the release frame reaches the final camera position");
    const idleWrites = markerWrites;
    engine.control("home");
    const focusedWrites = markerWrites;
    engine.control("home");
    assert.equal(markerWrites, focusedWrites, "unchanged projected transforms do not rewrite DOM styles");
    assert.ok(focusedWrites > idleWrites);
    canvas.events.get("pointerdown")({ ...event, pointerId: 2, type: "pointerdown" });
    canvas.events.get("pointercancel")({ ...event, pointerId: 2, type: "pointercancel" });
    assert.equal(rectReads, 2, "a new gesture refreshes layout for resized or moved viewports");
    engine.dispose(); engine = null;
    assert.equal(env.frames.size, 0, "disposing removes the queued interaction frame even with reduced motion");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("construction anchor projection can be suspended until a visible timer or completion effect needs it", async () => {
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(400), samples = [];
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, {},
      { objectAnchorsEnabled: false, onObjectAnchorsChange: anchors => samples.push(anchors) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("home"); dragMap(canvas, 25, 30);
    assert.deepEqual(samples, [], "ordinary camera movement does not notify an unused overlay");
    engine.setObjectAnchorsEnabled(true); canvas.flushFrame();
    assert.equal(samples.length, 1);
    assert.equal(samples[0][0].objectId, "home");
    const previous = samples[0][0];
    dragMap(canvas, 12, 18);
    assert.equal(samples.at(-1)[0].x, previous.x + 12);
    assert.equal(samples.at(-1)[0].y, previous.y + 18);
    engine.setObjectAnchorsEnabled(false);
    assert.deepEqual(samples.at(-1), []);
    const count = samples.length;
    dragMap(canvas, 10, 10);
    assert.equal(samples.length, count, "disabling a completed overlay stops subsequent camera notifications");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("overlapping phone marker targets resolve the nearest available anchor rather than DOM stacking", async () => {
  const fire = { id: "test-fire", position: { x: 700, y: 650 }, seat: { x: 720, y: 680 }, radius: 10 };
  const { createMapEngine, worldDevStore } = await modules({ sites: [clearingHome], campfires: [fire] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch(quietClearing);
    const canvas = env.surface(390), places = [], selections = [];
    const marker = id => {
      const events = new Map();
      return { dataset: { objectId: id }, style: {}, events,
        addEventListener: (name, callback) => events.set(name, callback),
        removeEventListener: name => events.delete(name) };
    };
    const houseMarker = marker("home"), fireMarker = marker(fire.id);
    const loading = createMapEngine(canvas, options, place => places.push(place), [houseMarker, fireMarker], undefined, {},
      { onSelectionChange: selection => selections.push(selection) });
    env.finish(); await flush(); env.finishPath("/test-residence.webp"); engine = await loading;
    engine.control("overview");
    const project = point => {
      const projection = mapProjection(canvas);
      return { x: projection.left + point.x * projection.zoom, y: projection.top + point.y * projection.zoom };
    };
    const pointerTap = (node, point) => {
      const event = { pointerId: 1, pointerType: "touch", button: 0, clientX: point.x, clientY: point.y };
      (node?.events ?? canvas.events).get("pointerdown")({ ...event, type: "pointerdown" });
      canvas.events.get("pointerup")({ ...event, type: "pointerup" });
    };
    const homePoint = project(clearingHome.anchor), firePoint = project(fire.position);
    assert.ok(Math.abs(homePoint.x - firePoint.x) < 22 && homePoint.y === firePoint.y,
      "the last 44px DOM target covers the neighboring marker's center on this phone viewport");
    pointerTap(fireMarker, homePoint);
    assert.deepEqual(places, ["house"], "campfire DOM delivery at the house center chooses the house anchor");
    assert.equal(selections.at(-1).objectId, "home");
    pointerTap(houseMarker, firePoint);
    assert.deepEqual(places, ["house", "campfire"], "house DOM delivery at the campfire center chooses the fire anchor");
    assert.equal(selections.at(-1).objectId, fire.id);
    const middle = { x: (homePoint.x + firePoint.x) / 2, y: homePoint.y };
    pointerTap(fireMarker, { ...middle, x: middle.x - 1 });
    pointerTap(houseMarker, { ...middle, x: middle.x + 1 });
    assert.deepEqual(places, ["house", "campfire", "house", "campfire"],
      "each side of the midpoint resolves the physically nearer marker");

    const bodyPoint = project({ x: fixture.actor.spawn.x, y: fixture.actor.spawn.y - fixture.actor.size / 2 });
    assert.ok(Math.abs(bodyPoint.x - firePoint.x) < 22 && Math.abs(bodyPoint.y - firePoint.y) < 22,
      "the fire's large marker target physically overlaps the visible hero center");
    const beforeMarkerBodyTap = places.length;
    pointerTap(fireMarker, bodyPoint); pointerTap(houseMarker, bodyPoint);
    assert.equal(places.length, beforeMarkerBodyTap, "marker DOM delivery at the visible body still notices the hero before choosing an anchor");
    assert.equal(selections.at(-1), null, "body attention closes the previous object menu");
    assert.equal(env.timers.size, 2, "marker-origin body taps use one finite gesture and one speech expiry");

    worldDevStore.patch({ showBuildings: false });
    assert.equal(houseMarker.style.visibility, "hidden");
    assert.equal(engine.activateObject("home"), false, "hidden buildings are unavailable even through their explicit ID");
    pointerTap(fireMarker, homePoint);
    assert.equal(places.at(-1), "campfire", "hidden house anchors cannot capture a nearby visible marker tap");
    const beforeBodyTap = places.length;
    pointerTap(null, project({ x: fixture.actor.spawn.x, y: fixture.actor.spawn.y - fixture.actor.size / 2 }));
    assert.equal(places.length, beforeBodyTap, "ordinary canvas body taps keep their visible-hero priority");
    assert.equal(env.timers.size, 2, "another body tap does not accumulate response timers");
    pointerTap(null, project({ x: 675, y: 600 }));
    assert.equal(places.length, beforeBodyTap, "the hidden house's polygon does not gain a ghost map target");
    pointerTap(null, firePoint);
    assert.equal(places.at(-1), "campfire", "ordinary canvas taps still use the authored fire footprint");
    const beforeKeyboard = places.length;
    assert.equal(engine.activateObject(fire.id), true);
    assert.equal(places.length, beforeKeyboard + 1);
    assert.equal(places.at(-1), "campfire", "keyboard activation keeps the requested object ID explicit");
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("full map clears the vertical HUD when zoomed in without adding horizontal travel", async () => {
  const { createMapEngine } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(393, 852), top = { offsetHeight: 170 }, bottom = { offsetHeight: 110 };
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, { top, bottom });
    env.finish(); engine = await loading;
    engine.control("home");
    dragMap(canvas, 10_000, 10_000);
    let projection = mapProjection(canvas);
    approximately(projection.top, top.offsetHeight, "the upper edge moves below the full top HUD");
    approximately(projection.left, 0, "the left edge retains its existing hard boundary");
    dragMap(canvas, -10_000, -10_000);
    projection = mapProjection(canvas);
    approximately(projection.bottom, canvas.clientHeight - bottom.offsetHeight, "the lower edge moves above the dock");
    approximately(projection.right, canvas.clientWidth, "the right edge retains its existing hard boundary");

    // Wheel zoom must remove the extra travel as soon as the whole map fits vertically.
    const heightFit = canvas.clientHeight / fixture.height;
    canvas.events.get("wheel")({ clientX: 196.5, clientY: 426,
      deltaY: Math.log(projection.zoom / heightFit) / .0015, preventDefault() {} });
    dragMap(canvas, 0, 10_000);
    projection = mapProjection(canvas);
    approximately(projection.top, 0, "no upper gap at vertical fit");
    approximately(projection.bottom, canvas.clientHeight, "no lower gap at vertical fit");
    canvas.events.get("keydown")({ key: "ArrowDown", preventDefault() {} });
    approximately(mapProjection(canvas).top, 0, "keyboard panning uses the same zoom-dependent limits");

    engine.control("overview");
    projection = mapProjection(canvas);
    approximately(projection.left, 0, "overview continues to show the complete width");
    approximately(projection.right, canvas.clientWidth, "overview never crops either side");
    approximately(projection.top, (canvas.clientHeight - canvas.clientWidth) / 2, "existing portrait overview stays centered");
    const overview = { ...projection };
    dragMap(canvas, 0, -10_000);
    assert.deepEqual(mapProjection(canvas), overview, "overview cannot be dragged farther into its letterbox");

    engine.control("home");
    const first = { pointerId: 1, pointerType: "touch", button: 0, clientX: 120, clientY: 400 };
    const second = { ...first, pointerId: 2, clientX: 280 };
    canvas.events.get("pointerdown")({ ...first, type: "pointerdown" });
    canvas.events.get("pointerdown")({ ...second, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...second, type: "pointermove", clientX: 121 });
    canvas.events.get("pointercancel")({ ...first, type: "pointercancel" });
    canvas.events.get("pointercancel")({ ...second, type: "pointercancel", clientX: 121 });
    canvas.flushFrame();
    assert.deepEqual(mapProjection(canvas), overview, "pinch zoom closes the extra travel just like the overview control");
  } finally { engine?.dispose(); env.restore(); }
});

test("HUD layout and viewport changes reclamp vertical travel and observers are released", async () => {
  const { createMapEngine } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(393, 852), top = { offsetHeight: 170 }, bottom = { offsetHeight: 110 };
    const loading = createMapEngine(canvas, options, assert.fail, [], undefined, { top, bottom });
    env.finish(); engine = await loading;
    engine.control("home"); dragMap(canvas, 0, 10_000);
    top.offsetHeight = 90; env.resize(top);
    approximately(mapProjection(canvas).top, 90, "a shorter top HUD removes the now-unnecessary gap immediately");
    dragMap(canvas, 0, -10_000);
    bottom.offsetHeight = 60; env.resize(bottom);
    approximately(mapProjection(canvas).bottom, canvas.clientHeight - 60, "a shorter bottom HUD also reclamps immediately");

    canvas.clientWidth = 852; canvas.clientHeight = 393; env.resize(canvas);
    dragMap(canvas, 10_000, 10_000);
    let projection = mapProjection(canvas);
    approximately(projection.top, 90, "landscape continues to use the measured top HUD height");
    approximately(projection.left, 0, "rotation does not loosen horizontal bounds");
    dragMap(canvas, -10_000, -10_000);
    projection = mapProjection(canvas);
    approximately(projection.bottom, canvas.clientHeight - 60, "landscape bottom edge clears the dock");
    approximately(projection.right, canvas.clientWidth, "landscape right edge remains bounded");

    engine.dispose();
    assert.equal(env.observed(), 0, "both HUD targets and canvas observers are disconnected");
    assert.equal(canvas.events.size, 0);
    const paints = canvas.calls.length;
    env.resize(top); env.resize(bottom); env.resize(canvas);
    assert.equal(canvas.calls.length, paints, "resizing detached HUD nodes cannot repaint a disposed engine");
  } finally { engine?.dispose(); env.restore(); }
});

test("exported Tiled edits drive both live views, active site art, pet hit area and expanded camera bounds", async () => {
  const focus = { x: 600, y: 800, width: 240, height: 240 };
  const actor = { spawn: { x: 710, y: 990 }, size: 60 };
  const terrain = [
    { id: "ground", image: "/test-ground.webp", bounds: { x: 0, y: 0, width: 1800, height: 1800 } },
    { id: "shore", image: "/test-shore.webp", bounds: { x: 0, y: 1800, width: 600, height: 600 } },
  ];
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [{ level: 1, label: "Дом", image: "/test-home.webp" }, { level: 2, label: "Будущее", image: "/unused-home.webp" }] };
  const { mountHabitat, createMapEngine, NEW_MAP_FOCUS, NEW_MAP_SPAWN, NEW_MAP_PET_SIZE, pixelSprite } = await modules({
    width: 1800, height: 2400, focus, actor, terrain, sites: [site],
  });
  const env = browser(); let scene, engine;
  try {
    assert.deepEqual(NEW_MAP_FOCUS, focus); assert.deepEqual(NEW_MAP_SPAWN, actor.spawn); assert.equal(NEW_MAP_PET_SIZE, 60);
    const circle = env.surface(); let ready = false;
    scene = mountHabitat(circle, options, { activity() {}, ready() { ready = true; }, failure: assert.fail });
    assert.deepEqual(env.requests, ["/test-ground.webp", "/test-home.webp"]);
    const ground = env.finish(); await flush(); assert.equal(ready, false, "visible initial art must finish first");
    const home = env.finish(); await flush(); assert.equal(ready, true, "off-focus shore art must not hold the circle");
    const shore = env.finishPath("/test-shore.webp"); await flush();
    assert.ok(circle.calls.some(call => call.method === "translate" && call.args[0] === -600 && call.args[1] === -800));
    assert.ok(circle.calls.some(call => call.method === "setTransform" && call.args[0] === 640 / 240));
    assert.deepEqual(scene.position(), { x: 710, y: 960 });
    assert.equal(scene.hitPet((710 - 600) / 240, (960 - 800) / 240), true);
    assert.equal(scene.hitPet((750 - 600) / 240, (960 - 800) / 240), false);
    const world = env.surface(400);
    engine = await createMapEngine(world, options, assert.fail, []);
    for (const target of [circle, world]) {
      const images = target.calls.filter(call => call.method === "drawImage");
      assert.deepEqual(sourceAndDestination(images.find(call => call.args[0] === ground).args).slice(1), [0, 0, 2560, 2560, 0, 0, 1800, 1800]);
      assert.deepEqual(sourceAndDestination(images.find(call => call.args[0] === shore).args).slice(1), [0, 0, 2560, 2560, 0, 1800, 600, 600]);
      assert.deepEqual(images.find(call => call.args[0] === home).args.slice(1), [600, 820, 120, 120]);
      const hero = images.findLast(call => call.args[0] === pixelSprite("idle", "front", 0));
      assert.deepEqual(hero.args.slice(1), [680, 933.75, 60, 60]);
      assert.equal(hero.args[2] + hero.args[4] * 45 / 48, actor.spawn.y,
        "the visible sole rests on the Tiled spawn instead of the transparent sprite edge");
    }
    const scale = () => world.calls.filter(call => call.method === "scale").at(-1).args[0];
    assert.equal(scale(), 400 / 2400, "initial world overview is independent of the circle crop");
    engine.control("home"); assert.equal(scale(), 400 / 240);
    engine.control("overview"); assert.equal(scale(), 400 / 2400);
    const lastCameraScale = world.calls.findLastIndex(call => call.method === "scale");
    assert.deepEqual(world.calls.slice(lastCameraScale).find(call => call.method === "translate").args, [-900, -1200]);
    assert.equal(env.requests.length, 3, "both views share asset cache; inactive upgrades are not loaded");
  } finally { scene?.dispose(); engine?.dispose(); env.restore(); }
});

test("development overrides redraw immediately while paused without advancing time or escaping background", async () => {
  const { mountHabitat, worldDevStore, WORLD_DEV_ENABLED, pixelSprite } = await modules();
  assert.equal(WORLD_DEV_ENABLED, true);
  const env = browser(); let scene;
  try {
    const canvas = env.surface(), initial = { ...options, reducedMotion: false, serverNow: 100_000 };
    scene = mountHabitat(canvas, initial, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush(); env.tick(100); env.tick(140);
    const before = canvas.calls.length, time = scene.ambience().elapsed;
    worldDevStore.patch({ paused: true });
    assert.equal(env.frames.size, 0); assert.ok(canvas.calls.length > before, "pausing refreshes both render consumers");
    worldDevStore.patch({ weather: "downpour", timeOfDay: "night", pose: "fish", direction: "right", heroScale: 1.5 });
    assert.equal(scene.ambience().rain, 1); assert.equal(scene.ambience().dusk, 1);
    const expectedSprite = pixelSprite("fish", "right", Math.floor(time * 3) % 4);
    const hero = canvas.calls.findLast(call => call.method === "drawImage" && call.args[0] === expectedSprite);
    assert.ok(hero, "the hero remains present before the night-lighting texture");
    assert.equal(hero.args[3], 54);
    env.tick(4000); assert.equal(scene.ambience().elapsed, time);
    for (const still of [false, true]) for (const direction of ["right", "left"]) {
      worldDevStore.patch({ pose: "auto", autoLife: still, reducedMotion: still ? "on" : "off", direction });
      const currentPaint = canvas.calls.slice(canvas.calls.findLastIndex(call => call.method === "clearRect"));
      assert.ok(currentPaint.some(call => call.method === "drawImage" && call.args[0] === pixelSprite("idle", direction, 0)),
        `DEV direction ${direction} redraws the automatic pose with ${still ? "reduced motion" : "automatic life disabled"}`);
    }
    scene.configure({ ...initial, backgrounded: true });
    const hidden = canvas.calls.length;
    worldDevStore.patch({ paused: false, weather: "clear", reducedMotion: "off" });
    worldDevStore.triggerPose("greet");
    assert.equal(canvas.calls.length, hidden); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
    scene.configure(initial); assert.equal(env.frames.size, 1);
    worldDevStore.patch({ showHero: false });
    assert.equal(scene.hitPet(.5, .5), false);
    scene.dispose(); const disposed = canvas.calls.length;
    worldDevStore.patch({ weather: "rain", paused: true }); worldDevStore.triggerPose("jump");
    assert.equal(canvas.calls.length, disposed); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("DEV day and night shade the complete scene and hide lights belonging to hidden buildings", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 600, width: 120, height: 120 },
    anchor: { x: 660, y: 720 }, entry: { x: 660, y: 730 }, hitArea: [], collision: [], initialLevel: 1,
    states: [{ level: 1, label: "Дом", image: "/test-lit-home.webp" }] };
  const lights = [
    { id: "home-lantern", position: { x: 675, y: 630 }, kind: "lantern", radius: 70, intensity: 1, color: "#ffd28a", flicker: 0 },
    { id: "path-lantern", position: { x: 850, y: 860 }, kind: "lantern", radius: 60, intensity: .8, color: "#ffd28a", flicker: 0 },
  ];
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ sites: [site], lights });
  const env = browser(); let scene;
  try {
    worldDevStore.patch({ timeOfDay: "day", weather: "clear", butterflies: "off", fireflies: "off", birds: "off" });
    scene = mountHabitat(env.surface(), options, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); const home = env.finish(); await flush();
    const sample = () => { const target = env.surface(); scene.paintWorld(target.context); return target.calls; };
    const multiply = call => call.method === "globalCompositeOperation" && call.args[0] === "multiply";
    const core = (calls, light) => calls.some(call => call.method === "ellipse"
      && call.args[0] === light.position.x && call.args[1] === light.position.y);
    const day = sample();
    assert.equal(day.some(multiply), false, "daylight preserves the original artwork without a night texture");
    assert.equal(core(day, lights[0]), false);
    worldDevStore.patch({ timeOfDay: "night" });
    const night = sample(), shadeIndex = night.findIndex(multiply);
    const heroIndex = night.findIndex(call => call.method === "drawImage" && call.args[0] === pixelSprite("idle", "front", 0));
    assert.ok(heroIndex >= 0 && shadeIndex > heroIndex, "one night pass includes the hero as well as terrain and buildings");
    assert.ok(core(night, lights[0]) && core(night, lights[1]), "both authored light sources glow at night");
    const nightTexture = night.slice(shadeIndex).find(call => call.method === "drawImage").args[0];
    const repeated = sample();
    assert.equal(repeated.slice(repeated.findIndex(multiply)).find(call => call.method === "drawImage").args[0], nightTexture,
      "another camera paint reuses the shared illumination texture");
    worldDevStore.patch({ showBuildings: false });
    const hidden = sample();
    assert.ok(hidden.some(multiply), "hiding buildings does not disable the night");
    assert.equal(hidden.some(call => call.method === "drawImage" && call.args[0] === home), false);
    assert.equal(core(hidden, lights[0]), false, "a hidden building cannot leave its lantern floating in the forest");
    assert.equal(core(hidden, lights[1]), true, "independent path lights remain visible");
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("authored shadow lighting integrates ground and night masks with the scene and DEV comparison restores legacy light", async () => {
  const receiver = { id: "light-test-ground", height: 0,
    points: [{ x: 530, y: 540 }, { x: 850, y: 540 }, { x: 850, y: 820 }, { x: 530, y: 820 }] };
  const caster = { id: "light-test-tree", height: 55, baseHeight: 0, opacity: .8, softness: 2,
    points: [{ x: 660, y: 660 }, { x: 680, y: 660 }, { x: 680, y: 680 }, { x: 660, y: 680 }] };
  const light = { id: "light-test-lamp", position: { x: 620, y: 620 }, height: 30,
    kind: "lantern", radius: 180, intensity: 1, color: "#ffd28a", flicker: 0 };
  const { mountHabitat, worldDevStore, pixelSprite } = await modules({ occluders: [], treeInteractions: [],
    shadowCasters: [caster], shadowReceivers: [receiver], lights: [light] });
  const env = browser(); let scene;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, lightQuality: "low" });
    scene = mountHabitat(env.surface(), options, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const sample = () => { const target = env.surface(); scene.paintWorld(target.context); return target.calls; };
    const lightDraws = calls => calls.filter(call => call.method === "drawImage" && call.args.length === 5
      && call.args[0]?.calls && [512, 768].includes(call.args[0].width) && call.args[3] === fixture.width);
    const day = sample(), directional = lightDraws(day);
    assert.equal(directional.length, 1, "authored ground has a directional shadow mask even in daylight");
    const hero = calls => calls.findIndex(call => call.method === "drawImage" && call.args[0] === pixelSprite("idle", "front", 0));
    assert.ok(day.indexOf(directional[0]) < hero(day), "ground shadows are painted before the actor, not over its face");
    const staticMask = directional[0].args[0].calls.find(call => call.method === "drawImage").args[0];
    assert.ok(staticMask.calls.some(call => call.method === "clip"), "caster projection is restricted to authored receivers");
    assert.ok(staticMask.calls.some(call => call.method === "fill"), "the scene passes its caster geometry into the mask");

    worldDevStore.patch({ timeOfDay: "night" });
    const night = sample(), masked = lightDraws(night);
    assert.equal(masked.length, 2, "night combines ground shadows and one final illumination field");
    assert.ok(night.indexOf(masked[1]) > hero(night), "final illumination includes the actor and terrain together");
    const field = masked[1].args[0];
    const pool = field.calls.find(call => call.method === "drawImage" && call.args.length === 9)?.args[0];
    assert.ok(pool?.calls.some(call => call.method === "globalCompositeOperation" && call.args[0] === "destination-out"),
      "the scene uses a source-specific erased shadow mask, rather than the old unoccluded pool");
    assert.ok(night.some(call => call.method === "ellipse" && call.args[0] === light.position.x && call.args[1] === light.position.y),
      "the visible lamp is still drawn over the illumination field");

    worldDevStore.patch({ lightShadows: false });
    const comparison = sample(), legacy = lightDraws(comparison);
    assert.equal(legacy.length, 1, "A/B removes both new directional and occluded lighting passes");
    assert.equal(legacy[0].args[0].width, 768, "A/B uses the existing legacy night texture");
    assert.notEqual(legacy[0].args[0], field);
    worldDevStore.patch({ lightShadows: true });
    assert.equal(lightDraws(sample()).at(-1).args[0], field, "re-enabling the prototype reuses its retained field");
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("authored shadow lighting keeps building lamps when DEV disables only building shadows", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 600, width: 120, height: 120 },
    anchor: { x: 660, y: 720 }, entry: { x: 660, y: 730 }, hitArea: [], collision: [], initialLevel: 1,
    states: [{ level: 1, label: "Дом", image: "/test/home-level-1.png" }] };
  const receiver = { id: "light-test-ground", height: 0,
    points: [{ x: 480, y: 500 }, { x: 880, y: 500 }, { x: 880, y: 860 }, { x: 480, y: 860 }] };
  const caster = { id: "home-volume", height: 65, baseHeight: 0, opacity: 1, softness: 1,
    points: [{ x: 630, y: 690 }, { x: 690, y: 690 }, { x: 690, y: 720 }, { x: 630, y: 720 }],
    when: { siteId: "home", level: 1 } };
  const light = { id: "path-lamp", position: { x: 580, y: 650 }, kind: "lantern", height: 30,
    radius: 220, intensity: 1, color: "#ffd28a", flicker: 0 };
  const { paintNewMap, TILED_WORLD, WORLD_DEV_DEFAULTS } = await modules({ sites: [site], lights: [light],
    occluders: [], treeInteractions: [], shadowCasters: [caster], shadowReceivers: [receiver] });
  const env = browser();
  try {
    const home = new Image(), ground = new Image();
    const images = new Map([[fixture.terrain[0].image, ground], [site.states[0].image, home]]);
    const sample = buildingShadow => {
      const target = env.surface();
      paintNewMap(target.context, images, { ...options, dusk: true }, 0, false, 0, 1,
        { scene: TILED_WORLD, residents: [], state: { ...WORLD_DEV_DEFAULTS, ...quietClearing,
          timeOfDay: "night", showHero: false, heroShadow: false, buildingShadow, lightQuality: "low" } });
      const field = target.calls.findLast(call => call.method === "drawImage" && call.args[0]?.width === 512
        && call.args.length === 5 && call.args[3] === fixture.width)?.args[0];
      assert.ok(field, "the complete scene selected its occluded night renderer");
      return { calls: target.calls, pools: field.calls.filter(call => call.method === "drawImage" && call.args.length === 9).map(call => call.args[0]) };
    };
    const enabled = sample(true), disabled = sample(false);
    assert.ok(enabled.pools.some(pool => pool.calls.some(call => call.method === "fill")),
      "the home blocks another lamp's light when building shadows are enabled");
    assert.ok(disabled.pools.every(pool => !pool.calls.some(call => call.method === "fill")),
      "disabling building shadows removes the conditional home volume from every source mask");
    assert.equal(disabled.pools.length, enabled.pools.length, "building shadow toggle cannot discard any lamp contributions");
    assert.ok(disabled.pools.length >= 2, "both the artwork-mounted home lamp and independent path lamp remain lit");
    assert.ok(disabled.calls.some(call => call.method === "drawImage" && call.args[0] === home), "the visible building remains present");
    const cores = calls => calls.filter(call => call.method === "ellipse" && call.args[0] === light.position.x && call.args[1] === light.position.y);
    assert.ok(cores(enabled.calls).length > 0); assert.equal(cores(disabled.calls).length, cores(enabled.calls).length);
  } finally { env.restore(); }
});

test("manual pose events restart, finish, preserve loop choice and use finite reduced-motion stills", async () => {
  const { mountHabitat, worldDevStore, pixelSprite } = await modules();
  const env = browser(); let scene;
  try {
    const canvas = env.surface();
    scene = mountHabitat(canvas, options, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const assertHero = (pose, frame, message) => {
      const sprite = pixelSprite(pose, worldDevStore.getSnapshot().direction, frame);
      const currentFrame = canvas.calls.slice(canvas.calls.findLastIndex(call => call.method === "clearRect"));
      assert.ok(currentFrame.some(call => call.method === "drawImage" && call.args[0] === sprite), message ?? `painted ${pose} frame ${frame}`);
    };
    worldDevStore.patch({ pose: "sleep", direction: "left" });
    assertHero("sleep", 0);
    worldDevStore.triggerPose("greet");
    assertHero("greet", 2); assert.equal(env.frames.size, 0);
    const firstTimer = [...env.timers.keys()][0]; assert.ok(firstTimer);
    worldDevStore.triggerPose("greet");
    assert.equal(env.timers.has(firstTimer), false); assert.equal(env.timers.size, 1);
    env.fireTimer([...env.timers.keys()][0]);
    assertHero("sleep", 0); assert.equal(env.timers.size, 0);
    worldDevStore.triggerPose("greet"); worldDevStore.patch({ pose: "fish", animation: null });
    assertHero("fish", 0); assert.equal(env.timers.size, 0, "choosing a loop cancels the manual event immediately");
    worldDevStore.patch({ reducedMotion: "off", pose: "idle" });
    worldDevStore.triggerPose("greet"); assertHero("greet", 0);
    env.tick(100);
    for (let now = 150; now <= 500; now += 50) env.tick(now);
    assertHero("greet", 1);
    worldDevStore.triggerPose("greet"); assertHero("greet", 0, "a repeated click starts at the first frame");
    env.tick(550);
    for (let now = 600; now <= 1550; now += 50) env.tick(now);
    assertHero("idle", Math.floor(scene.ambience().elapsed * 3) % 4);
    worldDevStore.patch({ paused: true }); worldDevStore.triggerPose("jump");
    assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0); assertHero("jump", 0);
    worldDevStore.reset(); assertHero("idle", 0, "reset clears manual events and loop overrides");
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("initial readiness waits for the latest confirmed building artwork when account data changes mid-load", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [1, 2].map(level => ({ level, label: `Level ${level}`, image: `/startup-home-${level}.webp` })) };
  const { mountHabitat } = await modules({ sites: [site] });
  const env = browser(); let scene;
  try {
    let ready = 0;
    scene = mountHabitat(env.surface(), { ...options, economyBuildings: { home: 1 } }, {
      activity() {}, ready: () => ready++, failure: assert.fail,
    });
    scene.configure({ ...options, economyBuildings: { home: 2 } });
    env.finishPath("/test-ground.webp"); env.finishPath("/startup-home-1.webp"); await flush();
    assert.equal(ready, 0, "the old successful response cannot reveal an incomplete current scene");
    env.finishPath("/startup-home-2.webp"); await flush();
    assert.equal(ready, 1, "ready is emitted once, after the current home art arrives");
  } finally { scene?.dispose(); env.restore(); }
});

test("development building levels load only selected artwork and reject stale and failed replacements", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [1, 2, 3, 4].map(level => ({ level, label: `Level ${level}`, image: `/home-${level}.webp` })) };
  const { mountHabitat, worldDevStore } = await modules({ sites: [site] });
  const env = browser(); let scene;
  try {
    const canvas = env.surface(); let ready = 0;
    scene = mountHabitat(canvas, options, { activity() {}, ready: () => ready++, failure: assert.fail });
    env.finish(); const first = env.finish(); await flush();
    assert.equal(ready, 1); assert.deepEqual(env.requests, ["/test-ground.webp", "/home-1.webp"]);
    worldDevStore.patch({ paused: true, levels: { home: 2 } });
    worldDevStore.patch({ levels: { home: 3 } });
    assert.deepEqual(env.requests, ["/test-ground.webp", "/home-1.webp", "/home-2.webp", "/home-3.webp"]);
    const latest = env.finishPath("/home-3.webp"); await flush();
    const paintedBuilding = () => canvas.calls.findLast(call => call.method === "drawImage" && call.args.length === 5
      && call.args[0] instanceof Image).args[0];
    assert.equal(paintedBuilding(), latest);
    env.finishPath("/home-2.webp"); await flush();
    worldDevStore.patch({ timeOfDay: "night" }); assert.equal(paintedBuilding(), latest, "old completion cannot replace the latest chosen art");
    worldDevStore.patch({ levels: { home: 4 } }); env.finishPath("/home-4.webp", true); await flush();
    assert.ok(worldDevStore.getSnapshot().artError); assert.equal(paintedBuilding(), latest, "a failed level retains complete previous art");
    assert.equal(ready, 1, "building changes do not remount the scene");
    worldDevStore.patch({ levels: { home: 999, unknown: 2 } });
    assert.equal(env.requests.length, 5, "invalid or unauthored states never load artwork");
    worldDevStore.reset(); await flush(); assert.equal(paintedBuilding(), first); assert.equal(worldDevStore.getSnapshot().artError, null);
  } finally { scene?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("conditional bridge debris loads atomically with current obstacles in the main circle and world", async () => {
  const bridge = { id: "bridge", label: "Мост", bounds: { x: 700, y: 720, width: 40, height: 40 },
    anchor: { x: 720, y: 750 }, entry: { x: 720, y: 765 }, hitArea: [], collision: [], initialLevel: 0,
    states: [0, 1].map(level => ({ level, label: String(level), image: "/conditional-bridge.webp" })) };
  const debris = { id: "bridge-debris", image: "/conditional-beams.png", bounds: bridge.bounds, when: { siteId: "bridge", level: 0 } };
  const navigation = { ...livingNavigation, obstacles: [{ id: "debris-blocker", when: { siteId: "bridge", level: 0 },
    points: [{ x: 680, y: 640 }, { x: 700, y: 640 }, { x: 700, y: 660 }, { x: 680, y: 660 }] }] };
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD, previewWorldScene, isWalkable } =
    await modules({ sites: [bridge], navigation, terrain: [...fixture.terrain, debris] });
  const env = browser(), scenes = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, paused: true, autoLife: false, previewBuildings: true, levels: { bridge: 1 } });
    const initial = { ...options, presenceKey: "conditional-bridge-account" };
    let ready = 0;
    const callbacks = { activity() {}, ready: () => ready++, failure: assert.fail };
    scenes.push(mountHabitat(env.surface(), initial, callbacks));
    scenes.push(mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks));
    assert.deepEqual(env.requests, ["/test-ground.webp", "/conditional-bridge.webp"],
      "an intact bridge must not wait for its hidden debris image");
    env.finishPath("/test-ground.webp"); env.finishPath("/conditional-bridge.webp"); await flush();
    assert.equal(ready, 2, "both views become ready without loading beams");
    const current = level => {
      const probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { bridge: level }), "circle", 0, 0, () => {});
      probes.push(probe); return probe;
    };
    const intact = current(1), blockedPoint = { x: 690, y: 650 };
    assert.equal(isWalkable(intact.state.clearing.navigation, blockedPoint), true);
    let beams;
    const paintedDebris = scene => {
      const surface = env.surface(); scene.paintWorld(surface.context);
      return surface.calls.some(call => call.method === "drawImage" && call.args[0] === beams);
    };
    worldDevStore.patch({ levels: { bridge: 0 } });
    assert(env.pending.some(request => request.path === debris.image), "returning to ruins requests previously hidden terrain");
    for (const scene of scenes) assert.equal(paintedDebris(scene), false, "pending debris keeps the previous complete frame");
    assert.equal(isWalkable(intact.state.clearing.navigation, blockedPoint), true, "pending images cannot install the ruin blocker early");
    beams = env.finishPath(debris.image); await flush();
    for (const scene of scenes) assert.equal(paintedDebris(scene), true);
    const ruins = current(0);
    assert.notEqual(ruins.state, intact.state);
    assert.equal(isWalkable(ruins.state.clearing.navigation, blockedPoint), false, "committed ruins use the filtered current obstacles");
    worldDevStore.patch({ levels: { bridge: 1 } }); await flush();
    for (const scene of scenes) assert.equal(paintedDebris(scene), false);
    assert.equal(isWalkable(current(1).state.clearing.navigation, blockedPoint), true, "restoration removes the blocker from actual navigation");
    const requests = env.requests.length;
    worldDevStore.patch({ levels: { bridge: 0 } }); await flush();
    for (const scene of scenes) assert.equal(paintedDebris(scene), true);
    assert.equal(isWalkable(current(0).state.clearing.navigation, blockedPoint), false, "switching back reinstates the cached ruin navigation");
    assert.equal(env.requests.length, requests, "revisiting a complete scene reuses its already loaded artwork");
    assert.equal(TILED_WORLD.terrain.length, 2);
    assert.equal(TILED_WORLD.navigation.obstacles.length, 1, "level changes never rewrite authored conditions");
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

test("building geometry switches with loaded art and both cameras share the new doorway and collision", async () => {
  const shift = offset => ({
    bounds: { ...clearingHome.bounds, x: clearingHome.bounds.x + offset },
    anchor: { ...clearingHome.anchor, x: clearingHome.anchor.x + offset },
    entry: { ...clearingHome.entry, x: clearingHome.entry.x + offset },
    doorway: { ...clearingHome.doorway, x: clearingHome.doorway.x + offset },
    hitArea: clearingHome.hitArea.map(point => ({ ...point, x: point.x + offset })),
    collision: clearingHome.collision.map(point => ({ ...point, x: point.x + offset })),
  });
  const site = { ...clearingHome, states: [1, 2, 3].map(level => ({ level, label: `Level ${level}`,
    image: `/moving-home-${level}.webp`, geometry: shift((level - 1) * 50) })) };
  const navigation = { ...livingNavigation, areas: [{ id: "clearing", points: [
    { x: 570, y: 610 }, { x: 780, y: 610 }, { x: 780, y: 735 }, { x: 570, y: 735 },
  ] }] };
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD, previewWorldScene, isWalkable } = await modules({ sites: [site], navigation });
  const env = browser(), scenes = [], probes = [];
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    const initial = { ...options, reducedMotion: false, presenceKey: "moving-home-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    env.finish(); const first = env.finish(); await flush();
    const probe = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 1 }), "circle", 0, 0, () => {}); probes.push(probe);
    const building = scene => {
      const surface = env.surface(); scene.paintWorld(surface.context);
      return surface.calls.findLast(call => call.method === "drawImage" && call.args[0] instanceof Image && call.args.length === 5).args;
    };
    worldDevStore.patch({ levels: { home: 2 } });
    assert.deepEqual(building(circle), [first, 620, 580, 80, 70], "pending artwork keeps its old bounds");
    const second = env.finishPath("/moving-home-2.webp"); await flush();
    const current = connectForestSession(initial.presenceKey, previewWorldScene(TILED_WORLD, { home: 2 }), "circle", 0, 0, () => {}); probes.push(current);
    assert.notEqual(current.state, probe.state, "old paths and residence cannot survive changed geometry");
    assert.equal(current.state.memory.enabled, false, "DEV geometry cannot persist a test residence");
    assert.deepEqual(current.state.clearing.interactions.home.entry, shift(50).entry);
    assert.equal(isWalkable(current.state.clearing.navigation, { x: 650, y: 630 }), true, "old collision is removed");
    assert.equal(isWalkable(current.state.clearing.navigation, { x: 700, y: 630 }), false, "new footprint blocks navigation");
    assert.deepEqual(building(circle), [second, 670, 580, 80, 70]);
    assert.deepEqual(building(world), building(circle));
    assert.equal(env.frames.size, 1, "the two cameras share one replacement simulation");
    worldDevStore.triggerLife("home-sleep");
    const clock = sceneClock(env);
    clock.until(() => current.state.clearing.stage === "home-sleep", "the new entrance is reachable", 600);
    assert.deepEqual(circle.position(), { x: 700, y: 640 - fixture.actor.size / 2 });
    assert.deepEqual(world.position(), circle.position());
    const oldHit = circlePoint({ x: 630, y: 610 }), newHit = circlePoint({ x: 730, y: 610 });
    assert.equal(circle.hitPet(oldHit.x, oldHit.y), false);
    assert.equal(circle.hitPet(newHit.x, newHit.y), true, "sleeping house uses its new hit area");
    worldDevStore.patch({ levels: { home: 3 } }); env.finishPath("/moving-home-3.webp", true); await flush();
    assert.deepEqual(building(circle), [second, 670, 580, 80, 70], "failed art keeps the complete previous geometry");
    assert.equal(circle.hitPet(newHit.x, newHit.y), true);
    circle.notice();
    clock.until(() => current.state.clearing.stage !== "home-sleep", "the replacement resident can wake");
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

test("full map responds to shared paused edits and camera commands and releases dev subscriptions", async () => {
  const { createMapEngine, worldDevStore } = await modules();
  const env = browser(); let engine;
  try {
    const canvas = env.surface(400), loading = createMapEngine(canvas, { ...options, reducedMotion: false }, assert.fail, []);
    env.finish(); engine = await loading;
    assert.equal(env.frames.size, 2, "map and shared scene initially run their clocks");
    worldDevStore.patch({ paused: true }); assert.equal(env.frames.size, 0);
    const frozen = canvas.calls.length;
    worldDevStore.patch({ timeOfDay: "night", showHero: false });
    assert.ok(canvas.calls.length > frozen, "world redraws store edits even with no RAF");
    const scale = () => canvas.calls.filter(call => call.method === "scale").at(-1).args[0];
    const beforeZoom = scale(); worldDevStore.triggerCamera("in"); assert.ok(scale() > beforeZoom);
    worldDevStore.triggerCamera("overview"); assert.equal(scale(), 400 / 1254);
    worldDevStore.patch({ paused: false, reducedMotion: "on" }); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ reducedMotion: "off" }); assert.equal(env.frames.size, 2);
    engine.update({ ...options, reducedMotion: false, backgrounded: true }); assert.equal(env.frames.size, 0);
    const hidden = canvas.calls.length; worldDevStore.patch({ paused: true, weather: "rain" });
    assert.equal(canvas.calls.length, hidden, "development overrides do not wake a hidden world");
    engine.dispose(); const disposed = canvas.calls.length; worldDevStore.triggerCamera("pet"); worldDevStore.reset();
    assert.equal(canvas.calls.length, disposed); assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0); assert.equal(env.observed(), 0);
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("map loading adopts the latest dev pause before starting its outer animation loop", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 600, y: 820, width: 120, height: 120 },
    anchor: { x: 660, y: 940 }, entry: { x: 660, y: 950 }, hitArea: [], collision: [], initialLevel: 1,
    states: [{ level: 1, label: "Дом", image: "/test-loading-home.webp" }] };
  const { createMapEngine, worldDevStore } = await modules({ sites: [site] });
  const env = browser(); let engine;
  try {
    const loading = createMapEngine(env.surface(400), { ...options, reducedMotion: false }, assert.fail, []);
    env.finish(); await flush();
    assert.deepEqual(env.requests, ["/test-ground.webp", "/test-loading-home.webp"]);
    worldDevStore.patch({ paused: true });
    env.finish(); engine = await loading;
    assert.equal(env.frames.size, 0, "both scene and map retain the pause applied during the asynchronous load");
    worldDevStore.patch({ paused: false }); assert.equal(env.frames.size, 2);
  } finally { engine?.dispose(); worldDevStore.reset(); env.restore(); }
});

test("same-account art-ready world owns one clock and preserves life, moisture and time on return", async () => {
  const site = { id: "home", label: "Дом", bounds: { x: 900, y: 820, width: 100, height: 100 },
    anchor: { x: 950, y: 920 }, entry: { x: 950, y: 930 }, hitArea: [], collision: [], initialLevel: 1,
    states: [1, 2].map(level => ({ level, label: `Level ${level}`, image: `/shared-home-${level}.webp` })) };
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD } = await modules({ sites: [site] });
  const env = browser(), scenes = []; let probe;
  try {
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "owner-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    env.finishPath("/test-ground.webp"); await flush();
    env.finishPath("/shared-home-1.webp"); await flush(); env.tick(100); env.tick(150);
    probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {});
    worldDevStore.patch({ weather: "rain", levels: { home: 2 } });
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    const before = circle.ambience().elapsed; env.tick(200); env.tick(250);
    assert.ok(circle.ambience().elapsed > before, "loading world has not taken the ready circle's clock");
    env.finishPath("/shared-home-2.webp"); await flush();
    assert.equal(env.frames.size, 1, "only one shared scene clock runs after world art is ready");
    circle.configure({ ...initial, backgrounded: true });
    worldDevStore.triggerLife("mushroom");
    env.tick(300); for (let now = 350; now <= 2850; now += 50) env.tick(now);
    assert.equal(probe.state.life.routine.kind, "mushroom"); assert.equal(probe.state.life.routine.picked, true);
    assert.ok(probe.state.wetness > 0);
    assert.deepEqual(circle.ambience(), world.ambience());
    const snapshot = structuredClone(probe.state);
    circle.setTime(80_000);
    world.dispose(); circle.configure(initial); await flush();
    assert.equal(env.frames.size, 1); assert.deepEqual(probe.state, snapshot, "handoff does not reset life or rewind to an old circle time sample");
    env.tick(2900); env.tick(2950);
    assert.ok(probe.state.life.routine.elapsed > snapshot.life.routine.elapsed);
    assert.ok(probe.state.wetness > snapshot.wetness);
    assert.deepEqual(circle.position(), { x: 630, y: 642 }, "routines never move the authored hero");
  } finally { probe?.release(); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});

test("shared DEV transitions apply once and pause, reduced motion and account changes isolate life", async () => {
  const { mountHabitat, worldDevStore, connectForestSession, TILED_WORLD } = await modules({ habitats: livingHabitats });
  const env = browser(), scenes = [], probes = [];
  try {
    worldDevStore.patch({ weather: "clear", timeOfDay: "day", autoLife: false });
    const initial = { ...options, reducedMotion: false, serverNow: 100_000, presenceKey: "life-account" };
    const callbacks = { activity() {}, ready() {}, failure: assert.fail };
    const circle = mountHabitat(env.surface(), initial, callbacks); scenes.push(circle);
    const world = mountHabitat(env.surface(), { ...initial, view: "world" }, callbacks); scenes.push(world);
    env.finish(); await flush();
    const clock = sceneClock(env);
    const probe = connectForestSession(initial.presenceKey, TILED_WORLD, "circle", 0, 0, () => {}); probes.push(probe);
    worldDevStore.triggerBirds();
    assert.equal(probe.state.birdSeed, 0, "both cameras consume the first bird visit only once");
    assert.equal(probe.state.birdStarted, probe.state.elapsed);
    worldDevStore.triggerBirds();
    assert.equal(probe.state.birdSeed, 1, "another DEV invocation chooses the next shared scenario");
    worldDevStore.triggerPose("greet"); worldDevStore.triggerLife("butterfly");
    assert.equal(probe.state.pendingLife, "butterfly", "the shared request survives both camera subscribers");
    clock.advance(.1);
    assert.equal(probe.state.fauna.encounter?.kind, "butterfly", "the next visible step reserves one real individual");
    assert.equal(probe.state.fauna.sequence, 1, "the two cameras cannot create duplicate reservations");
    assert.equal(probe.state.life.routine, null, "insects never use the old transient prop routine");
    assert.equal(probe.state.animation, null);
    worldDevStore.patch({ pose: "sleep" }); worldDevStore.triggerLife("firefly");
    assert.equal(probe.state.pendingLife, "firefly", "changing a held pose to auto is also a single shared transition");
    worldDevStore.patch({ paused: true });
    const paused = structuredClone(probe.state); env.tick(10_000);
    assert.deepEqual(probe.state, paused); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ paused: false, reducedMotion: "on" });
    const still = structuredClone(probe.state); env.tick(20_000);
    assert.deepEqual(probe.state, still); assert.equal(env.frames.size, 0);
    worldDevStore.patch({ reducedMotion: "off" }); worldDevStore.triggerPose("jump");
    assert.equal(probe.state.life.routine, null, "manual sprite poses cancel interaction props immediately");
    assert.equal(probe.state.fauna.encounter, null); assert.equal(probe.state.pendingLife, null);
    world.configure({ ...initial, presenceKey: "other-account", view: "world" });
    const other = connectForestSession("other-account", TILED_WORLD, "circle", 0, 0, () => {}); probes.push(other);
    assert.notEqual(other.state, probe.state); assert.equal(other.state.life.elapsed, 0);
    assert.equal(other.state.animation, null); assert.equal(other.state.wetness, 0);
    await flush(); assert.equal(env.frames.size, 2, "different accounts and anonymous scenes remain independent");
  } finally { probes.forEach(probe => probe.release()); scenes.forEach(scene => scene.dispose()); worldDevStore.reset(); env.restore(); }
});