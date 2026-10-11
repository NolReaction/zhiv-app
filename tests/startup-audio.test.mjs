import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createStartupAudioEntry, getStartupAudioEntry, STARTUP_AUDIO_BUDGET_MS, STARTUP_LOGO_AUDIO_WINDOW_MS }
  = await vite.ssrLoadModule("/features/startup/startup-audio.ts");
const { DEFAULT_AUDIO_SETTINGS } = await vite.ssrLoadModule("/features/audio/domain/settings.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture(options = {}) {
  let now = 1_000, visible = true, state = "running";
  const preparations = [], events = [];
  const settings = { ...DEFAULT_AUDIO_SETTINGS, enabled: true, buses: { ...DEFAULT_AUDIO_SETTINGS.buses }, ...options.settings };
  const runtime = {
    getSettings: () => settings,
    getDiagnostics: () => ({ state }),
    prepare: (cues, options) => { preparations.push({ cues: [...cues], signal: options.signal }); return Promise.resolve(); },
    play: event => events.push(event),
    unlock: () => { throw new Error("Startup must never resume or unlock the browser context"); },
    ...options.runtime,
  };
  const environment = { visible: () => visible, now: () => now };
  const entry = createStartupAudioEntry(runtime, environment);
  return { entry, runtime, environment, preparations, events, settings,
    advance: milliseconds => { now += milliseconds; }, setVisible: value => { visible = value; }, setState: value => { state = value; } };
}

test("warm entry prepares only critical UI and plays the logo once at its actual reveal", async () => {
  const f = fixture();
  let settled = 0;
  f.entry.subscribe(() => settled++);
  f.entry.start();
  await flush();
  assert.equal(settled, 1);
  assert.deepEqual(f.preparations.map(item => item.cues), [["ui.startup"], ["ui.click", "ui.open", "ui.daily-reward"]]);
  assert.equal(f.events.length, 0, "prepared does not mean played");
  f.entry.reveal(); f.entry.reveal();
  assert.deepEqual(f.events, [{ id: "startup:logo", cueId: "ui.startup", occurredAt: 1_000, maxAgeMs: STARTUP_LOGO_AUDIO_WINDOW_MS }]);
  f.entry.close();
});

test("cold logo can join the current entrance promptly, without waiting for other menu effects", async () => {
  const logo = deferred(), controls = deferred();
  const f = fixture({ runtime: { prepare: cues => cues.includes("ui.startup") ? logo.promise : controls.promise } });
  let settled = 0;
  f.entry.subscribe(() => settled++);
  f.entry.start(); f.entry.reveal();
  await flush();
  assert.equal(f.events.length, 0);
  f.advance(80); logo.resolve(); await flush();
  assert.equal(f.events.length, 1);
  assert.equal(settled, 0);
  controls.resolve(); await flush();
  assert.equal(settled, 1);
  f.entry.close();
});

test("an uncached slow logo stays silent and is never replayed on later input or another account", async () => {
  const logo = deferred();
  const f = fixture({ runtime: { prepare: () => logo.promise } });
  f.entry.start(); f.entry.reveal();
  f.advance(STARTUP_LOGO_AUDIO_WINDOW_MS + 1);
  logo.resolve(); await flush();
  f.entry.reveal(); f.entry.start();
  assert.equal(f.events.length, 0);
  f.entry.close();
});

test("offline preparation failure releases startup and never requires a network retry button", async () => {
  const f = fixture({ runtime: { prepare: async () => { throw new TypeError("Offline"); } } });
  let settled = 0;
  f.entry.subscribe(() => settled++);
  f.entry.start(); f.entry.reveal();
  await flush();
  assert.equal(settled, 1);
  assert.equal(f.events.length, 0);
  f.entry.close();
});

test("a stalled fetch or decoder cannot hold the app beyond its small optional budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(), signals = [];
  const f = fixture({ runtime: { prepare: (_cues, { signal }) => { signals.push(signal); return pending.promise; } } });
  let settled = 0;
  f.entry.subscribe(() => settled++);
  f.entry.start(); f.entry.reveal();
  await flush();
  t.mock.timers.tick(STARTUP_AUDIO_BUDGET_MS - 1);
  assert.equal(settled, 0);
  f.advance(STARTUP_AUDIO_BUDGET_MS);
  t.mock.timers.tick(1);
  assert.equal(settled, 1);
  assert.ok(signals.every(signal => signal.aborted));
  pending.resolve(); await flush();
  assert.equal(settled, 1);
  assert.equal(f.events.length, 0);
  f.entry.close();
});

