import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { tapOrbitReading, advanceTapOrbit } = await vite.ssrLoadModule("/features/game/tap-boost-orbit-model.ts");
const { TapBoostOrbit } = await vite.ssrLoadModule("/features/game/tap-boost-orbit.tsx");
const start = Date.parse("2026-11-01T12:00:00Z"), iso = ms => new Date(ms).toISOString();
const snapshot = (powerBps = 1000, charge = 200, patch = {}) => ({
  jobs: [{ id: "mine", actorId: "miner", kind: "exploration", finishesAt: iso(start + 100_000), targetId: "stone" }],
  catalog: { buildings: [] }, tapBoost: { jobId: "mine", charge, powerBps, grantedAt: iso(start), expiresAt: iso(start + 60_000) }, ...patch,
});
const reading = (state = snapshot(), now = start, owner = "owner:0") => tapOrbitReading(state, now, owner);

test("orbit arc represents remaining time independently of power and never invents idle charge", () => {
  assert.equal(reading().remainingRatio, 1);
  assert.equal(reading(snapshot(2000), start + 30_000).remainingRatio, .5);
  assert.equal(reading(snapshot(2000), start + 30_000).powerPercent, 20);
  assert.equal(reading(snapshot(), start + 60_000).remainingRatio, 0);
  assert.equal(reading(snapshot(), start + 60_000).powerPercent, 0);
  const idle = reading(snapshot(2000, 1000, { jobs: [] }));
  assert.equal(idle.active, false);
  assert.equal(idle.remainingRatio, 0);
  const markup = renderToStaticMarkup(createElement(TapBoostOrbit, { snapshot: snapshot(), now: start + 30_000, ownerKey: "owner:0", tapSignal: 200, active: true }));
  assert.match(markup, /data-power="10"/);
  assert.match(markup, /stroke-dashoffset="50"/);
  assert.equal((markup.match(/<i /g) ?? []).length, 5, "bounded embers regardless of tap count");
  assert.match(markup, /role="status"/);
});

test("milestones require local input and only cross once; restored snapshots and owner switches stay quiet", () => {
  let result = advanceTapOrbit(null, reading(snapshot(2000, 1000)), true);
  assert.equal(result.event, null);
  assert.equal(advanceTapOrbit(result.memory, reading(snapshot(2000, 1000)), true).event, null);
  let memory = advanceTapOrbit(null, reading(snapshot(100, 1)), false).memory;
  result = advanceTapOrbit(memory, reading(snapshot(500, 51)), true);
  assert.deepEqual(result.event, { kind: "milestone", powerPercent: 5 });
  assert.equal(advanceTapOrbit(result.memory, reading(snapshot(500, 51)), true).event, null);
  memory = advanceTapOrbit(result.memory, reading(snapshot(1500, 400)), false).memory;
  assert.equal(advanceTapOrbit(memory, reading(snapshot(1500, 400)), true).event, null, "polling cannot replay a consumed step");
  assert.equal(advanceTapOrbit(memory, reading(snapshot(2000, 1000), start, "other:0"), true).event, null);
  result = advanceTapOrbit(memory, reading(snapshot(2000, 1000)), true);
  assert.deepEqual(result.event, { kind: "milestone", powerPercent: 20 });
});

test("new charge after expiry can celebrate again without carrying prior boost steps", () => {
  const before = advanceTapOrbit(null, reading(snapshot(2000, 1000)), false).memory;
  const next = snapshot(500, 51);
  next.tapBoost.grantedAt = iso(start + 70_000);
  next.tapBoost.expiresAt = iso(start + 130_000);
  assert.deepEqual(advanceTapOrbit(before, reading(next, start + 70_000), true).event, { kind: "milestone", powerPercent: 5 });
});

test("completion is an observed job clock crossing, never mount, cancellation or stale polling", () => {
  const before = advanceTapOrbit(null, reading(snapshot(), start + 99_000), false).memory;
  const result = advanceTapOrbit(before, reading(snapshot(), start + 100_000), false);
  assert.deepEqual(result.event, { kind: "complete", targetName: "Каменоломня" });
  assert.equal(advanceTapOrbit(result.memory, reading(snapshot(), start + 120_000), false).event, null);
  assert.equal(advanceTapOrbit(null, reading(snapshot(), start + 120_000), false).event, null);
  assert.equal(advanceTapOrbit(before, reading(snapshot(1000, 200, { jobs: [] }), start + 100_000), false).event, null);
});
