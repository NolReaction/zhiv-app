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
const { AUDIO_CATALOG } = await vite.ssrLoadModule("/features/audio/catalog/catalog.ts");

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
  start(...args) { this.startArgs = args; this.started++; this.context.started.push(this); }
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

test("slider feedback varies pitch and respects the edited channel even in a music-only menu", async () => {
  const f = fixture([cue("ui.slider", "one-shot", { bus: "ui", cooldownMs: 90, pitchVariation: 0 })]);
  await f.runtime.unlock(); f.runtime.updateFrame(frame([], { soundscape: false }));
  f.runtime.play({ id: "slider-low", cueId: "ui.slider", feedbackBus: "weather", playbackRate: .94 });
  await flush(); assert.equal(f.context.started.length, 1); assert.equal(f.context.started[0].playbackRate.value, .94);
  f.advance(100);
  f.runtime.play({ id: "slider-high", cueId: "ui.slider", feedbackBus: "weather", playbackRate: 1.12 });
  await flush(); assert.equal(f.context.started.length, 2); assert.equal(f.context.started[1].playbackRate.value, 1.12);
  f.runtime.setSettings({ buses: { weather: 0 } });
  assert.equal(f.runtime.getDiagnostics().activeVoices, 0, "zero stops an in-flight slider response routed through UI");
  f.advance(100);
  f.runtime.play({ id: "slider-muted", cueId: "ui.slider", feedbackBus: "weather" });
  await flush(); assert.equal(f.context.started.length, 2);
  f.runtime.dispose();
});

test("slider feedback never catches up after a cold decode or a muted edited channel", async () => {
  for (const action of ["mute", "stale", "superseded"]) {
    const f = fixture([cue("ui.slider", "one-shot", { bus: "ui", cooldownMs: 90, pitchVariation: 0 })]);
    const gate = deferred(); f.context.decode = () => gate.promise;
    await f.runtime.unlock();
    f.runtime.play({ id: "slider-pending", cueId: "ui.slider", feedbackBus: "weather" });
    await flush();
    if (action === "mute") f.runtime.setSettings({ buses: { weather: 0 } });
    if (action === "stale") f.advance(181);
    if (action === "superseded") {
      f.advance(10);
      f.runtime.play({ id: "slider-newer", cueId: "ui.slider", feedbackBus: "weather", playbackRate: 1.1 });
    }
    gate.resolve({ length: 44100, numberOfChannels: 1, duration: 1 });
    await flush(); assert.equal(f.context.started.length, 0, action);
    f.runtime.dispose();
  }
});

test("slider feedback is bounded during rapid dragging and never bypasses UI or master mute", async () => {
  const f = fixture([cue("ui.slider", "one-shot", { bus: "ui", cooldownMs: 90, pitchVariation: 0 })]);
  await f.runtime.unlock();
  for (let index = 0; index < 100; index++) {
    f.runtime.play({ id: `drag-${index}`, cueId: "ui.slider", feedbackBus: "weather", playbackRate: 99 });
    await flush(); f.advance(10);
  }
  assert.ok(f.context.started.length <= 12);
  assert.ok(f.context.started.every(source => source.playbackRate.value === 1.18));
  const count = f.context.started.length;
  f.runtime.setSettings({ buses: { ui: 0 } }); f.advance(100);
  f.runtime.play({ id: "ui-muted", cueId: "ui.slider", feedbackBus: "weather" });
  f.runtime.setSettings({ buses: { ui: .35 }, master: 0 }); f.advance(100);
  f.runtime.play({ id: "master-muted", cueId: "ui.slider", feedbackBus: "weather" });
  await flush(); assert.equal(f.context.started.length, count);
  f.runtime.dispose();
});

test("centred explicit hero replies still honour the character bus, global mute and map scope", async () => {
  for (const setting of [{ buses: { characters: 0 } }, { master: 0 }, { enabled: false }, null]) {
    const f = fixture([], { catalog: AUDIO_CATALOG });
    await f.runtime.unlock();
    if (setting) f.runtime.setSettings(setting);
    else f.runtime.updateFrame(frame([], { soundscape: false }));
    f.runtime.play({ id: "clicked-hero", cueId: "actor.mochlik.greeting", gain: 1, pan: 0 });
    await flush(); assert.equal(f.context.started.length, 0);
    assert.equal(f.requests.length, 0);
    f.runtime.dispose();
  }
});

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

