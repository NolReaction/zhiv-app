import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { drawResidentHomeIndicator: drawHome, residentHomeParticles } = await vite.ssrLoadModule("/features/world/characters/resident-home-effects.ts");
const { leaftailWindowResidentFrame: windowFrame, drawLeaftailWindowResident: drawWindow } = await vite.ssrLoadModule("/features/world/characters/leaftail/leaftail-window-painter.ts");
const { drawLopukhWoodpile: drawPile } = await vite.ssrLoadModule("/features/world/characters/lopukh/lopukh-woodpile-painter.ts");
const { advanceWoodcutterCycle } = await vite.ssrLoadModule("/features/world/characters/villagers/woodcutter-cycle.ts");
const { createForestVillagers, rehydrateForestVillagers } = await vite.ssrLoadModule("/features/world/characters/villagers/villager-mind.ts");
const { residentScenePresentation } = await vite.ssrLoadModule("/features/world/scene/resident-scene-presentation.ts");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { previewWorldScene, initialPreviewLevels } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { createWorldNavigation } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
after(() => vite.close());

function deliveryGround() {
  const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  const scene = { width: 300, height: 200, actor: { size: 50 }, terrain: [], paths: [],
    sites: [{ id: "lopukh-home", bounds: { x: 10, y: 10, width: 20, height: 20 }, collision: rect(10, 10, 20, 20) }],
    navigation: { version: 1, cellSize: 10, areas: [{ id: "ground", points: rect(0, 0, 300, 200) }], obstacles: [], interests: [] },
    water: { surfaces: [], exclusions: [] } };
  return { scene, places: { woodcutting: {}, navigation: createWorldNavigation(scene, 4.4) } };
}

test("the real indoor fish follow their authored door-side centre, level and size without moving the resident", () => {
  const state = { elapsed: 12, pleskMind: { home: { phase: "inside" } } }, before = structuredClone(state);
  const anchor = TILED_WORLD.effectAnchors.find(anchor => anchor.id === "plesk-home-fish");
  assert.ok(anchor);
  const presentation = residentScenePresentation(state, TILED_WORLD), cue = presentation.homes[0];
  assert.deepEqual(cue.position, anchor.position); assert.equal(cue.centered, true); assert.equal(cue.size, anchor.size);
  const shop = TILED_WORLD.sites.find(site => site.id === "plesk-shop");
  assert.ok(Math.hypot(anchor.position.x - shop.doorway.x, anchor.position.y - shop.doorway.y) < 25);
  const moved = structuredClone(TILED_WORLD); moved.effectAnchors[0].position.x += 17; moved.effectAnchors[0].position.y += 9;
  const next = residentScenePresentation(state, moved).homes[0];
  for (const still of [false, true]) {
    const first = residentHomeParticles(cue, still), second = residentHomeParticles(next, still);
    first.forEach((particle, index) => {
      assert.ok(Math.abs(second[index].x - particle.x - 17) < 1e-8); assert.ok(Math.abs(second[index].y - particle.y - 9) < 1e-8);
      assert.ok(Math.abs(particle.y - anchor.position.y) < 7, "the point marks the visible motif centre, not a hidden roof offset");
    });
  }
  const hidden = structuredClone(TILED_WORLD); hidden.effectAnchors[0].when.level = 2;
  assert.equal(previewWorldScene(hidden, initialPreviewLevels(hidden)).effectAnchors.length, 0);
  const legacy = { ...TILED_WORLD, effectAnchors: undefined };
  assert.deepEqual(residentScenePresentation(state, legacy).homes[0].position, shop.doorway);
  assert.deepEqual(state, before); assert.deepEqual(cue.position, anchor.position);
});

function context() {
  const paints = [], images = [], clips = [], stack = [];
  return { paints, images, clips, globalAlpha: .6, imageSmoothingEnabled: true, fillStyle: "#000000",
    save() { stack.push([this.globalAlpha, this.fillStyle, this.imageSmoothingEnabled]); },
    restore() { [this.globalAlpha, this.fillStyle, this.imageSmoothingEnabled] = stack.pop(); },
    fillRect(...rectangle) { paints.push({ rectangle, color: this.fillStyle, alpha: this.globalAlpha }); },
    beginPath() {}, ellipse(...args) { clips.push(args); }, clip() {}, fill() {},
    drawImage(...args) { images.push(args); },
    fillText() { assert.fail("home daydreams and the window portrait use no letters or font"); },
  };
}
function browser(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = { createElement() {
    const sprite = { width: 0, height: 0, pixels: [] };
    sprite.getContext = () => ({ fillStyle: "#000000", fillRect(...rectangle) { sprite.pixels.push([this.fillStyle, ...rectangle]); } });
    return sprite;
  } };
  try { run(); } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
}

