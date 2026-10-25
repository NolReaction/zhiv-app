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
