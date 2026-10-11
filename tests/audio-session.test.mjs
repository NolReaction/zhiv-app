import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { configureAmbientAudioSession } = await vite.ssrLoadModule("/features/audio/runtime/audio-session.ts");
const { getAudioRuntime } = await vite.ssrLoadModule("/features/audio/runtime/audio-service.ts");

test("absent Audio Session support leaves the browser untouched", () => {
  for (const browserNavigator of [undefined, null, {}, { audioSession: null }, { audioSession: {} }]) {
    const before = browserNavigator ? structuredClone(browserNavigator) : browserNavigator;
    assert.equal(configureAmbientAudioSession(browserNavigator), false);
    assert.deepEqual(browserNavigator, before);
  }
});

test("supported sessions request ambient mixing without repeating an identical policy", () => {
  let type = "auto", writes = 0;
  const audioSession = {
    get type() { return type; },
    set type(value) { writes++; type = value; },
  };
  assert.equal(configureAmbientAudioSession({ audioSession }), true);
  assert.equal(type, "ambient");
  assert.equal(configureAmbientAudioSession({ audioSession }), true);
  assert.equal(writes, 1);
});

test("unavailable or read-only experimental sessions never break playback setup", () => {
  const blocked = () => { throw new Error("Audio Session unavailable"); };
  const unavailableSession = Object.defineProperty({}, "audioSession", { get: blocked });
  const unavailableType = { audioSession: Object.defineProperty({}, "type", { get: blocked }) };
  const rejectedType = { audioSession: { get type() { return "auto"; }, set type(value) { blocked(value); } } };
  const readOnly = { audioSession: Object.freeze({ type: "auto" }) };
  const ignoredType = { audioSession: { get type() { return "auto"; }, set type(_value) {} } };
  for (const browserNavigator of [unavailableSession, unavailableType, rejectedType, readOnly, ignoredType]) {
    assert.equal(configureAmbientAudioSession(browserNavigator), false);
  }
});

test("SSR service access has no browser dependency or shared player runtime", () => {
  assert.equal(typeof window, "undefined");
  const first = getAudioRuntime(), second = getAudioRuntime();
  assert.notEqual(first, second);
  assert.equal(first.getDiagnostics().state, "locked");
  first.dispose(); second.dispose();
});

test("browser service selects ambient once before playback without allocating audio resources", () => {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const savedAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  let writes = 0, type = "auto", allocations = 0, runtime;
  const audioSession = { get type() { return type; }, set type(value) { writes++; type = value; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    navigator: { audioSession }, localStorage: { getItem: () => null, setItem() {} },
  } });
  class UnwantedAudioResource { constructor() { allocations++; throw new Error("Playback needs a gesture"); } }
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: UnwantedAudioResource });
  Object.defineProperty(globalThis, "Audio", { configurable: true, value: UnwantedAudioResource });
  try {
    runtime = getAudioRuntime();
    assert.equal(type, "ambient");
    assert.equal(runtime.getDiagnostics().state, "locked");
    for (let render = 0; render < 100; render++) assert.equal(getAudioRuntime(), runtime);
    assert.equal(writes, 1);
    assert.equal(allocations, 0);
  } finally {
    runtime?.dispose();
    for (const [name, descriptor] of [["window", savedWindow], ["AudioContext", savedContext], ["Audio", savedAudio]]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