test("each home has two quiet occupational motifs and Pleska's fish have eyes instead of sleep letters", () => {
  const silhouettes = [];
  for (const id of ["plesk", "builder", "lopukh", "kamneshmyg", "leaftail"]) {
    const frame = { id, position: { x: 50, y: 60 }, size: 44, elapsed: 2 }, before = structuredClone(frame), ctx = context();
    drawHome(ctx, frame, false);
    assert.deepEqual(frame, before); assert.equal(ctx.globalAlpha, .6); assert.equal(ctx.imageSmoothingEnabled, true);
    assert.equal(residentHomeParticles(frame, false).length, 2);
    assert.ok(ctx.paints.length > 30 && ctx.paints.length < 110, "bounded, tiny source-pixel icons");
    assert.ok(ctx.paints.every(paint => paint.alpha >= 0 && paint.alpha <= .6));
    silhouettes.push(JSON.stringify(ctx.paints));
    if (id === "plesk") assert.equal(ctx.paints.filter(paint => paint.color === "#355c66").length, 2, "both fish have a readable dark eye");
  }
  assert.equal(new Set(silhouettes).size, 5);
});

test("indoor particles share scene time, rise within the doorway envelope and freeze for reduced motion", () => {
  const frame = { id: "plesk", position: { x: 50, y: 60 }, size: 44, elapsed: 0 };
  for (let elapsed = -4; elapsed < 30; elapsed += .1) for (const particle of residentHomeParticles({ ...frame, elapsed }, false)) {
    assert.ok(particle.y <= 38.01 && particle.y >= 25.67);
    assert.ok(Math.abs(particle.x - 50) < 7); assert.ok(particle.opacity >= 0 && particle.opacity <= .78);
  }
  assert.deepEqual(residentHomeParticles(frame, true), residentHomeParticles({ ...frame, elapsed: 2000 }, true));
  for (const invalid of [{ size: 0 }, { elapsed: NaN }, { position: { x: Infinity, y: 60 } }]) {
    const ctx = context(); drawHome(ctx, { ...frame, ...invalid }, false); assert.deepEqual(ctx.paints, []);
  }
});

test("the merchant occupies only the real round window and uses his same face, blink and greeting sprite", () => browser(() => {
  const site = TILED_WORLD.sites.find(site => site.id === "leaftail-caravan"), frame = windowFrame(TILED_WORLD, .2, true), ctx = context();
  assert.ok(frame); assert.ok(frame.position.x > site.bounds.x && frame.position.x < site.bounds.x + site.bounds.width);
  assert.ok(frame.width < site.bounds.width * .06 && frame.height < site.bounds.height * .1);
  const before = structuredClone(frame); drawWindow(ctx, frame, false);
  assert.deepEqual(frame, before); assert.equal(ctx.images.length, 1); assert.equal(ctx.clips.length, 1);
  assert.deepEqual(ctx.clips[0].slice(0, 4), [frame.position.x, frame.position.y, frame.width / 2, frame.height / 2]);
  const [sprite, sx, sy, sw, sh] = ctx.images[0];
  assert.equal(sprite.width, 48); assert.equal(sprite.height, 48);
  assert.ok(sprite.pixels.some(([color]) => color === "#352e24"), "the resident's actual dark eyes and nose");
  assert.ok(sw < 48 && sh < 48 && sx > 0 && sy > 0, "only the head, upper scarf and little paw can enter the clip");
  assert.equal(ctx.globalAlpha, .6); assert.equal(ctx.imageSmoothingEnabled, true);
  const stillA = context(), stillB = context(); drawWindow(stillA, frame, true); drawWindow(stillB, { ...frame, elapsed: 80 }, true);
  assert.deepEqual(stillA.images[0], stillB.images[0]); assert.deepEqual(stillA.paints, stillB.paints);
  assert.equal(windowFrame({ sites: [] }, 0), null);
  assert.equal(windowFrame({ sites: [{ ...site, imagePlacement: { ...site.bounds, rotation: 30 } }] }, 0), null,
    "unsupported rotated artwork must not put a face on the roof");
}));

test("only a completed unload records one cosmetic delivery, never an early or repeated reward", () => {
  const mind = { id: "lopukh", action: "unload", age: .5, socialNeed: .2, position: { x: 70, y: 80 }, target: null,
    intent: "home", route: null, noticePending: false, job: true, workNeed: .3, fatigue: .2, elapsed: 1,
    woodwork: { phase: "unload", elapsed: .5, failures: 0, retryAt: 0, completedCycles: 0, chopSeconds: 8 } };
  const { scene, places } = deliveryGround();
  advanceWoodcutterCycle(mind, scene, places, .5, []); assert.equal(mind.woodwork.lastDelivery, undefined);
  advanceWoodcutterCycle(mind, scene, places, .1, []);
  assert.deepEqual(mind.woodwork.lastDelivery, { position: { x: 70, y: 80 }, sequence: 1 }); assert.equal(mind.action, "rest");
  const delivery = structuredClone(mind.woodwork.lastDelivery);
  mind.position.x += 1; advanceWoodcutterCycle(mind, scene, places, .2, []);
  assert.deepEqual(mind.woodwork.lastDelivery, delivery, "rest and later movement cannot repeat or drag the delivered log");
  assert.equal(mind.job, true); assert.equal(mind.woodwork.completedCycles, 0);
});