test("idle render frames preserve music, loop voices and in-flight volume ramps", async () => {
  const f = fixture([cue("theme", "music"), cue("river", "loop")]);
  await f.runtime.unlock();
  const current = frame([target("theme", "theme"), target("water")]);
  f.runtime.updateFrame(current); await flush();
  const gains = f.context.gains.map(node => ({ param: node.gain, count: node.gain.ramps.length }));
  const panners = [...f.context.started, ...f.context.mediaSources].map(source => source.connected[0].connected[0].pan);
  const panCounts = panners.map(param => param.ramps.length);
  f.media[0].currentTime = 28;
  // Reproduce a stationary 120 Hz renderer sending equivalent audio frames.
  for (let index = 0; index < 1200; index++) {
    f.context.currentTime = index / 120;
    f.runtime.updateFrame({ ...current, loops: current.loops.map(item => ({ ...item })) });
  }
  assert.equal(f.context.started.length, 1);
  assert.equal(f.media.length, 1); assert.equal(f.media[0].plays, 1); assert.equal(f.media[0].currentTime, 28);
  for (const { param, count } of gains) assert.equal(param.ramps.length, count, "an unchanged gain must complete its original ramp");
  panners.forEach((param, index) => assert.equal(param.ramps.length, panCounts[index], "stationary pan must not reschedule automation"));
  f.runtime.dispose();
});

test("camera and duck changes retarget only affected gains while keeping the same streams", async () => {
  const f = fixture([cue("theme", "music"), cue("river", "loop")]);
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("theme", "theme"), target("water")])); await flush();
  const master = f.context.gains[0].gain;
  const musicBus = f.context.mediaSources[0].connected[0].connected[0].connected[0].gain;
  const riverGain = f.context.started[0].connected[0].gain;
  const riverPan = f.context.started[0].connected[0].connected[0].pan;
  const counts = [master, musicBus, riverGain, riverPan].map(param => param.ramps.length);
  f.context.currentTime = 4;
  const next = frame([target("theme", "theme"), { ...target("water", "river", .25), pan: -.7 }], { musicDuck: .68 });
  f.runtime.updateFrame(next);
  assert.equal(master.ramps.length, counts[0]);
  assert.equal(musicBus.ramps.length, counts[1] + 1);
  assert.equal(riverGain.ramps.length, counts[2] + 1);
  assert.equal(riverPan.ramps.length, counts[3] + 1);
  for (let index = 0; index < 120; index++) { f.context.currentTime += 1 / 120; f.runtime.updateFrame(next); }
  assert.equal(riverGain.ramps.length, counts[2] + 1);
  assert.equal(riverPan.ramps.length, counts[3] + 1);
  assert.equal(f.context.started.length, 1); assert.equal(f.media[0].plays, 1);
  assert.equal(riverGain.value, 10 ** (-10 / 20) * .25);
  assert.equal(riverPan.value, -.7);
  f.runtime.dispose();
});

test("camera jitter at a source boundary reuses the fading loop instead of layering restarts", async () => {
  const f = fixture([cue("river", "loop", { maxInstances: 1, fadeMs: 1100 })]);
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water")])); await flush();
  const source = f.context.started[0];
  for (let index = 1; index <= 240; index++) {
    f.context.currentTime = index / 120;
    f.runtime.updateFrame(frame(index % 2 ? [] : [target("water", "river", .002)]));
    await flush();
  }
  assert.equal(f.context.started.length, 1, "crossing the audibility boundary must not start a fresh sample every other frame");
  assert.equal(f.runtime.getDiagnostics().playback.loopStarts, 1);
  assert.equal(source.stops.length, 0, "a proximity release must remain reversible until its silent cleanup");
  assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
  f.runtime.dispose();
});

