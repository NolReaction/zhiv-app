#!/usr/bin/env node
// Finite CPU comparison of the unchanged water-grid shader, not browser FPS.
// node scripts/benchmark-world-water-shading.mjs --baseline 7f04fd6
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--baseline")) throw Error("Only --baseline <git-ref> is supported.");
const baselineRef = args[1] ?? "7f04fd6";
if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(baselineRef)) throw Error("Invalid baseline git revision.");
const path = "features/world/environment/water/forest-water-dynamics-painter.ts";
const sources = {
  "virtual:water-before": execFileSync("git", ["show", `${baselineRef}:${path}`], { cwd: root, encoding: "utf8" }),
  "virtual:water-after": await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
};
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "node_modules/.vite-water-shading-benchmark",
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } },
  plugins: [{ name: "water-shading-comparison", resolveId(id) { if (id in sources) return `\0${id}`; },
    load(id) {
      if (!id.startsWith("\0virtual:water-")) return;
      // Expose just this private leaf for the comparison; production API stays unchanged.
      const code = sources[id.slice(1)].replaceAll('from "./', 'from "@/features/world/environment/water/');
      return ts.transpileModule(`${code}\nexport { surfaceTexture };`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
    } }], server: { middlewareMode: true, hmr: false, ws: false } });
const previousCanvas = globalThis.OffscreenCanvas;
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return {
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: pixels => { this.pixels = pixels.data; },
  }; }
};
function timeRun(shader, state, count = 480) {
  const start = performance.now();
  for (let frame = 0; frame < count; frame++) {
    state.revision++; state.elapsed = frame / 30;
    shader(state, (frame % 65) / 64);
  }
  return performance.now() - start;
}
try {
  const before = await vite.ssrLoadModule("virtual:water-before"), after = await vite.ssrLoadModule("virtual:water-after");
  const { createForestWaterDynamics, advanceForestWaterDynamics, disturbForestWater } = await vite.ssrLoadModule("/features/world/environment/water/forest-water-dynamics.ts");
  const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const state = createForestWaterDynamics(scene), untouched = state.active[0];
  const touch = { x: state.origin.x + (untouched % state.columns + .5) * state.cellSize,
    y: state.origin.y + (Math.floor(untouched / state.columns) + .5) * state.cellSize };
  let frames = 0, bytes = 0;
  for (let frame = 0; frame < 180; frame++) {
    if (frame % 30 === 0) disturbForestWater(state, touch, { strength: .9 });
    advanceForestWaterDynamics(state, 1 / 30, { rain: frame % 2 ? .68 : 0, wind: .45 });
    for (const dusk of [0, .5, 1]) {
      const first = before.surfaceTexture(state, dusk), second = after.surfaceTexture(state, dusk);
      assert.deepEqual(second.pixels, first.pixels, `exact RGBA at frame ${frame}, dusk ${dusk}`);
      frames++; bytes += second.pixels.length;
    }
  }
  // Alternate warmed implementations to reduce order/temperature bias. Canvas
  // uploads are no-ops; solver advancement stays outside these timed batches.
  timeRun(before.surfaceTexture, state, 120); timeRun(after.surfaceTexture, state, 120);
  const baseline = [], candidate = [];
  for (let run = 0; run < 9; run++) {
    if (run % 2) { candidate.push(timeRun(after.surfaceTexture, state)); baseline.push(timeRun(before.surfaceTexture, state)); }
    else { baseline.push(timeRun(before.surfaceTexture, state)); candidate.push(timeRun(after.surfaceTexture, state)); }
  }
  const summary = samples => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { samples: samples.length, framesPerBatch: 480, medianBatchMs: sorted[4], p95BatchMs: sorted.at(-1) };
  };
  console.log(JSON.stringify({ baselineRef, map: scene.id, columns: state.columns, rows: state.rows,
    activeCells: state.active.length, phaseCacheBytes: state.active.length * 16,
    exactRgbaFrames: frames, comparedBytes: bytes, before: summary(baseline), after: summary(candidate),
    scope: "Finite Node CPU batches on the actual Tiled water grid; no image/resolution/simulation changes. Does not measure browser FPS or physical device performance." }, null, 2));
} finally {
  if (previousCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previousCanvas;
  await vite.close();
}
