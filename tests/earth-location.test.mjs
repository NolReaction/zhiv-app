import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthLocationController, readEarthPosition } = await vite.ssrLoadModule("/features/earth/location.ts");
after(() => vite.close());

function browser(overrides = {}) {
  let visible = true;
  const watches = [];
  const cleared = [];
  const visibilityListeners = new Set();
  const permissionListeners = new Set();
  const permission = {
    state: "prompt",
    subscribe(listener) {
      permissionListeners.add(listener);
      return () => permissionListeners.delete(listener);
    },
  };
  const environment = {
    secure: true,
    geolocation: {
      watchPosition(success, failure, options) { watches.push({ success, failure, options }); return watches.length - 1; },
      clearWatch(id) { cleared.push(id); },
    },
    visible: () => visible,
    onVisibilityChange(listener) {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    queryPermission: async () => permission,
    ...overrides,
  };
  return {
    environment, watches, cleared, visibilityListeners, permissionListeners, permission,
    setVisible(value) { visible = value; for (const listener of visibilityListeners) listener(); },
    setPermission(value) { permission.state = value; for (const listener of permissionListeners) listener(); },
  };
}

function session(options = {}) {
  const platform = browser(options);
  const controller = createEarthLocationController("owner-a", () => platform.environment);
  const deactivate = controller.activate();
  controller.setEnabled(true);
  return { ...platform, controller, deactivate };
}

function fix(values = {}) {
  return { coords: { latitude: 55.75, longitude: 37.61, accuracy: 30, ...values }, timestamp: values.timestamp ?? 1_000 };
}

test("screen activation never requests coordinates; an explicit start opens only one foreground watch", () => {
  const s = session();
  assert.deepEqual(s.controller.getSnapshot(), { position: null, status: "idle", error: null });
  s.setVisible(false); s.setVisible(true); s.controller.setEnabled(false); s.controller.setEnabled(true);
  assert.equal(s.watches.length, 0);
  s.controller.start(); s.controller.start();
  assert.equal(s.watches.length, 1);
  assert.equal(s.controller.getSnapshot().status, "requesting");
  assert.deepEqual(s.watches[0].options, { enableHighAccuracy: false, maximumAge: 15_000, timeout: 20_000 });
  s.watches[0].success(fix());
  assert.deepEqual(s.controller.getSnapshot(), {
    position: { latitude: 55.75, longitude: 37.61, accuracy: 30, timestamp: 1_000 }, status: "active", error: null,
  });
  s.deactivate();
});

test("hiding and disabling pause the watch; only a previously requested session can resume", () => {
  const s = session();
  s.controller.start(); s.watches[0].success(fix());
  s.setVisible(false);
  assert.deepEqual(s.cleared, [0]);
  assert.equal(s.controller.getSnapshot().status, "paused");
  assert.equal(s.controller.getSnapshot().position.timestamp, 1_000);
  s.watches[0].success(fix({ timestamp: 2_000 }));
  assert.equal(s.controller.getSnapshot().position.timestamp, 1_000);
  s.controller.setEnabled(false); s.setVisible(true);
  assert.equal(s.watches.length, 1);
  s.controller.setEnabled(true);
  assert.equal(s.watches.length, 2);
  s.watches[0].failure({ code: 1 });
  assert.equal(s.controller.getSnapshot().status, "requesting");
  s.watches[1].success(fix({ timestamp: 3_000 }));
  assert.equal(s.controller.getSnapshot().status, "active");
  s.controller.stop();
  assert.equal(s.controller.getSnapshot().position, null);
  s.controller.setEnabled(false); s.controller.setEnabled(true); s.setVisible(false); s.setVisible(true);
  assert.equal(s.watches.length, 2);
  s.deactivate();
});

test("stop and account replacement clear coordinates and reject late callbacks and old actions", () => {
  const s = session();
  s.controller.start(); s.watches[0].success(fix()); s.controller.stop();
  s.watches[0].success(fix({ timestamp: 2_000 })); s.watches[0].failure({ code: 1 });
  assert.equal(s.controller.getSnapshot().status, "idle");
  s.controller.start();
  s.deactivate();
  const next = createEarthLocationController("owner-b", () => s.environment);
  const deactivateNext = next.activate(); next.setEnabled(true);
  s.watches[1].success(fix()); s.controller.start();
  assert.equal(s.watches.length, 2);
  assert.equal(next.getSnapshot().position, null);
  assert.equal(s.controller.getSnapshot().position, null);
  next.start();
  assert.equal(s.watches.length, 3);
  deactivateNext();
  assert.equal(s.visibilityListeners.size, 0);
});

test("permission revocation wipes the fix and requires another explicit request even after re-grant", async () => {
  const s = session();
  s.permission.state = "granted";
  s.controller.start();
  await Promise.resolve();
  s.watches[0].success(fix());
  s.setPermission("denied");
  assert.equal(s.controller.getSnapshot().status, "denied");
  assert.equal(s.controller.getSnapshot().position, null);
  assert.deepEqual(s.cleared, [0]);
  assert.equal(s.permissionListeners.size, 0);
  s.setPermission("granted"); s.setVisible(false); s.setVisible(true);
  assert.equal(s.watches.length, 1);
  s.controller.start();
  await Promise.resolve();
  s.watches[1].success(fix()); s.setPermission("prompt");
  assert.equal(s.controller.getSnapshot().status, "denied");
  assert.equal(s.controller.getSnapshot().position, null);
  s.deactivate();
});

test("late permission promises cannot attach a listener or revive a stopped session", async () => {
  let resolve;
  const pending = new Promise(accept => { resolve = accept; });
  const s = session({ queryPermission: () => pending });
  s.controller.start(); s.controller.stop();
  resolve(s.permission);
  await Promise.resolve();
  assert.equal(s.permissionListeners.size, 0);
  assert.equal(s.controller.getSnapshot().status, "idle");
  s.deactivate();
});

test("a missing Permissions query does not block a valid location", async () => {
  const s = session({ queryPermission: () => Promise.reject(new Error("unsupported query")) });
  s.controller.start();
  await Promise.resolve(); await Promise.resolve();
  s.watches[0].success(fix());
  assert.equal(s.controller.getSnapshot().status, "active");
  s.deactivate();
});

test("insecure contexts and unsupported devices fail without opening a watch", () => {
  for (const [options, expected] of [[{ secure: false }, "insecure"], [{ geolocation: null }, "unsupported"]]) {
    const s = session(options); s.controller.start();
    assert.equal(s.controller.getSnapshot().status, expected);
    assert.ok(s.controller.getSnapshot().error);
    assert.equal(s.watches.length, 0);
    s.deactivate();
  }
});

test("denial timeout and unavailable errors terminate the watch and can be retried explicitly", () => {
  for (const [code, expected] of [[1, "denied"], [2, "unavailable"], [3, "timeout"]]) {
    const s = session(); s.controller.start(); s.watches[0].success(fix());
    s.watches[0].failure({ code });
    assert.equal(s.controller.getSnapshot().status, expected);
    assert.equal(s.controller.getSnapshot().position, null);
    assert.deepEqual(s.cleared, [0]);
    s.setVisible(false); s.setVisible(true);
    assert.equal(s.watches.length, 1);
    s.controller.start();
    assert.equal(s.watches.length, 2);
    s.watches[1].success(fix({ timestamp: 2_000 }));
    assert.equal(s.controller.getSnapshot().status, "active");
    s.deactivate();
  }
});

test("coordinates are finite bounded and chronological", () => {
  for (const values of [
    { latitude: NaN }, { latitude: 90.001 }, { latitude: -91 }, { longitude: Infinity },
    { longitude: 181 }, { longitude: -181 }, { accuracy: -1 }, { accuracy: Infinity },
    { timestamp: NaN }, { timestamp: -1 }, { latitude: "55" },
  ]) assert.equal(readEarthPosition(fix(values)), null);
  assert.deepEqual(readEarthPosition(fix({ latitude: -90, longitude: 180, accuracy: 0 })), {
    latitude: -90, longitude: 180, accuracy: 0, timestamp: 1_000,
  });
  const s = session(); s.controller.start();
  s.watches[0].success(fix({ timestamp: 2_000 }));
  s.watches[0].success(fix({ timestamp: 1_000 }));
  assert.equal(s.controller.getSnapshot().position.timestamp, 2_000);
  s.watches[0].success(fix({ longitude: 181 }));
  assert.equal(s.controller.getSnapshot().status, "unavailable");
  assert.equal(s.controller.getSnapshot().position, null);
  s.deactivate();
});

test("a callback arriving before visibilitychange cannot update a hidden page", () => {
  let visible = true;
  const s = session({ visible: () => visible }); s.controller.start();
  visible = false;
  s.watches[0].success(fix());
  assert.equal(s.controller.getSnapshot().status, "paused");
  assert.equal(s.controller.getSnapshot().position, null);
  assert.deepEqual(s.cleared, [0]);
  s.deactivate();
});

test("synchronous errors and thrown browser errors cannot leak a watch", () => {
  const cleared = [];
  const sync = session({ geolocation: {
    watchPosition(_success, failure) { failure({ code: 1 }); return 7; },
    clearWatch(id) { cleared.push(id); },
  } });
  sync.controller.start();
  assert.equal(sync.controller.getSnapshot().status, "denied");
  assert.deepEqual(cleared, [7]); sync.deactivate();
  const thrown = session({ geolocation: {
    watchPosition() { throw new Error("browser unavailable"); }, clearWatch() {},
  } });
  thrown.controller.start();
  assert.equal(thrown.controller.getSnapshot().status, "unavailable"); thrown.deactivate();
});

test("react strict effect replay remains idle and fully removes observers", async () => {
  const s = session(); s.deactivate();
  const deactivateAgain = s.controller.activate(); s.controller.setEnabled(true);
  assert.equal(s.watches.length, 0);
  s.controller.start(); await Promise.resolve();
  assert.equal(s.permissionListeners.size, 1);
  deactivateAgain();
  assert.equal(s.permissionListeners.size, 0);
  assert.equal(s.visibilityListeners.size, 0);
  assert.equal(s.controller.getSnapshot().position, null);
});

test("an explicit request on an inactive screen waits for visibility and an empty owner cannot request", () => {
  const s = session();
  s.controller.setEnabled(false); s.controller.start();
  assert.equal(s.controller.getSnapshot().status, "paused");
  assert.equal(s.watches.length, 0);
  s.setVisible(false); s.controller.setEnabled(true);
  assert.equal(s.watches.length, 0);
  s.setVisible(true);
  assert.equal(s.watches.length, 1);
  s.deactivate();
  const anonymous = createEarthLocationController("", () => s.environment);
  const deactivate = anonymous.activate(); anonymous.setEnabled(true); anonymous.start();
  assert.equal(s.watches.length, 1);
  assert.equal(anonymous.getSnapshot().status, "idle");
  deactivate();
});
