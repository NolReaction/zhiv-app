import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createTradeShipPreviewArtwork } = await vite.ssrLoadModule("/features/world/dev/trade-ship-preview-artwork.ts");
const { createWorldDevStore } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");
const { TRADE_SHIP_GANGWAY, TRADE_SHIP_VOYAGE } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("world ship artwork loads only on demand and does not restore a stale enabled generation", async () => {
  const requests = [], changes = [], errors = [];
  const artwork = createTradeShipPreviewArtwork(() => {
    const request = deferred(); requests.push(request); return request.promise;
  }, () => changes.push(artwork.getImage()), () => errors.push(true));
  assert.equal(artwork.getImage(), null);
  artwork.setEnabled(false); await settle(); assert.equal(requests.length, 0);
  artwork.setEnabled(true); artwork.setEnabled(true); await settle(); assert.equal(requests.length, 1);
  artwork.setEnabled(false); artwork.setEnabled(true); await settle(); assert.equal(requests.length, 2);
  requests[0].resolve({ id: "stale" }); await settle();
  assert.equal(artwork.getImage(), null); assert.deepEqual(changes, []);
  const current = { id: "current" };
  requests[1].resolve(current); await settle();
  assert.equal(artwork.getImage(), current); assert.deepEqual(changes, [current]);
  artwork.setEnabled(false); assert.equal(artwork.getImage(), null);
  assert.deepEqual(errors, []);
});

test("optional ship image failures can be retried and disposal suppresses late callbacks", async () => {
  let request = deferred(), changes = 0, errors = 0;
  const artwork = createTradeShipPreviewArtwork(() => request.promise, () => changes++, () => errors++);
  artwork.setEnabled(true); await settle(); request.reject(new Error("network")); await settle();
  assert.equal(errors, 1); assert.equal(changes, 0); assert.equal(artwork.getImage(), null);
  artwork.setEnabled(false); request = deferred(); artwork.setEnabled(true); await settle();
  artwork.dispose(); request.resolve({ id: "after-unmount" }); await settle();
  assert.equal(artwork.getImage(), null); assert.equal(changes, 0); assert.equal(errors, 1);
  artwork.setEnabled(true); await settle(); assert.equal(artwork.getImage(), null);
});

test("ship preview is temporary, resettable and unavailable from a disabled DEV store", () => {
  const enabled = createWorldDevStore(true), production = createWorldDevStore(false);
  assert.equal(enabled.getSnapshot().tradeShipPreview, false);
  enabled.patch({ tradeShipPreview: true }); assert.equal(enabled.getSnapshot().tradeShipPreview, true);
  enabled.reset(); assert.equal(enabled.getSnapshot().tradeShipPreview, false);
  production.patch({ tradeShipPreview: true }); assert.equal(production.getSnapshot().tradeShipPreview, false);
});

test("in-game voyage commands share one clock, wait for PNG and never publish per-frame scene overrides", () => {
  const store = createWorldDevStore(true), phases = [];
  let changes = 0;
  store.subscribe(() => changes++);
  store.subscribeTradeShipPhase(() => phases.push(store.getTradeShipPhase()));
  store.triggerTradeShip("arrive");
  assert.equal(store.getSnapshot().tradeShipPreview, true);
  assert.equal(store.getSnapshot().cameraEvent.action, "ship");
  const start = store.getTradeShipMotion();
  store.advanceTradeShip(2, 100, false); assert.equal(store.getTradeShipMotion(), start, "loading cannot consume the visible voyage");
  store.advanceTradeShip(2, 100, true);
  assert.equal(store.getTradeShipMotion().elapsed, 2);
  store.advanceTradeShip(2, 100, true);
  assert.equal(store.getTradeShipMotion().elapsed, 2, "two views cannot advance the same RAF twice");
  assert.equal(changes, 1, "ordinary frames cannot re-enter scene configuration");
  store.triggerTradeShip("arrive");
  assert.equal(store.getTradeShipMotion().elapsed, 2, "repeated arrival preserves position and speed");
  store.advanceTradeShip(TRADE_SHIP_VOYAGE.arrivalDuration - 2, 200, true);
  assert.equal(store.getTradeShipPhase(), "deploying"); assert.equal(store.getTradeShipMotion().gangway, 0);
  const deploying = store.getTradeShipMotion();
  for (const command of ["arrive", "depart"]) {
    store.triggerTradeShip(command); assert.equal(store.getTradeShipMotion(), deploying);
  }
  store.advanceTradeShip(TRADE_SHIP_GANGWAY.deployDuration / 2, 210, true);
  assert.ok(Math.abs(store.getTradeShipMotion().gangway - .5) < 1e-8);
  store.advanceTradeShip(TRADE_SHIP_GANGWAY.deployDuration / 2, 220, true);
  assert.equal(store.getTradeShipPhase(), "docked");
  assert.equal(store.getTradeShipMotion().gangway, 1);
  store.triggerTradeShip("depart");
  assert.equal(store.getTradeShipPhase(), "retracting");
  const retracting = store.getTradeShipMotion();
  for (const command of ["arrive", "depart"]) {
    store.triggerTradeShip(command); assert.equal(store.getTradeShipMotion(), retracting);
  }
  store.advanceTradeShip(TRADE_SHIP_GANGWAY.retractDuration / 2, 230, true);
  assert.ok(Math.abs(store.getTradeShipMotion().gangway - .5) < 1e-8);
  assert.equal(store.getTradeShipMotion().x, retracting.x); assert.equal(store.getTradeShipMotion().y, retracting.y);
  store.advanceTradeShip(TRADE_SHIP_GANGWAY.retractDuration / 2, 300, true);
  assert.equal(store.getTradeShipPhase(), "departing"); assert.equal(store.getTradeShipMotion().gangway, 0);
  const departing = store.getTradeShipMotion();
  store.triggerTradeShip("depart"); assert.equal(store.getTradeShipMotion(), departing);
  store.patch({ paused: true }); store.advanceTradeShip(4, 400, true);
  assert.equal(store.getTradeShipMotion(), departing);
  store.patch({ paused: false }); store.advanceTradeShip(100, 500, true);
  assert.equal(store.getTradeShipPhase(), "departed"); assert.equal(store.getTradeShipMotion().visible, false);
  assert.deepEqual(phases, ["arriving", "deploying", "docked", "retracting", "departing", "departed"]);
  store.patch({ tradeShipPreview: false });
  assert.equal(store.getTradeShipPhase(), "docked");
  store.patch({ tradeShipPreview: true }); assert.equal(store.getTradeShipMotion().elapsed, 0);
  store.reset(); assert.equal(store.getSnapshot().tradeShipPreview, false);
});

test("disabled DEV cannot issue ship commands or advance a voyage", () => {
  const store = createWorldDevStore(false), initial = store.getTradeShipMotion();
  for (const command of ["arrive", "depart", "dock"]) store.triggerTradeShip(command);
  store.advanceTradeShip(20, 100, true); store.triggerCamera("ship");
  assert.equal(store.getTradeShipMotion(), initial);
  assert.equal(store.getSnapshot().tradeShipPreview, false);
  assert.equal(store.getSnapshot().cameraEvent, null);
});
