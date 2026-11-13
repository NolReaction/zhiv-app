import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { createNativeEarthLocationEnvironment } = await vite.ssrLoadModule("/features/earth/native-location.ts");
const { createEarthLocationController } = await vite.ssrLoadModule("/features/earth/location.ts");
after(() => vite.close());

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
const fix = (timestamp = 1_000) => ({ timestamp, coords: { latitude: 55.75, longitude: 37.61, accuracy: 25, speed: 12 } });

function native({ pendingState = false, pendingListener = false } = {}) {
  const state = deferred(), registration = deferred();
  const appListeners = new Set(), documentListeners = new Set();
  const watches = [], cleared = [];
  let active = true, visibilityState = "visible", removed = 0, permissionChecks = 0;
  let permission = { location: "granted", coarseLocation: "granted" }, permissionError = null;
  const document = {
    get visibilityState() { return visibilityState; },
    addEventListener(_event, listener) { documentListeners.add(listener); },
    removeEventListener(_event, listener) { documentListeners.delete(listener); },
  };
  const app = {
    getState: () => pendingState ? state.promise : Promise.resolve({ isActive: active }),
    addListener(_event, listener) {
      appListeners.add(listener);
      const handle = { async remove() { removed += 1; appListeners.delete(listener); } };
      if (!pendingListener) registration.resolve(handle);
      return registration.promise;
    },
  };
  const geolocation = {
    watchPosition(options, callback) {
      const result = deferred();
      watches.push({ options, callback, ...result });
      return result.promise;
    },
    async clearWatch({ id }) { cleared.push(id); },
    async checkPermissions() {
      permissionChecks += 1;
      if (permissionError) throw permissionError;
      return permission;
    },
    async requestPermissions() { return permission; },
  };
  const environment = createNativeEarthLocationEnvironment({ app, geolocation, document });
  return { environment, state, registration, watches, cleared, appListeners, documentListeners, geolocation,
    get removed() { return removed; }, get permissionChecks() { return permissionChecks; },
    setPermission(value) { permission = value; },
    setPermissionError(error) { permissionError = error; },
    setActive(value) { active = value; for (const listener of appListeners) listener({ isActive: value }); },
    setDocumentVisible(value) { visibilityState = value ? "visible" : "hidden"; for (const listener of documentListeners) listener(); },
  };
}

async function session(options) {
  const platform = native(options);
  let denials = 0;
  const controller = createEarthLocationController("owner-a", () => platform.environment, () => { denials += 1; });
  const deactivate = controller.activate();
  controller.setEnabled(true);
  await settle();
  return { ...platform, controller, deactivate, get denials() { return denials; } };
}

test("native registration accepts an early callback and clears its eventual ID after stop", async () => {
  const s = await session();
  try {
    s.controller.start(); await settle();
    assert.equal(s.watches.length, 1);
    s.watches[0].callback(fix());
    assert.deepEqual(s.controller.getSnapshot().position, { latitude: 55.75, longitude: 37.61, accuracy: 25, timestamp: 1_000 });
    assert.equal(s.watches[0].options.maximumAge, 0);
    s.controller.stop();
    s.watches[0].callback(fix(2_000));
    s.watches[0].resolve("native-1");
    await settle();
    assert.deepEqual(s.cleared, ["native-1"]);
    assert.equal(s.controller.getSnapshot().position, null);
  } finally { s.deactivate(); }
});

test("backgrounding during a permission prompt cancels pending registration and fences its callbacks", async () => {
  const s = await session();
  try {
    s.controller.start(); await settle();
    s.setActive(false);
    assert.equal(s.controller.getSnapshot().status, "paused");
    s.watches[0].callback(fix());
    s.watches[0].resolve("old");
    await settle();
    assert.deepEqual(s.cleared, ["old"]);
    assert.equal(s.controller.getSnapshot().position, null);
    s.setActive(true);
    await settle();
    assert.equal(s.watches.length, 2);
    s.watches[0].callback(fix(2_000));
    assert.equal(s.controller.getSnapshot().position, null);
    s.watches[1].callback(fix(3_000));
    assert.equal(s.controller.getSnapshot().position.timestamp, 3_000);
  } finally { s.deactivate(); }
});

test("both native foreground and document visibility are necessary for a watch", async () => {
  const s = await session();
  try {
    s.setDocumentVisible(false);
    s.controller.start(); await settle();
    assert.equal(s.watches.length, 0);
    s.setActive(false);
    s.setDocumentVisible(true);
    assert.equal(s.watches.length, 0);
    s.setActive(true);
    await settle();
    assert.equal(s.watches.length, 1);
    s.setDocumentVisible(false);
    s.watches[0].resolve("hidden");
    await settle();
    assert.deepEqual(s.cleared, ["hidden"]);
    s.setActive(true);
    await settle();
    assert.equal(s.watches.length, 1);
  } finally { s.deactivate(); }
});

