import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEngineProfiler } = await vite.ssrLoadModule("/apps/engine/src/editor/diagnostics/engine-profiler.ts");
const { estimateCacheMemory, mergeCacheMemory } = await vite.ssrLoadModule("/packages/engine/src/rendering/cache-memory.ts");
const { createScenePainter } = await vite.ssrLoadModule("/packages/engine/src/rendering/renderer.ts");
const { EMPTY_TERRAIN_DEFINITION } = await vite.ssrLoadModule("/packages/engine/src/terrain/layout.ts");
const { SOLID_TERRAIN_PAINTER } = await vite.ssrLoadModule("/packages/engine/src/terrain/terrain.ts");
const { initialLighting } = await vite.ssrLoadModule("/packages/engine/src/lighting/lighting-data.ts");

test("disabled diagnostics invoke operations directly without clocks or samples", async () => {
  const profiler = createEngineProfiler({ clock() { throw new Error("disabled clock must never run"); } });
  const value = {}, promise = Promise.resolve(value);
  assert.equal(profiler.measure("paint", () => value), value);
  assert.equal(profiler.measureAsync("save", () => promise), promise);
  assert.equal(await promise, value);
  profiler.record("paint", 5);
  assert.deepEqual(profiler.snapshot().timings.paint, { count: 0, samples: 0, latestMs: null, medianMs: null, p95Ms: null });
  const failure = new Error("original error");
  assert.throws(() => profiler.measure("commit", () => { throw failure; }), error => error === failure);
});

test("timing windows are bounded and report latest, even median and nearest-rank p95 in milliseconds", () => {
  const profiler = createEngineProfiler({ capacity: 4, enabled: true });
  for (const value of [1000, 2, 20, 4, 10]) profiler.record("paint", value);
  assert.deepEqual(profiler.snapshot().timings.paint, { count: 5, samples: 4, latestMs: 10, medianMs: 7, p95Ms: 20 });
  for (const value of [-1, NaN, Infinity]) profiler.record("paint", value);
  profiler.record("unknown-operation", 50);
  assert.equal(profiler.snapshot().timings.paint.count, 5);
  const copy = profiler.snapshot(); copy.timings.paint.count = -1;
  assert.equal(profiler.snapshot().timings.paint.count, 5, "snapshots cannot mutate retained statistics");
  for (let index = 0; index < 10000; index++) profiler.record("commit", index);
  assert.equal(profiler.snapshot().timings.commit.samples, 4);
  assert.equal(profiler.snapshot().timings.commit.count, 10000);
  for (const capacity of [0, -1, 1.5, 2049]) assert.throws(() => createEngineProfiler({ capacity }), RangeError);
});

test("sync and async failures preserve operation outcomes and still measure completed work", async () => {
  let time = 10;
  const profiler = createEngineProfiler({ enabled: true, clock: () => time });
  assert.equal(profiler.measure("commit", () => { time += 7; return "done"; }), "done");
  const failure = new Error("quota exceeded");
  await assert.rejects(profiler.measureAsync("save", async () => { time += 23; throw failure; }), error => error === failure);
  assert.deepEqual(profiler.snapshot().timings.save, { count: 1, samples: 1, latestMs: 23, medianMs: 23, p95Ms: 23 });
  assert.throws(() => profiler.measure("undo", () => { time += 3; throw failure; }), error => error === failure);
  assert.equal(profiler.snapshot().timings.undo.latestMs, 3);
  assert.throws(() => profiler.measureAsync("export", () => { time += 9; throw failure; }), error => error === failure);
  assert.equal(profiler.snapshot().timings.export.latestMs, 9);
});

test("a reset or disable during an async operation cannot repopulate a later profiling session", async () => {
  let finish, time = 0;
  const profiler = createEngineProfiler({ enabled: true, clock: () => time });
  const pending = profiler.measureAsync("save", () => new Promise(resolve => { finish = resolve; }));
  profiler.reset(); time = 100; finish("saved"); assert.equal(await pending, "saved");
  assert.equal(profiler.snapshot().timings.save.count, 0);
  const next = profiler.measureAsync("save", () => new Promise(resolve => { finish = resolve; }));
  profiler.setEnabled(false); profiler.setEnabled(true); time = 200; finish("saved"); await next;
  assert.equal(profiler.snapshot().timings.save.count, 0);
  profiler.record("paint", 8); profiler.setEnabled(false);
  assert.equal(profiler.snapshot().timings.paint.latestMs, 8, "disabling retains the last deliberate measurements");
});

