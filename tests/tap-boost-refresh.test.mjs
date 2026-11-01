import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const virtual = "virtual:tap-refresh-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "tap-refresh-lifecycle", enforce: "pre",
    resolveId(id) { if (id === virtual) return `\0${id}`; },
    load(id) { if (id === `\0${virtual}`) return `
      let slots = [], cursor = 0, pending = [];
      export function render() { cursor = 0; }
      export function useRef(value) { return slots[cursor++] ??= { current: value }; }
      export function useEffect(callback, deps) {
        const index = cursor++, previous = slots[index];
        if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
          pending.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
        }
      }
      export function flush() { const effects = pending; pending = []; effects.forEach(fn => fn()); }
      export function reset() { slots.forEach(slot => slot.cleanup?.()); slots = []; cursor = 0; pending = []; }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/integration/use-tap-boost-refresh.ts"))
      return source.replace('from "react";', `from "${virtual}";`); },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(virtual);
const { useTapBoostRefresh } = await vite.ssrLoadModule("/features/economy/integration/use-tap-boost-refresh.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const owner = "AAAA-0000-0001";
function snapshot(revision = 0, charge = 0) {
  return { ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 }), ownerPublicId: owner, revision, serverTime: "2026-11-01T12:00:00Z", catalog: economyCatalog,
    tapBoost: { charge, powerBps: charge ? 100 : 0, grantedAt: null, appliedAt: null, expiresAt: null, jobId: null },
    storage: { capacity: 50, used: 0, reserved: 0, available: 50, overflow: 0 } };
}
const market = async () => ({ ownerPublicId: owner, listings: [], mine: [], nextCursor: null, serverTime: "2026-11-01T12:00:00Z" });
const receipt = state => ({ state, acceptedRevision: state.revision, message: "Готово", replayed: false });
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function browser(run) {
  const descriptors = Object.fromEntries(["document", "window", "navigator", "performance"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new EventTarget(), window = new EventTarget(), navigator = { onLine: true };
  let now = 0, nextId = 1;
  const timers = new Map();
  document.hidden = false;
  window.setTimeout = (callback, delay) => { const id = nextId++; timers.set(id, { at: now + delay, callback }); return id; };
  window.clearTimeout = id => timers.delete(id);
  for (const [key, value] of Object.entries({ document, window, navigator, performance: { now: () => now } }))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  hooks.reset();
  let props = { owner: "ME", taps: 0, hasWork: true, refresh: async () => true };
  function useRefreshRender(patch = {}) { props = { ...props, ...patch }; hooks.render(); useTapBoostRefresh(props.owner, props.taps, props.hasWork, props.refresh); hooks.flush(); }
  const tick = async milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await settle();
    }
    now = end; await settle();
  };
  try { await run({ render: useRefreshRender, tick, document, window, navigator, timers, unmount: hooks.reset, now: () => now }); }
  finally { hooks.reset(); for (const [key, descriptor] of Object.entries(descriptors))
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
}

test("the first new confirmed tap reads immediately, without an initial or unchanged polling request", () => browser(async ({ render, tick, timers, now }) => {
  const reads = [];
  const refresh = async () => { reads.push(now()); return true; };
  render({ taps: 500, refresh }); await tick(10_000);
  assert.deepEqual(reads, []);
  render({ taps: 501 }); assert.deepEqual(reads, [10_000]);
  await settle(); render({ taps: 501 }); await tick(5000);
  assert.equal(reads.length, 1); assert.equal(timers.size, 0);
}));

test("rapid receipts coalesce at 750 ms and keep a single read in flight with a trailing latest read", () => browser(async ({ render, tick, now, timers }) => {
  const first = deferred(), reads = [];
  render({ refresh: () => { reads.push(now()); return reads.length === 1 ? first.promise : Promise.resolve(true); } });
  render({ taps: 1 }); render({ taps: 50 }); await tick(100); render({ taps: 100 }); await tick(900);
  assert.deepEqual(reads, [0]); assert.equal(timers.size, 0, "no polling during the outstanding read");
  first.resolve(true); await settle(); assert.deepEqual(reads, [0, 1000]);
  render({ taps: 101 }); await tick(749); assert.equal(reads.length, 2);
  await tick(1); assert.deepEqual(reads, [0, 1000, 1750]);
  await tick(1000); assert.equal(reads.length, 3);
}));

test("hidden or offline receipts wait for availability, then fetch once without replaying each tap", () => browser(async ({ render, tick, document, window, navigator, timers }) => {
  let reads = 0;
  render({ refresh: async () => { reads++; return true; } });
  document.hidden = true; render({ taps: 1 }); render({ taps: 10 }); await tick(2000);
  assert.equal(reads, 0); assert.equal(timers.size, 0);
  navigator.onLine = false; document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(reads, 0);
  navigator.onLine = true; window.dispatchEvent(new Event("online")); await settle();
  assert.equal(reads, 1);
  document.dispatchEvent(new Event("visibilitychange")); await tick(1000); assert.equal(reads, 1);
  render({ taps: 11 }); await settle(); render({ taps: 12 });
  navigator.onLine = false; window.dispatchEvent(new Event("offline"));
  assert.equal(timers.size, 0); await tick(2000); assert.equal(reads, 2);
  navigator.onLine = true; window.dispatchEvent(new Event("online")); await settle(); assert.equal(reads, 3);
}));

test("owner changes, idle work and counter resets establish a baseline; an old in-flight result cannot consume the new owner", () => browser(async ({ render, tick, timers, unmount }) => {
  const first = deferred(), calls = [];
  render({ refresh: () => { calls.push("old"); return first.promise; } }); render({ taps: 1 });
  render({ owner: "OTHER", taps: 100, refresh: async () => { calls.push("new"); return true; } });
  render({ taps: 101 }); await tick(1000); assert.deepEqual(calls, ["old"]);
  first.resolve(true); await settle(); assert.deepEqual(calls, ["old", "new"]);
  render({ hasWork: false, taps: 110 }); await tick(1000); render({ hasWork: true }); await tick(1000);
  assert.equal(calls.length, 2);
  render({ taps: 0 }); await tick(1000); assert.equal(calls.length, 2);
  render({ taps: 1 }); await settle(); assert.equal(calls.length, 3);
  render({ taps: 2 }); assert.equal(timers.size, 1); unmount(); await tick(1000);
  assert.equal(calls.length, 3); assert.equal(timers.size, 0);
}));

test("failed reads retry the pending receipt at the same bounded cadence, and success ends retries", () => browser(async ({ render, tick, now, timers }) => {
  const reads = [];
  render({ refresh: async () => {
    reads.push(now()); if (reads.length === 1) throw new Error("offline race"); return reads.length > 2;
  } });
  render({ taps: 1 }); await settle(); await tick(749); assert.deepEqual(reads, [0]);
  await tick(1); assert.deepEqual(reads, [0, 750]);
  await tick(750); assert.deepEqual(reads, [0, 750, 1500]);
  await tick(5000); assert.equal(reads.length, 3); assert.equal(timers.size, 0);
}));


test("a real busy session cannot acknowledge the only tap until its post-command GET succeeds", () => browser(async ({ render, tick }) => {
  const command = deferred(); let reads = 0;
  const session = createEconomySession(owner, { get: async () => { reads++; return snapshot(reads > 1 ? 1 : 0, reads > 1 ? 1 : 0); },
    send: () => command.promise, market, trade: async () => receipt(snapshot()) }, () => assert.fail("unexpected session loss"));
  const stop = session.activate();
  try {
    await session.refresh();
    render({ owner, taps: 100, refresh: session.refreshTapBoost });
    assert.equal(session.act("claim_job", "ready-work"), true);
    render({ taps: 101 }); await settle(); await tick(750);
    assert.equal(reads, 1, "busy refreshes do not count as successful reads");
    command.resolve(receipt(snapshot(1))); await settle(); await tick(750);
    assert.equal(reads, 2); assert.equal(session.getSnapshot().snapshot.tapBoost.charge, 1);
    await tick(5000); assert.equal(reads, 2, "the same tap stops retrying after the confirmed read");
  } finally { stop(); }
}));

test("a real session's swallowed network error and backoff retain an unchanged confirmed tap for retry", () => browser(async ({ render, tick, timers }) => {
  let reads = 0;
  const session = createEconomySession(owner, { get: async () => {
    reads++; if (reads === 2) throw new Error("temporary connection loss"); return snapshot(0, reads > 2 ? 1 : 0);
  }, send: async () => receipt(snapshot()), market, trade: async () => receipt(snapshot()) }, () => assert.fail());
  const stop = session.activate();
  try {
    await session.refresh(); render({ owner, refresh: session.refreshTapBoost });
    render({ taps: 1 }); await settle(); assert.equal(reads, 2);
    await tick(1500); assert.equal(reads, 2, "750ms wake-ups respect the session's 2s network backoff");
    await tick(750); assert.equal(reads, 3); assert.equal(session.getSnapshot().snapshot.tapBoost.charge, 1);
    await tick(5000); assert.equal(reads, 3); assert.equal(timers.size, 0);
  } finally { stop(); }
}));

test("an already-running GET from before the tap cannot satisfy its confirmation refresh", () => browser(async ({ render }) => {
  const earlier = deferred(); let reads = 0;
  const session = createEconomySession(owner, { get: async () => {
    reads++; return reads === 2 ? earlier.promise : snapshot(0, reads > 2 ? 1 : 0);
  }, send: async () => receipt(snapshot()), market, trade: async () => receipt(snapshot()) }, () => assert.fail());
  const stop = session.activate();
  try {
    await session.refresh(); render({ owner, refresh: session.refreshTapBoost });
    const oldRead = session.refresh(); render({ taps: 1 }); await settle(); assert.equal(reads, 2);
    earlier.resolve(snapshot()); await oldRead; await settle();
    assert.equal(reads, 3, "a separate GET starts after the accepted tap");
    assert.equal(session.getSnapshot().snapshot.tapBoost.charge, 1);
  } finally { stop(); }
}));

test("unavailable sessions explicitly report that no tap refresh happened", () => browser(async () => {
  let reads = 0;
  const session = createEconomySession(owner, { get: async () => { reads++; return snapshot(); },
    send: async () => receipt(snapshot()), market, trade: async () => receipt(snapshot()) }, () => assert.fail());
  const stop = session.activate();
  try {
    session.setAvailable(false); assert.equal(await session.refreshTapBoost(), false); assert.equal(reads, 0);
    session.setAvailable(true); assert.equal(await session.refreshTapBoost(), true); assert.equal(reads, 1);
  } finally { stop(); }
  assert.equal(await session.refreshTapBoost(), false); assert.equal(reads, 1);
}));