test("disabled sound, master zero and UI zero stay silent while warming future UI without blocking entry", async () => {
  for (const patch of [{ enabled: false }, { master: 0 }, { buses: { ...DEFAULT_AUDIO_SETTINGS.buses, ui: 0 } }]) {
    const pending = deferred(), requested = [];
    const f = fixture({ settings: patch, runtime: { prepare: cues => { requested.push([...cues]); return pending.promise; } } });
    let settled = 0;
    f.entry.subscribe(() => settled++);
    f.entry.start(); f.entry.reveal(); await flush();
    assert.equal(settled, 1, "muted entry opens before optional fetch finishes");
    assert.deepEqual(requested, [["ui.startup"], ["ui.click", "ui.open", "ui.daily-reward"]]);
    assert.equal(f.events.length, 0);
    f.entry.close();
    pending.resolve(); await flush();
    assert.equal(f.events.length, 0, "late cache completion is never a playback request");
  }
});

test("mute during preparation cancels the logo opportunity, including unmute after the reveal", async () => {
  const pending = deferred();
  const f = fixture({ runtime: { prepare: () => pending.promise } });
  f.entry.start();
  f.settings.enabled = false;
  f.entry.reveal();
  f.settings.enabled = true;
  pending.resolve(); await flush();
  assert.equal(f.events.length, 0);
  f.entry.close();
});

test("a browser-blocked context never waits for a future gesture to play the logo", async () => {
  const f = fixture();
  f.setState("locked");
  f.entry.start(); await flush();
  f.entry.reveal();
  f.setState("running");
  f.entry.reveal();
  assert.equal(f.events.length, 0);
  f.entry.close();
});

test("hidden boot does not prepare or play, and a foreground return does not replay branding", async () => {
  const f = fixture();
  f.setVisible(false);
  f.entry.start(); f.entry.reveal(); await flush();
  f.setVisible(true);
  f.entry.start(); f.entry.reveal();
  assert.equal(f.preparations.length, 0);
  assert.equal(f.events.length, 0);
  f.entry.close();
});

test("hiding during cold preparation aborts its wait and suppresses any late result", async () => {
  const pending = deferred();
  const f = fixture({ runtime: { prepare: () => pending.promise } });
  let settled = 0;
  f.entry.subscribe(() => settled++);
  f.entry.start(); f.entry.reveal(); await flush();
  f.setVisible(false); f.entry.hide();
  assert.equal(settled, 1);
  f.setVisible(true); pending.resolve(); await flush();
  f.entry.reveal();
  assert.equal(f.events.length, 0);
  f.entry.close();
});

test("closing a fast reduced-motion splash suppresses a decode that finishes afterwards", async () => {
  const pending = deferred();
  const f = fixture({ runtime: { prepare: () => pending.promise } });
  f.entry.start(); f.entry.reveal(); await flush();
  f.entry.close(); pending.resolve(); await flush();
  assert.equal(f.events.length, 0);
});

test("StrictMode detach and reattach reuse one preparation and one reveal ledger per runtime", async () => {
  const f = fixture();
  const first = getStartupAudioEntry(f.runtime, f.environment);
  let detachedNotifications = 0, currentNotifications = 0;
  const detach = first.subscribe(() => detachedNotifications++);
  first.start(); detach();
  const second = getStartupAudioEntry(f.runtime, f.environment);
  assert.equal(first, second);
  second.subscribe(() => currentNotifications++);
  second.start(); await flush();
  first.reveal(); second.reveal();
  assert.equal(detachedNotifications, 0);
  assert.equal(currentNotifications, 1);
  assert.equal(f.preparations.length, 2, "one logo request and one control request, not another batch");
  assert.equal(f.events.length, 1);
  second.close();
  assert.equal(getStartupAudioEntry(f.runtime, f.environment), second, "account hydration cannot create another brand opportunity");
});