test("duplicate spatial cues consume their instance quota before the global loop budget", async () => {
  const f = fixture([cue("work", "loop", { maxInstances: 1, priority: 35 }), cue("forest", "loop", { maxInstances: 1, priority: 20 })]);
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([...Array.from({ length: 12 }, (_, index) => target(`site-${index}`, "work", .4 + index / 30)), target("bed", "forest")]));
  await flush();
  assert.equal(f.context.started.length, 2, "inaudible duplicate instances must not crowd the forest bed out of ten slots");
  assert.deepEqual(f.requests.map(item => item.url).sort(), ["/audio/forest-a.wav", "/audio/work-a.wav"]);
  f.runtime.dispose();
});

test("same-cue spatial selection changes only when a competing source is clearly louder", async () => {
  const f = fixture([cue("river", "loop", { maxInstances: 1 })]);
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([{ ...target("left", "river", .5), pan: -.7 }, { ...target("right", "river", .45), pan: .7 }]));
  await flush();
  for (let index = 0; index < 50; index++) {
    f.runtime.updateFrame(frame([{ ...target("right", "river", .51), pan: .7 }, { ...target("left", "river", .5), pan: -.7 }]));
    await flush();
  }
  assert.equal(f.context.started.length, 1, "small gain changes or array reorder must not switch the selected emitter");
  f.runtime.updateFrame(frame([{ ...target("left", "river", .3), pan: -.7 }, { ...target("right", "river", .8), pan: .7 }])); await flush();
  assert.equal(f.context.started.length, 2);
  assert.equal(f.context.started[1].connected[0].connected[0].pan.value, .7, "a substantially nearer source should take over");
  f.runtime.dispose();
});

test("a source returning after silent cleanup resumes its advancing loop phase", async t => {
  const f = fixture([cue("river", "loop", { maxInstances: 1, pitchVariation: 0, fadeMs: 1100 })]);
  f.context.decode = () => ({ length: 441000, numberOfChannels: 1, duration: 10 });
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water")])); await flush();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.context.currentTime = 3; f.runtime.updateFrame(frame());
  t.mock.timers.tick(2000);
  assert.equal(f.context.started[0].disconnected, true, "inaudible sources must release browser resources");
  f.context.currentTime = 14.25; f.runtime.updateFrame(frame([target("water")])); await flush();
  assert.equal(f.context.started.length, 2);
  assert.equal(f.context.started[1].startArgs[1], 4.25, "spatial reentry must preserve the world's loop timeline instead of repeating the sample intro");
  f.runtime.updateFrame(frame([target("water")], { sceneId: "account-b:forest" })); await flush();
  assert.equal(f.context.started[2].startArgs[1], 0, "a different account/scene must begin its own timeline");
  f.runtime.dispose();
});

test("a faded loop cannot be reclaimed after mute, scene change or disposal", async () => {
  const f = fixture([cue("river", "loop", { maxInstances: 1 })]);
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water")])); await flush();
  f.runtime.updateFrame(frame());
  f.runtime.setSettings({ enabled: false }); f.runtime.setSettings({ enabled: true });
  f.runtime.updateFrame(frame([target("water")])); await flush();
  assert.equal(f.context.started.length, 2);
  f.runtime.updateFrame(frame());
  f.runtime.updateFrame(frame([target("water")], { sceneId: "different-forest" })); await flush();
  assert.equal(f.context.started.length, 3);
  f.runtime.updateFrame(frame()); f.runtime.dispose();
  assert.ok(f.context.started.every(source => source.disconnected));
});

test("muted environment keeps the catalog river silent when entering the map and moving near water", async () => {
  const river = AUDIO_CATALOG.cues.find(item => item.id === "river");
  const f = fixture([river], { initialSettings: { ...DEFAULT_AUDIO_SETTINGS, enabled: true,
    buses: { ...DEFAULT_AUDIO_SETTINGS.buses, ambience: 0, world: .9 } } });
  await f.runtime.unlock(); f.runtime.updateFrame(frame([], { ownerId: "menu", soundscape: false }));
  for (let index = 0; index < 120; index++) {
    f.runtime.updateFrame(frame([{ ...target("river-zone", "river", (index + 1) / 120), pan: index / 100 - .6 }],
      { ownerId: "map", soundscape: true }));
  }
  await flush();
  assert.equal(f.requests.length, 0, "river belongs to the muted environment even while action sounds remain enabled");
  assert.equal(f.context.started.length, 0);
  assert.equal(f.runtime.getSettings().buses.ambience, 0);
  f.runtime.dispose();
});

