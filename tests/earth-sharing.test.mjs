import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthSharingController, browserEarthSharingEnvironment } = await vite.ssrLoadModule("/features/earth/sharing.ts");
const OWNER = "AAAA-BBBB-CCCC", OTHER = "DDDD-EEEE-FFFF";
const CIRCLE = "11111111-1111-4111-8111-111111111111";
const BASE = Date.parse("2026-10-18T17:00:00.000Z");
const options = { recipientCircleIds: [CIRCLE], precision: "APPROXIMATE", durationMinutes: 60 };
const id = sequence => `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function privacyBus() { return { values: new Map(), listeners: new Map() }; }
function fixture({ owner = OWNER, bus = privacyBus(), initial = {}, visible = true, online = true } = {}) {
  let mono = 0, wallOffset = 0, sequence = 0, timerSequence = 0, documentVisible = true;
  const timers = new Map(), visibilityListeners = new Set(), calls = { settings: [], people: [], updates: [], positions: [], stops: [], order: [] };
  const iso = offset => new Date(BASE + mono + offset).toISOString();
  let server = { ownerPublicId: owner, mode: "OFF", revision: 0, precision: "APPROXIMATE", recipientCircleIds: [],
    frozenCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: iso(0), ...initial };
  const clock = {
    mono: () => mono, wall: () => BASE + mono + wallOffset, iso,
    rollback: amount => { wallOffset -= amount; },
    callbacks: () => [...timers.values()].map(timer => timer.callback),
    async advance(duration) {
      const end = mono + duration;
      for (;;) {
        const [key, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0] ?? [];
        if (!timer || timer.due > end) break;
        mono = timer.due; timers.delete(key); timer.callback(); await flush();
      }
      mono = end; await flush();
    },
  };
  const environment = {
    now: clock.wall, monotonicNow: clock.mono,
    schedule(callback, delay) { const key = ++timerSequence; timers.set(key, { callback, due: mono + delay }); return key; },
    cancel: key => timers.delete(key), visible: () => documentVisible,
    onVisibilityChange(callback) { visibilityListeners.add(callback); return () => visibilityListeners.delete(callback); },
    loadPending: () => bus.values.get(owner) ?? null,
    savePending(intent) { bus.values.set(owner, { ...intent }); for (const listener of bus.listeners.get(owner) ?? []) listener({ ...intent }); },
    clearPending(key) {
      if (bus.values.get(owner)?.key !== key) return;
      bus.values.delete(owner); for (const listener of bus.listeners.get(owner) ?? []) listener(null);
    },
    onPendingChange(callback) {
      if (!bus.listeners.has(owner)) bus.listeners.set(owner, new Set()); bus.listeners.get(owner).add(callback);
      return () => bus.listeners.get(owner).delete(callback);
    },
    createId: () => id(++sequence),
  };
  const transport = {
    async getEarthSharing(signal) { calls.settings.push(signal); calls.order.push("get"); return { ...server, publicationEpoch: null, serverTime: iso(0) }; },
    async updateEarthSharing(write, key, signal) {
      calls.updates.push({ write, key, signal }); calls.order.push(`update:${write.mode}`);
      if (write.frozenOnly && write.mode === "SHARING") {
        server = { ...server, revision: server.revision + 1, recipientCircleIds: [...write.recipientCircleIds],
          frozenCircleIds: [...(write.frozenCircleIds ?? [])],
          ...(write.recipientCircleIds.length ? {} : { mode: "OFF", sharingUntil: null }), publicationEpoch: null, serverTime: iso(0) };
        return { ...server };
      }
      server = { ...server, mode: write.mode, revision: server.revision + 1,
        recipientCircleIds: write.mode === "GHOST" ? server.recipientCircleIds : write.mode === "OFF" ? [] : write.recipientCircleIds,
        frozenCircleIds: write.mode === "GHOST" ? server.frozenCircleIds : write.mode === "OFF" ? [] : write.frozenCircleIds ?? [],
        precision: write.mode === "GHOST" ? server.precision : write.precision,
        sharingUntil: write.mode === "SHARING" && write.durationMinutes !== null ? iso(write.durationMinutes * 60_000) : null,
        publicationEpoch: write.mode === "SHARING" ? id(++sequence) : null, serverTime: iso(0) };
      return { ...server };
    },
    async publishEarthPosition(write, key, signal) {
      calls.positions.push({ write, key, signal });
      return { ownerPublicId: owner, acceptedAt: iso(0), expiresAt: iso(120_000), serverTime: iso(0) };
    },
    async stopEarthPublication(write, key, signal) { calls.stops.push({ write, key, signal }); return { ownerPublicId: owner, serverTime: iso(0) }; },
    async getEarthPeople(signal) { calls.people.push(signal); calls.order.push("people"); return { ownerPublicId: owner, people: [], serverTime: iso(0) }; },
  };
  let lost = 0;
  const controller = createEarthSharingController({ ownerPublicId: owner, transport, getEnvironment: () => environment, onSessionLost: () => lost++ });
  let deactivate;
  return { controller, calls, transport, environment, timers, bus, clock,
    get lost() { return lost; },
    async start() { deactivate = controller.activate(); controller.setContext({ visible, isOnline: online }); await flush(); },
    stop() { deactivate?.(); },
    context(next) { if ("visible" in next) visible = next.visible; if ("online" in next) online = next.online;
      controller.setContext({ visible, isOnline: online }); },
    hide(value) { documentVisible = !value; for (const callback of visibilityListeners) callback(); },
    fix(overrides = {}) { return { latitude: 55.7558123, longitude: 37.6178391, accuracy: 23, timestamp: clock.wall(), ...overrides }; },
    person(overrides = {}) { return { circleId: CIRCLE, user: { publicId: OTHER, displayName: "Друг" }, latitude: 55.75, longitude: 37.62,
      accuracyMeters: 1_500, precision: "APPROXIMATE", updatedAt: iso(0), expiresAt: iso(120_000), ...overrides }; },
  };
}

test("persisted consent and private WhereIam never acquire a publisher, including after F5", async t => {
  const s = fixture({ initial: { mode: "SHARING", revision: 5, recipientCircleIds: [CIRCLE] } }); t.after(() => s.stop());
  await s.start(); s.controller.setPosition(s.fix()); await flush();
  assert.equal(s.controller.getSnapshot().settings.mode, "SHARING");
  assert.equal(s.controller.getSnapshot().settings.publicationEpoch, null);
  assert.equal(s.controller.getSnapshot().publishing, false);
  assert.equal(s.calls.positions.length, 0); assert.equal(s.calls.updates.length, 0);
});

test("explicit sharing requires selected direct friends and publishes only a new approximate fix", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start();
  assert.equal(await s.controller.share({ ...options, recipientCircleIds: [] }), false);
  assert.equal(s.calls.updates.length, 0);
  const oldPrivateFix = s.fix(); await s.clock.advance(1_000);
  assert.equal(await s.controller.share(options), true);
  s.controller.setPosition(null); assert.equal(s.controller.getSnapshot().publishing, true, "waiting for permission is not a GPS failure");
  s.controller.setPosition(oldPrivateFix); await flush(); assert.equal(s.calls.positions.length, 0);
  s.controller.setPosition(s.fix()); await flush();
  assert.equal(s.calls.positions.length, 1);
  assert.deepEqual(s.calls.positions[0].write, { expectedOwnerPublicId: OWNER, publicationEpoch: s.calls.updates[0] ? id(2) : "",
    sequence: 1, latitude: 55.76, longitude: 37.62, accuracyMeters: 1_500, capturedAt: s.clock.iso(0) });
  assert.equal(s.controller.getSnapshot().settings.publicationEpoch, null, "publisher capability is not rendered or persisted");
  assert.equal(s.bus.values.size, 0, "GPS fixes never enter privacy-intent storage");
});

test("GPS fixes are single-use, updates have a 30-second budget, and offline fixes are discarded", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start(); await s.controller.share(options);
  const first = s.fix(); s.controller.setPosition(first); await flush();
  s.controller.setPosition(first); await s.clock.advance(1_000); s.controller.setPosition(s.fix());
  await s.clock.advance(28_999); assert.equal(s.calls.positions.length, 1);
  await s.clock.advance(1); assert.equal(s.calls.positions.length, 2);
  assert.equal(s.calls.positions[1].write.sequence, 2);
  s.context({ online: false }); s.controller.setPosition(s.fix()); await s.clock.advance(120_000);
  assert.equal(s.calls.positions.length, 2); assert.equal(s.controller.getSnapshot().publishing, false);
  s.context({ online: true }); await flush(); s.controller.setPosition(s.fix()); await flush();
  assert.equal(s.calls.positions.length, 2, "a connection return never resumes an old publisher");
});

test("hiding aborts feed/upload, clears RAM markers, stops the scoped publisher and leaves no timers", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start(); await s.controller.share(options);
  const upload = deferred(), feed = deferred();
  s.transport.publishEarthPosition = (write, key, signal) => { s.calls.positions.push({ write, key, signal }); return upload.promise; };
  s.transport.getEarthPeople = signal => { s.calls.people.push(signal); return feed.promise; };
  s.controller.setPosition(s.fix()); s.controller.refresh(); await flush();
  const oldFeed = s.calls.people.at(-1), oldUpload = s.calls.positions.at(-1).signal;
  s.hide(true);
  assert.equal(oldFeed.aborted, true); assert.equal(oldUpload.aborted, true);
  assert.equal(s.controller.getSnapshot().publishing, false); assert.deepEqual(s.controller.getSnapshot().people, []);
  assert.equal(s.timers.size, 0); assert.equal(s.calls.stops.length, 1);
  upload.resolve({ ownerPublicId: OWNER, acceptedAt: s.clock.iso(0), expiresAt: s.clock.iso(120_000), serverTime: s.clock.iso(0) });
  feed.resolve({ ownerPublicId: OWNER, people: [s.person()], serverTime: s.clock.iso(0) }); await flush();
  assert.deepEqual(s.controller.getSnapshot().people, []); assert.equal(s.controller.getSnapshot().lastPublishedAt, null);
  await s.clock.advance(180_000); assert.equal(s.timers.size, 0);
  s.hide(false); await flush(); assert.equal(s.controller.getSnapshot().publishing, false);
});

test("ghost is synchronous, fences an in-flight grant, and its retry survives Earth leaving", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start();
  const enable = deferred();
  const realUpdate = s.transport.updateEarthSharing;
  s.transport.updateEarthSharing = (write, key, signal) => write.mode === "SHARING" ? enable.promise : realUpdate(write, key, signal);
  const granting = s.controller.share(options);
  s.controller.ghost();
  assert.equal(s.controller.getSnapshot().pendingGhost, true);
  assert.equal(s.controller.getSnapshot().settings.mode, "GHOST");
  assert.equal(s.controller.getSnapshot().publishing, false);
  s.context({ visible: false });
  enable.resolve({ ownerPublicId: OWNER, mode: "SHARING", revision: 1, precision: "APPROXIMATE", recipientCircleIds: [CIRCLE],
    sharingUntil: null, publicationEpoch: id(99), serverTime: s.clock.iso(0) });
  assert.equal(await granting, false); await flush();
  assert.equal(s.controller.getSnapshot().settings.mode, "GHOST"); assert.equal(s.controller.getSnapshot().pendingGhost, false);
  assert.equal(s.calls.updates.at(-1).write.mode, "GHOST"); assert.equal(s.timers.size, 0);
});

test("pending owner hide intent contains no coordinates and is replayed before reads after reload", async t => {
  const bus = privacyBus(), first = fixture({ bus }); t.after(() => first.stop()); await first.start();
  first.context({ online: false }); first.controller.ghost(); first.controller.setPosition(first.fix());
  const pending = bus.values.get(OWNER); assert.deepEqual(Object.keys(pending).sort(), ["key", "mode"]);
  first.stop();
  const next = fixture({ bus }); t.after(() => next.stop()); await next.start();
  assert.equal(next.calls.order[0], "update:GHOST"); assert.equal(next.controller.getSnapshot().pendingGhost, false);
  assert.equal(bus.values.size, 0);
});

test("cross-tab hide stops another publisher immediately and ghost may still receive allowed friends", async t => {
  const bus = privacyBus(), first = fixture({ bus }), second = fixture({ bus });
  t.after(() => { first.stop(); second.stop(); }); await first.start(); await second.start();
  await first.controller.share(options); first.controller.setPosition(first.fix()); await flush();
  second.controller.ghost();
  assert.equal(first.controller.getSnapshot().publishing, false); assert.equal(first.calls.stops.length, 1);
  await flush();
  first.transport.getEarthPeople = async () => ({ ownerPublicId: OWNER, people: [first.person()], serverTime: first.clock.iso(0) });
  first.controller.refresh(); await flush();
  assert.equal(first.controller.getSnapshot().settings.mode, "GHOST");
  assert.equal(first.controller.getSnapshot().people.length, 1, "visibility is not forced reciprocal");
});

test("feed expiry is monotonic, subtracts request elapsed, and repeated old snapshots cannot extend visibility", async t => {
  const s = fixture(); t.after(() => s.stop());
  const person = s.person(), snapshot = { ownerPublicId: OWNER, people: [person], serverTime: s.clock.iso(0) };
  const response = deferred(); s.transport.getEarthPeople = () => response.promise;
  await s.start(); await s.clock.advance(5_000); response.resolve(snapshot); await flush();
  assert.equal(s.controller.getSnapshot().people[0].expiresAtMonotonic, 120_000);
  const firstDeadline = s.controller.getSnapshot().people[0].expiresAtMonotonic;
  s.clock.rollback(86_400_000);
  s.transport.getEarthPeople = async () => snapshot;
  await s.clock.advance(15_000);
  assert.ok(s.controller.getSnapshot().people[0].expiresAtMonotonic <= firstDeadline);
  await s.clock.advance(100_000);
  assert.deepEqual(s.controller.getSnapshot().people, []);
});

test("a last-known friend remains visible beyond two minutes without renewing its original deadline", async t => {
  const s = fixture(); t.after(() => s.stop());
  const lifetime = 86_400_000;
  const person = s.person({ expiresAt: s.clock.iso(lifetime) });
  s.transport.getEarthPeople = async () => ({ ownerPublicId: OWNER, people: [person], serverTime: s.clock.iso(0) });
  await s.start();
  const expires = s.controller.getSnapshot().people[0].expiresAtMonotonic;
  await s.clock.advance(180_000);
  assert.equal(s.controller.getSnapshot().people.length, 1);
  assert.equal(s.controller.getSnapshot().people[0].updatedAt, person.updatedAt);
  assert.ok(s.controller.getSnapshot().people[0].expiresAtMonotonic <= expires);
  s.context({ online: false });
  await s.clock.advance(lifetime);
  s.context({ online: true }); await flush();
  assert.deepEqual(s.controller.getSnapshot().people, [], "a replay cannot resurrect the expired original fix");
});

test("409 and 401 retire publishers without adopting a GET epoch or repeatedly reauthenticating", async t => {
  for (const status of [409, 401]) {
    const s = fixture(); t.after(() => s.stop()); await s.start(); await s.controller.share(options);
    s.transport.publishEarthPosition = async () => { throw { status }; };
    s.controller.setPosition(s.fix()); await flush();
    assert.equal(s.controller.getSnapshot().publishing, false);
    s.controller.setPosition(s.fix({ timestamp: s.clock.wall() + 1 })); await flush();
    assert.equal(s.calls.updates.length, 1, "a conflict never automatically enables a publisher again");
    assert.equal(s.lost, status === 401 ? 1 : 0);
  }
});

test("privacy failures retry in the background, but 401 ends the loop and does not erase the persisted hide intent", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start();
  let attempts = 0;
  s.transport.updateEarthSharing = async () => { attempts++; throw { status: attempts === 1 ? 503 : 401 }; };
  s.controller.ghost(); s.context({ visible: false }); await flush();
  assert.equal(s.controller.getSnapshot().pendingGhost, true); assert.equal(s.timers.size, 1);
  await s.clock.advance(1_000);
  assert.equal(attempts, 2); assert.equal(s.lost, 1); assert.equal(s.timers.size, 0);
  await s.clock.advance(300_000); assert.equal(attempts, 2); assert.equal(s.bus.values.get(OWNER).mode, "GHOST");
});

test("owner mismatches and old-owner async completion cannot expose positions or activate a publisher", async t => {
  const old = fixture(); t.after(() => old.stop()); await old.start();
  const response = deferred(); old.transport.getEarthPeople = () => response.promise; old.controller.refresh();
  old.stop();
  const next = fixture({ owner: OTHER }); t.after(() => next.stop()); await next.start();
  response.resolve({ ownerPublicId: OWNER, people: [old.person()], serverTime: old.clock.iso(0) }); await flush();
  assert.deepEqual(next.controller.getSnapshot().people, []); assert.deepEqual(old.controller.getSnapshot().people, []);
  next.transport.getEarthPeople = async () => ({ ownerPublicId: OWNER, people: [old.person()], serverTime: old.clock.iso(0) });
  next.controller.refresh(); await flush();
  assert.deepEqual(next.controller.getSnapshot().people, []); assert.match(next.controller.getSnapshot().error, /владелец/);
});

test("malformed and oversized feeds fail closed, and disposal fences queued timers and pending writes", async () => {
  const s = fixture(); await s.start();
  s.transport.getEarthPeople = async () => ({ ownerPublicId: OWNER, people: Array.from({ length: 101 }, () => s.person()), serverTime: s.clock.iso(0) });
  s.controller.refresh(); await flush(); assert.deepEqual(s.controller.getSnapshot().people, []);
  const queued = s.clock.callbacks(); s.stop(); for (const callback of queued) callback(); await flush();
  s.controller.refresh(); s.controller.ghost(); s.controller.setPosition(s.fix());
  assert.equal(s.timers.size, 0); assert.deepEqual(s.controller.getSnapshot().people, []);
});


test("cross-tab emergency hide still broadcasts when persistent browser storage fails", () => {
  const originalWindow = globalThis.window, originalChannel = globalThis.BroadcastChannel;
  const messages = []; let closed = false;
  globalThis.window = { localStorage: { getItem: () => null, setItem() { throw new Error("quota"); } },
    addEventListener() {}, removeEventListener() {} };
  globalThis.BroadcastChannel = class {
    postMessage(value) { messages.push(value); } addEventListener() {} removeEventListener() {} close() { closed = true; }
  };
  try {
    const environment = browserEarthSharingEnvironment(OWNER);
    const remove = environment.onPendingChange(() => {});
    const intent = { mode: "GHOST", key: id(1) };
    assert.throws(() => environment.savePending(intent), /quota/);
    assert.deepEqual(messages, [intent], "storage failure must not prevent another live tab from hiding");
    remove(); assert.equal(closed, true);
  } finally { globalThis.window = originalWindow; globalThis.BroadcastChannel = originalChannel; }
});

test("fast ghost then off serializes hide intents and only acknowledges the newest one", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start();
  const first = deferred(), second = deferred(); let attempt = 0;
  s.transport.updateEarthSharing = (write, key, signal) => {
    s.calls.updates.push({ write, key, signal });
    return ++attempt === 1 ? first.promise : second.promise;
  };
  s.controller.ghost(); s.controller.off();
  assert.equal(s.calls.updates.length, 1); assert.equal(s.controller.getSnapshot().pendingPrivacyMode, "OFF");
  first.resolve({ ownerPublicId: OWNER, mode: "GHOST", revision: 1, precision: "APPROXIMATE",
    recipientCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: s.clock.iso(0) });
  await flush(); assert.equal(s.calls.updates.length, 2); assert.equal(s.calls.updates[1].write.mode, "OFF");
  assert.equal(s.controller.getSnapshot().pendingGhost, true);
  second.resolve({ ownerPublicId: OWNER, mode: "OFF", revision: 2, precision: "APPROXIMATE",
    recipientCircleIds: [], sharingUntil: null, publicationEpoch: null, serverTime: s.clock.iso(0) });
  await flush(); assert.equal(s.controller.getSnapshot().pendingGhost, false);
  assert.equal(s.controller.getSnapshot().settings.mode, "OFF");
});

test("precise consent sends just the latest requested fields and a publication expires without renewing a stale fix", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start();
  await s.controller.share({ ...options, precision: "PRECISE", durationMinutes: null });
  const fix = s.fix(); s.controller.setPosition({ ...fix, altitude: 100, speed: 9 }); await flush();
  const write = s.calls.positions[0].write;
  assert.equal(write.latitude, fix.latitude); assert.equal(write.longitude, fix.longitude); assert.equal(write.accuracyMeters, 23);
  assert.equal("altitude" in write, false); assert.equal("speed" in write, false);
  await s.clock.advance(120_000);
  assert.equal(s.controller.getSnapshot().lastPublishedAt, null);
  assert.equal(s.calls.positions.length, 1, "there is no position heartbeat from an old GPS fix");
});


test("stopping during an in-flight explicit grant fences its late publisher capability", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start();
  const grant = deferred(); let signal;
  s.transport.updateEarthSharing = (_write, _key, requestSignal) => { signal = requestSignal; return grant.promise; };
  const sharing = s.controller.share(options);
  s.controller.stopPublishing(); assert.equal(signal.aborted, true);
  grant.resolve({ ownerPublicId: OWNER, mode: "SHARING", revision: 1, precision: "APPROXIMATE", recipientCircleIds: [CIRCLE],
    sharingUntil: null, publicationEpoch: id(90), serverTime: s.clock.iso(0) });
  assert.equal(await sharing, false);
  assert.equal(s.controller.getSnapshot().publishing, false); assert.equal(s.controller.getSnapshot().saving, false);
  s.controller.setPosition(s.fix()); await flush(); assert.equal(s.calls.positions.length, 0);
});


test("privacy idempotency bodies remain canonical across cached revisions, tabs, and reloads", async t => {
  const bus = privacyBus();
  const first = fixture({ bus, initial: { mode: "SHARING", revision: 17, precision: "PRECISE", recipientCircleIds: [CIRCLE] } });
  t.after(() => first.stop()); await first.start();
  first.context({ online: false }); first.controller.ghost();
  const intent = { ...bus.values.get(OWNER) }; first.stop();
  const replay = fixture({ bus, initial: { mode: "SHARING", revision: 90, precision: "PRECISE", recipientCircleIds: [CIRCLE] } });
  t.after(() => replay.stop()); await replay.start();
  assert.deepEqual(replay.calls.updates[0], {
    write: { expectedOwnerPublicId: OWNER, expectedRevision: 0, mode: "GHOST", precision: "APPROXIMATE", recipientCircleIds: [], durationMinutes: null },
    key: intent.key, signal: replay.calls.updates[0].signal,
  });
  assert.equal(replay.controller.getSnapshot().settings.precision, "PRECISE");
  assert.deepEqual(replay.controller.getSnapshot().settings.recipientCircleIds, [CIRCLE]);
  replay.controller.off(); await flush();
  assert.deepEqual(replay.calls.updates.at(-1).write, { expectedOwnerPublicId: OWNER, expectedRevision: 0, mode: "OFF",
    precision: "APPROXIMATE", recipientCircleIds: [], durationMinutes: null });
});

test("a new fix during upload retains only the latest foreground sample and flushes after the 30-second budget", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start(); await s.controller.share(options);
  const first = deferred();
  s.transport.publishEarthPosition = (write, key, signal) => {
    s.calls.positions.push({ write, key, signal });
    return s.calls.positions.length === 1 ? first.promise : Promise.resolve({ ownerPublicId: OWNER,
      acceptedAt: s.clock.iso(0), expiresAt: s.clock.iso(120_000), serverTime: s.clock.iso(0) });
  };
  s.controller.setPosition(s.fix()); await flush();
  await s.clock.advance(1_000); s.controller.setPosition(s.fix({ latitude: 55.71 }));
  await s.clock.advance(1_000); const latest = s.fix({ latitude: 55.79 }); s.controller.setPosition(latest);
  await s.clock.advance(6_000);
  first.resolve({ ownerPublicId: OWNER, acceptedAt: s.clock.iso(0), expiresAt: s.clock.iso(120_000), serverTime: s.clock.iso(0) });
  await flush();
  assert.equal(s.calls.positions.length, 1);
  await s.clock.advance(21_999); assert.equal(s.calls.positions.length, 1);
  await s.clock.advance(1);
  assert.equal(s.calls.positions.length, 2);
  assert.equal(s.calls.positions[1].write.latitude, 55.79);
  assert.equal(s.calls.positions[1].write.capturedAt, new Date(latest.timestamp).toISOString());
  assert.equal(s.calls.positions[1].write.sequence, 2);
  await s.clock.advance(120_000); assert.equal(s.calls.positions.length, 2, "neither sample is retried as a heartbeat");
});

test("individual freeze preserves an existing publisher and deadline without a new enable or a GPS heartbeat", async t => {
  const second = id(501), s = fixture(); t.after(() => s.stop()); await s.start();
  await s.controller.share({ ...options, recipientCircleIds: [CIRCLE, second] });
  s.controller.setPosition(s.fix()); await flush();
  const originalEpoch = s.calls.positions[0].write.publicationEpoch, until = s.controller.getSnapshot().settings.sharingUntil;
  await s.clock.advance(30_000);
  assert.equal(await s.controller.setFrozen(CIRCLE, true), true);
  assert.equal(s.calls.updates.at(-1).write.frozenOnly, true);
  assert.deepEqual(s.calls.updates.at(-1).write.frozenCircleIds, [CIRCLE]);
  assert.equal(s.controller.getSnapshot().settings.sharingUntil, until);
  assert.equal(s.controller.getSnapshot().publishing, true); assert.equal(s.calls.stops.length, 0);
  assert.equal(s.calls.positions.length, 1, "changing preferences never publishes or reuses a fix");
  s.controller.setPosition(s.fix()); await flush();
  assert.equal(s.calls.positions.length, 2); assert.equal(s.calls.positions[1].write.publicationEpoch, originalEpoch);
  assert.equal(s.calls.positions[1].write.sequence, 2);
});

test("freeze and unfreeze on a paused session save preferences without acquiring a publisher or extending consent", async t => {
  const until = new Date(BASE + 3_600_000).toISOString();
  const s = fixture({ initial: { mode: "SHARING", revision: 8, recipientCircleIds: [CIRCLE], sharingUntil: until } });
  t.after(() => s.stop()); await s.start();
  assert.equal(await s.controller.setFrozen(CIRCLE, true), true);
  assert.deepEqual(s.controller.getSnapshot().settings.frozenCircleIds, [CIRCLE]);
  assert.equal(await s.controller.setFrozen(CIRCLE, false), true);
  assert.equal(s.controller.getSnapshot().publishing, false); assert.equal(s.controller.getSnapshot().settings.sharingUntil, until);
  s.controller.setPosition(s.fix()); await flush(); assert.equal(s.calls.positions.length, 0);
  assert.equal(s.calls.updates.length, 2); assert.equal(s.calls.stops.length, 0);
});

test("freezing every recipient stops the current publisher and unfreezing cannot restart it", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start(); await s.controller.share(options);
  assert.equal(await s.controller.setFrozen(CIRCLE, true), true);
  assert.equal(s.controller.getSnapshot().publishing, false); assert.equal(s.calls.stops.length, 1);
  assert.equal(await s.controller.setFrozen(CIRCLE, false), true);
  assert.equal(s.controller.getSnapshot().publishing, false);
  s.controller.setPosition(s.fix()); await flush(); assert.equal(s.calls.positions.length, 0);
  assert.equal(await s.controller.share({ ...options, frozenCircleIds: [CIRCLE] }), true);
  assert.equal(s.controller.getSnapshot().publishing, false, "a fully frozen explicit selection also has no reason to start GPS");
});

test("narrow revocation keeps other recipients live and removing the final recipient turns access OFF", async t => {
  const second = id(502), s = fixture(); t.after(() => s.stop()); await s.start();
  await s.controller.share({ ...options, recipientCircleIds: [CIRCLE, second] });
  assert.equal(await s.controller.revokeRecipient(CIRCLE), true);
  assert.deepEqual(s.controller.getSnapshot().settings.recipientCircleIds, [second]);
  assert.equal(s.controller.getSnapshot().publishing, true); assert.equal(s.calls.stops.length, 0);
  assert.equal(await s.controller.setFrozen(CIRCLE, true), false);
  assert.equal(await s.controller.revokeRecipient(second), true);
  assert.equal(s.controller.getSnapshot().settings.mode, "OFF"); assert.equal(s.controller.getSnapshot().publishing, false);
  assert.deepEqual(s.controller.getSnapshot().settings.frozenCircleIds, []); assert.equal(s.calls.stops.length, 1);
});

test("an uncertain preference change suppresses outbound samples and fails closed without an automatic restart", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start(); await s.controller.share(options);
  const deferredChange = deferred(); s.transport.updateEarthSharing = () => deferredChange.promise;
  const changing = s.controller.setFrozen(CIRCLE, true);
  assert.equal(s.controller.getSnapshot().saving, true);
  s.controller.setPosition(s.fix()); await flush(); assert.equal(s.calls.positions.length, 0);
  deferredChange.reject(new Error("network uncertain")); assert.equal(await changing, false);
  assert.equal(s.controller.getSnapshot().publishing, false); assert.equal(s.controller.getSnapshot().saving, false);
  s.controller.setPosition(s.fix()); await flush(); assert.equal(s.calls.positions.length, 0);
  assert.match(s.controller.getSnapshot().error, /network uncertain/);
});

test("global privacy intent fences a late preference reply and survives its aborted transport", async t => {
  const s = fixture(); t.after(() => s.stop()); await s.start(); await s.controller.share(options);
  const pendingChange = deferred(), original = s.transport.updateEarthSharing; let signal;
  s.transport.updateEarthSharing = (write, key, requestSignal) => {
    if (write.frozenOnly) { signal = requestSignal; return pendingChange.promise; }
    return original(write, key, requestSignal);
  };
  const changing = s.controller.setFrozen(CIRCLE, true);
  s.controller.ghost(); await flush(); assert.equal(signal.aborted, true);
  pendingChange.resolve({ ...s.controller.getSnapshot().settings, mode: "SHARING", revision: 99, publicationEpoch: null,
    recipientCircleIds: [CIRCLE], frozenCircleIds: [CIRCLE] });
  assert.equal(await changing, false);
  assert.equal(s.controller.getSnapshot().settings.mode, "GHOST"); assert.equal(s.controller.getSnapshot().publishing, false);
  assert.equal(await s.controller.setFrozen(CIRCLE, false), false);
});

test("preference acknowledgements cannot add recipients or extend expiry and disposal rejects late replies", async t => {
  for (const change of [settings => ({ ...settings, sharingUntil: new Date(BASE + 9_000_000).toISOString() }),
    settings => ({ ...settings, recipientCircleIds: [...settings.recipientCircleIds, id(503)] })]) {
    const s = fixture(); t.after(() => s.stop()); await s.start(); await s.controller.share(options);
    const original = s.transport.updateEarthSharing;
    s.transport.updateEarthSharing = async (...args) => change(await original(...args));
    assert.equal(await s.controller.setFrozen(CIRCLE, true), false);
    assert.equal(s.controller.getSnapshot().publishing, false); assert.match(s.controller.getSnapshot().error, /не подтвердил/);
  }
  const s = fixture(); await s.start(); await s.controller.share(options);
  const pendingChange = deferred(); s.transport.updateEarthSharing = () => pendingChange.promise;
  const changing = s.controller.setFrozen(CIRCLE, true), old = s.controller.getSnapshot().settings;
  s.stop(); pendingChange.resolve({ ...old, revision: old.revision + 1, frozenCircleIds: [CIRCLE], publicationEpoch: null });
  assert.equal(await changing, false); assert.equal(s.controller.getSnapshot().settings, null);
});

test("a loaded global ghost can revoke one recipient without unghosting or restarting publication", async t => {
  const second = id(504), until = new Date(BASE + 3_600_000).toISOString();
  const s = fixture({ initial: { mode: "GHOST", revision: 12, recipientCircleIds: [CIRCLE, second], frozenCircleIds: [CIRCLE], sharingUntil: until } });
  t.after(() => s.stop()); await s.start();
  assert.equal(await s.controller.revokeRecipient(CIRCLE), true);
  const settings = s.controller.getSnapshot().settings, write = s.calls.updates[0].write;
  assert.equal(write.mode, "SHARING"); assert.equal(write.frozenOnly, true, "the narrow wire intent never enables sharing");
  assert.deepEqual(write.recipientCircleIds, [second]); assert.deepEqual(write.frozenCircleIds, []);
  assert.equal(settings.mode, "GHOST"); assert.equal(settings.publicationEpoch, null); assert.equal(settings.sharingUntil, until);
  assert.deepEqual(settings.recipientCircleIds, [second]); assert.equal(s.controller.getSnapshot().publishing, false);
  assert.equal(await s.controller.setFrozen(second, true), false, "individual live/frozen switches remain inherited from the global ghost");
  s.controller.setPosition(s.fix()); await flush(); assert.equal(s.calls.positions.length, 0); assert.equal(s.calls.stops.length, 0);
  assert.equal(await s.controller.revokeRecipient(second), true);
  assert.equal(s.controller.getSnapshot().settings.mode, "OFF"); assert.equal(s.controller.getSnapshot().settings.sharingUntil, null);
  assert.equal(s.controller.getSnapshot().publishing, false); assert.equal(s.calls.positions.length, 0);
  assert.equal(s.calls.updates.every(call => call.write.frozenOnly === true), true);
});
