import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createAudioRuntime } = await vite.ssrLoadModule("/features/audio/runtime/audio-runtime.ts");
const { getAudioRuntime } = await vite.ssrLoadModule("/features/audio/runtime/audio-service.ts");
const { DEFAULT_AUDIO_SETTINGS } = await vite.ssrLoadModule("/features/audio/domain/settings.ts");

class Param {
  value = 0; ramps = [];
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value, time) { this.value = value; this.ramps.push({ value, time }); }
}
class Node {
  connected = []; disconnected = false;
  connect(node) { this.connected.push(node); return node; }
  disconnect() { this.disconnected = true; }
}
class Gain extends Node { gain = new Param(); }
class Panner extends Node { pan = new Param(); }
class Source extends Node {
  playbackRate = new Param(); started = 0; stops = []; onended = null; loop = false;
  constructor(context) { super(); this.context = context; }
  start() { this.started++; this.context.started.push(this); }
  stop(time) { this.stops.push(time); }
  end() { this.onended?.(); }
}
class Context {
  currentTime = 0; state = "suspended"; destination = new Node(); sources = []; started = []; decoded = 0; mediaSources = []; gains = [];
  createGain() { const node = new Gain(); this.gains.push(node); return node; }
  createStereoPanner() { return new Panner(); }
  createBufferSource() { const node = new Source(this); this.sources.push(node); return node; }
  createOscillator() { const source = new Source(this); source.frequency = new Param(); return source; }
  createMediaElementSource(media) { const node = new Node(); node.media = media; this.mediaSources.push(node); return node; }
  async resume() { this.state = "running"; this.onstatechange?.(); }
  async suspend() { this.state = "suspended"; this.onstatechange?.(); }
  async close() { this.state = "closed"; }
  async decodeAudioData(data) { this.decoded++; return this.decode ? this.decode(data) : { length: 44100, numberOfChannels: 1, duration: 1 }; }
}
class Media {
  plays = 0; pauses = 0; loads = 0; readyState = 4; src = "";
  async play() { this.plays++; }
  pause() { this.pauses++; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  load() { this.loads++; }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const asset = id => ({ id, status: "ready", src: `/audio/${id}.wav`, license: null });
const cue = (id, mode = "one-shot", overrides = {}) => ({ id, bus: mode === "music" ? "music" : "world", mode, assets: [`${id}-a`], gainDb: -10, priority: 10, maxInstances: 3, cooldownMs: 0, pitchVariation: .03, fadeMs: 80, ...overrides });
const frame = (loops = [], overrides = {}) => ({ ownerId: "user-a", sceneId: "forest", listener: { position: { x: 0, y: 0 }, viewportWidth: 400, zoom: 1, detail: 1 }, loops, musicDuck: 1, ...overrides });
const target = (id, cueId = "river", gain = .8) => ({ id, cueId, gain, pan: .4 });
function fixture(cueList = [cue("tap"), cue("river", "loop")], options = {}) {
  const context = new Context();
  let time = 100_000; let contextCount = 0; const requests = []; const media = [];
  const runtime = createAudioRuntime({ catalog: { version: 1, cues: cueList, assets: [...new Set(cueList.flatMap(item => item.assets))].map(asset), profiles: [] },
    initialSettings: { ...DEFAULT_AUDIO_SETTINGS, enabled: true }, now: () => time, random: () => .2,
    createContext: () => { contextCount++; return context; },
    fetchAsset: async (url, config) => { requests.push({ url, config }); return new Response(new Uint8Array([1, 2, 3])); },
    createMediaElement: () => { const item = new Media(); media.push(item); return item; },
    ...options,
  });
  return { runtime, context, requests, media, advance: amount => { time += amount; }, get contextCount() { return contextCount; } };
}

// Every fixture is disposed so timers/voices cannot leak between otherwise independent cases.
test("SSR and disabled runtime allocate no context, fetches or singleton account state", async () => {
  assert.notEqual(getAudioRuntime(), getAudioRuntime());
  const f = fixture(undefined, { initialSettings: DEFAULT_AUDIO_SETTINGS });
  assert.equal(await f.runtime.unlock(), false);
  f.runtime.updateFrame(frame([target("water")])); f.runtime.play({ id: "tap-1", cueId: "tap" });
  await flush(); assert.equal(f.contextCount, 0); assert.equal(f.requests.length, 0);
  f.runtime.dispose();
});

test("pending catalog entries never fetch or synthesize automatic placeholders", async () => {
  const f = fixture([cue("river", "loop")], { catalog: { version: 1, cues: [cue("river", "loop")], assets: [{ ...asset("river-a"), status: "pending", src: null }], profiles: [] } });
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water")]));
  await flush(); assert.equal(f.requests.length, 0); assert.equal(f.context.started.length, 0);
  assert.equal(f.runtime.getDiagnostics().pendingAssets, 1); f.runtime.dispose();
});

test("overlapping frame updates share one decode and retain a single loop voice", async () => {
  const f = fixture(); const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock();
  for (let index = 0; index < 30; index++) f.runtime.updateFrame(frame([target("water", "river", index / 40 + .1)]));
  await flush(); assert.equal(f.requests.length, 1);
  gate.resolve({ length: 44100, numberOfChannels: 1, duration: 1 }); await flush();
  assert.equal(f.context.started.length, 1); assert.equal(f.context.started[0].loop, true);
  for (let index = 0; index < 30; index++) f.runtime.updateFrame(frame([target("water")]));
  assert.equal(f.context.started.length, 1); assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
  f.runtime.dispose();
});

test("clearing frame or switching account during decode cannot resurrect old world or event", async () => {
  for (const action of [runtime => runtime.clearFrame("user-a"), runtime => runtime.updateFrame(frame([], { ownerId: "user-b", sceneId: "account-b:forest" }))]) {
    const f = fixture(); const gate = deferred(); f.context.decode = () => gate.promise;
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water")])); f.runtime.play({ id: "tap-old", cueId: "tap" });
    await flush(); action(f.runtime); gate.resolve({ length: 1, numberOfChannels: 1, duration: 1 }); await flush();
    assert.equal(f.context.started.length, 0); f.runtime.dispose();
  }
});

test("outgoing surface cleanup does not clear a different owner frame", async () => {
  const f = fixture(); await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("water")], { ownerId: "map" }));
  f.runtime.clearFrame("circle"); await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 1); f.runtime.dispose();
});