test("a late initial app snapshot cannot overwrite a newer background event", async () => {
  const s = await session({ pendingState: true });
  try {
    s.controller.start(); await settle();
    assert.equal(s.watches.length, 0, "unknown native lifecycle starts paused");
    s.setActive(false);
    s.state.resolve({ isActive: true });
    await settle();
    assert.equal(s.environment.visible(), false);
    assert.equal(s.watches.length, 0);
    s.setActive(true);
    await settle();
    assert.equal(s.watches.length, 1);
  } finally { s.deactivate(); }
});

test("teardown removes a late native listener and ignores a late initial app state", async () => {
  const s = await session({ pendingState: true, pendingListener: true });
  let removed = 0;
  s.controller.start(); await settle();
  s.deactivate();
  s.registration.resolve({ async remove() { removed += 1; } });
  s.state.resolve({ isActive: true });
  await settle();
  assert.equal(removed, 1);
  assert.equal(s.documentListeners.size, 0);
  assert.equal(s.watches.length, 0);
  assert.equal(s.environment.visible(), false);
});

test("native permission denial is not retried and never grants publication or restarts on resume", async () => {
  const s = await session();
  try {
    s.controller.start(); await settle();
    s.watches[0].reject({ code: "OS-PLUG-GLOC-0003" });
    await settle();
    assert.equal(s.controller.getSnapshot().status, "denied");
    assert.equal(s.denials, 1);
    s.setActive(false); s.setActive(true);
    await settle();
    assert.equal(s.watches.length, 1);
  } finally { s.deactivate(); }
});

test("native timeouts use the controller's bounded low-accuracy retry", async () => {
  const s = await session();
  try {
    s.controller.start(); await settle();
    s.watches[0].callback(null, { code: "OS-PLUG-GLOC-0010" });
    await settle();
    assert.equal(s.watches.length, 2);
    assert.equal(s.watches[1].options.enableHighAccuracy, false);
    s.watches[1].callback(null, { code: "OS-PLUG-GLOC-0010" });
    assert.equal(s.controller.getSnapshot().status, "timeout");
    assert.equal(s.watches.length, 2);
  } finally { s.deactivate(); }
});

test("restricted location is denied, while disabled device services are unavailable", async () => {
  for (const [code, expected, attempts] of [["OS-PLUG-GLOC-0008", "denied", 1], ["OS-PLUG-GLOC-0007", "unavailable", 2]]) {
    const s = await session();
    try {
      s.controller.start(); await settle();
      for (let index = 0; index < attempts; index += 1) { s.watches[index].callback(null, { code }); await settle(); }
      assert.equal(s.controller.getSnapshot().status, expected);
      assert.equal(s.watches.length, attempts);
    } finally { s.deactivate(); }
  }
});

test("Android approximate permission is accepted without requiring fine access", async () => {
  const s = native();
  s.setPermission({ location: "denied", coarseLocation: "granted" });
  const remove = s.environment.onVisibilityChange(() => {});
  try {
    await settle();
    const permission = await s.environment.queryPermission();
    assert.equal(permission.state, "granted");
  } finally { remove(); }
});

test("an Android approximate grant suppresses repeated fine prompts across refresh and resume", async () => {
  const s = await session();
  try {
    s.setPermission({ location: "prompt-with-rationale", coarseLocation: "granted" });
    s.controller.start(); await settle();
    assert.equal(s.watches[0].options.enableHighAccuracy, false);
    s.watches[0].callback(fix());
    s.controller.locate({ fresh: true }); await settle();
    assert.equal(s.watches[1].options.enableHighAccuracy, false);
    s.setActive(false); s.setActive(true); await settle();
    assert.equal(s.watches[2].options.enableHighAccuracy, false);
    s.setActive(false);
    s.setPermission({ location: "granted", coarseLocation: "granted" });
    s.setActive(true); await settle();
    assert.equal(s.watches[3].options.enableHighAccuracy, true, "a newly granted precise permission is used");
  } finally { s.deactivate(); }
});

test("stopping while the native permission preflight is pending never registers a watch", async () => {
  const s = await session();
  const check = deferred();
  s.geolocation.checkPermissions = () => check.promise;
  try {
    s.controller.start();
    s.controller.stop();
    check.resolve({ location: "granted", coarseLocation: "granted" });
    await settle();
    assert.equal(s.watches.length, 0);
    assert.equal(s.controller.getSnapshot().position, null);
  } finally { s.deactivate(); }
});

