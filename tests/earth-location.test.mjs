import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { createEarthLocationController, readEarthPosition } = await vite.ssrLoadModule("/features/earth/location.ts");
const { createEarthSharingController } = await vite.ssrLoadModule("/features/earth/sharing.ts");
after(() => vite.close());

function browser(overrides = {}) {
  let visible = true;
  const watches = [];
  const cleared = [];
  const visibilityListeners = new Set();
  const permissionListeners = new Set();
  const timers = new Map();
  let timerSequence = 0;
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
    schedule(callback, delay) { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; },
    cancel: id => timers.delete(id),
    queryPermission: async () => permission,
    ...overrides,
  };
  return {
    environment, watches, cleared, visibilityListeners, permissionListeners, permission, timers,
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

test("freezing keeps only the last private marker, cancels late fixes and never resumes GPS implicitly", async () => {
  const s = session();
  s.controller.start();
  s.watches[0].success(fix());
  const position = s.controller.getSnapshot().position;
  s.controller.freeze();
  assert.deepEqual(s.cleared, [0]);
  assert.equal(s.controller.getSnapshot().position, position);
  assert.equal(s.controller.getSnapshot().status, "paused");
  s.watches[0].success(fix({ latitude: 10, timestamp: 2_000 }));
  s.setVisible(false); s.setVisible(true);
  s.controller.setEnabled(false); s.controller.setEnabled(true);
  s.permission.state = "granted";
  s.controller.setAutomaticStartPolicy(true);
  await Promise.resolve();
  assert.equal(s.watches.length, 1);
  assert.equal(s.controller.getSnapshot().position, position);
  s.controller.start();
  assert.equal(s.watches.length, 2, "an explicit private lookup remains possible");
  s.watches[1].success(fix({ latitude: 11, timestamp: 3_000 }));
  assert.equal(s.controller.getSnapshot().position.latitude, 11);
  s.deactivate();
  assert.equal(s.controller.getSnapshot().position, null, "account teardown clears frozen coordinates");
});

test("screen activation never requests coordinates; an explicit start opens only one foreground watch", () => {
  const s = session();
  assert.deepEqual(s.controller.getSnapshot(), { position: null, status: "idle", error: null });
  s.setVisible(false); s.setVisible(true); s.controller.setEnabled(false); s.controller.setEnabled(true);
  assert.equal(s.watches.length, 0);
  s.controller.start(); s.controller.start();
  assert.equal(s.watches.length, 1);
  assert.equal(s.controller.getSnapshot().status, "requesting");
  assert.deepEqual(s.watches[0].options, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 });
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

test("Find me ignores a stale initial denied Permissions snapshot and succeeds on the first watch", async () => {
  const s = session();
  s.permission.state = "denied";
  s.controller.locate();
  await settlePermission();
  assert.equal(s.controller.getSnapshot().status, "requesting");
  assert.equal(s.controller.getSnapshot().error, null);
  assert.deepEqual(s.cleared, [], "a passive snapshot cannot cancel a real acquisition");
  s.setPermission("granted");
  s.watches[0].success(fix());
  assert.equal(s.controller.getSnapshot().status, "active");
  assert.equal(s.controller.getSnapshot().position.latitude, 55.75);
  assert.equal(s.watches.length, 1, "the player does not need another Find me tap");
  s.deactivate();
});

test("a delayed stale permission query cannot erase an already acquired fix", async () => {
  let resolve;
  const permission = new Promise(accept => { resolve = accept; });
  const s = session({ queryPermission: () => permission });
  s.permission.state = "denied";
  s.controller.locate(); s.watches[0].success(fix());
  resolve(s.permission); await settlePermission();
  assert.equal(s.controller.getSnapshot().status, "active");
  assert.equal(s.controller.getSnapshot().position.timestamp, 1_000);
  assert.deepEqual(s.cleared, []);
  s.setPermission("granted"); s.setPermission("denied");
  assert.equal(s.controller.getSnapshot().status, "denied", "a later real revocation still clears the acquired fix");
  assert.equal(s.controller.getSnapshot().position, null);
  s.deactivate();
});

test("a real Geolocation denial remains authoritative regardless of its initial permission snapshot", async () => {
  for (const permission of ["prompt", "denied", "granted"]) {
    const s = session(); s.permission.state = permission;
    s.controller.locate(); await settlePermission();
    s.watches[0].failure({ code: 1 });
    assert.equal(s.controller.getSnapshot().status, "denied");
    assert.equal(s.controller.getSnapshot().position, null);
    assert.match(s.controller.getSnapshot().error, /Разреши геопозицию/);
    assert.equal(s.watches.length, 1, "a permission refusal never retries GPS");
    assert.equal(s.permissionListeners.size, 0);
    s.deactivate();
  }
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

test("denial terminates immediately; provider errors retry once and keep the private fix", () => {
  for (const [code, expected] of [[1, "denied"], [2, "unavailable"], [3, "timeout"]]) {
    const s = session(); s.controller.start(); s.watches[0].success(fix());
    const previous = s.controller.getSnapshot().position;
    s.watches[0].failure({ code });
    const retries = code === 1 ? 0 : 1;
    if (retries) {
      assert.equal(s.controller.getSnapshot().status, "requesting");
      assert.equal(s.watches[1].options.enableHighAccuracy, false);
      s.watches[1].failure({ code });
    }
    assert.equal(s.controller.getSnapshot().status, expected);
    assert.equal(s.controller.getSnapshot().position, code === 1 ? null : previous);
    assert.deepEqual(s.cleared, retries ? [0, 1] : [0]);
    s.setVisible(false); s.setVisible(true);
    assert.equal(s.watches.length, 1 + retries);
    s.controller.start();
    assert.equal(s.watches.length, 2 + retries);
    assert.equal(s.watches.at(-1).options.enableHighAccuracy, true);
    s.watches.at(-1).success(fix({ timestamp: 2_000 }));
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
  assert.equal(s.controller.getSnapshot().position.timestamp, 2_000);
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


const settlePermission = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

test("cold map entry starts native GPS without waiting for Permissions on iOS", async () => {
  for (const value of ["prompt", "denied", "missing", "reject", "pending"]) {
    const s = session(value === "missing" ? { queryPermission: undefined }
      : value === "reject" ? { queryPermission: () => Promise.reject(new Error("unsupported")) }
      : value === "pending" ? { queryPermission: () => new Promise(() => {}) } : {});
    if (value === "prompt" || value === "denied") s.permission.state = value;
    s.controller.setAutomaticStartPolicy(true);
    assert.equal(s.watches.length, 1, `${value}: no Find me tap is required`);
    await settlePermission();
    s.watches[0].success(fix());
    assert.equal(s.controller.getSnapshot().status, "active");
    assert.equal(s.controller.getSnapshot().position.latitude, 55.75);
    s.deactivate();
  }
});

test("an initial private lookup waits for privacy metadata and never retries after a manual stop", async () => {
  const s = session();
  s.permission.state = "granted";
  s.controller.setAutomaticStartPolicy(null); await settlePermission();
  assert.equal(s.watches.length, 0, "wait for sharing metadata before native GPS");
  s.controller.setAutomaticStartPolicy(true); await settlePermission();
  assert.equal(s.watches.length, 1); assert.equal(s.controller.getSnapshot().status, "requesting");
  s.watches[0].success(fix()); assert.equal(s.controller.getSnapshot().status, "active");
  s.controller.stop(); s.controller.setAutomaticStartPolicy(true);
  s.controller.setEnabled(false); s.controller.setEnabled(true); await settlePermission();
  assert.equal(s.watches.length, 1, "incidental renders and map return do not override a stop");
  s.deactivate();
});

test("an initial stale permission becoming granted does not duplicate the automatic native watch", async () => {
  for (const initial of ["prompt", "denied"]) {
    const s = session(); s.permission.state = initial;
    s.controller.setAutomaticStartPolicy(true); await settlePermission();
    assert.equal(s.watches.length, 1);
    assert.equal(s.controller.getSnapshot().error, null);
    s.setPermission("granted"); await settlePermission();
    assert.equal(s.watches.length, 1);
    s.watches[0].success(fix());
    assert.equal(s.controller.getSnapshot().status, "active");
    assert.equal(s.controller.getSnapshot().position.longitude, 37.61);
    assert.equal(s.permissionListeners.size, 1, "the live observer remains available for later revocation");
    s.deactivate(); assert.equal(s.permissionListeners.size, 0);
  }
});

test("stop, freeze, OFF, ghost and teardown retire an automatic lookup and its queued callbacks", async () => {
  for (const interrupt of [s => s.controller.stop(), s => s.controller.freeze(), s => s.controller.setAllowed(false),
    s => s.controller.setAutomaticStartPolicy(false), s => s.deactivate()]) {
    const s = session();
    s.controller.setAutomaticStartPolicy(true); await settlePermission();
    assert.equal(s.watches.length, 1);
    const queuedChange = [...s.permissionListeners][0];
    interrupt(s);
    assert.equal(s.permissionListeners.size, 0);
    s.permission.state = "granted"; queuedChange();
    s.watches[0].success(fix()); s.watches[0].failure({ code: 1 });
    s.setVisible(false); s.setVisible(true);
    s.controller.setEnabled(false); s.controller.setEnabled(true); await settlePermission();
    assert.equal(s.watches.length, 1, "retired callbacks cannot revive a stopped lookup");
    assert.equal(s.controller.getSnapshot().position, null);
    s.deactivate();
  }
});

test("hidden and inactive maps defer automatic GPS and pause a previously started watch", () => {
  for (const boundary of ["visible", "enabled"]) {
    const s = session();
    if (boundary === "visible") s.setVisible(false); else s.controller.setEnabled(false);
    s.controller.setAutomaticStartPolicy(true);
    assert.equal(s.watches.length, 0);
    if (boundary === "visible") s.setVisible(true); else s.controller.setEnabled(true);
    assert.equal(s.watches.length, 1);
    s.watches[0].success(fix());
    if (boundary === "visible") s.setVisible(false); else s.controller.setEnabled(false);
    assert.deepEqual(s.cleared, [0]);
    s.watches[0].failure({ code: 1 });
    assert.equal(s.controller.getSnapshot().status, "paused");
    if (boundary === "visible") s.setVisible(true); else s.controller.setEnabled(true);
    assert.equal(s.watches.length, 2, "an existing foreground session may resume");
    s.deactivate();
  }
});

test("a later ghost policy freezes automatic coordinates but never cancels an explicit private lookup", () => {
  const s = session();
  s.controller.setAutomaticStartPolicy(true); s.watches[0].success(fix());
  const position = s.controller.getSnapshot().position;
  s.controller.setAutomaticStartPolicy(false);
  assert.deepEqual(s.cleared, [0]);
  assert.equal(s.controller.getSnapshot().status, "paused");
  assert.equal(s.controller.getSnapshot().position, position);
  s.watches[0].success(fix({ latitude: 10, timestamp: 2_000 }));
  assert.equal(s.controller.getSnapshot().position, position);
  s.controller.locate();
  s.controller.setAutomaticStartPolicy(false);
  assert.equal(s.watches.length, 2);
  assert.deepEqual(s.cleared, [0]);
  s.watches[1].success(fix({ latitude: 56, timestamp: 3_000 }));
  assert.equal(s.controller.getSnapshot().position.latitude, 56);
  s.deactivate();
});

test("ghost suppresses automatic GPS for this visit but still allows an explicit private lookup", async () => {
  const s = session(); s.permission.state = "granted";
  s.controller.setAutomaticStartPolicy(false); s.controller.setAutomaticStartPolicy(true); await settlePermission();
  assert.equal(s.watches.length, 0, "a later OFF metadata change cannot silently override initial ghost");
  s.controller.start(); assert.equal(s.watches.length, 1);
  s.controller.stop(); s.controller.setAutomaticStartPolicy(true); await settlePermission();
  assert.equal(s.watches.length, 1);
  s.deactivate();
});

test("a privacy policy applied before activation fences replay and later automatic enabling", () => {
  const platform = browser();
  const controller = createEarthLocationController("initial-ghost", () => platform.environment);
  controller.setEnabled(true); controller.setAutomaticStartPolicy(false);
  const cleanup = controller.activate();
  controller.setAutomaticStartPolicy(true);
  assert.equal(platform.watches.length, 0);
  cleanup();
  controller.setAutomaticStartPolicy(false);
  const cleanupAgain = controller.activate();
  controller.setAutomaticStartPolicy(true);
  assert.equal(platform.watches.length, 0, "effect replay cannot discard the pre-activation suppression");
  controller.locate();
  assert.equal(platform.watches.length, 1);
  cleanupAgain();
});

test("late permission queries cannot revive an automatic lookup after lifecycle boundaries", async () => {
  for (const interrupt of [s => s.controller.stop(), s => s.setVisible(false), s => s.controller.setEnabled(false),
    s => s.controller.setAutomaticStartPolicy(false), s => s.deactivate()]) {
    let resolve; const permission = new Promise(accept => { resolve = accept; });
    const s = session({ queryPermission: () => permission });
    s.permission.state = "granted"; s.controller.setAutomaticStartPolicy(true); interrupt(s);
    resolve(s.permission); await settlePermission();
    assert.equal(s.watches.length, 1, "permission probes never start native GPS");
    s.watches[0].success(fix()); s.watches[0].failure({ code: 1 });
    assert.equal(s.controller.getSnapshot().position, null);
    assert.notEqual(s.controller.getSnapshot().status, "denied");
    s.deactivate(); assert.equal(s.permissionListeners.size, 0);
  }
});

test("strict effect replay retires the old native watch and observes only the live activation", async () => {
  const probes = [];
  const s = session({ queryPermission: () => new Promise(resolve => probes.push(resolve)) });
  s.permission.state = "granted"; s.controller.setAutomaticStartPolicy(true);
  assert.equal(probes.length, 1); assert.equal(s.watches.length, 1); s.deactivate();
  const cleanup = s.controller.activate(); s.controller.setEnabled(true); s.controller.setAutomaticStartPolicy(true);
  assert.equal(probes.length, 2); assert.equal(s.watches.length, 2);
  assert.deepEqual(s.cleared, [0], "only the new activation owns a live watch");
  probes[0](s.permission); await settlePermission(); assert.equal(s.permissionListeners.size, 0);
  s.watches[0].success(fix()); assert.equal(s.controller.getSnapshot().position, null);
  probes[1](s.permission); await settlePermission(); assert.equal(s.permissionListeners.size, 1);
  s.watches[1].success(fix()); assert.equal(s.controller.getSnapshot().status, "active");
  cleanup(); assert.equal(s.visibilityListeners.size, 0); assert.equal(s.permissionListeners.size, 0);
});

test("automatic private coordinates do not publish even when saved server consent remains SHARING", async () => {
  const s = session(); s.permission.state = "granted";
  const writes = [], epoch = Date.parse("2026-10-18T17:00:00Z"), owner = "AAAA-BBBB-CCCC";
  const sharing = createEarthSharingController({ ownerPublicId: owner, getEnvironment: () => ({
    now: () => epoch, monotonicNow: () => 0, visible: () => true, schedule: () => 1, cancel() {},
    onVisibilityChange: () => () => {}, loadPending: () => null, savePending() {}, clearPending() {},
    onPendingChange: () => () => {}, createId: () => "11111111-1111-4111-8111-111111111111",
  }), transport: {
    getEarthSharing: async () => ({ ownerPublicId: owner, mode: "SHARING", revision: 1, precision: "APPROXIMATE",
      recipientCircleIds: ["11111111-1111-4111-8111-111111111111"], sharingUntil: null, publicationEpoch: null, serverTime: new Date(epoch).toISOString() }),
    getEarthPeople: async () => ({ ownerPublicId: owner, people: [], serverTime: new Date(epoch).toISOString() }),
    updateEarthSharing: async write => { writes.push(write); }, publishEarthPosition: async write => { writes.push(write); },
    stopEarthPublication: async write => { writes.push(write); },
  } });
  const deactivateSharing = sharing.activate(); sharing.setContext({ visible: true, isOnline: true }); await settlePermission();
  const unsubscribe = s.controller.subscribe(() => { sharing.setPosition(s.controller.getSnapshot().position); });
  s.controller.setAutomaticStartPolicy(true); await settlePermission();
  s.watches[0].success(fix({ timestamp: epoch })); await settlePermission();
  assert.equal(s.controller.getSnapshot().status, "active");
  assert.equal(sharing.getSnapshot().settings.mode, "SHARING"); assert.equal(sharing.getSnapshot().publishing, false);
  assert.deepEqual(writes, [], "the initial private marker never upgrades persisted consent into a live publisher");
  unsubscribe(); s.deactivate(); deactivateSharing();
});

test("Find me is idempotent while requesting and cannot turn an acquisition into a GPS stop", () => {
  const s = session();
  s.controller.locate(); s.controller.locate(); s.controller.locate();
  assert.equal(s.watches.length, 1);
  assert.deepEqual(s.cleared, []);
  assert.equal(s.controller.getSnapshot().status, "requesting");
  s.watches[0].success(fix());
  assert.equal(s.controller.getSnapshot().status, "active");
  assert.equal(s.controller.getSnapshot().position.latitude, 55.75);
  s.deactivate();
});

test("an explicit refresh keeps the private marker until a new fix and fences the replaced watch's late callbacks", () => {
  const s = session();
  s.controller.start(); s.watches[0].success(fix());
  const previous = s.controller.getSnapshot().position;
  s.controller.locate();
  assert.deepEqual(s.cleared, [0]); assert.equal(s.watches.length, 2);
  assert.equal(s.controller.getSnapshot().status, "requesting");
  assert.equal(s.controller.getSnapshot().position, previous);
  s.controller.locate(); assert.equal(s.watches.length, 2);
  s.watches[0].success(fix({ latitude: 12, timestamp: 999_000 }));
  s.watches[0].failure({ code: 1 });
  assert.equal(s.controller.getSnapshot().position, previous);
  assert.equal(s.controller.getSnapshot().status, "requesting");
  s.watches[1].success(fix({ latitude: 56, timestamp: 2_000 }));
  assert.equal(s.controller.getSnapshot().position.latitude, 56);
  assert.equal(s.controller.getSnapshot().status, "active");
  s.deactivate();
});

test("a provider failure uses one balanced fallback watch and fences the earlier callbacks", () => {
  const s = session();
  s.controller.locate(); s.watches[0].success(fix());
  const previous = s.controller.getSnapshot().position;
  s.watches[0].failure({ code: 2 });
  assert.equal(s.watches.length, 2);
  assert.deepEqual(s.watches[1].options, { enableHighAccuracy: false, maximumAge: 15_000, timeout: 20_000 });
  assert.equal(s.controller.getSnapshot().position, previous);
  s.watches[0].success(fix({ latitude: 10, timestamp: 999_000 })); s.watches[0].failure({ code: 1 });
  assert.equal(s.controller.getSnapshot().position, previous);
  assert.equal(s.controller.getSnapshot().status, "requesting");
  s.watches[1].success(fix({ latitude: 56, timestamp: 2_000 }));
  assert.equal(s.controller.getSnapshot().status, "active");
  assert.equal(s.controller.getSnapshot().position.latitude, 56);
  s.watches[1].failure({ code: 2 });
  assert.equal(s.watches.length, 3, "a later outage gets its own bounded retry after an actual new fix");
  s.watches[2].failure({ code: 2 });
  assert.equal(s.watches.length, 3, "a continuously failing provider cannot retry indefinitely");
  assert.equal(s.controller.getSnapshot().position.timestamp, 2_000);
  assert.match(s.controller.getSnapshot().error, /настройках устройства и браузера/);
  s.deactivate();
});

test("visibility pauses the bounded fallback; stop and teardown retire it without reviving GPS", () => {
  for (const end of [s => s.controller.stop(), s => s.controller.freeze(), s => s.deactivate()]) {
    const s = session(); s.controller.locate(); s.watches[0].failure({ code: 3 });
    s.setVisible(false); s.setVisible(true);
    assert.equal(s.watches.length, 3);
    assert.equal(s.watches[2].options.enableHighAccuracy, false, "visibility does not reset the retry budget");
    s.watches[1].failure({ code: 2 });
    assert.equal(s.controller.getSnapshot().status, "requesting");
    end(s);
    s.watches[2].success(fix()); s.watches[2].failure({ code: 2 });
    s.setVisible(false); s.setVisible(true);
    assert.equal(s.watches.length, 3);
    assert.equal(s.controller.getSnapshot().position, null);
    s.deactivate();
  }
});

test("synchronous unavailable callbacks clear both watch handles and retry only once", () => {
  const options = [], cleared = [];
  const s = session({ geolocation: {
    watchPosition(_success, failure, value) { const id = options.length; options.push(value); failure({ code: 2 }); return id; },
    clearWatch(id) { cleared.push(id); },
  } });
  s.controller.locate();
  assert.equal(options.length, 2);
  assert.deepEqual(options.map(value => value.enableHighAccuracy), [true, false]);
  assert.deepEqual(cleared.toSorted(), [0, 1]);
  assert.equal(s.controller.getSnapshot().status, "unavailable");
  s.deactivate();
});

test("Find me after a ghost freeze acquires private GPS without changing ghost consent or publishing coordinates", async () => {
  const s = session(), writes = [], epoch = Date.parse("2026-10-20T12:00:00Z"), owner = "AAAA-BBBB-CCCC";
  const circle = "11111111-1111-4111-8111-111111111111";
  const sharing = createEarthSharingController({ ownerPublicId: owner, getEnvironment: () => ({
    now: () => epoch, monotonicNow: () => 0, visible: () => true, schedule: () => 1, cancel() {},
    onVisibilityChange: () => () => {}, loadPending: () => null, savePending() {}, clearPending() {},
    onPendingChange: () => () => {}, createId: () => circle,
  }), transport: {
    getEarthSharing: async () => ({ ownerPublicId: owner, mode: "GHOST", revision: 2, precision: "APPROXIMATE",
      recipientCircleIds: [circle], frozenCircleIds: [circle], sharingUntil: null, publicationEpoch: null, serverTime: new Date(epoch).toISOString() }),
    getEarthPeople: async () => ({ ownerPublicId: owner, people: [], serverTime: new Date(epoch).toISOString() }),
    updateEarthSharing: async write => { writes.push(write); }, publishEarthPosition: async write => { writes.push(write); },
    stopEarthPublication: async write => { writes.push(write); },
  } });
  const deactivateSharing = sharing.activate(); sharing.setContext({ visible: true, isOnline: true }); await settlePermission();
  const consent = structuredClone(sharing.getSnapshot().settings);
  const unsubscribe = s.controller.subscribe(() => sharing.setPosition(s.controller.getSnapshot().position));
  s.controller.start(); s.watches[0].success(fix({ timestamp: epoch - 1000 }));
  s.controller.freeze(); s.controller.setAutomaticStartPolicy(false);
  s.controller.locate(); s.controller.locate();
  assert.equal(s.watches.length, 2);
  s.watches[1].success(fix({ latitude: 56, timestamp: epoch })); await settlePermission();
  assert.equal(s.controller.getSnapshot().position.latitude, 56);
  assert.equal(s.controller.getSnapshot().status, "active");
  assert.deepEqual(sharing.getSnapshot().settings, consent);
  assert.equal(sharing.getSnapshot().publishing, false);
  assert.deepEqual(writes, [], "A private lookup neither enables sharing nor sends coordinates, even in GHOST");
  unsubscribe(); s.deactivate(); deactivateSharing();
});

test("device-wide OFF clears coordinates, retires late callbacks and blocks explicit and passive GPS until ON", async () => {
  const s = session();
  s.permission.state = "granted";
  s.controller.start(); s.watches[0].success(fix());
  s.controller.setAllowed(false);
  assert.deepEqual(s.controller.getSnapshot(), { position: null, status: "idle", error: null });
  assert.deepEqual(s.cleared, [0]);
  s.watches[0].success(fix({ latitude: 10, timestamp: 2_000 }));
  s.watches[0].failure({ code: 2 });
  s.controller.start(); s.controller.locate();
  s.setVisible(false); s.setVisible(true);
  s.controller.setEnabled(false); s.controller.setEnabled(true);
  s.controller.setAutomaticStartPolicy(true);
  await settlePermission();
  assert.equal(s.watches.length, 1);
  assert.equal(s.controller.getSnapshot().position, null);
  s.controller.setAllowed(true);
  await settlePermission();
  assert.equal(s.watches.length, 1, "ON only unlocks a new explicit lookup");
  s.controller.locate();
  assert.equal(s.watches.length, 2);
  s.watches[1].success(fix({ timestamp: 3_000 }));
  assert.equal(s.controller.getSnapshot().position.timestamp, 3_000);
  s.deactivate();
});

test("OFF fences a delayed permission observer and an unmounted disabled controller never starts", async () => {
  const probes = [];
  const s = session({ queryPermission: () => new Promise(resolve => probes.push(resolve)) });
  s.permission.state = "granted";
  s.controller.setAutomaticStartPolicy(true);
  assert.equal(probes.length, 1);
  s.controller.setAllowed(false);
  probes[0](s.permission); await settlePermission();
  assert.equal(s.watches.length, 1);
  s.deactivate();
  const cleanup = s.controller.activate();
  s.controller.setEnabled(true); s.controller.setAutomaticStartPolicy(true);
  s.controller.start(); s.controller.locate();
  await settlePermission();
  assert.equal(s.watches.length, 1);
  assert.equal(probes.length, 1);
  cleanup();
});


test("a new publication lease replaces even a pending entry watch with an uncached high-accuracy fix", () => {
  const s = session();
  s.controller.start();
  s.controller.locate({ fresh: true });
  assert.equal(s.watches.length, 2);
  assert.deepEqual(s.cleared, [0]);
  assert.deepEqual(s.watches[1].options, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
  s.watches[0].success(fix({ timestamp: 9_000 }));
  assert.equal(s.controller.getSnapshot().position, null, "the replaced pre-consent watch cannot supply the new lease");
  s.watches[1].success(fix({ timestamp: 10_000 }));
  assert.equal(s.controller.getSnapshot().position.timestamp, 10_000);
  s.controller.locate({ fresh: true });
  assert.equal(s.watches.length, 3, "a later lease also replaces an existing fresh watch");
  s.watches[2].failure({ code: 2 });
  assert.equal(s.watches.length, 4);
  assert.equal(s.watches[3].options.maximumAge, 0, "the bounded fallback cannot return a pre-lease cached fix");
  assert.equal(s.watches[3].options.enableHighAccuracy, false);
  s.deactivate();
});

test("a stationary foreground device asks for a real new fix without refreshing the old timestamp", () => {
  const s = session();
  s.controller.start(); s.watches[0].success(fix());
  const position = s.controller.getSnapshot().position;
  const [id, timer] = [...s.timers][0];
  assert.equal(timer.delay, 30_000);
  s.timers.delete(id); timer.callback();
  assert.equal(s.watches.length, 2, "a silent watch is replaced even when the player does not move");
  assert.deepEqual(s.cleared, [0]);
  assert.equal(s.watches[1].options.maximumAge, 0);
  assert.equal(s.controller.getSnapshot().position, position);
  assert.equal(s.controller.getSnapshot().position.timestamp, 1_000);
  s.watches[0].success(fix({ latitude: 1, timestamp: 99_000 }));
  assert.equal(s.controller.getSnapshot().position, position, "late retired callbacks cannot impersonate the new lookup");
  s.watches[1].success(fix({ timestamp: 31_000 }));
  assert.equal(s.controller.getSnapshot().status, "active");
  assert.equal(s.controller.getSnapshot().position.timestamp, 31_000);
  assert.equal(s.timers.size, 1, "each new fix keeps one bounded foreground freshness timer");
  s.deactivate(); assert.equal(s.timers.size, 0);
});

test("new GPS measurements postpone refresh while duplicate cached fixes cannot keep a silent watch alive", () => {
  const s = session(); s.controller.start(); s.watches[0].success(fix());
  const firstTimer = [...s.timers.keys()][0];
  const retiredCallback = s.timers.get(firstTimer).callback;
  s.watches[0].success(fix());
  assert.equal([...s.timers.keys()][0], firstTimer, "an identical provider timestamp is not an update");
  s.watches[0].success(fix({ timestamp: 2_000 }));
  assert.equal(s.timers.has(firstTimer), false);
  assert.equal(s.timers.size, 1); assert.equal(s.watches.length, 1, "normal watch updates do not restart GPS");
  retiredCallback();
  assert.equal(s.watches.length, 1, "a canceled timer queued before a real fix cannot restart its watch");
  assert.equal(s.timers.size, 1);
  s.deactivate();
});

test("foreground refresh timers cannot survive privacy, backgrounding, disabled screens or owner teardown", () => {
  for (const interrupt of [s => s.controller.stop(), s => s.controller.freeze(), s => s.controller.setAllowed(false),
    s => s.setVisible(false), s => s.controller.setEnabled(false), s => s.deactivate()]) {
    const s = session(); s.controller.start(); s.watches[0].success(fix());
    const timer = [...s.timers.values()][0];
    interrupt(s);
    assert.equal(s.timers.size, 0);
    timer.callback();
    assert.equal(s.watches.length, 1, "an already queued timer cannot revive native GPS");
    s.deactivate();
  }
});

test("recovery from one provider outage restores the bounded fallback for a later independent outage", () => {
  const s = session(); s.controller.start(); s.watches[0].success(fix());
  s.watches[0].failure({ code: 2 });
  s.watches[1].success(fix({ timestamp: 2_000 }));
  s.watches[1].failure({ code: 3 });
  assert.equal(s.watches.length, 3, "one old outage cannot spend the retry for the rest of the application session");
  assert.equal(s.watches[2].options.enableHighAccuracy, false);
  s.watches[2].failure({ code: 3 });
  assert.equal(s.controller.getSnapshot().status, "timeout", "a continuously failing provider still stops after its one fallback");
  s.deactivate();
});
