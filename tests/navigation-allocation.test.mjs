import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldNavigation, canTraverse, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { forestPerformanceProfiler: profiler } = await vite.ssrLoadModule("/features/world/dev/forest-performance-profiler.ts");
const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const fixture = (obstacles = []) => ({ actor: { size: 20 }, sites: [], navigation: { version: 1, cellSize: 8,
  areas: [{ points: rect(0, 0, 200, 200) }], obstacles } });

test("short checks in one spatial bucket need no duplicate set, while long queries preserve strict blocker semantics", () => {
  const nav = createWorldNavigation(fixture(), 2), blocked = createWorldNavigation(fixture([{ points: rect(90, 30, 1, 140) }]), 2);
  const NativeSet = globalThis.Set; let allocations = 0;
  globalThis.Set = class extends NativeSet { constructor(...args) { super(...args); allocations++; } };
  try {
    for (let index = 0; index < 100; index++) assert.equal(canTraverse(nav, { x: 50, y: 50 }, { x: 51, y: 51 }), true);
    assert.equal(allocations, 0, "one-bucket movement queries use the bucket's existing uniqueness");
    assert.equal(canTraverse(nav, { x: 10, y: 100 }, { x: 180, y: 100 }), true);
    assert.ok(allocations > 0, "multi-bucket sweeps still deduplicate shared edges");
    assert.equal(canTraverse(blocked, { x: 10, y: 100 }, { x: 180, y: 100 }), false, "a one-unit wall is never skipped");
  } finally { globalThis.Set = NativeSet; }
});

test("public path search instruments finite and rejected paths with inherited source and leaves disabled paths clock-free", () => {
  const nav = createWorldNavigation(fixture(), 2), descriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
  profiler.setEnabled(false); profiler.reset();
  Object.defineProperty(globalThis, "performance", { configurable: true, get() { assert.fail("a disabled path profiler must not read performance"); } });
  try { assert.deepEqual(findWorldPath(nav, { x: 20, y: 20 }, { x: 30, y: 30 }), [{ x: 20, y: 20 }, { x: 30, y: 30 }]); }
  finally { if (descriptor) Object.defineProperty(globalThis, "performance", descriptor); else delete globalThis.performance; }
  profiler.setEnabled(true);
  try {
    const parent = profiler.begin("ai", "rehearsal");
    assert.equal(findWorldPath(nav, { x: -1, y: 20 }, { x: 30, y: 30 }), null);
    profiler.end(parent); profiler.flush();
    const row = profiler.getSnapshot().summaries.find(row => row.stage === "navigation");
    assert.equal(row.count, 1); assert.equal(row.source, "rehearsal"); assert.ok(row.averageMs >= 0);
    assert.equal(nav.stats.lastSearch.reason, "invalid-endpoint");
  } finally { profiler.setEnabled(false); profiler.reset(); }
});