test("permission is requested before watch registration so cancellation during the OS prompt leaves no native watch", async () => {
  const s = await session();
  const request = deferred();
  const requests = [];
  s.setPermission({ location: "prompt", coarseLocation: "prompt" });
  s.geolocation.requestPermissions = options => { requests.push(options); return request.promise; };
  try {
    s.controller.start(); await settle();
    assert.deepEqual(requests, [{ permissions: ["location"] }]);
    assert.equal(s.watches.length, 0);
    s.setActive(false);
    request.resolve({ location: "granted", coarseLocation: "granted" });
    s.setPermission({ location: "granted", coarseLocation: "granted" });
    await settle();
    assert.equal(s.watches.length, 0, "a retired permission request never registers a native watch");
    s.setActive(true); await settle();
    assert.equal(s.watches.length, 1);
    assert.equal(requests.length, 1);
  } finally { s.deactivate(); }
});

test("denying the native permission request reports denial without ever creating a watch", async () => {
  const s = await session();
  s.setPermission({ location: "prompt", coarseLocation: "prompt" });
  s.geolocation.requestPermissions = async () => ({ location: "denied", coarseLocation: "denied" });
  try {
    s.controller.start(); await settle();
    assert.equal(s.watches.length, 0);
    assert.equal(s.controller.getSnapshot().status, "denied");
    assert.equal(s.denials, 1);
  } finally { s.deactivate(); }
});

test("returning from native settings rechecks permission and retires the prior owner's fix", async () => {
  const s = await session();
  try {
    s.controller.start(); await settle();
    await settle();
    s.watches[0].callback(fix());
    s.setActive(false);
    s.setPermission({ location: "denied", coarseLocation: "denied" });
    s.setActive(true);
    await settle();
    assert.equal(s.controller.getSnapshot().status, "denied");
    assert.equal(s.controller.getSnapshot().position, null);
    s.watches.at(-1).callback(fix(2_000));
    assert.equal(s.controller.getSnapshot().position, null);
    assert.equal(s.denials, 1);
  } finally { s.deactivate(); }
});

test("permission-query failure does not manufacture revocation, while watch errors remain authoritative", async () => {
  const s = await session();
  try {
    s.controller.start(); await settle();
    await settle();
    s.watches[0].callback(fix());
    s.setActive(false);
    s.setPermissionError({ code: "OS-PLUG-GLOC-0007" });
    s.setActive(true);
    await settle();
    assert.equal(s.denials, 0);
    s.watches[1].callback(null, { code: "OS-PLUG-GLOC-0007" });
    await settle();
    s.watches[2].callback(null, { code: "OS-PLUG-GLOC-0007" });
    assert.equal(s.controller.getSnapshot().status, "unavailable");
    assert.equal(s.denials, 0);
  } finally { s.deactivate(); }
});

test("native fixes keep measurement time and invalid coordinates never reach the controller state", async () => {
  const s = await session();
  try {
    s.controller.start(); await settle();
    s.watches[0].callback(fix(123));
    assert.equal(s.controller.getSnapshot().position.timestamp, 123);
    s.watches[0].callback({ ...fix(456), coords: { latitude: NaN, longitude: 37, accuracy: 5 } });
    assert.equal(s.controller.getSnapshot().status, "unavailable");
    assert.equal(s.controller.getSnapshot().position.timestamp, 123, "a failed new fix does not freshen the old marker");
  } finally { s.deactivate(); }
});

test("old account's rejected native registration cannot affect a replacement controller", async () => {
  const s = await session();
  s.controller.start(); await settle();
  s.deactivate();
  const next = createEarthLocationController("owner-b", () => s.environment);
  const deactivateNext = next.activate(); next.setEnabled(true);
  try {
    await settle(); next.start(); await settle();
    s.watches[0].reject({ code: "OS-PLUG-GLOC-0003" });
    await settle();
    assert.equal(next.getSnapshot().status, "requesting");
    assert.equal(s.denials, 0);
    s.watches[1].callback(fix());
    assert.equal(next.getSnapshot().status, "active");
  } finally { deactivateNext(); }
});

test("failing native lifecycle registration pauses a lookup even after initial foreground state", async () => {
  const s = await session({ pendingListener: true });
  try {
    s.controller.start(); await settle();
    assert.equal(s.watches.length, 1);
    s.registration.reject(new Error("native listener unavailable"));
    await settle();
    assert.equal(s.environment.visible(), false);
    assert.equal(s.controller.getSnapshot().status, "paused");
    s.watches[0].resolve("retired");
    await settle();
    assert.deepEqual(s.cleared, ["retired"]);
  } finally { s.deactivate(); }
});
