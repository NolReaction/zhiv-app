#!/usr/bin/env node
// Finite local CPU/allocation comparison, not a browser FPS or memory estimate.
// node scripts/benchmark-world-navigation.mjs --baseline 8f9cd9b
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--baseline")) throw Error("Only --baseline <git-ref> is supported.");
const baselineRef = args[1] ?? "8f9cd9b";
if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(baselineRef)) throw Error("Invalid baseline git revision.");
const source = execFileSync("git", ["show", `${baselineRef}:features/world/navigation/navigation.ts`], { cwd: root, encoding: "utf8" });
const baselineCode = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "node_modules/.vite-navigation-benchmark",
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } },
  plugins: [{ name: "navigation-comparison", resolveId(id) { if (id === "virtual:navigation-baseline") return "\0navigation-baseline"; },
    load(id) { if (id === "\0navigation-baseline") return baselineCode; } }],
  server: { middlewareMode: true, hmr: false, ws: false } });

function queriesFor(nav) {
  const points = [], { grid, cellSize } = nav;
  const every = Math.max(1, Math.ceil(nav.stats.walkableCells / 256)); let seen = 0;
  for (let id = 0; id < grid.walkable.length && points.length < 256; id++) if (grid.walkable[id] && seen++ % every === 0)
    points.push({ x: grid.origin.x + id % grid.columns * cellSize, y: grid.origin.y + Math.floor(id / grid.columns) * cellSize });
  return points.map((point, index) => [point, { x: point.x + (index % 2 ? 1.3 : -1.7), y: point.y + (index % 3 ? 1.1 : -1.4) }]);
}
function allocationRun(api, nav, queries) {
  const NativeSet = globalThis.Set; let allocations = 0;
  globalThis.Set = class extends NativeSet { constructor(...items) { super(...items); allocations++; } };
  try { return { results: queries.map(([a, b]) => api.canTraverse(nav, a, b)), allocations }; }
  finally { globalThis.Set = NativeSet; }
}
function timeRun(api, nav, queries) {
  const samples = [];
  for (let run = 0; run < 7; run++) {
    const start = performance.now();
    for (let round = 0; round < 8; round++) for (const [a, b] of queries) api.canTraverse(nav, a, b);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { batchCalls: queries.length * 8, samples: samples.length,
    averageBatchMs: samples.reduce((sum, value) => sum + value, 0) / samples.length, p95BatchMs: samples.at(-1) };
}

try {
  const old = await vite.ssrLoadModule("virtual:navigation-baseline"), current = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
  const scene = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const before = old.createWorldNavigation(scene, 5), after = current.createWorldNavigation(scene, 5);
  assert.ok(before && after, "the actual Tiled scene supports both independent navigation implementations");
  assert.deepEqual(before.grid.walkable, after.grid.walkable); assert.deepEqual(before.debug, after.debug);
  const queries = queriesFor(before), baseline = allocationRun(old, before, queries), candidate = allocationRun(current, after, queries);
  assert.deepEqual(candidate.results, baseline.results);
  const endpoints = queries.map(([point]) => point).filter((_, index) => index % 17 === 0).slice(0, 12);
  let found = 0;
  for (let index = 1; index < endpoints.length; index++) {
    const first = old.findWorldPath(before, endpoints[0], endpoints[index]);
    const second = current.findWorldPath(after, endpoints[0], endpoints[index]);
    assert.deepEqual(second, first); assert.deepEqual(after.stats.lastSearch, before.stats.lastSearch);
    if (first) found++;
  }
  // Repeat timings after paths warm both independent edge caches. Set counting
  // is off here, so the instrumented constructor cannot skew reported CPU time.
  const beforeTime = timeRun(old, before, queries), afterTime = timeRun(current, after, queries);
  console.log(JSON.stringify({ baselineRef, map: scene.id, radius: 5, queries: queries.length,
    equalMovementResults: true, equalGridAndGeometry: true, equalPathAndSearchStats: true, pathPairs: endpoints.length - 1, pathsFound: found,
    setsPerQueryBatch: { before: baseline.allocations, after: candidate.allocations,
      removed: baseline.allocations - candidate.allocations }, timing: { before: beforeTime, after: afterTime },
    scope: "Finite Node CPU batches on actual Tiled geometry; does not measure browser FPS, total game memory or device performance." }, null, 2));
} finally { await vite.close(); }
