import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createForestPerformanceProfiler: create, FOREST_PERFORMANCE_STAGES: stages,
  FOREST_PERFORMANCE_LIMITS: limits } = await vite.ssrLoadModule("/features/world/dev/forest-performance-profiler.ts");

test("disabled and production profilers read no clock or memory, including stale tokens and manual refresh", () => {
  for (const allowed of [false, true]) {
    let clocks = 0, memories = 0;
    const profiler = create({ allowed, now() { clocks++; return 0; }, memory() { memories++; return {}; } });
    const off = () => { profiler.begin("ai"); profiler.end(null); profiler.refreshMemory(); profiler.flush(); profiler.getSnapshot(); };
    off(); assert.equal(clocks, 0); assert.equal(memories, 0);
    profiler.setEnabled(true);
    if (allowed) {
      const token = profiler.begin("ai"); assert.equal(clocks, 1);
      profiler.setEnabled(false); profiler.end(token); assert.equal(clocks, 1);
    } else { off(); assert.equal(profiler.isEnabled(), false); assert.equal(clocks, 0); }
    profiler.setEnabled(false); profiler.reset();
    const before = clocks; off(); assert.equal(clocks, before); assert.equal(memories, 0);
  }
});

test("recent bounded timings report arithmetic average, nearest-rank p95 and maximum without estimating FPS", () => {
  let now = 0; const profiler = create({ allowed: true, now: () => now }); profiler.setEnabled(true);
  for (let duration = 1; duration <= 260; duration++) { const token = profiler.begin("render"); now += duration; profiler.end(token); }
  profiler.flush();
  assert.deepEqual(profiler.getSnapshot().summaries, [{ stage: "render", source: "world", count: 240,
    averageMs: 140.5, p95Ms: 248, maxMs: 260 }]);
  assert.ok(Object.isFrozen(profiler.getSnapshot())); assert.ok(Object.isFrozen(profiler.getSnapshot().summaries[0]));
  const stopped = profiler.getSnapshot(); profiler.setEnabled(false); now += 100000;
  profiler.end(profiler.begin("render"));
  assert.deepEqual(profiler.getSnapshot().summaries, stopped.summaries, "disabled time is never a sample or a catch-up duration");
});

test("nested path and water timings inherit the active world's source and remain separate overlapping measurements", () => {
  let now = 0; const profiler = create({ allowed: true, now: () => now }); profiler.setEnabled(true);
  const ai = profiler.begin("ai", "rehearsal"); now = 2;
  const nav = profiler.begin("navigation"); now = 5; profiler.end(nav); now = 7; profiler.end(ai);
  const render = profiler.begin("render", "world"), water = profiler.begin("water"); now = 9;
  profiler.end(water); now = 10; profiler.end(render); profiler.flush();
  const rows = profiler.getSnapshot().summaries;
  assert.equal(rows.find(row => row.stage === "ai").averageMs, 7);
  assert.equal(rows.find(row => row.stage === "navigation").source, "rehearsal");
  assert.equal(rows.find(row => row.stage === "navigation").averageMs, 3);
  assert.equal(rows.find(row => row.stage === "water").source, "world");
  assert.equal(rows.find(row => row.stage === "render").averageMs, 3);
});

test("arbitrary source labels, excessive unfinished calls and stale reset tokens cannot grow memory or inject rows", () => {
  let now = 0, reads = 0; const profiler = create({ allowed: true, now() { reads++; return now; } }); profiler.setEnabled(true);
  for (let index = 0; index < 1000; index++) {
    const token = profiler.begin(stages[index % stages.length], index % 2 ? "rehearsal" : `account-${index}`);
    now++; profiler.end(token);
  }
  const pending = Array.from({ length: limits.pending }, () => profiler.begin("render"));
  const before = reads; assert.equal(profiler.begin("render"), null); assert.equal(reads, before);
  assert.equal(profiler.begin("unbounded-custom-stage"), null);
  profiler.flush(); assert.ok(profiler.getSnapshot().summaries.length <= stages.length * 2);
  assert.ok(profiler.getSnapshot().summaries.every(row => ["world", "rehearsal"].includes(row.source) && row.count <= 240));
  profiler.reset(); const afterReset = reads;
  for (const token of pending) profiler.end(token);
  assert.equal(reads, afterReset); assert.deepEqual(profiler.getSnapshot().summaries, []);
  const token = profiler.begin("ai"); now++; profiler.end({ ...token }); profiler.end(token); profiler.end(token);
  profiler.flush(); assert.equal(profiler.getSnapshot().summaries[0].count, 1, "only the live exact token records one sample");
});

test("the subscriber snapshot is throttled without a timer and can be flushed after a finite benchmark", () => {
  let now = 0, updates = 0; const profiler = create({ allowed: true, now: () => now });
  const unsubscribe = profiler.subscribe(() => updates++); profiler.setEnabled(true);
  for (let index = 0; index < 100; index++) { const token = profiler.begin("ai"); now++; profiler.end(token); }
  assert.equal(updates, 2, "enable plus first data sample; no per-call React updates");
  profiler.flush(); assert.equal(profiler.getSnapshot().summaries[0].count, 100); assert.equal(updates, 3);
  unsubscribe(); profiler.setEnabled(false); assert.equal(updates, 3);
});

test("memory is read only on enabled manual request and represents actual supported JS heap fields", () => {
  let value, reads = 0;
  const profiler = create({ allowed: true, now: () => 0, memory() { reads++; return value; } });
  profiler.refreshMemory(); assert.equal(reads, 0); profiler.setEnabled(true); assert.equal(reads, 0);
  profiler.refreshMemory(); assert.equal(profiler.getSnapshot().memoryStatus, "unavailable");
  value = { usedJSHeapSize: 12_000, totalJSHeapSize: 16_000, jsHeapSizeLimit: 24_000 };
  profiler.refreshMemory(); assert.deepEqual(profiler.getSnapshot().memory, { usedBytes: 12_000, allocatedBytes: 16_000, limitBytes: 24_000 });
  value = { usedJSHeapSize: NaN }; profiler.refreshMemory(); assert.equal(profiler.getSnapshot().memory, null);
  value = { usedJSHeapSize: 12_000, totalJSHeapSize: 1, jsHeapSizeLimit: Infinity };
  profiler.refreshMemory(); assert.deepEqual(profiler.getSnapshot().memory, { usedBytes: 12_000 });
  profiler.setEnabled(false); const before = reads; profiler.refreshMemory(); assert.equal(reads, before);
});

test("unsupported or failing clocks and memory APIs never break scene execution", () => {
  const profiler = create({ allowed: true, now() { throw Error("unsupported"); }, memory() { throw Error("unsupported"); } });
  profiler.setEnabled(true); assert.equal(profiler.begin("ai"), null);
  assert.doesNotThrow(() => profiler.refreshMemory()); assert.equal(profiler.getSnapshot().memoryStatus, "unavailable");
  let now = 10; const backwards = create({ allowed: true, now: () => now }); backwards.setEnabled(true);
  const token = backwards.begin("ai"); now = 9; backwards.end(token); backwards.flush();
  assert.deepEqual(backwards.getSnapshot().summaries, []);
  let time = 0; const detached = create({ allowed: true, now: () => time });
  detached.subscribe(() => { throw Error("closed DEV view"); });
  assert.doesNotThrow(() => detached.setEnabled(true));
  const sample = detached.begin("ai"); time++;
  assert.doesNotThrow(() => detached.end(sample)); assert.equal(detached.getSnapshot().summaries[0].count, 1);
});