test("muting environment during a catalog river decode prevents its delayed start and camera retries", async () => {
  const river = AUDIO_CATALOG.cues.find(item => item.id === "river");
  const f = fixture([river]); const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("river-zone", "river")], { soundscape: true })); await flush();
  assert.equal(f.requests.length, 1);
  f.runtime.setSettings({ buses: { ambience: 0 } });
  gate.resolve({ length: 441000, numberOfChannels: 1, duration: 10 }); await flush();
  f.runtime.updateFrame(frame([], { ownerId: "menu", soundscape: false }));
  for (let index = 0; index < 20; index++) {
    f.runtime.updateFrame(frame([target("river-zone", "river", .9)], { ownerId: "map", soundscape: true }));
    await flush();
  }
  assert.equal(f.context.started.length, 0, "neither a late decode nor the next camera frame may bypass bus mute");
  assert.equal(f.requests.length, 1);
  f.runtime.dispose();
});

test("a fading catalog river cannot be reclaimed near water until environment is explicitly unmuted", async () => {
  const river = AUDIO_CATALOG.cues.find(item => item.id === "river");
  const f = fixture([river]); await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("river-zone", "river")], { soundscape: true })); await flush();
  const source = f.context.started[0];
  f.runtime.updateFrame(frame([], { soundscape: true }));
  f.runtime.setSettings({ buses: { ambience: 0 } });
  f.runtime.updateFrame(frame([target("river-zone", "river")], { soundscape: true })); await flush();
  assert.equal(source.disconnected, true, "muting releases any already-retiring environment voice");
  assert.equal(f.context.started.length, 1);
  assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
  f.runtime.setSettings({ buses: { ambience: .4 } }); await flush();
  assert.equal(f.context.started.length, 2, "only an explicit volume change can restore the river");
  f.runtime.dispose();
});

test("legacy AudioParam retargeting closes the interrupted ramp without resetting its held value", async () => {
  const f = fixture([cue("river", "loop")]);
  const createGain = f.context.createGain.bind(f.context);
  f.context.createGain = () => {
    const node = createGain();
    node.gain.cancelAndHoldAtTime = undefined;
    // Model a browser whose exposed value changes when the future endpoint goes.
    node.gain.cancelScheduledValues = () => { node.gain.value = -999; };
    return node;
  };
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("water", "river", .8)])); await flush();
  const param = f.context.started[0].connected[0].gain, level = 10 ** (-10 / 20);
  f.context.currentTime = .04;
  f.runtime.updateFrame(frame([target("water", "river", .3)]));
  let [hold, destination] = param.ramps.slice(-2);
  assert.ok(Math.abs(hold.value - level * .4) < 1e-10, "the interrupted 80 ms fade must hold its halfway level");
  assert.equal(hold.time, .04, "a ramp endpoint at the hold point preserves the rendered prefix");
  assert.equal(destination.value, level * .3); assert.equal(destination.time, .12);
  f.context.currentTime = .06;
  f.runtime.updateFrame(frame([target("water", "river", .9)]));
  [hold, destination] = param.ramps.slice(-2);
  assert.ok(Math.abs(hold.value - level * .375) < 1e-10, "another retarget must continue from the preceding linear segment");
  assert.equal(hold.time, .06); assert.equal(destination.value, level * .9);
  const count = param.ramps.length;
  for (let index = 0; index < 120; index++) f.runtime.updateFrame(frame([target("water", "river", .9)]));
  assert.equal(param.ramps.length, count, "legacy browsers also avoid redundant cancellation");
  assert.equal(f.context.started.length, 1);
  f.runtime.dispose();
});