test("mute/unmute during decode consumes old events; bus mute also invalidates queued one-shots", async () => {
  for (const [off, on] of [[{ enabled: false }, { enabled: true }], [{ buses: { world: 0 } }, { buses: { world: .7 } }]]) {
    const f = fixture(); const gate = deferred(); f.context.decode = () => gate.promise;
    await f.runtime.unlock(); f.runtime.play({ id: "old", cueId: "tap" }); await flush();
    f.runtime.setSettings(off); f.runtime.setSettings(on);
    gate.resolve({ length: 1, numberOfChannels: 1, duration: 1 }); await flush();
    assert.equal(f.context.started.length, 0); f.runtime.dispose();
  }
});

test("replayed receipt ids and stale events are dropped, including events consumed while disabled", async () => {
  const f = fixture(); await f.runtime.unlock();
  f.runtime.play({ id: "receipt", cueId: "tap" }); f.runtime.play({ id: "receipt", cueId: "tap" });
  f.runtime.play({ id: "old", cueId: "tap", occurredAt: 1 });
  await flush(); assert.equal(f.context.started.length, 1);
  f.runtime.setSettings({ enabled: false }); f.runtime.play({ id: "muted", cueId: "tap" });
  f.runtime.setSettings({ enabled: true }); await f.runtime.unlock(); f.runtime.play({ id: "muted", cueId: "tap" });
  await flush(); assert.equal(f.context.started.length, 1); f.runtime.dispose();
});

test("loading a short effect too slowly does not play a late action", async () => {
  const f = fixture(); const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock(); f.runtime.play({ id: "late", cueId: "tap" }); await flush();
  f.advance(3000); gate.resolve({ length: 1, numberOfChannels: 1, duration: 1 }); await flush();
  assert.equal(f.context.started.length, 0); f.runtime.dispose();
});

test("variants do not immediately repeat, pitch stays subtle and cooldown limits chatter", async () => {
  const f = fixture([cue("tap", "one-shot", { assets: ["a", "b"], cooldownMs: 200, maxInstances: 4 })]);
  await f.runtime.unlock(); f.runtime.play({ id: "first", cueId: "tap" }); await flush();
  f.runtime.play({ id: "too-soon", cueId: "tap" }); f.advance(250);
  f.runtime.play({ id: "second", cueId: "tap" }); await flush();
  assert.deepEqual(f.requests.map(item => item.url), ["/audio/a.wav", "/audio/b.wav"]);
  assert.equal(f.context.started.length, 2);
  assert.ok(f.context.started.every(source => source.playbackRate.value >= .97 && source.playbackRate.value <= 1.03)); f.runtime.dispose();
});

test("voice budget drops low priority events and admits a high priority confirmation", async () => {
  const f = fixture([cue("tap", "one-shot", { maxInstances: 50 }), cue("reward", "one-shot", { priority: 100 })]);
  await f.runtime.unlock();
  for (let index = 0; index < 30; index++) f.runtime.play({ id: `event-${index}`, cueId: "tap" });
  await flush(); assert.equal(f.runtime.getDiagnostics().activeVoices, 24); assert.equal(f.context.started.length, 24);
  f.runtime.play({ id: "reward", cueId: "reward" }); await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 24); assert.equal(f.context.started.length, 25); f.runtime.dispose();
});

