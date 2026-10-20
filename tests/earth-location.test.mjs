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

test("denial terminates immediately; provider errors retry once and keep the private fix", () => {
  for (const [code, expected] of [[1, "denied"], [2, "unavailable"], [3, "timeout"]]) {
    const s = session(); s.controller.start(); s.watches[0].success(fix());
    const previous = s.controller.getSnapshot().position;
    s.watches[0].failure({ code });
    const retries = code === 1 ? 0 : 1;
    if (retries) {
      assert.equal(s.controller.getSnapshot().status, "requesting");
      assert.equal(s.watches[1].options.enableHighAccuracy, true);
      s.watches[1].failure({ code });
    }
    assert.equal(s.controller.getSnapshot().status, expected);
    assert.equal(s.controller.getSnapshot().position, code === 1 ? null : previous);
    assert.deepEqual(s.cleared, retries ? [0, 1] : [0]);
    s.setVisible(false); s.setVisible(true);
    assert.equal(s.watches.length, 1 + retries);
    s.controller.start();
    assert.equal(s.watches.length, 2 + retries);
    assert.equal(s.watches.at(-1).options.enableHighAccuracy, false);
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

test("an initial private lookup starts only with known granted permission and never retries after a manual stop", async () => {
  const s = session();
  s.permission.state = "granted";
  s.controller.setAutomaticStartPolicy(null); await settlePermission();
  assert.equal(s.watches.length, 0, "wait for sharing metadata before probing");
  s.controller.setAutomaticStartPolicy(true); await settlePermission();
  assert.equal(s.watches.length, 1); assert.equal(s.controller.getSnapshot().status, "requesting");
  s.watches[0].success(fix()); assert.equal(s.controller.getSnapshot().status, "active");
  s.controller.stop(); s.controller.setAutomaticStartPolicy(true);
  s.controller.setEnabled(false); s.controller.setEnabled(true); await settlePermission();
  assert.equal(s.watches.length, 1, "incidental renders and map return do not override a stop");
  s.deactivate();
});

test("prompt, denied and unavailable permission APIs never request automatic GPS or a browser prompt", async () => {
  for (const value of ["prompt", "denied", "missing", "reject"]) {
    const s = session(value === "missing" ? { queryPermission: undefined }
      : value === "reject" ? { queryPermission: () => Promise.reject(new Error("unsupported")) } : {});
    if (value === "prompt" || value === "denied") s.permission.state = value;
    s.controller.setAutomaticStartPolicy(true); await settlePermission();
    assert.equal(s.watches.length, 0); assert.equal(s.controller.getSnapshot().status, "idle");
    assert.equal(s.permissionListeners.size, 0);
    s.controller.start(); assert.equal(s.watches.length, 1, "the explicit private action remains usable");
    s.deactivate();
  }
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

test("delayed granted probes cannot start after stop, hidden/disabled transition, owner teardown or ghost", async () => {
  for (const interrupt of [s => s.controller.stop(), s => s.setVisible(false), s => s.controller.setEnabled(false),
    s => s.controller.setAutomaticStartPolicy(false), s => s.deactivate()]) {
    let resolve; const permission = new Promise(accept => { resolve = accept; });
    const s = session({ queryPermission: () => permission });
    s.permission.state = "granted"; s.controller.setAutomaticStartPolicy(true); interrupt(s);
    resolve(s.permission); await settlePermission();
    assert.equal(s.watches.length, 0); assert.equal(s.permissionListeners.size, 0);
    s.deactivate();
  }
});

test("strict effect replay fences the first granted probe and starts just one watch from the live activation", async () => {
  const probes = [];
  const s = session({ queryPermission: () => new Promise(resolve => probes.push(resolve)) });
  s.permission.state = "granted"; s.controller.setAutomaticStartPolicy(true);
  assert.equal(probes.length, 1); s.deactivate();
  const cleanup = s.controller.activate(); s.controller.setEnabled(true); s.controller.setAutomaticStartPolicy(true);
  assert.equal(probes.length, 2);
  probes[0](s.permission); await settlePermission(); assert.equal(s.watches.length, 0);
  probes[1](s.permission); await settlePermission(); assert.equal(s.watches.length, 1);
  if (probes[2]) probes[2](s.permission); await settlePermission();
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

test("a provider failure uses one high-accuracy watch and fences the earlier callbacks", () => {
  const s = session();
  s.controller.locate(); s.watches[0].success(fix());
  const previous = s.controller.getSnapshot().position;
  s.watches[0].failure({ code: 2 });
  assert.equal(s.watches.length, 2);
  assert.deepEqual(s.watches[1].options, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 });
  assert.equal(s.controller.getSnapshot().position, previous);
  s.watches[0].success(fix({ latitude: 10, timestamp: 999_000 })); s.watches[0].failure({ code: 1 });
  assert.equal(s.controller.getSnapshot().position, previous);
  assert.equal(s.controller.getSnapshot().status, "requesting");
  s.watches[1].success(fix({ latitude: 56, timestamp: 2_000 }));
  assert.equal(s.controller.getSnapshot().status, "active");
  assert.equal(s.controller.getSnapshot().position.latitude, 56);
  s.watches[1].failure({ code: 2 });
  assert.equal(s.watches.length, 2, "a successful retry does not create an endless fallback budget");
  assert.equal(s.controller.getSnapshot().position.timestamp, 2_000);
  assert.match(s.controller.getSnapshot().error, /настройках устройства и браузера/);
  s.deactivate();
});

test("visibility pauses the bounded fallback; stop and teardown retire it without reviving GPS", () => {
  for (const end of [s => s.controller.stop(), s => s.controller.freeze(), s => s.deactivate()]) {
    const s = session(); s.controller.locate(); s.watches[0].failure({ code: 3 });
    s.setVisible(false); s.setVisible(true);
    assert.equal(s.watches.length, 3);
    assert.equal(s.watches[2].options.enableHighAccuracy, true, "visibility does not reset the retry budget");
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
  assert.deepEqual(options.map(value => value.enableHighAccuracy), [false, true]);
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