test("muting a DEV tone samples its release envelope instead of restoring its attack level", async () => {
  const f = fixture();
  const createGain = f.context.createGain.bind(f.context);
  f.context.createGain = () => {
    const node = createGain(); node.gain.cancelAndHoldAtTime = undefined;
    node.gain.cancelScheduledValues = () => { node.gain.value = -999; };
    return node;
  };
  await f.runtime.unlock(); f.runtime.previewTone();
  const param = f.context.started[0].connected[0].gain;
  f.context.currentTime = .19;
  // The real browser exposes the tone's running, independently scheduled decay.
  const releasingLevel = 10 ** (-24 / 20) / 2;
  param.value = releasingLevel;
  f.runtime.setSettings({ enabled: false });
  const [hold, destination] = param.ramps.slice(-2);
  assert.equal(hold.value, releasingLevel); assert.equal(hold.time, .19);
  assert.equal(destination.value, 0);
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

test("cold decode cannot collapse spaced world contacts into a burst of simultaneous sounds", async () => {
  const f = fixture([cue("step", "one-shot", { cooldownMs: 120, maxInstances: 3 })]);
  const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock();
  for (let index = 0; index < 5; index++) {
    f.runtime.play({ id: `step-${index}`, cueId: "step" });
    f.advance(150);
  }
  await flush(); assert.equal(f.requests.length, 1);
  gate.resolve({ length: 22050, numberOfChannels: 1, duration: .5 }); await flush();
  assert.equal(f.context.started.length, 1, "loading must not replay the preceding contacts together at decode completion");
  f.advance(150); f.runtime.play({ id: "fresh-contact", cueId: "step" }); await flush();
  assert.equal(f.context.started.length, 2, "new contacts resume with their authored spacing once cached");
  f.runtime.dispose();
});

test("playback cooldown also spaces independently decoded variants that finish together", async () => {
  const f = fixture([cue("step", "one-shot", { assets: ["left", "right"], cooldownMs: 120, maxInstances: 3 })]);
  const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock();
  f.runtime.play({ id: "left-contact", cueId: "step" });
  f.advance(150); f.runtime.play({ id: "right-contact", cueId: "step" });
  await flush(); assert.equal(f.requests.length, 2);
  gate.resolve({ length: 22050, numberOfChannels: 1, duration: .5 }); await flush();
  assert.equal(f.context.started.length, 1);
  f.runtime.dispose();
});

test("music-only menu fades world sounds while preserving the song and interface taps", async t => {
  const f = fixture([cue("theme", "music"), cue("wind", "loop", { bus: "ambience", fadeMs: 800 }),
    cue("voice", "one-shot", { bus: "characters", fadeMs: 200 }), cue("tap", "one-shot", { bus: "ui" })]);
  await f.runtime.unlock();
  const loops = [target("theme", "theme"), target("wind", "wind")];
  f.runtime.updateFrame(frame(loops, { soundscape: true }));
  f.runtime.play({ id: "map-voice", cueId: "voice" }); await flush();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wind = f.context.started.find(source => source.loop), voice = f.context.started.find(source => !source.loop);
  f.media[0].currentTime = 19;
  // Even an erroneously retained ambient target is silenced by the frame scope.
  f.runtime.updateFrame(frame(loops, { soundscape: false, ownerId: "menu" }));
  assert.equal(wind.connected[0].gain.value, 0); assert.equal(voice.connected[0].gain.value, 0);
  assert.equal(wind.disconnected, false, "ambience must fade smoothly instead of cutting at menu entry");
  assert.equal(voice.disconnected, false, "character tails must fade on return to the menu too");
  f.runtime.play({ id: "menu-voice", cueId: "voice" });
  f.runtime.play({ id: "menu-click", cueId: "tap" }); await flush();
  assert.equal(f.context.started.length, 3, "only the interface tap can start while the soundscape is closed");
  assert.equal(f.media[0].plays, 1); assert.equal(f.media[0].currentTime, 19);
  t.mock.timers.tick(1000);
  assert.equal(wind.disconnected, true); assert.equal(voice.disconnected, true);
  f.runtime.dispose();
});

test("world decodes from a prior visit cannot catch up after menu then map, while UI decodes survive", async () => {
  const f = fixture([cue("step"), cue("tap", "one-shot", { bus: "ui" })]);
  const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock(); f.runtime.updateFrame(frame([], { soundscape: true }));
  f.runtime.play({ id: "old-step", cueId: "step" }); f.runtime.play({ id: "ui-tap", cueId: "tap" });
  await flush();
  f.runtime.updateFrame(frame([], { soundscape: false, ownerId: "menu" }));
  f.runtime.updateFrame(frame([], { soundscape: true, ownerId: "map-again" }));
  gate.resolve({ length: 22050, numberOfChannels: 1, duration: .5 }); await flush();
  assert.equal(f.context.started.length, 1, "only the cross-surface UI event remains valid");
  assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
  f.runtime.play({ id: "new-step", cueId: "step" }); await flush();
  assert.equal(f.context.started.length, 2, "the new visit can play its own contacts");
  f.runtime.dispose();
});

test("returning to the music-only menu releases a DEV audition of the forest bed", async () => {
  const f = fixture([cue("wind", "loop", { bus: "ambience", maxInstances: 1 })]);
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("bed", "wind")], { soundscape: true })); await flush();
  f.runtime.preview("wind");
  f.runtime.updateFrame(frame([], { soundscape: false }));
  assert.equal(f.context.started[0].connected[0].gain.value, 0);
  assert.equal(f.runtime.getDiagnostics().activeVoices, 0, "audition must not keep map ambience active above the menu");
  f.runtime.dispose();
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

test("DEV auditions a live loop once and restores its latest spatial target after four seconds", async t => {
  const f = fixture([cue("river", "loop", { maxInstances: 1 })]);
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water", "river", .2)])); await flush();
  // Asset I/O and its deadline finish on real timers; the mock owns only the
  // audition interval, without unrelated asynchronous server/cache callbacks.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gain = f.context.started[0].connected[0], panner = gain.connected[0];
  const level = 10 ** (-10 / 20);
  f.runtime.preview("river");
  assert.equal(f.context.started.length, 1, "a maxInstances=1 scene voice must be reused");
  assert.equal(gain.gain.value, level); assert.equal(panner.pan.value, 0);
  f.runtime.updateFrame(frame([{ ...target("water", "river", .35), pan: -.6 }]));
  assert.equal(gain.gain.value, level, "frame updates must not cancel the audition");
  t.mock.timers.tick(4000);
  assert.equal(gain.gain.value, level * .35); assert.equal(panner.pan.value, -.6);
  assert.equal(f.context.started.length, 1); assert.equal(f.requests.length, 1);
  f.runtime.dispose();
});

test("DEV auditions active music without a new stream or a playhead reset", async t => {
  const f = fixture([cue("day", "music", { maxInstances: 1 }), cue("night", "music", { maxInstances: 1 })]);
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("day", "day", .4), target("night", "night", .6)])); await flush();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const day = f.media.find(item => item.src === "/audio/day-a.wav");
  day.currentTime = 37;
  const gain = f.context.mediaSources.find(source => source.media === day).connected[0];
  f.runtime.preview("day");
  assert.equal(gain.gain.value, 10 ** (-10 / 20));
  assert.equal(f.media.length, 2, "audition must also work when both music decks are occupied");
  assert.equal(day.plays, 1); assert.equal(day.currentTime, 37);
  t.mock.timers.tick(4000);
  assert.equal(gain.gain.value, 10 ** (-10 / 20) * .4);
  assert.equal(f.runtime.getDiagnostics().activeVoices, 2); f.runtime.dispose();
});

