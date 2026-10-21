import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { worldFrameDue } = await vite.ssrLoadModule("/features/world/scene/frame-timing.ts");

function presentationTimes(refreshRate, timestamp = value => value) {
  let previous = 0;
  const presented = [];
  for (let frame = 1; frame <= refreshRate * 10; frame++) {
    const now = timestamp(frame * 1000 / refreshRate, frame);
    if (worldFrameDue(now, previous)) { presented.push(now); previous = now; }
  }
  return presented;
}

test("30Hz animation no longer falls to 20Hz on ideal 60Hz RAF timestamps", () => {
  const presented = presentationTimes(60);
  assert.equal(presented.length, 300);
  for (let index = 1; index < presented.length; index++) assert.ok(Math.abs(presented[index] - presented[index - 1] - 1000 / 30) < 1e-8);
});

test("common refresh rates retain bounded cadence with fractional, rounded and lightly jittered clocks", () => {
  for (const refreshRate of [60, 90, 120, 144, 240]) {
    const expected = refreshRate === 144 ? 288 : 300;
    for (const [kind, timestamp] of [["fractional", value => value], ["rounded", value => Math.round(value)],
      ["jittered", (value, frame) => value + (frame % 3 - 1) * .12]]) {
      const presented = presentationTimes(refreshRate, timestamp);
      assert.ok(Math.abs(presented.length - expected) <= 1, `${refreshRate}Hz ${kind}: ${presented.length} paints per ten seconds`);
      for (let index = 1; index < presented.length; index++) assert.ok(presented[index] - presented[index - 1] >= 1000 / 30 - .50000001,
        `${refreshRate}Hz ${kind} cannot turn animation into unbounded refresh-rate painting`);
    }
  }
});

test("half-millisecond tolerance accepts quantized boundaries without advancing clocks or catching up", () => {
  const previous = 1000, boundary = previous + 1000 / 30 - .5;
  assert.equal(worldFrameDue(boundary - .001, previous), false);
  assert.equal(worldFrameDue(boundary + .001, previous), true);
  assert.equal(worldFrameDue(previous + 33, previous), true, "a whole-millisecond clock keeps its second 60Hz frame");
  assert.equal(worldFrameDue(previous + 16.7, previous), false);
  assert.equal(worldFrameDue(previous - 1, previous), false);
  const resumedAt = previous + 5000;
  assert.equal(worldFrameDue(resumedAt, previous), true);
  assert.equal(worldFrameDue(resumedAt, resumedAt), false, "one delayed RAF cannot request another update at the same timestamp");
  assert.equal(worldFrameDue(resumedAt + 16.7, resumedAt), false, "the next frame uses the actual presentation timestamp");
  assert.equal(previous, 1000, "timing eligibility never changes simulation timestamps or computes its delta");
});
