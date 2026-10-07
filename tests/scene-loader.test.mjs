import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createSceneLoader, bindSceneLoaderEnvironment } = await vite.ssrLoadModule("/features/startup/scene-loader.ts");
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t, load) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = { online: true, visible: true, calls: [], events: [], ready: [], released: [] };
  const loader = createSceneLoader({
    load: signal => { state.calls.push(signal); return load(signal, state.calls.length); },
    release: value => state.released.push(value),
    onReady: value => state.ready.push(value),
    onState: (status, error) => state.events.push({ status, error }),
    isOnline: () => state.online,
    isVisible: () => state.visible,
  });
  t.after(() => loader.dispose());
  return { state, loader, tick: async ms => { t.mock.timers.tick(ms); await drain(); } };
}

test("scene failures retry at 1/3/8/15 seconds and retain the bounded delay during a long outage", async t => {
  const failure = new TypeError("Failed to load scene chunk");
  const { state, loader, tick } = fixture(t, async () => { throw failure; });
  loader.retry(); await drain();
  assert.equal(state.calls.length, 1);
  for (const [index, delay] of [1000, 3000, 8000, 15000, 15000].entries()) {
    await tick(delay - 1); assert.equal(state.calls.length, index + 1);
    await tick(1); assert.equal(state.calls.length, index + 2);
  }
  assert.equal(state.events.filter(event => event.status === "error").length, 6);
  assert.ok(state.events.filter(event => event.status === "error").every(event => event.error === failure));
});

test("only one load runs at a time and successful setup ends all automatic and manual retries", async t => {
  let resolve;
  const scene = { id: "loaded" };
  const { state, loader, tick } = fixture(t, () => new Promise(done => { resolve = done; }));
  loader.retry(); loader.resume(); loader.retry(); await drain();
  assert.equal(state.calls.length, 1);
  await tick(24_999); assert.equal(state.calls.length, 1);
  resolve(scene); await drain();
  loader.resume(); loader.retry(); await tick(100_000);
  assert.deepEqual(state.ready, [scene]); assert.equal(state.calls.length, 1);
  assert.deepEqual(state.events.map(event => event.status), ["loading", "ready"]);
  loader.dispose(); loader.dispose();
  assert.deepEqual(state.released, [scene], "the ready engine is released exactly once");
});

test("offline and hidden startup waits without a failed load, reconnect starts immediately", async t => {
  const { state, loader, tick } = fixture(t, async () => "scene");
  state.online = false;
  loader.retry(); await tick(100_000); assert.equal(state.calls.length, 0);
  state.online = true; state.visible = false;
  loader.resume(); await tick(100_000); assert.equal(state.calls.length, 0);
  state.visible = true; loader.resume(); await drain();
  assert.deepEqual(state.ready, ["scene"]);
  assert.equal(state.events.some(event => event.status === "error"), false);
});

test("backgrounding cancels the retry timer and returning bypasses backoff", async t => {
  const { state, loader, tick } = fixture(t, async (_signal, attempt) => {
    if (attempt < 3) throw new Error("Image unavailable");
    return "scene";
  });
  loader.retry(); await drain();
  state.visible = false; loader.pause();
  await tick(100_000); assert.equal(state.calls.length, 1);
  state.visible = true; loader.resume(); await drain();
  assert.equal(state.calls.length, 2);
  loader.retry(); await drain();
  assert.deepEqual(state.ready, ["scene"], "manual retry bypasses the waiting timer");
  await tick(100_000); assert.equal(state.calls.length, 3);
});

test("an aborted old setup cannot report ready or failure after a newer attempt", async t => {
  const pending = [];
  const { state, loader } = fixture(t, signal => new Promise((resolve, reject) => pending.push({ signal, resolve, reject })));
  loader.retry(); await drain();
  loader.pause(); assert.equal(pending[0].signal.aborted, true);
  loader.resume(); await drain();
  pending[1].resolve("current"); await drain();
  pending[0].resolve("old"); await drain();
  assert.deepEqual(state.ready, ["current"]);
  assert.deepEqual(state.released, ["old"], "a late engine is disposed even if its loader ignored abort");
  assert.equal(state.events.some(event => event.status === "error"), false);
  loader.dispose(); assert.deepEqual(state.released, ["old", "current"]);
});