test("a missing or broken diagnostic clock never breaks scene operations", async () => {
  const profiler = createEngineProfiler({ enabled: true, clock() { throw new Error("unavailable clock"); } });
  assert.equal(profiler.measure("paint", () => 42), 42);
  assert.equal(await profiler.measureAsync("save", async () => 43), 43);
  assert.equal(profiler.snapshot().timings.paint.count, 0);
  let time = 100;
  const backwards = createEngineProfiler({ enabled: true, clock: () => time-- });
  backwards.measure("paint", () => 1); assert.equal(backwards.snapshot().timings.paint.count, 0);
});

test("memory groups deduplicate shared canvas/image identities and count byte buffers once", () => {
  const canvas = {}, image = {}, seen = new Set();
  const first = estimateCacheMemory({ sprites: [{ value: canvas, pixels: 100, kind: "canvas" }],
    casters: [{ value: canvas, pixels: 100, kind: "canvas" }] }, 13, seen);
  const second = estimateCacheMemory({ lighting: [{ value: canvas, pixels: 100, kind: "canvas" }],
    decoded: [{ value: image, pixels: 50, kind: "decoded-image" }, { value: image, pixels: 50, kind: "decoded-image" }] }, 7, seen);
  const total = mergeCacheMemory(first, second);
  assert.equal(total.canvasCount, 1); assert.equal(total.decodedImageCount, 1);
  assert.equal(total.canvasBytesEstimate, 400); assert.equal(total.decodedImageBytesEstimate, 200);
  assert.equal(total.retainedBufferBytes, 20); assert.equal(total.totalBytesEstimate, 620);
  assert.equal(total.groups.casters.bytesEstimate, 0); assert.equal(total.groups.lighting.bytesEstimate, 0);
  assert.equal(total.actualMemoryMeasured, false);
});

function context() {
  return new Proxy({}, {
    get(_, key) {
      if (key === "createRadialGradient" || key === "createLinearGradient") return () => ({ addColorStop() {} });
      if (key === "getImageData" || key === "createImageData") return (...args) => {
        const [width, height] = key === "getImageData" ? args.slice(2) : args;
        return { data: new Uint8ClampedArray(width * height * 4) };
      };
      return () => {};
    },
    set() { return true; },
  });
}
const object = (id, kind = "crate") => ({ id, kind, x: 55, y: 65, scale: 1, variant: 0 });
const options = overrides => ({ width: 128, height: 96, seed: 1, removed: new Set(), planted: [], ...overrides });
const plainPreset = catalog => ({ id: "diagnostic-example", catalog, terrain: EMPTY_TERRAIN_DEFINITION, terrainPainter: SOLID_TERRAIN_PAINTER });

test("renderer estimates include terrain workspaces, atlases, static surfaces and light buffers without caster-source duplication", () => {
  const allocated = [], factory = (width, height) => { const canvas = { width, height, getContext: () => context() }; allocated.push(canvas); return canvas; };
  const painter = createScenePainter(factory, plainPreset({
    crate: { bounds: { x: -10, y: -20, width: 20, height: 20 }, sprite: { bounds: { x: -10, y: -20, width: 20, height: 20 }, scale: 2 },
      shadowHeight: 20, draw() {}, contactShadow: { bounds: { x: -8, y: -4, width: 16, height: 8 }, scale: 2, draw() {} } },
    beacon: { bounds: { x: -4, y: -12, width: 8, height: 12 }, shadowHeight: 12, draw() {} },
  }));
  const lighting = { ...initialLighting(), enabled: true, points: [{ id: "lamp", name: "Lamp", x: 15, y: 60,
    radius: 160, intensity: 1, color: "#ffaa66", enabled: true }] };
  const state = options({ planted: [...Array.from({ length: 500 }, (_, index) => object(`item:${index}`)), object("beacon", "beacon")],
    terrain: { baseTrails: true, cells: { "1:1": "path" } }, lighting, interactiveCache: true, renderScale: 1 });
  painter.paint(context(), { x: 0, y: 0, width: 128, height: 96 }, state);
  const diagnostics = painter.diagnostics(), memory = diagnostics.memory;
  const pixels = allocated.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0);
  assert.equal(memory.canvasCount, allocated.length, "every first-frame retained surface is represented exactly once");
  assert.equal(memory.canvasPixels, pixels); assert.equal(memory.canvasBytesEstimate, pixels * 4);
  assert.equal(memory.retainedBufferBytes, diagnostics.lighting.rawBytes);
  assert.equal(memory.totalBytesEstimate, pixels * 4 + diagnostics.lighting.rawBytes);
  for (const group of ["terrainBase", "terrainMaterials", "terrainComposites", "terrainWorkspace", "sprites", "contactShadows", "casterArt", "staticWorld", "staticWorkspace", "lightingWorld", "lightingWorkspace", "lightingPointStamps"])
    assert.ok(memory.groups[group].bytesEstimate > 0, `${group} contributes a retained surface`);
  const before = allocated.length; painter.diagnostics(); assert.equal(allocated.length, before, "reading diagnostics never allocates a rendering surface");
  painter.dispose();
  assert.equal(painter.diagnostics().memory.totalBytesEstimate, 0);
  assert.equal(painter.diagnostics().sceneBuilds, diagnostics.sceneBuilds, "lifetime work counters survive disposal");
});