test("DEV audition shares a pending scene decode and never leaks after hiding", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("river", "loop", { maxInstances: 1 })]);
  const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water", "river", .2)]));
  f.runtime.preview("river"); await flush();
  gate.resolve({ length: 44100, numberOfChannels: 1, duration: 1 }); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.context.started.length, 1);
  assert.equal(f.context.started[0].connected[0].gain.value, 10 ** (-10 / 20));
  f.runtime.setVisible(false); t.mock.timers.tick(5000); await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
  f.runtime.setVisible(true); await flush();
  assert.equal(f.context.started[1].connected[0].gain.value, 10 ** (-10 / 20) * .2);
  f.runtime.dispose();
});

test("DEV audition releases a loop no longer requested by the scene at the deadline", async t => {
  const f = fixture([cue("river", "loop", { maxInstances: 1 })]);
  await f.runtime.unlock(); f.runtime.updateFrame(frame([target("water")])); await flush();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.runtime.preview("river"); f.runtime.updateFrame(frame());
  assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
  t.mock.timers.tick(4000);
  assert.equal(f.runtime.getDiagnostics().activeVoices, 0); f.runtime.dispose();
});

test("weather mute leaves river and wildlife audible across camera movement and entry", async () => {
  const ids = ["weather.wind", "weather.rain", "forest.day", "river"];
  const cues = ids.map(id => AUDIO_CATALOG.cues.find(item => item.id === id));
  const f = fixture(cues, { initialSettings: { ...DEFAULT_AUDIO_SETTINGS, enabled: true,
    buses: { ...DEFAULT_AUDIO_SETTINGS.buses, weather: 0 } } });
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([], { soundscape: false }));
  for (let index = 0; index < 120; index++) {
    f.runtime.updateFrame(frame(ids.map(id => target(id, id, .2 + index / 150)), { ownerId: "map", soundscape: true }));
  }
  await flush();
  assert.equal(f.context.started.length, 2);
  assert.deepEqual(f.requests.map(request => request.url).sort(), ["/audio/forest.day.01.wav", "/audio/river.01.wav"]);
  f.runtime.setSettings({ buses: { ambience: 0, weather: .3 } }); await flush();
  assert.equal(f.context.started.length, 4, "weather can be enabled independently of forest/water");
  assert.deepEqual(f.requests.slice(2).map(request => request.url).sort(), ["/audio/weather.rain.01.wav", "/audio/weather.wind.01.wav"]);
  f.runtime.dispose();
});