test("disposing before import starts cancels setup without leaving timers or failure messages", async t => {
  const { state, loader, tick } = fixture(t, async () => "scene");
  loader.retry(); loader.dispose(); await drain();
  loader.retry(); loader.resume(); await tick(100_000);
  assert.equal(state.calls.length, 0);
  assert.deepEqual(state.ready, []); assert.deepEqual(state.released, []);
  assert.equal(state.events.some(event => event.status === "error"), false);
});

test("a hung setup times out, retries, and releases its late result without replacing the recovered scene", async t => {
  let resolveHung;
  const { state, loader, tick } = fixture(t, (_signal, attempt) => attempt === 1
    ? new Promise(resolve => { resolveHung = resolve; }) : Promise.resolve("recovered"));
  loader.retry(); await drain();
  await tick(24_999); assert.equal(state.events.some(event => event.status === "error"), false);
  await tick(1);
  assert.equal(state.calls[0].aborted, true);
  assert.equal(state.events.at(-1).status, "error");
  assert.equal(state.events.at(-1).error.name, "TimeoutError");
  await tick(999); assert.equal(state.calls.length, 1);
  await tick(1); assert.deepEqual(state.ready, ["recovered"]);
  resolveHung("expired"); await drain();
  assert.deepEqual(state.released, ["expired"]);
  assert.deepEqual(state.ready, ["recovered"]);
  await tick(100_000); assert.equal(state.calls.length, 2, "success clears its deadline and all retry timers");
});

test("pausing or disposing a hung attempt clears its deadline and suppresses late updates", async t => {
  const pending = [];
  const { state, loader, tick } = fixture(t, () => new Promise(resolve => pending.push(resolve)));
  loader.retry(); await drain();
  loader.pause(); await tick(100_000);
  assert.equal(state.calls.length, 1);
  assert.equal(state.events.some(event => event.status === "error"), false);
  loader.resume(); await drain(); loader.dispose(); await tick(100_000);
  pending[0]("paused"); pending[1]("disposed"); await drain();
  assert.deepEqual(state.released, ["paused", "disposed"]);
  assert.deepEqual(state.ready, []);
  assert.equal(state.events.some(event => event.status === "error"), false);
  assert.equal(state.calls.length, 2);
});

test("pausing or disposing inside a failure callback cannot schedule another attempt", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["pause", "dispose"]) {
    let calls = 0;
    const loader = createSceneLoader({
      load: async () => { calls++; throw new Error("Unavailable"); },
      release() {}, onReady: assert.fail,
      onState: state => { if (state === "error") loader[action](); },
      isOnline: () => true, isVisible: () => true,
    });
    loader.retry(); await drain();
    t.mock.timers.tick(100_000); await drain();
    assert.equal(calls, 1, action);
    loader.dispose();
  }
});

test("disposing inside loading or ready callbacks cannot publish stale readiness or leak a scene", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["loading", "ready"]) {
    const states = [], released = []; let calls = 0;
    const loader = createSceneLoader({
      load: async () => { calls++; return "scene"; },
      release: value => released.push(value),
      onReady: () => { if (phase === "ready") loader.dispose(); },
      onState: state => { states.push(state); if (phase === "loading") loader.dispose(); },
      isOnline: () => true, isVisible: () => true,
    });
    loader.retry(); await drain(); t.mock.timers.tick(100_000); await drain();
    assert.deepEqual(states, ["loading"], phase);
    assert.equal(calls, phase === "loading" ? 0 : 1);
    assert.deepEqual(released, phase === "loading" ? [] : ["scene"]);
  }
});

test("environment bindings pause offline/hidden and cleanly remove reconnect listeners", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { hidden: false });
  const events = [];
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  try {
    const unbind = bindSceneLoaderEnvironment({ pause: () => events.push("pause"), resume: () => events.push("resume") });
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual(events, ["pause", "resume", "pause", "resume"]);
    unbind();
    window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(events.length, 4);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete globalThis.window;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
  }
});