test("long music streams without fetch/decode and has at most two decks during transitions", async () => {
  const f = fixture([cue("day", "music"), cue("night", "music"), cue("cave", "music")]);
  await f.runtime.unlock();
  for (let index = 0; index < 5; index++) f.runtime.updateFrame(frame([target("theme", "day")]));
  await flush(); assert.equal(f.media.length, 1); assert.equal(f.media[0].plays, 1);
  f.runtime.updateFrame(frame([target("theme", "night")]));
  f.runtime.updateFrame(frame([target("theme", "cave")]));
  await flush();
  assert.equal(f.requests.length, 0); assert.equal(f.context.decoded, 0);
  assert.equal(f.media.filter(item => item.src !== "").length, 2);
  assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
  f.runtime.dispose(); assert.ok(f.media.every(item => item.src === "" && item.pauses > 0));
});

test("hide stops voices, foreground restores loops once and never replays earlier one-shots", async () => {
  const f = fixture(); await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("water")])); f.runtime.play({ id: "first", cueId: "tap" }); await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 2);
  f.runtime.setVisible(false); assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
  f.runtime.play({ id: "hidden", cueId: "tap" }); f.runtime.setVisible(true); await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
  assert.equal(f.context.started.filter(source => !source.loop).length, 1); assert.equal(f.contextCount, 1); f.runtime.dispose();
});

test("snapshot identity remains stable for equivalent frames and no-op settings", async () => {
  const f = fixture(); await f.runtime.unlock();
  f.runtime.updateFrame(frame()); const first = f.runtime.getDiagnostics();
  f.runtime.updateFrame(frame()); f.runtime.setSettings({ master: first.settings.master });
  assert.equal(f.runtime.getDiagnostics(), first);
  f.runtime.setSettings({ master: .1 }); assert.notEqual(f.runtime.getDiagnostics(), first); f.runtime.dispose();
});

test("disposed cache aborts downloads and async completion cannot start voices", async () => {
  const gate = deferred(); let signal;
  const f = fixture(undefined, { fetchAsset: async (_url, config) => { signal = config.signal; return gate.promise; } });
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water")])); await flush();
  f.runtime.dispose(); assert.equal(signal.aborted, true);
  gate.resolve(new Response(new Uint8Array([1]))); await flush();
  assert.equal(f.context.started.length, 0); assert.equal(f.runtime.getDiagnostics().state, "disposed");
});

test("decoded effects have an enforced memory budget and download failures do not retry per frame", async () => {
  const f = fixture(undefined, { maxDecodedBytes: 100 });
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water")])); await flush();
  assert.equal(f.context.started.length, 0); assert.deepEqual(f.runtime.getDiagnostics().failedAssets, ["river-a"]);
  for (let index = 0; index < 10; index++) { f.runtime.updateFrame(frame([target("water")])); await flush(); }
  assert.equal(f.requests.length, 1); f.runtime.dispose();
});

test("stream codec failure attempts fallback once without a duplicate media source", async () => {
  const music = cue("theme", "music"); const player = new Media();
  player.play = async () => { player.plays++; if (player.src.endsWith(".opus")) throw new DOMException("Unsupported", "NotSupportedError"); };
  const f = fixture([music], { createMediaElement: () => player, catalog: { version: 1, cues: [music], profiles: [],
    assets: [{ ...asset("theme-a"), src: "/audio/theme.opus", fallbackSrc: "/audio/theme.m4a" }] } });
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("theme", "theme")])); await flush();
  assert.equal(player.plays, 2); assert.equal(player.src, "/audio/theme.m4a");
  assert.equal(f.context.mediaSources.length, 1); assert.deepEqual(f.runtime.getDiagnostics().failedAssets, []); f.runtime.dispose();
});

test("autoplay rejection stops music without trying codecs or retrying every frame", async () => {
  const music = cue("theme", "music"); const player = new Media();
  player.play = async () => { player.plays++; throw new DOMException("Gesture required", "NotAllowedError"); };
  const f = fixture([music], { createMediaElement: () => player, catalog: { version: 1, cues: [music], profiles: [],
    assets: [{ ...asset("theme-a"), fallbackSrc: "/audio/theme.m4a" }] } });
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("theme", "theme")])); await flush();
  for (let index = 0; index < 10; index++) f.runtime.updateFrame(frame([target("theme", "theme")]));
  assert.equal(player.plays, 1); assert.deepEqual(f.runtime.getDiagnostics().failedAssets, ["theme-a"]); f.runtime.dispose();
});

