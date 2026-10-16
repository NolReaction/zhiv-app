import assert from "node:assert/strict";
import test from "node:test";
import {
  browser,
  flush,
  mapProjection,
  modules,
  options,
  quietClearing,
  studioFocusLayouts
} from "./helpers/new-map-scene.mjs";


test("lighting studio drafts feed the visible sources and renderer while preview off restores authored light", async () => {
  const light = { id: "studio-lamp", position: { x: 620, y: 620 }, height: 30,
    kind: "lantern", radius: 100, intensity: 1, color: "#ffd28a", flicker: 0 };
  const caster = { id: "studio-tree", height: 55, baseHeight: 0, opacity: .8, softness: 2,
    points: [{ x: 660, y: 660 }, { x: 680, y: 660 }, { x: 680, y: 680 }, { x: 660, y: 680 }] };
  const { mountHabitat, worldDevStore, worldLightingEditorStore } = await modules({ lights: [light], shadowCasters: [caster] });
  const env = browser(); let scene;
  try {
    worldDevStore.patch({ ...quietClearing, timeOfDay: "night", autoLife: false });
    scene = mountHabitat(env.surface(), options, { activity() {}, ready() {}, failure: assert.fail });
    env.finish(); await flush();
    const baselineCasters = scene.lightingCasters();
    worldLightingEditorStore.setEnabled(true); worldLightingEditorStore.selectLight(light.id);
    worldLightingEditorStore.patchLight({ position: { x: 640, y: 630 }, radius: 125 });
    assert.deepEqual(scene.lightingLights().find(item => item.id === light.id).position, { x: 640, y: 630 });
    assert.deepEqual(worldLightingEditorStore.getSnapshot().lightProjections.find(item => item.id === light.id),
      { id: light.id, position: { x: 640, y: 630 }, height: 30 });
    assert.equal(scene.lightingCasters(), baselineCasters, "lamp edits do not replace caster geometry");
    const target = env.surface(); scene.paintWorld(target.context);
    assert.ok(target.calls.some(call => call.method === "ellipse" && call.args[0] === 640 && call.args[1] === 630),
      "the lamp emitter follows the same edited source as the map tool");
    worldLightingEditorStore.setPreviewDraft(false);
    assert.deepEqual(scene.lightingLights().find(item => item.id === light.id).position, light.position);
    worldLightingEditorStore.setPreviewDraft(true);
    const added = worldLightingEditorStore.addLight({ x: 700, y: 710 }, "glow");
    assert.ok(scene.lightingLights().some(item => item.id === added));
    worldLightingEditorStore.undo(); assert.equal(scene.lightingLights().some(item => item.id === added), false);
    worldLightingEditorStore.selectLight(light.id); worldLightingEditorStore.patchLight({ enabled: false });
    assert.equal(scene.lightingLights().find(item => item.id === light.id).enabled, false, "a disabled lamp remains selectable in the studio");
  } finally {
    scene?.dispose(); worldLightingEditorStore.resetAll(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});

test("lighting studio map capture cancels a vertex on pinch, hidden page and Escape before release", async () => {
  const caster = { id: "studio-tree", height: 55, baseHeight: 0, opacity: .8, softness: 2,
    points: [{ x: 660, y: 660 }, { x: 680, y: 660 }, { x: 680, y: 680 }, { x: 660, y: 680 }] };
  const { createMapEngine, worldDevStore, worldLightingEditorStore } = await modules({ shadowCasters: [caster] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    worldLightingEditorStore.setEnabled(true); worldLightingEditorStore.setTool("vertex");
    const canvas = env.surface(700), loading = createMapEngine(canvas, options, assert.fail, []);
    env.finish(); await flush(); engine = await loading; engine.control("home"); canvas.flushFrame();
    const pointer = () => {
      const projection = mapProjection(canvas);
      return { pointerId: 1, pointerType: "touch", button: 0, clientX: projection.left + caster.points[0].x * projection.zoom,
        clientY: projection.top + caster.points[0].y * projection.zoom };
    };
    const send = (type, event) => canvas.events.get(type)({ ...event, type });
    let first = pointer(); send("pointerdown", first); assert.equal(canvas.hasPointerCapture(1), true);
    send("pointermove", { ...first, clientX: first.clientX - 5 });
    canvas.flushFrame();
    assert.notDeepEqual(worldLightingEditorStore.getSnapshot().casters[0].points[0], caster.points[0]);
    const second = { ...first, pointerId: 2, clientX: first.clientX + 40 };
    send("pointerdown", second); assert.deepEqual(worldLightingEditorStore.getSnapshot().casters[0].points[0], caster.points[0]);
    send("pointerup", first); send("pointerup", second); canvas.flushFrame();
    first = pointer(); send("pointerdown", first); send("pointermove", { ...first, clientX: first.clientX - 5 });
    canvas.events.get("keydown")({ key: "Escape", preventDefault() {} });
    send("pointerup", first); assert.deepEqual(worldLightingEditorStore.getSnapshot().casters[0].points[0], caster.points[0]);
    first = pointer(); send("pointerdown", first); send("pointermove", { ...first, clientX: first.clientX - 5 });
    env.visibility(true); assert.equal(canvas.hasPointerCapture(1), false);
    assert.deepEqual(worldLightingEditorStore.getSnapshot().casters[0].points[0], caster.points[0]);
    env.visibility(false); canvas.flushFrame();
    worldLightingEditorStore.setTool("light"); first = { ...pointer(), clientX: 300, clientY: 300 };
    send("pointerdown", first); send("pointerdown", { ...first, pointerId: 2, clientX: 340 });
    send("pointerup", first); send("pointerup", { ...first, pointerId: 2, clientX: 340 });
    assert.equal(worldLightingEditorStore.getSnapshot().lights.length, 0, "pinch does not accidentally place a lamp");
    worldLightingEditorStore.setEnabled(false); engine.control("home"); canvas.flushFrame();
    const cameraBefore = mapProjection(canvas); first = pointer();
    send("pointerdown", first); send("pointermove", { ...first, clientX: first.clientX + 30 });
    send("pointerup", { ...first, clientX: first.clientX + 30 }); canvas.flushFrame();
    assert.notDeepEqual(mapProjection(canvas), cameraBefore, "ordinary camera dragging resumes when the studio closes");
    assert.deepEqual(worldLightingEditorStore.getSnapshot().casters[0].points, caster.points);
  } finally {
    engine?.dispose(); worldLightingEditorStore.resetAll(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});

test("studio light pointer bursts update geometry once per frame and commit the exact release position", async () => {
  const light = { id: "dragged-glow", kind: "glow", position: { x: 660, y: 660 }, radius: 100,
    height: 24, intensity: 1, color: "#ffd28a", flicker: 0, manualPosition: true };
  const { createMapEngine, worldDevStore, worldLightingEditorStore } = await modules({ lights: [light] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    worldLightingEditorStore.setEnabled(true); worldLightingEditorStore.setTool("move");
    const canvas = env.surface(700), loading = createMapEngine(canvas, options, assert.fail, []);
    env.finish(); await flush(); engine = await loading; engine.control("home"); canvas.flushFrame();
    const projection = mapProjection(canvas);
    const send = (type, x, y) => canvas.events.get(type)({ type, pointerId: 1, pointerType: "mouse", button: 0,
      clientX: projection.left + x * projection.zoom, clientY: projection.top + y * projection.zoom });
    send("pointerdown", 660, 660);
    const before = worldLightingEditorStore.getSnapshot().lightRevision;
    for (let step = 1; step <= 120; step++) send("pointermove", 660 + step / 4, 660 + step / 8);
    assert.equal(worldLightingEditorStore.getSnapshot().lightRevision, before,
      "high-rate input does not rebuild the store, scene or React property panels for each packet");
    canvas.flushFrame();
    assert.equal(worldLightingEditorStore.getSnapshot().lightRevision, before + 1);
    assert.deepEqual(worldLightingEditorStore.getSnapshot().lights[0].position, { x: 690, y: 675 });
    send("pointermove", 692, 676); send("pointerup", 693, 677);
    assert.equal(worldLightingEditorStore.getSnapshot().lightRevision, before + 2, "release flushes one final update before committing");
    assert.deepEqual(worldLightingEditorStore.getSnapshot().lights[0].position, { x: 693, y: 677 });
    canvas.flushFrame();
    assert.equal(worldLightingEditorStore.getSnapshot().lightRevision, before + 2, "no stale packet runs after pointerup");
    worldLightingEditorStore.undo(); assert.deepEqual(worldLightingEditorStore.getSnapshot().lights[0].position, light.position);
    worldLightingEditorStore.redo(); assert.deepEqual(worldLightingEditorStore.getSnapshot().lights[0].position, { x: 693, y: 677 });
    send("pointerdown", 693, 677); send("pointermove", 703, 687);
    canvas.events.get("keydown")({ key: "Escape", preventDefault() {} }); send("pointerup", 703, 687); canvas.flushFrame();
    assert.deepEqual(worldLightingEditorStore.getSnapshot().lights[0].position, { x: 693, y: 677 }, "Escape discards even an unpresented final packet");
  } finally {
    engine?.dispose(); worldLightingEditorStore.resetAll(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});

test("lighting studio bridge supports mixed pointer selection, layout-independent keyboard commands and viewport exclusions", async () => {
  const caster = (id, x) => ({ id, height: 20, baseHeight: 0, opacity: 1, softness: 2,
    points: [{ x, y: 650 }, { x: x + 20, y: 650 }, { x: x + 20, y: 670 }, { x, y: 670 }] });
  const receiver = { id: "studio-ground", height: 0, points: [{ x: 610, y: 710 }, { x: 750, y: 710 }, { x: 750, y: 800 }, { x: 610, y: 800 }] };
  const { createMapEngine, createWorldStudioKeyboard, WORLD_STUDIO_MAP_KEY_EVENT, worldDevStore, worldLightingEditorStore, requestWorldStudioCreate } = await modules({
    shadowCasters: [caster("studio-one", 620), caster("studio-two", 700)], shadowReceivers: [receiver] });
  const env = browser(); let engine;
  const events = new Map();
  window.addEventListener = (name, callback) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); };
  window.removeEventListener = (name, callback) => events.get(name)?.delete(callback);
  window.dispatchEvent = event => { for (const callback of events.get(event.type) ?? []) callback(event); return true; };
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false }); worldLightingEditorStore.setEnabled(true);
    const canvas = env.surface(1000, 800), loading = createMapEngine(canvas, options, assert.fail, []);
    env.finish(); await flush(); engine = await loading; engine.control("home"); canvas.flushFrame();
    const send = (type, x, y, modifiers = {}) => {
      const projection = mapProjection(canvas);
      canvas.events.get(type)({ type, pointerId: 1, pointerType: "mouse", button: 0,
        clientX: projection.left + x * projection.zoom, clientY: projection.top + y * projection.zoom, ...modifiers });
    };
    send("pointerdown", 630, 660); send("pointerup", 630, 660);
    send("pointerdown", 710, 660, { ctrlKey: true }); send("pointerup", 710, 660, { ctrlKey: true });
    assert.equal(worldLightingEditorStore.getSnapshot().selectedElements.length, 2, "the map passes additive modifiers to studio selection");
    send("pointerdown", 1000, 1000, { metaKey: true }); send("pointerup", 1000, 1000, { metaKey: true });
    assert.equal(worldLightingEditorStore.getSnapshot().selectedElements.length, 2, "additive empty taps preserve the existing group");
    const keyboard = createWorldStudioKeyboard({ store: worldLightingEditorStore, ui() {}, close() {},
      map: request => window.dispatchEvent(new CustomEvent(WORLD_STUDIO_MAP_KEY_EVENT, { detail: request })) });
    const input = (key, code, modifiers = {}) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: null, ...modifiers });
    assert.equal(keyboard.down(input("п", "KeyG")), true); assert.equal(worldLightingEditorStore.getSnapshot().tool, "move");
    const before = structuredClone(worldLightingEditorStore.getSnapshot().casters);
    assert.equal(keyboard.down(input("ArrowRight", "ArrowRight")), true);
    assert.equal(worldLightingEditorStore.getSnapshot().casters[0].points[0].x, before[0].points[0].x + 1);
    assert.equal(worldLightingEditorStore.getSnapshot().casters[1].points[0].x, before[1].points[0].x + 1);
    assert.equal(keyboard.down(input("я", "KeyZ", { ctrlKey: true })), true);
    assert.deepEqual(worldLightingEditorStore.getSnapshot().casters, before);
    worldLightingEditorStore.selectReceiver(receiver.id); requestWorldStudioCreate("receiver-hole");
    assert.equal(worldLightingEditorStore.getSnapshot().receivers[0].holes.length, 1);
    assert.equal(worldLightingEditorStore.getSnapshot().selectedHole, 0); assert.equal(worldLightingEditorStore.getSnapshot().tool, "vertex");
    engine.dispose(); engine = null;
    assert.equal(events.get(WORLD_STUDIO_MAP_KEY_EVENT)?.size, 0, "disposed maps release their global keyboard bridge");
  } finally {
    engine?.dispose(); worldLightingEditorStore.resetAll(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});
for (const layout of studioFocusLayouts) test("lighting studio pending focus survives map loading with " + layout.name, async () => {
  const light = { id: "studio-focus", position: layout.point, kind: "lantern", radius: 50, intensity: 1, color: "#ffd28a", flicker: 0 };
  const { createMapEngine, worldDevStore, worldLightingEditorStore, requestWorldLightingEditorFocus } = await modules({ lights: [light] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    worldLightingEditorStore.setEnabled(true);
    worldLightingEditorStore.selectLight(light.id);
    document.querySelectorAll = () => (layout.panels ?? [layout.panel]).map(panel => ({ getBoundingClientRect: () => panel }));
    requestWorldLightingEditorFocus();
    const canvas = env.surface(layout.view.width, layout.view.height), loading = createMapEngine(canvas, options, assert.fail, []);
    env.finish(); await flush(); engine = await loading;
    const projection = mapProjection(canvas);
    layout.check({ x: projection.left + layout.point.x * projection.zoom, y: projection.top + layout.point.y * projection.zoom });
    assert.ok(projection.zoom > 1, "focus also frames the requested object bounds");
  } finally {
    engine?.dispose(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});


test("studio volume and surface creation uses the active visible viewport after map mount", async () => {
  for (const kind of ["caster", "receiver"]) {
    const { createMapEngine, worldDevStore, worldLightingEditorStore, requestWorldStudioCreate } = await modules({ shadowCasters: [], shadowReceivers: [] });
    const env = browser(); let engine;
    try {
      worldDevStore.patch({ ...quietClearing, autoLife: false }); worldLightingEditorStore.setEnabled(true);
      const panels = [{ left: 0, top: 90, width: 300, height: 710 }, { left: 880, top: 90, width: 320, height: 710 }, { left: 0, top: 0, width: 1200, height: 90 }];
      document.querySelectorAll = () => panels.map(panel => ({ getBoundingClientRect: () => panel }));
      requestWorldStudioCreate(kind);
      const canvas = env.surface(1200, 800), loading = createMapEngine(canvas, options, assert.fail, []);
      env.finish(); await flush(); engine = await loading;
      const snapshot = worldLightingEditorStore.getSnapshot(), created = kind === "caster" ? snapshot.casters[0] : snapshot.receivers[0];
      assert.ok(created); assert.equal(snapshot.selectedKind, kind); assert.equal(snapshot.selectedId, created.id); assert.equal(snapshot.tool, "move");
      const center = { x: created.points.reduce((s, p) => s + p.x, 0) / created.points.length, y: created.points.reduce((s, p) => s + p.y, 0) / created.points.length };
      const projection = mapProjection(canvas), screen = { x: projection.left + center.x * projection.zoom, y: projection.top + center.y * projection.zoom };
      assert.ok(screen.x > 316 && screen.x < 864 && screen.y > 106 && screen.y < 784, "new geometry is inside the live unobstructed map area");
      assert.equal(snapshot.canUndo, true); worldLightingEditorStore.undo();
      assert.equal((kind === "caster" ? worldLightingEditorStore.getSnapshot().casters : worldLightingEditorStore.getSnapshot().receivers).length, 0);
    } finally {
      engine?.dispose(); worldLightingEditorStore.resetAll(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
    }
  }
});

test("effective receiving contours reach the editor and lamp edits preserve their geometry references", async () => {
  const receiver = { id: "clearing-surface", points: [{ x: 580, y: 610 }, { x: 690, y: 610 }, { x: 690, y: 710 }, { x: 580, y: 710 }], height: 0 };
  const light = { id: "free-light", position: { x: 630, y: 600 }, kind: "lantern", radius: 100, intensity: 1, color: "#ffd28a", flicker: 0 };
  const { mountHabitat, worldDevStore, worldLightingEditorStore } = await modules({ lights: [light], shadowReceivers: [receiver] });
  const env = browser(); let scene;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false });
    scene = mountHabitat(env.surface(), options, { activity() {} }); env.finish(); await flush();
    const baseline = scene.lightingReceivers(); assert.deepEqual(baseline, [receiver]);
    worldLightingEditorStore.setEnabled(true); worldLightingEditorStore.selectLight(light.id); worldLightingEditorStore.patchLight({ intensity: .5 });
    assert.equal(scene.lightingReceivers(), baseline);
    worldLightingEditorStore.selectReceiver(receiver.id); worldLightingEditorStore.patchReceiver({ height: 25 });
    assert.equal(scene.lightingReceivers()[0].height, 25); assert.deepEqual(scene.lightingReceivers()[0].points, receiver.points);
    worldLightingEditorStore.setPreviewDraft(false); assert.equal(scene.lightingReceivers()[0].height, 0);
  } finally {
    scene?.dispose(); worldLightingEditorStore.resetAll(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});


test("studio hides legacy blue debug regions while retaining the normal debug switch outside editing", async () => {
  const receiver = { id: "ground-debug", points: [{ x: 550, y: 580 }, { x: 710, y: 580 }, { x: 710, y: 740 }, { x: 550, y: 740 }], height: 0 };
  const { mountHabitat, worldDevStore, worldLightingEditorStore } = await modules({ shadowReceivers: [receiver] });
  const env = browser(); let scene;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false, lightDebug: true, lightShadows: true });
    const canvas = env.surface(); scene = mountHabitat(canvas, options, { activity() {} }); env.finish(); await flush();
    assert.ok(canvas.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#56d5ec"));
    worldLightingEditorStore.setEnabled(true); canvas.calls.length = 0; scene.paintWorld(canvas.context);
    assert.equal(canvas.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#56d5ec"), false, "studio owns the semantic overlays and avoids global debug outlines");
    worldLightingEditorStore.setEnabled(false); canvas.calls.length = 0; scene.paintWorld(canvas.context);
    assert.ok(canvas.calls.some(call => call.method === "strokeStyle" && call.args[0] === "#56d5ec"));
  } finally {
    scene?.dispose(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});

test("studio refresh retains the same canvas viewport and creation centre despite temporary panel cleanup", async () => {
  const light = { id: "refresh-focus", position: { x: 420, y: 550 }, kind: "lantern", radius: 50, intensity: 1, color: "#ffd28a", flicker: 0 };
  const { createMapEngine, worldDevStore, worldLightingEditorStore, requestWorldLightingEditorFocus, requestWorldStudioCreate } = await modules({ lights: [light], shadowCasters: [], shadowReceivers: [], destinations: [{ id: "fishing", position: { x: 900, y: 1000 }, pauseSeconds: 15 }] });
  const env = browser(); let engine;
  const events = new Map();
  const centre = polygon => ({ x: polygon.points.reduce((sum, p) => sum + p.x, 0) / polygon.points.length,
    y: polygon.points.reduce((sum, p) => sum + p.y, 0) / polygon.points.length });
  try {
    window.addEventListener = (name, callback) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); };
    window.removeEventListener = (name, callback) => events.get(name)?.delete(callback);
    window.dispatchEvent = event => { for (const callback of events.get(event.type) ?? []) callback(event); return true; };
    const panels = [{ left: 0, top: 90, width: 300, height: 710 }, { left: 880, top: 90, width: 320, height: 710 }, { left: 0, top: 0, width: 1200, height: 90 }];
    document.querySelectorAll = () => panels.map(panel => ({ getBoundingClientRect: () => panel }));
    worldDevStore.patch({ ...quietClearing, autoLife: false }); worldLightingEditorStore.setEnabled(false);
    const canvas = env.surface(1200, 800), loading = createMapEngine(canvas, options, assert.fail, []);
    env.finish(); await flush(); engine = await loading; worldLightingEditorStore.setEnabled(true);
    worldDevStore.triggerCamera("fishing"); requestWorldLightingEditorFocus({ point: light.position }); engine.control("out");
    worldLightingEditorStore.setTool("pan");
    const pointer = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 600, clientY: 400 };
    canvas.events.get("pointerdown")({ ...pointer, type: "pointerdown" });
    canvas.events.get("pointermove")({ ...pointer, clientX: 545, clientY: 362, type: "pointermove" });
    canvas.events.get("pointerup")({ ...pointer, clientX: 545, clientY: 362, type: "pointerup" }); canvas.flushFrame();
    const before = mapProjection(canvas);
    requestWorldStudioCreate("receiver"); canvas.flushFrame();
    const first = centre(worldLightingEditorStore.getSnapshot().receivers[0]);
    worldLightingEditorStore.setEnabled(false); engine.dispose(); engine = undefined;
    worldLightingEditorStore.setEnabled(true); canvas.calls.length = 0;
    engine = await createMapEngine(canvas, options, assert.fail, []);
    const after = mapProjection(canvas);
    for (const key of ["left", "top", "zoom"]) assert.ok(Math.abs(after[key] - before[key]) < 1e-7, `same-canvas refresh preserves ${key}`);
    requestWorldStudioCreate("receiver"); canvas.flushFrame();
    assert.deepEqual(centre(worldLightingEditorStore.getSnapshot().receivers[1]), first, "new surfaces use the same visible viewport centre after refresh");
    engine.dispose(); engine = undefined;
    const nextCanvas = env.surface(1200, 800); engine = await createMapEngine(nextCanvas, options, assert.fail, []);
    assert.notEqual(mapProjection(nextCanvas).zoom, before.zoom, "closing/reopening with a new canvas has its normal initial framing");
    engine.dispose(); engine = undefined;
    worldLightingEditorStore.setEnabled(false); engine = await createMapEngine(canvas, options, assert.fail, []);
    assert.notEqual(mapProjection(canvas).zoom, before.zoom, "an inactive studio never restores an old editing viewport");
  } finally {
    engine?.dispose(); worldLightingEditorStore.resetAll(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});

test("same-canvas studio refresh keeps an edge selection between both panels", async () => {
  const light = { id: "refresh-edge", position: { x: 20, y: 20 }, kind: "lantern", radius: 50, intensity: 1, color: "#ffd28a", flicker: 0 };
  const { createMapEngine, worldDevStore, worldLightingEditorStore, requestWorldLightingEditorFocus } = await modules({ lights: [light] });
  const env = browser(); let engine;
  try {
    worldDevStore.patch({ ...quietClearing, autoLife: false }); worldLightingEditorStore.setEnabled(true); worldLightingEditorStore.selectLight(light.id);
    const panels = [{ left: 0, top: 0, width: 300, height: 800 }, { left: 880, top: 0, width: 320, height: 800 }];
    document.querySelectorAll = () => panels.map(panel => ({ getBoundingClientRect: () => panel }));
    requestWorldLightingEditorFocus();
    const canvas = env.surface(1200, 800), loading = createMapEngine(canvas, options, assert.fail, []);
    env.finish(); await flush(); engine = await loading;
    const before = mapProjection(canvas); engine.dispose(); engine = undefined; canvas.calls.length = 0;
    engine = await createMapEngine(canvas, options, assert.fail, []);
    const after = mapProjection(canvas), point = { x: after.left + light.position.x * after.zoom, y: after.top + light.position.y * after.zoom };
    for (const key of ["left", "top", "zoom"]) assert.ok(Math.abs(after[key] - before[key]) < 1e-7, `edge refresh preserves ${key}`);
    assert.ok(point.x > 316 && point.x < 864 && point.y > 16 && point.y < 784, "full-viewport clamping does not hide the target under either studio panel");
  } finally {
    engine?.dispose(); worldLightingEditorStore.setEnabled(false); worldDevStore.reset(); env.restore();
  }
});