test("decoded source estimates follow retained identity, pending decode, failure and disposal", async () => {
  let complete;
  const image = { width: 64, height: 32 }, assets = ["a", "b"].map(id => ({ id, name: `${id}.png`, width: 64, height: 32, dataUrl: `data:image/png;base64,${id}` }));
  const painter = createScenePainter((width, height) => ({ width, height, getContext: () => context() }), plainPreset({}),
    undefined, () => new Promise(resolve => { complete = resolve; }));
  const first = painter.prepareAssets([assets[0]]); await Promise.resolve();
  assert.equal(painter.diagnostics().sourceCache.pending, 1); assert.equal(painter.diagnostics().memory.decodedImageCount, 0);
  complete(image); await first;
  const second = painter.prepareAssets([assets[1]]); await Promise.resolve(); complete(image); await second;
  const memory = painter.diagnostics().memory;
  assert.equal(painter.diagnostics().sourceCache.entries, 2);
  assert.equal(memory.decodedImageCount, 1); assert.equal(memory.decodedImageBytesEstimate, 64 * 32 * 4);
  painter.dispose(); assert.equal(painter.diagnostics().memory.totalBytesEstimate, 0);
  const failed = createScenePainter(() => { throw new Error("unexpected canvas"); }, plainPreset({}), undefined, async () => { throw new Error("broken PNG"); });
  await assert.rejects(failed.prepareAssets([assets[0]]), /broken PNG/);
  assert.equal(failed.diagnostics().memory.decodedImageBytesEstimate, 0); assert.equal(failed.diagnostics().sourceCache.pending, 0);
  failed.dispose();
});

test("decoded estimates drop evicted history resources while preserving the current scene source", async () => {
  const attempts = new Map(), assets = Array.from({ length: 5 }, (_, index) => ({ id: `image:${index}`, name: `${index}.png`,
    width: 4000, height: 4000, dataUrl: `data:image/png;base64,${index}` }));
  const painter = createScenePainter((width, height) => ({ width, height, getContext: () => context() }), plainPreset({}), undefined,
    async url => { attempts.set(url, (attempts.get(url) ?? 0) + 1); return { width: 4000, height: 4000 }; });
  await painter.prepareAssets([assets[0]]);
  painter.paint(context(), { x: 1000, y: 1000, width: 1, height: 1 }, options({ assets: new Map([[assets[0].id, assets[0]]]) }));
  for (const asset of assets.slice(1)) await painter.prepareAssets([asset]);
  const full = painter.diagnostics();
  assert.equal(full.sourceCache.entries, 4); assert.equal(full.memory.decodedImageCount, 4);
  assert.equal(full.memory.decodedImagePixels, full.sourceCache.pixelBudget);
  await painter.prepareAssets([assets[0]]);
  assert.equal(attempts.get(assets[0].dataUrl), 1, "diagnostic collection does not affect protection or cache eviction");
  await painter.prepareAssets([assets[1]]);
  assert.equal(attempts.get(assets[1].dataUrl), 2, "the evicted history source is restored explicitly");
  assert.equal(painter.diagnostics().memory.decodedImageCount, 4);
  painter.dispose(); assert.equal(painter.diagnostics().memory.decodedImageCount, 0);
});
