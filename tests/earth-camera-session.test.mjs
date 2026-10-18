import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({ appType: "custom", configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthCameraSession } = await vite.ssrLoadModule("/features/earth/camera-session.ts");
const { createEarthMapRetention, EARTH_MAP_RETENTION_MS } = await vite.ssrLoadModule("/features/app/earth-map-retention.ts");

const camera = () => ({ center: [37.617839123, 55.755812345], zoom: 13.718234, bearing: 31.512345, pitch: 48.28765 });

test("a ready camera survives game resource release and map-retention expiry exactly", () => {
  const controller = createEarthCameraSession("owner-a");
  const deactivate = controller.activate();
  const context = { owner: "owner-a", selected: true, available: true, documentHidden: false };
  let expire;
  const retention = createEarthMapRetention({ now: () => 0,
    setTimeout(callback, delay) { assert.equal(delay, EARTH_MAP_RETENTION_MS); expire = callback; return 1; }, clearTimeout() {} });
  const expected = camera();
  const preferences = { weatherEnabled: true, lightingMode: "evening", buildings3d: false, eveningCenter: { lng: 35, lat: 27 } };
  retention.setContext(context); retention.reportReady("owner-a", true);
  controller.session.save(expected);
  controller.session.savePreferences(preferences);
  retention.setContext({ ...context, available: false });
  assert.equal(retention.getSnapshot().mounted, false, "entering the game can still free Map/WebGL resources");
  assert.deepEqual(controller.session.read(), expected, "the game does not own the account's camera snapshot");
  assert.deepEqual(controller.session.readPreferences(), preferences, "the game does not reset an existing weather choice");
  retention.setContext(context); retention.reportReady("owner-a", true);
  retention.setContext({ ...context, selected: false }); expire();
  assert.equal(retention.getSnapshot().mounted, false);
  assert.deepEqual(controller.session.read(), expected, "retention bounds map resources, not this single tiny snapshot");
  assert.deepEqual(controller.session.readPreferences(), preferences);
  retention.setContext(context);
  assert.deepEqual(controller.session.read(), expected, "the next map can restore all camera components without rounding");
  retention.dispose(); deactivate();
});

test("map preferences survive resource teardown, are copied, and reset only with their account session", () => {
  const controller = createEarthCameraSession("owner-a"); const deactivate = controller.activate();
  const defaults = { weatherEnabled: false, lightingMode: "auto", buildings3d: true, eveningCenter: null };
  assert.deepEqual(controller.session.readPreferences(), defaults);
  const input = { weatherEnabled: true, lightingMode: "evening", buildings3d: false, eveningCenter: { lng: 35, lat: 27 } };
  const expected = { ...input, eveningCenter: { ...input.eveningCenter } };
  controller.session.savePreferences(input); input.weatherEnabled = false;
  input.eveningCenter.lng = 0;
  const restored = controller.session.readPreferences(); restored.lightingMode = "day"; restored.eveningCenter.lat = 0;
  assert.deepEqual(controller.session.readPreferences(), expected);
  for (const invalid of [null, {}, { ...expected, weatherEnabled: 1 },
    { ...expected, lightingMode: "night" }, { ...expected, buildings3d: "yes" },
    { ...expected, eveningCenter: undefined }, { ...expected, eveningCenter: {} },
    { ...expected, eveningCenter: { lng: NaN, lat: 27 } }, { ...expected, eveningCenter: { lng: 35, lat: 91 } },
    { ...expected, eveningCenter: { lng: 35, lat: Infinity } }]) {
    controller.session.savePreferences(invalid);
    assert.deepEqual(controller.session.readPreferences(), expected);
  }
  deactivate(); controller.session.savePreferences(expected);
  assert.deepEqual(controller.session.readPreferences(), defaults);
  const next = createEarthCameraSession("owner-b"); const deactivateNext = next.activate();
  assert.deepEqual(next.session.readPreferences(), defaults, "another account retains the default opt-in policy");
  const replayCleanup = controller.activate();
  assert.deepEqual(controller.session.readPreferences(), defaults);
  replayCleanup(); deactivateNext();
});

test("saved and restored snapshots are defensive copies and invalid cameras do not overwrite the last valid view", () => {
  const controller = createEarthCameraSession("owner-a");
  const deactivate = controller.activate();
  const expected = camera(); const input = camera();
  controller.session.save(input); input.center[0] = 0; input.zoom = 0;
  const restored = controller.session.read(); restored.center[1] = 0; restored.bearing = 0;
  assert.deepEqual(controller.session.read(), expected);
  for (const value of [null, {}, { ...camera(), center: [0, NaN] }, { ...camera(), center: [0, 91] },
    { ...camera(), center: [Infinity, 0] }, { ...camera(), center: [0, 0, 0] },
    { ...camera(), zoom: NaN }, { ...camera(), zoom: -1.51 }, { ...camera(), zoom: 18.01 },
    { ...camera(), bearing: Infinity }, { ...camera(), pitch: -1 }, { ...camera(), pitch: 61 }]) {
    controller.session.save(value);
    assert.deepEqual(controller.session.read(), expected);
  }
  const wrapped = { center: [540, -90], zoom: -1.5, bearing: 450, pitch: 60 };
  controller.session.save(wrapped);
  assert.deepEqual(controller.session.read(), wrapped, "finite wrapped camera angles remain exact");
  deactivate();
});

test("logout and owner replacement clear old snapshots and fence late saves without sharing account cameras", () => {
  const old = createEarthCameraSession("owner-a"); const deactivateOld = old.activate();
  old.session.save(camera()); deactivateOld(); old.session.save(camera());
  assert.equal(old.session.read(), null);
  const next = createEarthCameraSession("owner-b"); const deactivateNext = next.activate();
  assert.equal(next.session.read(), null);
  next.session.save({ ...camera(), zoom: 5 });
  old.session.save(camera());
  assert.equal(next.session.read().zoom, 5);
  assert.equal(old.session.read(), null);
  deactivateNext();
  const loggedOut = createEarthCameraSession(null); const deactivateLoggedOut = loggedOut.activate();
  loggedOut.session.save(camera()); assert.equal(loggedOut.session.read(), null); deactivateLoggedOut();
});

test("strict effect replay starts empty and a stale cleanup cannot erase a newer activation", () => {
  const controller = createEarthCameraSession("owner-a");
  controller.session.save(camera()); assert.equal(controller.session.read(), null);
  const first = controller.activate(); controller.session.save(camera()); first();
  const second = controller.activate();
  assert.equal(controller.session.read(), null);
  controller.session.save(camera()); first();
  assert.deepEqual(controller.session.read(), camera());
  const third = controller.activate(); second();
  assert.deepEqual(controller.session.read(), camera());
  third(); assert.equal(controller.session.read(), null);
});
