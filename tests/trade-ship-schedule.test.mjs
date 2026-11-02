import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { tradeShipDepartureFrame } = await vite.ssrLoadModule("/features/world/scene/trade-ship-schedule.ts");
const { connectTradeShipArrival } = await vite.ssrLoadModule("/features/world/state/trade-ship-arrival.ts");
const { shipOrdersConfig } = await vite.ssrLoadModule("/features/economy/domain/ship-orders.ts");
const authority = owner => ({ ownerPublicId: owner, revision: 1, buildings: { lighthouse: 1 },
  production: { ownerPublicId: owner, revision: 1, jobs: [] } });

test("completion leaves immediately and reopening during cooldown never restarts the voyage", () => {
  const completion = Date.parse("2026-11-01T12:00:00Z");
  const ship = { voyage: null, completedVoyages: 1,
    nextAvailableAt: new Date(completion + shipOrdersConfig.intervalSeconds * 1000).toISOString() };
  const leaving = tradeShipDepartureFrame(ship, completion);
  assert.equal(leaving.motion.phase, "departing"); assert.equal(leaving.motion.elapsed, 0);
  const resumed = tradeShipDepartureFrame({ ...ship }, completion + 10_000);
  assert.equal(resumed.voyageId, leaving.voyageId);
  assert.equal(resumed.pending, false); assert.equal(resumed.motion.elapsed, 10);
  for (const seconds of [22, 300, 6 * 3600 - 1, 6 * 3600, 6 * 3600 + 1])
    assert.equal(tradeShipDepartureFrame(ship, completion + seconds * 1000), null);
  assert.equal(tradeShipDepartureFrame(ship, completion, true), null, "reduced motion leaves without animation");
  assert.equal(tradeShipDepartureFrame({ ...ship, voyage: { id: "new" } }, completion), null);
  assert.equal(tradeShipDepartureFrame(null, completion), null);
});

test("each server voyage gets one persisted arrival while tabs share its exact progress", () => {
  const owner = "ship-voyage-schedule-test";
  let current = connectTradeShipArrival(owner, () => {}, "voyage-one");
  current.configure(authority(owner)); assert.equal(current.getFrame().pending, true);
  current.start(true); assert.equal(current.getFrame().motion.phase, "docked");
  current.release();
  current = connectTradeShipArrival(owner, () => {}, "voyage-one");
  current.configure(authority(owner));
  assert.equal(current.getFrame().pending, false); assert.equal(current.getFrame().motion.phase, "docked");
  current.release();
  const next = connectTradeShipArrival(owner, () => {}, "voyage-two");
  next.configure(authority(owner)); assert.equal(next.getFrame().pending, true);
  next.start(); next.advance(.05, 100);
  const otherTab = connectTradeShipArrival(owner, () => {}, "voyage-two");
  assert.equal(otherTab.getFrame().pending, false);
  assert.equal(otherTab.getFrame().motion, next.getFrame().motion);
  next.release(); otherTab.release();
});


test("uncompleted automatic and paid departures animate without a completion count and never before their server time", () => {
  const departedAt = Date.parse("2026-11-02T12:00:00Z");
  const ship = { voyage: null, completedVoyages: 0, departureCargo: [0, .5, 0],
    nextAvailableAt: new Date(departedAt + shipOrdersConfig.intervalSeconds * 1000).toISOString() };
  assert.equal(tradeShipDepartureFrame(ship, departedAt - 1), null);
  assert.equal(tradeShipDepartureFrame(ship, departedAt).motion.elapsed, 0);
  assert.equal(tradeShipDepartureFrame(ship, departedAt + 22000), null);
});