test("circle to map handoff retains the same streaming playhead, including outgoing cleanup first", async () => {
  for (const clearFirst of [true, false]) {
    const f = fixture([cue("theme", "music")]); await f.runtime.unlock();
    f.runtime.updateFrame(frame([target("theme", "theme")], { ownerId: "circle-1" })); await flush();
    f.media[0].currentTime = 42;
    if (clearFirst) f.runtime.clearFrame("circle-1");
    f.runtime.updateFrame(frame([target("theme", "theme")], { ownerId: "map-2" }));
    f.runtime.clearFrame("circle-1"); await flush();
    assert.equal(f.media.length, 1); assert.equal(f.media[0].currentTime, 42);
    assert.equal(f.media[0].pauses, 0); assert.equal(f.runtime.getDiagnostics().activeVoices, 1); f.runtime.dispose();
  }
});

test("concurrent distinct decodes cannot evict buffers still required by pending voices", async () => {
  const f = fixture([cue("first"), cue("second")], { maxDecodedBytes: 200_000 });
  await f.runtime.unlock(); f.runtime.play({ id: "one", cueId: "first" }); f.runtime.play({ id: "two", cueId: "second" });
  await flush();
  assert.ok(f.runtime.getDiagnostics().activeVoices <= 1, "concurrent sounds must not bypass the decoded memory budget");
  f.runtime.dispose();
});

test("a blocked music stream exposes suspended state and retries on the next gesture with a running context", async () => {
  const music = cue("theme", "music"); let allowed = false; const players = [];
  const f = fixture([music], { createMediaElement: () => {
    const player = new Media(); players.push(player);
    player.play = async () => { player.plays++; if (!allowed) throw new DOMException("Gesture required", "NotAllowedError"); };
    return player;
  } });
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("theme", "theme")])); await flush();
  assert.equal(f.context.state, "running"); assert.equal(f.runtime.getDiagnostics().state, "suspended");
  allowed = true; const gesture = f.runtime.unlock();
  assert.equal(players.length, 2, "media retry must start synchronously inside the new gesture");
  await gesture; await flush();
  assert.equal(f.runtime.getDiagnostics().state, "running"); assert.equal(f.runtime.getDiagnostics().activeVoices, 1); f.runtime.dispose();
});

test("foreground music resumes its playhead while account changes discard old positions", async () => {
  const f = fixture([cue("theme", "music")]); await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("theme", "theme")], { sceneId: "account-a:forest" })); await flush();
  f.media[0].currentTime = 43;
  f.runtime.setVisible(false); f.runtime.setVisible(true); await flush();
  assert.equal(f.media[1].currentTime, 43);
  f.runtime.updateFrame(frame([target("theme", "theme")], { sceneId: "account-b:forest" })); await flush();
  assert.equal(f.media[2].currentTime ?? 0, 0); f.runtime.dispose();
});

test("hung decode releases requests at its deadline and late resolution cannot retain or play the asset", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock(); f.runtime.play({ id: "old", cueId: "tap" }); await flush();
  assert.equal(f.runtime.getDiagnostics().pendingAssets, 1);
  t.mock.timers.tick(12_001); await flush();
  assert.equal(f.runtime.getDiagnostics().pendingAssets, 0);
  assert.deepEqual(f.runtime.getDiagnostics().failedAssets, ["tap-a"]);
  gate.resolve({ length: 44100, numberOfChannels: 1, duration: 1 }); await flush();
  assert.equal(f.runtime.getDiagnostics().loadedAssets, 0); assert.equal(f.context.started.length, 0);
  f.advance(31_000); f.context.decode = null;
  f.runtime.play({ id: "fresh", cueId: "tap" }); await flush();
  assert.equal(f.context.started.length, 1); f.runtime.dispose();
});

test("positive authored Tiled gain survives mixing instead of silently flattening at unity", async () => {
  const f = fixture([cue("river", "loop", { gainDb: -10 })]); await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("water", "river", 3.8)])); await flush();
  const sourceGain = f.context.started[0].connected[0].gain.value;
  assert.ok(Math.abs(sourceGain - 10 ** (-10 / 20) * 3.8) < 1e-8); f.runtime.dispose();
});

test("clearing a silent scene allocates no handoff timer or browser audio resources", async t => {
  const timer = t.mock.method(globalThis, "setTimeout");
  const f = fixture(undefined, { initialSettings: DEFAULT_AUDIO_SETTINGS });
  f.runtime.updateFrame(frame([target("water")])); f.runtime.clearFrame("user-a");
  assert.equal(timer.mock.callCount(), 0); assert.equal(f.contextCount, 0);
  f.runtime.dispose();
});