test("the visible woodpile stays at delivered feet, is bounded to three logs and cannot mutate work", () => {
  const frame = { position: { x: 70, y: 80 }, deliveries: 3, size: 44 }, before = structuredClone(frame);
  const first = context(), later = context(); drawPile(first, frame); drawPile(later, { ...frame, deliveries: 1000 });
  assert.deepEqual(first.paints, later.paints); assert.equal(first.paints.length, 15);
  assert.deepEqual(frame, before); assert.equal(first.globalAlpha, .6);
  const empty = context(); drawPile(empty, { ...frame, deliveries: 0 }); assert.deepEqual(empty.paints, []);
});

test("a scene handoff preserves delivered logs without sharing their mutable position with the previous owner", () => {
  const previous = createForestVillagers(TILED_WORLD), delivery = { position: { x: 70, y: 80 }, sequence: 2 };
  previous.residents.lopukh.woodwork.lastDelivery = delivery;
  previous.residents.lopukh.woodwork.deliveries = [{ position: { x: 50, y: 60 }, sequence: 1 }, delivery];
  const next = rehydrateForestVillagers(TILED_WORLD, previous);
  assert.deepEqual(next.residents.lopukh.woodwork.lastDelivery, delivery);
  assert.notEqual(next.residents.lopukh.woodwork.lastDelivery, delivery);
  next.residents.lopukh.woodwork.lastDelivery.position.x += 1;
  assert.deepEqual(delivery.position, { x: 70, y: 80 });
  assert.deepEqual(next.residents.lopukh.woodwork.deliveries, previous.residents.lopukh.woodwork.deliveries);
  for (const [index, log] of next.residents.lopukh.woodwork.deliveries.entries()) {
    assert.notEqual(log, previous.residents.lopukh.woodwork.deliveries[index]);
    log.position.x += 10;
  }
  assert.deepEqual(previous.residents.lopukh.woodwork.deliveries.map(log => log.position), [{ x: 50, y: 60 }, { x: 70, y: 80 }]);
});

test("successful unload history retains the last three original drops and never drags earlier logs", () => {
  const { scene, places } = deliveryGround();
  const mind = { id: "lopukh", action: "unload", age: .5, socialNeed: .2, position: { x: 70, y: 80 }, target: null,
    intent: "home", route: null, noticePending: false, job: true, workNeed: .3, fatigue: .2, elapsed: 1,
    woodwork: { phase: "unload", elapsed: 1, failures: 0, retryAt: 0, completedCycles: 0, chopSeconds: 8 } };
  for (let index = 0; index < 4; index++) {
    mind.position = { x: 70 + index * 20, y: 80 + index * 5 };
    mind.woodwork.phase = "unload"; mind.woodwork.elapsed = 1;
    advanceWoodcutterCycle(mind, scene, places, .1, []);
    assert.equal(mind.woodwork.lastDelivery.sequence, index + 1);
    assert.ok(mind.woodwork.deliveries.length <= 3);
    for (const delivery of mind.woodwork.deliveries) assert.deepEqual(delivery.position,
      { x: 70 + (delivery.sequence - 1) * 20, y: 80 + (delivery.sequence - 1) * 5 });
  }
  assert.deepEqual(mind.woodwork.deliveries.map(delivery => delivery.sequence), [2, 3, 4]);
});

test("presentation stacks only drops at the same actual position without moving any surviving log", () => {
  const position = { x: 70, y: 80 }, elsewhere = { x: 90, y: 85 };
  const woodwork = { lastDelivery: { position, sequence: 3 }, deliveries: [
    { position, sequence: 1 }, { position: elsewhere, sequence: 2 }, { position: { ...position }, sequence: 3 }] };
  const state = { elapsed: 0, pleskMind: null, social: { current: null }, villagers: { residents: { lopukh: { woodwork } } } };
  const before = structuredClone(woodwork), { woodpiles } = residentScenePresentation(state, { sites: [] });
  assert.deepEqual(woodpiles, [{ position, deliveries: 2 }, { position: elsewhere, deliveries: 1 }]);
  woodpiles[0].position.x += 1; assert.deepEqual(woodwork, before, "the painter cannot alter a delivery by moving its frame");
});