test("muting weather during wind decode prevents delayed sound and later camera retries", async () => {
  const wind = AUDIO_CATALOG.cues.find(item => item.id === "weather.wind");
  const f = fixture([wind]); const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("weather", "weather.wind")], { soundscape: true })); await flush();
  assert.equal(f.requests.length, 1);
  f.runtime.setSettings({ buses: { weather: 0 } });
  gate.resolve({ length: 48000, numberOfChannels: 1, duration: 1 }); await flush();
  for (let index = 0; index < 120; index++) {
    f.runtime.updateFrame(frame([target("weather", "weather.wind", .9)], { soundscape: true }));
  }
  await flush();
  assert.equal(f.context.started.length, 0);
  f.runtime.updateFrame(frame([], { soundscape: false }));
  f.runtime.updateFrame(frame([target("weather", "weather.wind")], { soundscape: true })); await flush();
  assert.equal(f.context.started.length, 0, "re-entering the map cannot restore a muted weather bus");
  f.runtime.dispose();
});

test("weather fades on map exit and cannot start above the menu", async () => {
  const wind = AUDIO_CATALOG.cues.find(item => item.id === "weather.wind");
  const f = fixture([wind]); await f.runtime.unlock();
  const loops = [target("weather", "weather.wind")];
  f.runtime.updateFrame(frame(loops, { soundscape: false })); await flush();
  assert.equal(f.requests.length, 0, "music-only scope guards weather even if a stale target exists");
  f.runtime.updateFrame(frame(loops, { soundscape: true })); await flush();
  assert.equal(f.context.started.length, 1);
  const playingWind = f.context.started[0];
  f.runtime.updateFrame(frame([], { soundscape: false }));
  assert.equal(playingWind.connected[0].gain.value, 0);
  assert.equal(playingWind.disconnected, false, "map exit schedules the authored fade");
  f.runtime.updateFrame(frame(loops, { soundscape: false })); await flush();
  assert.equal(f.context.started.length, 1);
  assert.equal(playingWind.connected[0].gain.value, 0);
  f.runtime.dispose();
});
