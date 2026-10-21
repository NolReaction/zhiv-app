import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A real filesystem boundary: there is no main game, demo, host editor, config,
 * public asset directory or @ alias available to the copied engine package. */
async function isolatedEngine(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "zhiv-engine-isolation-"));
  await cp(path.join(root, "packages/engine/src"), path.join(directory, "src"), { recursive: true });
  const vite = await createServer({ appType: "custom", configFile: false, root: directory,
    cacheDir: path.join(directory, ".vite"), server: { middlewareMode: true, hmr: false, ws: false } });
  t.after(async () => { await vite.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual((await readdir(directory)).filter(name => !name.startsWith(".")), ["src"]);
  return { vite, module: await vite.ssrLoadModule("/src/runtime.ts") };
}

function drawingContext(calls = []) {
  return new Proxy({}, {
    get: (_, key) => String(key).includes("Gradient") ? () => ({ addColorStop() {} })
      : key === "createImageData" || key === "getImageData" ? (...args) => {
        const [width, height] = key === "getImageData" ? args.slice(2) : args;
        return { width, height, data: new Uint8ClampedArray(width * height * 4) };
      }
        : (...args) => calls.push([key, ...args]),
    set: (_, key, value) => { calls.push(["set", key, value]); return true; },
  });
}

test("copied engine runs a custom content catalog with no game, demo, DOM or asset dependencies", async t => {
  const { module } = await isolatedEngine(t), { createScenePainter, EMPTY_TERRAIN_DEFINITION, SOLID_TERRAIN_PAINTER } = module;
  const drawn = [], generatedBounds = [], allocations = [];
  const preset = {
    id: "laboratory", terrain: EMPTY_TERRAIN_DEFINITION, terrainPainter: SOLID_TERRAIN_PAINTER,
    catalog: {
      beacon: { bounds: { x: -8, y: -20, width: 16, height: 20 }, draw(ctx, object) { drawn.push(object.id); ctx.fillRect(-8, -20, 16, 20); } },
      orb: { bounds: { x: -10, y: -10, width: 20, height: 20 }, draw(ctx, object) { drawn.push(object.id); ctx.arc(0, 0, 10, 0, Math.PI * 2); } },
    },
    generateObjects(seed, bounds) {
      generatedBounds.push({ ...bounds });
      return [{ id: "auto:beacon", kind: "beacon", x: bounds.width - 20, y: bounds.height - 20, scale: 1, variant: seed % 4 }];
    },
    initialObjects: () => [{ id: "fixed:beacon", kind: "beacon", x: 45, y: 50, scale: 1, variant: 0 }],
  };
  const factory = (width, height) => { const canvas = { width, height, getContext: () => drawingContext() }; allocations.push(canvas); return canvas; };
  const painter = createScenePainter(factory, preset);
  t.after(() => painter.dispose());
  const planted = [{ id: "placed:orb", kind: "orb", x: 130, y: 100, scale: 1.2, variant: 0 }];
  const options = { seed: 42, width: 317, height: 231, removed: new Set(), planted, grid: false };
  const first = painter.objects(options);
  assert.deepEqual(first.map(object => object.id).sort(), ["auto:beacon", "fixed:beacon", "placed:orb"]);
  assert.deepEqual(first.find(object => object.id === "auto:beacon"), { id: "auto:beacon", kind: "beacon", x: 297, y: 211, scale: 1, variant: 2 });
  assert.equal(allocations.length, 0, "object queries remain browser-free and do not allocate drawing surfaces");
  assert.deepEqual(painter.objects(options), first);
  painter.paint(drawingContext(), { x: 0, y: 0, width: 317, height: 231 }, options);
  assert.ok(drawn.includes("placed:orb") && drawn.includes("auto:beacon") && drawn.includes("fixed:beacon"), "all custom catalog drawings reach the renderer");
  const expanded = { ...options, width: 640, height: 2300 }, tall = painter.objects(expanded);
  assert.deepEqual(tall.find(object => object.id === "auto:beacon"), { id: "auto:beacon", kind: "beacon", x: 620, y: 2280, scale: 1, variant: 2 });
  assert.deepEqual(tall.find(object => object.id === "placed:orb"), planted[0], "expansion keeps authored records exact");
  drawn.length = 0;
  const calls = [];
  painter.paint(drawingContext(calls), { x: 585, y: 2220, width: 55, height: 80 }, expanded);
  assert.ok(drawn.includes("auto:beacon"), "the runtime renders beyond the forest demo's 1600-unit height");
  assert.ok(!drawn.includes("fixed:beacon") && !drawn.includes("placed:orb"), "culling respects the requested custom scene view");
  assert.ok(calls.some(call => call[0] === "drawImage"), "terrain is still painted in the tall custom scene");
  assert.ok(generatedBounds.some(bounds => bounds.width === 640 && bounds.height === 2300));
  assert.deepEqual(planted, options.planted, "the runtime does not mutate host object records");
  assert.ok(allocations.length > 0);
});

test("different runtime presets and scene sizes coexist without generating forest content or sharing catalogs", async t => {
  const { module } = await isolatedEngine(t), { createScenePainter, EMPTY_TERRAIN_DEFINITION, SOLID_TERRAIN_PAINTER } = module;
  const noCanvas = () => assert.fail("queries must not create a canvas");
  const preset = (id, kind, x) => ({ id, catalog: { [kind]: { bounds: { x: -3, y: -5, width: 6, height: 5 } } },
    terrain: EMPTY_TERRAIN_DEFINITION, terrainPainter: SOLID_TERRAIN_PAINTER,
    initialObjects: () => [{ id: `${id}:one`, kind, x, y: 40, scale: 1, variant: 0 }] });
  const first = createScenePainter(noCanvas, preset("industrial", "machine", 30));
  const second = createScenePainter(noCanvas, preset("astronomy", "telescope", 200));
  t.after(() => { first.dispose(); second.dispose(); });
  const options = { seed: 1, width: 480, height: 270, removed: new Set(), planted: [] };
  assert.deepEqual(first.objects(options).map(object => object.kind), ["machine"]);
  assert.deepEqual(second.objects({ ...options, width: 2048, height: 4096 }).map(object => object.kind), ["telescope"]);
  const moved = { id: "industrial:one", kind: "machine", x: 70, y: 50, scale: 1, variant: 0 };
  assert.deepEqual(first.objects({ ...options, modified: new Map([[moved.id, moved]]) }), [moved]);
  assert.equal(second.objects(options)[0].x, 200, "one painter's edits and bounds cannot alter another instance");
  assert.equal(first.objects({ ...options, removed: new Set([moved.id]) }).length, 0);
  assert.equal(second.objects(options).length, 1);
});

test("lighting buffers support a one-unit and odd-height custom scene with positive integer canvas allocations", async t => {
  const { module } = await isolatedEngine(t), { createScenePainter, EMPTY_TERRAIN_DEFINITION, SOLID_TERRAIN_PAINTER, initialLighting } = module;
  const allocations = [];
  const factory = (width, height) => {
    assert.ok(Number.isInteger(width) && width >= 1); assert.ok(Number.isInteger(height) && height >= 1);
    allocations.push({ width, height }); return { width, height, getContext: () => drawingContext() };
  };
  const painter = createScenePainter(factory, { id: "plain", catalog: {}, terrain: EMPTY_TERRAIN_DEFINITION, terrainPainter: SOLID_TERRAIN_PAINTER });
  t.after(() => painter.dispose());
  for (const size of [{ width: 3, height: 1 }, { width: 317, height: 231 }]) {
    const options = { ...size, seed: 1, removed: new Set(), planted: [], lighting: { ...initialLighting(), enabled: true, ambient: .5 } };
    painter.paint(drawingContext(), { x: 0, y: 0, ...size }, options);
    assert.equal(painter.objects(options).length, 0, "an empty host scene stays empty even with lighting enabled");
  }
  assert.ok(allocations.some(size => size.height === 1));
});

test("growing a custom scene rebuilds previously partial static rows before revealing new objects", async t => {
  const { module } = await isolatedEngine(t), { createScenePainter, EMPTY_TERRAIN_DEFINITION, SOLID_TERRAIN_PAINTER } = module;
  const painted = [], objects = [];
  for (const [row, y] of [["top", 15], ["bottom", 115]]) for (let index = 0; index < 600; index++)
    objects.push({ id: `${row}:${index}`, kind: "marker", x: 20 + (index % 30) * 25, y: y + Math.floor(index / 30) * 3, scale: 1, variant: 0 });
  const painter = createScenePainter((width, height) => ({ width, height, getContext: () => drawingContext() }), {
    id: "row-growth", terrain: EMPTY_TERRAIN_DEFINITION, terrainPainter: SOLID_TERRAIN_PAINTER,
    initialObjects: () => objects,
    catalog: { marker: { bounds: { x: -2, y: -2, width: 4, height: 4 }, draw(_, object) { painted.push(object.id); } } },
  });
  t.after(() => painter.dispose());
  const options = { seed: 1, width: 1200, height: 100, removed: new Set(), planted: [], interactiveCache: true, renderScale: 1 };
  painter.paint(drawingContext(), { x: 0, y: 0, width: 1200, height: 100 }, options);
  assert.ok(painted.includes("top:0"));
  const before = painter.diagnostics().staticTileBuilds;
  painted.length = 0;
  painter.paint(drawingContext(), { x: 0, y: 0, width: 1200, height: 200 }, { ...options, height: 200 });
  assert.ok(painted.includes("bottom:0"), "objects below the old clipped row must appear in the left tile, not only the width-edge tile");
  assert.ok(painter.diagnostics().staticTileBuilds >= before + 3, "all three partial static rows are repainted for their new height");
  const rebuilt = painter.diagnostics().staticTileBuilds;
  painter.paint(drawingContext(), { x: 0, y: 0, width: 1200, height: 200 }, { ...options, height: 200 });
  assert.equal(painter.diagnostics().staticTileBuilds, rebuilt, "an unchanged full row remains cached");
});

test("odd-sized lighting fields retain their fractional source extent instead of stretching the padded bitmap", async t => {
  const { module } = await isolatedEngine(t), { createScenePainter, EMPTY_TERRAIN_DEFINITION, SOLID_TERRAIN_PAINTER, initialLighting } = module;
  const painter = createScenePainter((width, height) => ({ width, height, getContext: () => drawingContext() }), {
    id: "odd-field", catalog: {}, terrain: EMPTY_TERRAIN_DEFINITION, terrainPainter: SOLID_TERRAIN_PAINTER,
  });
  t.after(() => painter.dispose());
  for (const size of [{ width: 311, height: 231 }, { width: 3, height: 1 }]) {
    const calls = [], options = { ...size, seed: 1, removed: new Set(), planted: [], lighting: { ...initialLighting(), enabled: true, ambient: .5 } };
    painter.paint(drawingContext(calls), { x: 0, y: 0, ...size }, options);
    const field = calls.filter(call => call[0] === "drawImage").at(-1);
    assert.equal(field[1].width, Math.ceil(size.width / 2)); assert.equal(field[1].height, Math.ceil(size.height / 2));
    assert.deepEqual(field.slice(2), [0, 0, size.width / 2, size.height / 2, 0, 0, size.width, size.height],
      "the source crop maps one light texel to two world units, preserving light positions at odd dimensions");
  }
});

test("standalone editor renders its own document controls and only host-provided navigation", async t => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "engine-host-ui-"));
  const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  t.after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
  const { ProceduralForestPreview } = await vite.ssrLoadModule("/apps/engine/src/editor/ui/procedural-forest-preview.tsx");
  const standalone = renderToStaticMarkup(createElement(ProceduralForestPreview));
  assert.doesNotMatch(standalone, /href="\/"|Вернуться в приложение|Вернуться в игру/);
  assert.match(standalone, /accept="[^\"]*\.json/);
  assert.match(standalone, /accept="image\/png/);
  assert.match(standalone, /Canvas|canvas/);
  const linked = renderToStaticMarkup(createElement(ProceduralForestPreview, { backLink: { href: "/host/projects", label: "Мои проекты" } }));
  assert.match(linked, /<a[^>]+href="\/host\/projects"/); assert.match(linked, /Мои проекты/);
  const callback = renderToStaticMarkup(createElement(ProceduralForestPreview, { onBack() {}, backLink: { href: "/never-navigate", label: "Закрыть панель" } }));
  assert.match(callback, /<button[^>]+(?:title|aria-label)="Закрыть панель"/);
  assert.doesNotMatch(callback, /href="\/never-navigate"/);
});
