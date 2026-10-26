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
const { createMarketAudioController } = await vite.ssrLoadModule("/features/audio/ui/market-audio.ts");
const { createTradeShipAudioController, TRADE_SHIP_ARRIVAL_AUDIO: shipContact } = await vite.ssrLoadModule("/features/world/audio/trade-ship-audio.ts");
const { sampleTradeShipMotion } = await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");
const { AUDIO_VISIBILITY_RELEASE_SECONDS: RELEASE_SECONDS, AUDIO_VISIBILITY_CLEANUP_MS: CLEANUP_MS } = await vite.ssrLoadModule("/features/audio/runtime/audio-release-clock.ts");

class Param {
  value = 0; ramps = [];
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value, time) { this.value = value; this.ramps.push({ value, time }); }
  setTargetAtTime(value, time, timeConstant) { this.value = value; this.ramps.push({ value, time, timeConstant }); }
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
class Constant extends Node {
  offset = new Param(); stops = []; onended = null; started = 0;
  start() { this.started++; }
  stop(time) { this.stops.push(time); }
  end() { this.onended?.(); }
}
class Context {
  clocks = [];
  createConstantSource() { const node = new Constant(); this.clocks.push(node); return node; }
  currentTime = 0; state = "suspended"; destination = new Node(); sources = []; started = []; decoded = 0; mediaSources = []; gains = []; resumes = 0;
  createGain() { const node = new Gain(); this.gains.push(node); return node; }
  createStereoPanner() { return new Panner(); }
  createBufferSource() { const node = new Source(this); this.sources.push(node); return node; }
  createOscillator() { const source = new Source(this); source.frequency = new Param(); return source; }
  createMediaElementSource(media) { const node = new Node(); node.media = media; this.mediaSources.push(node); return node; }
  async resume() { this.resumes++; this.state = "running"; this.onstatechange?.(); }
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

test("ship horn cannot emerge after a slow decode, muted contact or owner/view handoff", async () => {
  for (const scenario of ["expired", "muted", "owner", "circle"]) {
    const decoding = deferred();
    const f = fixture([cue("ship.arrival", "one-shot", { gainDb: -13, maxInstances: 1, pitchVariation: 0 })]);
    f.context.decode = () => decoding.promise;
    const ship = createTradeShipAudioController(f.runtime);
    const current = frame([], { listener: { position: { x: 1000, y: 1300 }, viewportWidth: 500, zoom: 1, detail: 1 } });
    try {
      await f.runtime.unlock(); f.runtime.updateFrame(current);
      const update = elapsed => ship.update({ voyageId: "first-ship", motion: sampleTradeShipMotion("arriving", elapsed),
        frame: current, active: true, visible: true, now: 100_000 });
      update(shipContact.contactAt - .01); await flush();
      if (scenario === "muted") f.runtime.setSettings({ buses: { world: 0 } });
      update(shipContact.contactAt + .01);
      if (scenario === "expired") f.advance(351);
      if (scenario === "owner") f.runtime.updateFrame({ ...current, ownerId: "other-account-map" });
      if (scenario === "circle") f.runtime.updateFrame({ ...current, soundscape: false });
      decoding.resolve({ length: 124800, numberOfChannels: 1, duration: 2.6 }); await flush(); await flush();
      assert.equal(f.context.started.length, 0, scenario);
      f.runtime.setSettings({ buses: { world: 1 } }); f.runtime.updateFrame(current);
      update(shipContact.contactAt + .03); await flush(); assert.equal(f.context.started.length, 0, "no replay after return/unmute");
    } finally { ship.dispose(); f.runtime.dispose(); }
  }
});

test("entering and leaving a trading counter ducks the existing music without a second deck or rewind", async () => {
  const f = fixture([cue("music.day", "music")], { now: () => Date.now() });
  const counter = createMarketAudioController(f.runtime, "counter");
  try {
    await f.runtime.unlock();
    const forest = frame([target("music-day:music.day", "music.day", 1)]);
    f.runtime.updateFrame(forest); await flush();
    assert.equal(f.media.length, 1); f.media[0].currentTime = 27;
    counter.update({ active: true, sceneId: forest.sceneId, night: false }); await flush();
    for (let tick = 0; tick < 50; tick++) counter.update({ active: true, sceneId: forest.sceneId, night: false });
    await flush();
    assert.equal(f.context.started.length, 0, "market entry is silent");
    assert.equal(f.media.length, 1); assert.equal(f.media[0].currentTime, 27);
    assert.equal(f.runtime.getDiagnostics().playback.musicStarts, 1);
    f.runtime.updateFrame(forest); counter.update({ active: false, sceneId: forest.sceneId, night: false });
    await flush();
    assert.equal(f.media.length, 1); assert.equal(f.media[0].currentTime, 27);
    assert.equal(f.media[0].plays, 1, "the existing song never paused or restarted");
    assert.equal(f.runtime.getDiagnostics().playback.activeOwnerId, "user-a");
  } finally { counter.dispose(); f.runtime.dispose(); }
});

for (const cueId of ["action.water.touch", "action.tree.rustle"]) {
  const maxAgeMs = cueId === "action.tree.rustle" ? 200 : 180;
  test(`owned ${cueId} taps cannot finish decoding after losing their active view or sound`, async () => {
    const touch = AUDIO_CATALOG.cues.find(cue => cue.id === cueId);
    for (const transition of ["clear", "handoff", "return", "menu", "hidden", "mute"]) {
      const f = fixture([touch]), gate = deferred(); f.context.decode = () => gate.promise;
      try {
        await f.runtime.unlock(); f.runtime.updateFrame(frame());
        f.runtime.play({ id: "owned-tap", cueId: touch.id, ownerId: "user-a", maxAgeMs });
        await flush();
        if (transition === "clear") f.runtime.clearFrame("user-a");
        else if (transition === "menu") f.runtime.updateFrame(frame([], { soundscape: false }));
        else if (transition === "hidden") f.runtime.setVisible(false);
        else if (transition === "mute") f.runtime.setSettings({ buses: { world: 0 } });
        else f.runtime.updateFrame(frame([], { ownerId: "user-b" }));
        if (transition === "return") f.runtime.updateFrame(frame());
        gate.resolve({ length: 4800, numberOfChannels: 1, duration: .1 });
        await flush();
        assert.equal(f.context.started.length, 0, transition);
      } finally { f.runtime.dispose(); }
    }
  });

  test(`same-owner camera updates retain ${cueId} while another owner's requests are rejected`, async () => {
    const touch = AUDIO_CATALOG.cues.find(cue => cue.id === cueId);
    const f = fixture([touch]), gate = deferred(); f.context.decode = () => gate.promise;
    try {
      await f.runtime.unlock(); f.runtime.updateFrame(frame());
      f.runtime.play({ id: "wrong-view", cueId: touch.id, ownerId: "retired-view", maxAgeMs });
      assert.equal(f.requests.length, 0);
      f.runtime.play({ id: "owned-tap", cueId: touch.id, ownerId: "user-a", maxAgeMs });
      await flush(); f.runtime.updateFrame(frame([], { listener: { ...frame().listener, zoom: 3 } }));
      gate.resolve({ length: 4800, numberOfChannels: 1, duration: .1 }); await flush();
      assert.equal(f.context.started.length, 1, "zooming does not revoke a current owner");
    } finally { f.runtime.dispose(); }
  });

  test(`${cueId} obeys unlock, master and world mute, visibility, expiry and bounded polyphony`, async () => {
    const touch = AUDIO_CATALOG.cues.find(cue => cue.id === cueId);
    const f = fixture([touch]);
    let sequence = 0;
    const tap = () => f.runtime.play({ id: `tap:${++sequence}`, cueId: touch.id, ownerId: "user-a", maxAgeMs });
    try {
      f.runtime.updateFrame(frame()); tap();
      await f.runtime.unlock(); await flush();
      assert.equal(f.context.started.length, 0, "a locked tap is never replayed after unlock");
      await f.runtime.prepare([touch.id]);
      for (const patch of [{ enabled: false }, { master: 0 }, { buses: { world: 0 } }]) {
        f.runtime.setSettings(patch); tap(); await flush();
        assert.equal(f.context.started.length, 0);
        f.runtime.setSettings({ enabled: true, master: .65, buses: { world: .55 } });
        f.advance(200);
      }
      f.runtime.setVisible(false); tap(); await flush();
      assert.equal(f.context.started.length, 0, "hidden view is silent");
      f.context.currentTime += RELEASE_SECONDS;
      f.context.clocks.at(-1).end();
      f.runtime.setVisible(true); await f.runtime.unlock();
      f.runtime.play({ id: "expired-tap", cueId: touch.id, ownerId: "user-a", occurredAt: 1, maxAgeMs });
      await flush(); assert.equal(f.context.started.length, 0);
      for (let index = 0; index < 20; index++) { tap(); await flush(); f.advance(30); }
      assert.equal(f.context.started.length, 2, "rapid taps share two quiet voices without a backlog");
      assert.ok(f.context.started.every(source => Math.abs(source.playbackRate.value - 1) <= touch.pitchVariation));
    } finally { f.runtime.dispose(); }
  });
}

test("prepared building completion plays once in the simple view without sharing reward cooldown", async () => {
  const f = fixture([], { catalog: AUDIO_CATALOG });
  try {
    await f.runtime.unlock();
    f.runtime.updateFrame(frame([], { soundscape: false }));
    await f.runtime.prepare(["ui.construction-complete"]);
    assert.equal(f.context.started.length, 0, "preparation never celebrates an unfinished building");
    const path = "/audio/originals-v1/effect/ui.construction-complete.01.wav";
    assert.equal(f.requests.filter(request => request.url === path).length, 1);
    f.runtime.play({ id: "just-collected", cueId: "ui.reward" });
    await flush();
    assert.equal(f.context.started.length, 1);
    const event = { id: "economy:user-a:construction:home-job", cueId: "ui.construction-complete" };
    f.runtime.play(event);
    await flush();
    assert.equal(f.context.started.length, 2, "a recent generic reward cannot swallow the building signature");
    f.runtime.play(event);
    f.advance(1200);
    f.runtime.play(event);
    await flush();
    assert.equal(f.context.started.length, 2, "the same receipt is consumed even after cue cooldown");
    assert.equal(f.requests.filter(request => request.url === path).length, 1, "completion reuses the prepared recording");
  } finally { f.runtime.dispose(); }
});

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

test("music, weather and footsteps use the same gain graph when native media volume is read-only", async () => {
  const players = [];
  const f = fixture([], { catalog: AUDIO_CATALOG, createMediaElement() {
    const player = new Media(); player.volumeWrites = 0;
    // iOS-style HTMLMediaElement volume semantics: reads 1 and ignores writes.
    Object.defineProperty(player, "volume", { get: () => 1, set() { player.volumeWrites++; } });
    players.push(player); return player;
  } });
  const outputGain = source => {
    let node = source, gain = 1, visited = new Set();
    while (node !== f.context.destination) {
      assert.ok(!visited.has(node), "acyclic signal path"); visited.add(node);
      if (node.gain) gain *= node.gain.value;
      assert.equal(node.connected.length, 1, "no branch bypasses the bus or master");
      node = node.connected[0];
    }
    assert.ok(visited.has(f.context.gains[0]), "all streams and effects pass the master");
    return gain;
  };
  try {
    await f.runtime.unlock();
    f.runtime.updateFrame(frame([target("music", "music.day", 1), target("wind", "weather.wind", 1),
      target("rain", "weather.rain", 1)]));
    f.runtime.play({ id: "close-step", cueId: "action.step.grass", gain: 1 });
    for (let index = 0; index < 8; index++) await flush();
    const wind = f.context.started.find(source => source.loop && source.connected[0].gain.value === 10 ** (-36 / 20));
    const rain = f.context.started.find(source => source.loop && source.connected[0].gain.value === 10 ** (-10 / 20));
    const step = f.context.started.find(source => !source.loop);
    const music = f.context.mediaSources[0];
    assert.ok(wind && rain && step && music);
    const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ~= ${expected}`);
    close(outputGain(wind), 10 ** (-36 / 20) * .3 * .65);
    close(outputGain(rain), 10 ** (-10 / 20) * .3 * .65);
    close(outputGain(step), 10 ** (-22 / 20) * .25 * .65);
    close(outputGain(music), .1 * .65);
    f.runtime.setSettings({ master: .4, buses: { weather: .15, footsteps: .2, music: .3 } });
    close(outputGain(wind), 10 ** (-36 / 20) * .15 * .4);
    close(outputGain(step), 10 ** (-22 / 20) * .2 * .4);
    close(outputGain(music), .3 * .4);
    f.runtime.setSettings({ buses: { weather: 0 } });
    close(outputGain(wind), 0); close(outputGain(rain), 0);
    assert.ok(outputGain(step) > 0 && outputGain(music) > 0);
    f.runtime.setSettings({ master: 0 });
    close(outputGain(step), 0); close(outputGain(music), 0);
    assert.ok(players.every(player => player.volume === 1 && player.volumeWrites === 0),
      "balance never depends on the unsupported element volume property");
  } finally { f.runtime.dispose(); }
});

// Every fixture is disposed so timers/voices cannot leak between otherwise independent cases.
test("SSR and disabled runtime allocate no context, fetches or singleton account state", async () => {
  assert.notEqual(getAudioRuntime(), getAudioRuntime());
  const f = fixture(undefined, { initialSettings: { ...DEFAULT_AUDIO_SETTINGS, enabled: false } });
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
  const musicBus = f.context.mediaSources[0].connected[0].connected[0].connected[0].connected[0].gain;
  const riverGain = f.context.started[0].connected[0].gain;
  const riverPan = f.context.started[0].connected[0].connected[0].pan;
  const counts = [master, musicBus, riverGain, riverPan].map(param => param.ramps.length);
  f.context.currentTime = 4;
  const next = frame([target("theme", "theme"), { ...target("water", "river", .25), pan: -.7 }], { musicDuck: .68 });
  f.runtime.updateFrame(next);
  assert.equal(master.ramps.length, counts[0]);
  assert.equal(musicBus.ramps.length, counts[1] + 1);
  assert.equal(musicBus.ramps.at(-1).timeConstant, .8 / 3, "camera-driven music ducking also stays on the native envelope");
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

test("camera retargets and proximity fades never re-anchor spatial loops on a rounded clock", async () => {
  for (const legacy of [false, true]) {
    const f = fixture([cue("river", "loop"), cue("campfire", "loop")]);
    await f.runtime.unlock();
    const targets = [target("water"), target("fire", "campfire")];
    f.runtime.updateFrame(frame(targets)); await flush();
    const params = f.context.started.flatMap(source => [source.connected[0].gain, source.connected[0].connected[0].pan]);
    for (const param of params) {
      if (legacy) param.cancelAndHoldAtTime = undefined;
      else param.cancelAndHoldAtTime = () => assert.fail("continuous spatial automation must not cancel");
      param.cancelScheduledValues = () => assert.fail("camera motion must not discard the running envelope");
      param.setValueAtTime = () => assert.fail("a JS clock estimate must not set the rendered value");
      param.linearRampToValueAtTime = () => assert.fail("spatial loops must use native continuous targets");
    }
    for (let index = 1; index <= 240; index++) {
      // Strong privacy rounding: several pointer/camera frames share one time.
      f.context.currentTime = Math.floor(index / 120 * 10) / 10;
      f.runtime.updateFrame(frame(targets.map((item, offset) => ({ ...item,
        gain: .4 + .3 * Math.sin(index / 17 + offset), pan: .6 * Math.sin(index / 29 + offset),
      }))));
    }
    f.runtime.updateFrame(frame([]));
    for (const source of f.context.started) {
      const release = source.connected[0].gain.ramps.at(-1);
      assert.equal(release.value, 0); assert.equal(release.timeConstant, .3 / 8);
    }
    f.context.currentTime += .1;
    f.runtime.updateFrame(frame(targets));
    assert.equal(f.context.started.length, 2, "radius re-entry must reclaim the same river and fire voices");
    assert.equal(f.runtime.getDiagnostics().playback.loopStarts, 2);
    f.runtime.setSettings({ enabled: false });
    for (const source of f.context.started) {
      const release = source.connected[0].gain.ramps.at(-1);
      assert.equal(release.value, 0); assert.equal(release.timeConstant, .08 / 8,
        "a final stop must be effectively silent before source.stop");
    }
    f.runtime.dispose();
  }
});

test("legacy finite music fades close the interrupted ramp without resetting its held value", async () => {
  const f = fixture([cue("river", "music")]);
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
  const param = f.context.mediaSources[0].connected[0].gain, level = 10 ** (-10 / 20);
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
  assert.equal(f.media.length, 1);
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
  assert.equal(f.context.decoded, 1, "downloads may overlap but the native decoder stays serial");
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

test("footstep decodes from a prior visit cannot catch up after menu then map, while UI decodes survive", async () => {
  const f = fixture([cue("step", "one-shot", { bus: "footsteps" }), cue("tap", "one-shot", { bus: "ui" })]);
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

test("streamed song boundaries fade independently of scene tuning and retain one deck across ownership handoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("theme", "music")]);
  try {
    await f.runtime.unlock();
    const loops = [target("song", "theme")];
    f.runtime.updateFrame(frame(loops, { soundscape: false, ownerId: "menu" })); await flush();
    const player = f.media[0]; player.duration = 120; player.currentTime = 0;
    player.onloadedmetadata();
    const envelope = f.context.mediaSources[0].connected[0].connected[0].connected[0].gain;
    assert.ok(envelope.ramps.some(point => point.value === 0 && point.time === 120), "silence is scheduled at the exact native loop boundary");
    assert.ok(envelope.ramps.some(point => point.value === 1 && point.time === 122.5), "the next attack is scheduled before timeupdate can arrive");
    const count = envelope.ramps.length;
    for (let index = 0; index < 60; index++) f.runtime.updateFrame(frame(loops, { soundscape: false, ownerId: "menu", musicDuck: .8 }));
    assert.equal(envelope.ramps.length, count, "frame gain/duck tuning cannot overwrite the loop envelope");
    f.runtime.clearFrame("menu");
    f.runtime.updateFrame(frame(loops, { ownerId: "map" }));
    f.context.currentTime = 120.2; player.currentTime = .2;
    t.mock.timers.tick(200);
    assert.ok(envelope.ramps.some(point => point.value === 0 && point.time === 240), "static-menu watchdog schedules the next cycle without a media event");
    assert.equal(f.media.length, 1); assert.equal(player.plays, 1);
    assert.equal(f.context.decoded, 0); assert.equal(f.requests.length, 0);
  } finally { f.runtime.dispose(); }
});

test("music boundary automation is released on mute, background, account change and disposal", async t => {
  for (const action of ["mute", "music-zero", "hidden", "account", "dispose"]) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture([cue("theme", "music")]);
    try {
      await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "theme")], { soundscape: false })); await flush();
      const player = f.media[0]; player.duration = 120; player.currentTime = 119;
      player.onloadedmetadata();
      const envelope = f.context.mediaSources[0].connected[0].connected[0].connected[0];
      const queuedUpdate = player.ontimeupdate;
      if (action === "mute") f.runtime.setSettings({ enabled: false });
      if (action === "music-zero") f.runtime.setSettings({ buses: { music: 0 } });
      if (action === "hidden") f.runtime.setVisible(false);
      if (action === "account") f.runtime.updateFrame(frame([], { sceneId: "account-b" }));
      if (action === "dispose") f.runtime.dispose();
      assert.equal(player.ontimeupdate, null, action);
      assert.equal(player.onplaying, null, action);
      assert.equal(player.onwaiting, null, action);
      const count = envelope.gain.ramps.length;
      f.context.currentTime = 200;
      queuedUpdate(); t.mock.timers.tick(10_000); await flush();
      assert.equal(envelope.gain.ramps.length, count, `${action}: stale loop callbacks cannot schedule another attack`);
      assert.equal(envelope.disconnected, true, action);
      assert.equal(f.media.length, 1); assert.equal(player.plays, 1);
    } finally { f.runtime.dispose(); t.mock.timers.reset(); }
  }
});

test("hide stops voices, foreground restores loops once and never replays earlier one-shots", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("water")])); f.runtime.play({ id: "first", cueId: "tap" }); await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 2);
  f.runtime.setVisible(false); assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
  f.runtime.play({ id: "hidden", cueId: "tap" }); f.runtime.setVisible(true);
  f.context.currentTime += CLEANUP_MS / 1000; t.mock.timers.tick(CLEANUP_MS); await flush();
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

test("hiding releases the mixed waveform before pausing media, stopping effects or suspending the device", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("song", "music"), cue("river", "loop"), cue("tap")]);
  try {
    await f.runtime.unlock();
    f.runtime.updateFrame(frame([target("song", "song"), target("river", "river")]));
    f.runtime.play({ id: "tap-before-hide", cueId: "tap" }); await flush();
    const player = f.media[0], sources = [...f.context.started, ...f.context.mediaSources];
    const master = f.context.gains[0].gain;
    const suspend = f.context.suspend.bind(f.context); let suspensions = 0;
    f.context.suspend = () => { suspensions++; assert.ok(f.context.currentTime >= 2 + RELEASE_SECONDS); return suspend(); };
    f.context.currentTime = 2;
    f.runtime.setVisible(false);
    assert.equal(f.runtime.getDiagnostics().activeVoices, 0, "logical playback is revoked synchronously");
    assert.equal(f.runtime.getDiagnostics().state, "suspended");
    assert.deepEqual(master.ramps.at(-1), { value: 0, time: 2 + RELEASE_SECONDS });
    assert.equal(player.pauses, 0); assert.equal(player.loads, 0);
    assert.ok(sources.every(source => !source.disconnected), "a running nonzero signal is never physically severed");
    assert.ok(f.context.started.every(source => source.stops.length === 0));
    assert.equal(suspensions, 0);
    assert.equal(player.onpause, null); assert.equal(player.ontimeupdate, null);
    f.runtime.play({ id: "hidden-tap", cueId: "tap" });
    f.context.currentTime = 2 + RELEASE_SECONDS / 2; t.mock.timers.tick(RELEASE_SECONDS * 500);
    assert.equal(player.pauses, 0, "the native ramp owns the release, not a per-voice pause");
    f.context.currentTime = 2 + CLEANUP_MS / 1000; t.mock.timers.tick(CLEANUP_MS - RELEASE_SECONDS * 500); await flush();
    assert.ok(sources.every(source => source.disconnected));
    assert.equal(player.pauses, 1); assert.equal(player.loads, 1); assert.equal(player.src, "");
    assert.equal(suspensions, 1); assert.equal(f.context.state, "suspended");
    assert.equal(f.context.started.length, 2, "hidden UI input is consumed, never queued");
  } finally { f.runtime.dispose(); }
});

test("visibility release preserves an earlier mute deadline instead of extending or cutting its still-audible tail", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("river")])); await flush();
    f.context.currentTime = 2;
    f.runtime.setSettings({ enabled: false });
    const master = f.context.gains[0].gain;
    assert.equal(master.ramps.at(-1).time, 2.12);
    f.context.currentTime = 2.005;
    f.runtime.setVisible(false);
    assert.ok(Math.abs(master.ramps.at(-1).time - 2.12) < 1e-10);
    assert.equal(master.ramps.at(-1).value, 0);
    f.context.currentTime = 2.005 + CLEANUP_MS / 1000; t.mock.timers.tick(CLEANUP_MS); await flush();
    assert.equal(f.context.started[0].disconnected, true);
  } finally { f.runtime.dispose(); }
});

test("hiding halfway through the initial attack keeps the waveform continuous in older browsers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("song", "music")]), anchors = [];
  const createGain = f.context.createGain.bind(f.context);
  f.context.createGain = () => {
    const gain = createGain();
    if (f.context.gains.length === 1) {
      gain.gain.cancelAndHoldAtTime = undefined;
      gain.gain.setValueAtTime = (value, time) => { gain.gain.value = value; anchors.push({ value, time }); };
    }
    return gain;
  };
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "song")])); await flush();
    f.context.currentTime = .06; f.runtime.setVisible(false);
    assert.deepEqual(anchors.at(-1), { value: DEFAULT_AUDIO_SETTINGS.master / 2, time: .06 },
      "release begins at the interpolated attack value instead of jumping to full volume or zero");
    assert.deepEqual(f.context.gains[0].gain.ramps.at(-2), anchors.at(-1));
    assert.deepEqual(f.context.gains[0].gain.ramps.at(-1), { value: 0, time: .06 + RELEASE_SECONDS });
    assert.equal(f.media[0].pauses, 0);
    f.context.currentTime = .06 + RELEASE_SECONDS; f.context.clocks[0].end();
    assert.equal(f.media[0].pauses, 1); assert.deepEqual(anchors.at(-1), { value: 0, time: .24 });
  } finally { f.runtime.dispose(); }
});

test("foreground during the short release waits for silence and never revives old one-shots", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("song", "music"), cue("tap")]);
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "song")]));
    f.runtime.play({ id: "before-hide", cueId: "tap" }); await flush();
    const oldPlayer = f.media[0], oldEffect = f.context.started[0]; oldPlayer.currentTime = 43;
    let suspensions = 0; f.context.suspend = async () => { suspensions++; };
    f.context.currentTime = 1;
    f.runtime.setVisible(false); f.runtime.setVisible(true); await flush();
    assert.equal(f.media.length, 1); assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
    assert.equal(f.context.gains[0].gain.ramps.at(-1).value, 0, "foreground cannot reopen the old mix mid-release");
    f.context.currentTime = 1 + CLEANUP_MS / 1000; t.mock.timers.tick(CLEANUP_MS); await flush();
    assert.equal(suspensions, 0, "returning before cleanup does not issue an obsolete suspend request");
    assert.equal(oldEffect.disconnected, true); assert.equal(oldPlayer.src, "");
    assert.equal(f.context.started.length, 1, "the old one-shot never starts a second time");
    assert.equal(f.media.length, 2); assert.equal(f.media[1].currentTime, 43);
    assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
    assert.equal(f.context.gains[0].gain.ramps.at(-1).value, DEFAULT_AUDIO_SETTINGS.master);
  } finally { f.runtime.dispose(); }
});

test("rapid Home and tab returns cannot cut a stalled native waveform or accumulate audio work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("song", "music"), cue("tap")]);
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "song")]));
    f.runtime.play({ id: "before-home", cueId: "tap" }); await flush();
    const player = f.media[0], effect = f.context.started[0], master = f.context.gains[0].gain;
    player.currentTime = 29; f.context.currentTime = 10;
    const suspend = f.context.suspend.bind(f.context); let suspensions = 0;
    f.context.suspend = () => { suspensions++; return suspend(); };
    const timer = t.mock.method(globalThis, "setTimeout");
    f.runtime.setVisible(false);
    const nativeClock = f.context.clocks[0], queuedEnd = nativeClock.onended;
    f.context.currentTime = 10.005;
    for (let index = 0; index < 100; index++) {
      f.runtime.setVisible(true); f.runtime.setVisible(false);
    }
    assert.equal(f.context.clocks.length, 1); assert.equal(timer.mock.callCount(), 2,
      "one fallback and one shared bounded foreground wait, with no polling per event");
    t.mock.timers.tick(60_000); await flush();
    assert.equal(player.pauses, 0); assert.equal(effect.disconnected, false);
    assert.equal(suspensions, 0); assert.equal(f.contextCount, 1); assert.equal(f.context.resumes, 1);
    assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
    assert.equal(master.ramps.at(-1).value, 0);
    f.runtime.setVisible(true);
    assert.equal(await f.runtime.unlock(), false, "a stuck clock returns without hanging the gesture");
    assert.equal(f.media.length, 1); assert.equal(timer.mock.callCount(), 2);
    f.context.currentTime = 10 + RELEASE_SECONDS; queuedEnd(); await flush();
    assert.equal(player.pauses, 1); assert.equal(effect.disconnected, true);
    assert.equal(f.media.length, 2); assert.equal(f.media[1].currentTime, 29);
    assert.equal(f.context.started.length, 1, "old effects are not replayed");
    assert.equal(f.context.resumes, 1, "repeated tab events do not flood native resume");
    assert.equal(suspensions, 0, "the current foreground supersedes an obsolete hidden suspension");
    queuedEnd(); await flush(); assert.equal(f.media.length, 2, "late native end is fenced");
  } finally { f.runtime.dispose(); }
});

test("mute and account changes during a frozen release never reopen retired or hidden sound", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["mute", "account"]) {
    const f = fixture([cue("song", "music"), cue("tap")]);
    try {
      await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "song")]));
      f.runtime.play({ id: "old-contact", cueId: "tap" }); await flush();
      const oldPlayer = f.media[0]; oldPlayer.currentTime = 48;
      f.context.currentTime = 1; f.runtime.setVisible(false);
      if (action === "mute") f.runtime.setSettings({ enabled: false });
      else f.runtime.updateFrame(frame([target("song", "song")], { ownerId: "user-b", sceneId: "new-account" }));
      t.mock.timers.tick(5000); await flush();
      assert.equal(f.media.length, 1); assert.equal(oldPlayer.pauses, 0);
      f.context.currentTime = 1 + RELEASE_SECONDS; f.context.clocks.at(-1).end(); await flush();
      assert.equal(oldPlayer.pauses, 1); assert.equal(oldPlayer.src, "");
      assert.equal(f.runtime.getDiagnostics().activeVoices, 0, `${action}: background remains silent`);
      f.runtime.setVisible(true); await flush();
      assert.equal(f.context.started.length, 1, `${action}: no old one-shot tail`);
      if (action === "mute") {
        assert.equal(f.media.length, 1); assert.equal(await f.runtime.unlock(), false);
      } else {
        assert.equal(f.media.length, 2); assert.equal(f.media[1].currentTime, undefined,
          "another account never inherits the old music playhead");
        assert.equal(f.runtime.getDiagnostics().playback.activeOwnerId, "user-b");
      }
    } finally { f.runtime.dispose(); }
  }
});

test("a missed native end callback is recovered from actual audio time before the foreground attack", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("song", "music")]);
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "song")])); await flush();
    f.context.currentTime = 4; f.runtime.setVisible(false);
    t.mock.timers.tick(CLEANUP_MS); await flush();
    assert.equal(f.media[0].pauses, 0);
    // Browsers may throttle the ended task as well as the fallback timer. The
    // audio deadline itself is sufficient when the user returns.
    f.context.currentTime = 4 + RELEASE_SECONDS;
    f.runtime.setVisible(true); await flush();
    assert.equal(f.media[0].pauses, 1); assert.equal(f.media.length, 2);
    assert.equal(f.runtime.getDiagnostics().state, "running");
  } finally { f.runtime.dispose(); }
});

test("pending native suspend cannot cut a new foreground song, and a stalled promise never hangs unlock", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("song", "music")]);
  const pending = deferred();
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "song")])); await flush();
    f.media[0].currentTime = 43;
    f.context.suspend = () => pending.promise;
    f.context.currentTime = 1;
    f.runtime.setVisible(false);
    f.context.currentTime = 1 + CLEANUP_MS / 1000; t.mock.timers.tick(CLEANUP_MS); await flush();
    f.runtime.setVisible(true);
    const unlocking = f.runtime.unlock();
    t.mock.timers.tick(250);
    assert.equal(await unlocking, false);
    assert.equal(f.media.length, 1); assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
    f.context.state = "interrupted"; f.context.onstatechange(); await flush();
    assert.equal(f.media.length, 1, "Safari interruption cannot release an outstanding native suspend fence");
    assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
    // WebKit can emit the stopped state before resolving suspend(). The state
    // confirmation is enough to allow a fresh graph and preserve the playhead.
    f.context.state = "suspended"; f.context.onstatechange(); await flush();
    assert.equal(f.media.length, 2); assert.equal(f.media[1].currentTime, 43);
    assert.equal(f.runtime.getDiagnostics().state, "running");
    pending.resolve(); await flush();
    assert.equal(f.media.length, 2, "late promise settlement cannot restart or suspend the new deck");
  } finally { pending.resolve(); f.runtime.dispose(); }
});

test("a rejected native suspension leaves the hidden graph silent and permits a fresh foreground attack", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("song", "music")]);
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "song")])); await flush();
    f.context.suspend = async () => { throw new Error("Device interruption"); };
    f.context.currentTime = 1; f.runtime.setVisible(false);
    f.context.currentTime = 1 + CLEANUP_MS / 1000; t.mock.timers.tick(CLEANUP_MS); await flush();
    assert.equal(f.context.gains[0].gain.value, 0);
    assert.equal(f.media[0].src, ""); assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
    f.runtime.setVisible(true); await flush();
    assert.equal(f.media.length, 2); assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
  } finally { f.runtime.dispose(); }
});

test("a pending media play result loses ownership as soon as the page hides", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(), player = new Media(); player.play = () => pending.promise;
  const f = fixture([cue("song", "music")], { createMediaElement: () => player });
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "song")]));
    f.context.currentTime = 1; f.runtime.setVisible(false);
    pending.reject(new DOMException("Old permission rejected", "NotAllowedError")); await flush();
    assert.deepEqual(f.runtime.getDiagnostics().failedAssets, []);
    assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
    assert.equal(player.onpause, null); assert.equal(player.ontimeupdate, null);
    f.context.currentTime = 1 + CLEANUP_MS / 1000; t.mock.timers.tick(CLEANUP_MS); await flush();
    assert.equal(player.src, "");
  } finally { f.runtime.dispose(); }
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

test("foreground music resumes its playhead while account changes discard old positions", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([cue("theme", "music")]); await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("theme", "theme")], { sceneId: "account-a:forest" })); await flush();
  f.media[0].currentTime = 43;
  f.runtime.setVisible(false); f.runtime.setVisible(true);
  f.context.currentTime += CLEANUP_MS / 1000; t.mock.timers.tick(CLEANUP_MS); await flush();
  assert.equal(f.media[1].currentTime, 43);
  f.runtime.updateFrame(frame([target("theme", "theme")], { sceneId: "account-b:forest" })); await flush();
  assert.equal(f.media[2].currentTime ?? 0, 0); f.runtime.dispose();
});

test("hung decode releases callers at its deadline but holds its native decoder claim until completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const gate = deferred(); f.context.decode = () => gate.promise;
  await f.runtime.unlock(); f.runtime.play({ id: "old", cueId: "tap" }); await flush();
  assert.equal(f.runtime.getDiagnostics().pendingAssets, 1);
  t.mock.timers.tick(12_001); await flush();
  assert.equal(f.runtime.getDiagnostics().pendingAssets, 1, "an uncancellable native decoder must not overlap its retry");
  assert.deepEqual(f.runtime.getDiagnostics().failedAssets, ["tap-a"]);
  gate.resolve({ length: 44100, numberOfChannels: 1, duration: 1 }); await flush();
  assert.equal(f.runtime.getDiagnostics().pendingAssets, 0);
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
  f.runtime.setVisible(false); f.context.currentTime += CLEANUP_MS / 1000;
  t.mock.timers.tick(5000); await flush();
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

test("a brief failed river download recovers on the next second's frame instead of a 30-second gap", async () => {
  let attempts = 0;
  const f = fixture([cue("river", "loop", { bus: "ambience" })], {
    fetchAsset: async () => new Response(new Uint8Array([1]), { status: ++attempts === 1 ? 503 : 200 }),
  });
  try {
    await f.runtime.unlock();
    const scene = frame([target("river", "river")], { soundscape: true });
    f.runtime.updateFrame(scene); await flush();
    assert.equal(f.context.started.length, 0); assert.equal(attempts, 1);
    f.advance(999); f.runtime.updateFrame(scene); await flush(); assert.equal(attempts, 1);
    f.advance(1); f.runtime.updateFrame(scene); await flush();
    assert.equal(attempts, 2); assert.equal(f.context.started.length, 1);
    f.runtime.updateFrame(scene); await flush(); assert.equal(f.context.started.length, 1, "recovery creates one loop");
  } finally { f.runtime.dispose(); }
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

test("actual cooking loop obeys world mute and keeps one playing source through rain and camera movement", async () => {
  const { buildWorldAudioFrame } = await vite.ssrLoadModule("/features/world/audio/world-audio-frame.ts");
  const cooking = AUDIO_CATALOG.cues.find(item => item.id === "cooking.simmer");
  assert.ok(cooking, "the working pot resolves to an authored ready loop");
  const f = fixture([], { catalog: { ...AUDIO_CATALOG, cues: [cooking] },
    initialSettings: { ...DEFAULT_AUDIO_SETTINGS, enabled: true, buses: { ...DEFAULT_AUDIO_SETTINGS.buses, world: 0 } } });
  const now = Date.parse("2026-10-11T12:00:00Z"), point = { x: 100, y: 100 };
  const scene = { id: "cooking", focus: { x: -75, y: -75, width: 350, height: 350 }, sites: [],
    campfires: [{ id: "clearing-campfire", position: point, radius: 12 }] };
  const production = { ownerPublicId: "player", revision: 1, jobs: [{ id: "soup", stationId: "dryer", stationLevel: 1,
    startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 60000).toISOString() }] };
  const environment = { ownerId: "map", sceneId: "player:forest", ownerPublicId: "player", now, dusk: 0, rain: 0,
    levels: {}, fires: [{ id: "clearing-campfire", position: point, lit: false, flame: 0 }], production };
  const update = (index, extra = {}) => f.runtime.updateFrame(buildWorldAudioFrame(scene, { ...environment,
    rain: (index % 100) / 100, camera: { x: 100 + Math.sin(index / 20) * 120, y: 100, zoom: 2, viewportWidth: 700 }, ...extra }));
  try {
    await f.runtime.unlock();
    for (let index = 0; index < 120; index++) update(index);
    await flush();
    assert.equal(f.requests.length, 0, "world=0 prevents even a simmer asset request");
    f.runtime.setSettings({ buses: { world: .55 } }); await flush();
    assert.equal(f.context.started.length, 1);
    const source = f.context.started[0];
    assert.equal(source.loop, true);
    for (let index = 0; index < 600; index++) update(index);
    await flush();
    assert.equal(f.context.started.length, 1, "camera and rain only change parameters, never the playing source");
    assert.equal(f.requests.length, 1);
    assert.deepEqual(source.stops, []);
    update(0, { now: now + 60000 });
    assert.equal(source.connected[0].gain.value, 0, "ready food fades the simmer immediately");
    f.runtime.setSettings({ buses: { world: 0 } });
    update(1); await flush();
    assert.equal(f.context.started.length, 1, "later map updates cannot resurrect a muted pot");
  } finally { f.runtime.dispose(); }
});

test("water contact expires after a cold decode; the next real hit can use the warmed asset", async () => {
  const f = fixture([], { catalog: AUDIO_CATALOG });
  const gate = deferred(); f.context.decode = () => gate.promise;
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame());
    f.runtime.play({ id: "water-cold", cueId: "water.drop", maxAgeMs: 250 });
    await flush(); f.advance(251);
    gate.resolve({ length: 44100, numberOfChannels: 1, duration: 1 });
    await flush(); assert.equal(f.context.started.length, 0, "a late drop cannot play after the visible hit");
    f.advance(1300);
    f.runtime.play({ id: "water-warm", cueId: "water.drop", maxAgeMs: 250 });
    await flush(); assert.equal(f.context.started.length, 1, "the following new contact remains audible");
  } finally { f.runtime.dispose(); }
});

test("event max age only shortens the normal TTL and rejects stale contacts before loading", async () => {
  for (const { maxAgeMs, age, expected } of [
    { maxAgeMs: undefined, age: 500, expected: 1 },
    { maxAgeMs: 9000, age: 2001, expected: 0 },
    { maxAgeMs: NaN, age: 500, expected: 1 },
    { maxAgeMs: 250, age: 251, expected: 0 },
  ]) {
    const f = fixture([cue("contact")]);
    try {
      await f.runtime.unlock();
      f.runtime.play({ id: "contact-age", cueId: "contact", occurredAt: 100_000 - age, maxAgeMs });
      await flush(); assert.equal(f.context.started.length, expected, `age ${age}, max ${maxAgeMs}`);
      assert.equal(f.requests.length, expected, "stale contacts do not initiate a download");
    } finally { f.runtime.dispose(); }
  }
});

test("water contacts obey forest/water zero and cannot arrive after a menu return", async () => {
  for (const condition of ["zero", "menu", "zero-pending", "menu-pending"]) {
    const f = fixture([], { catalog: AUDIO_CATALOG });
    const gate = deferred(); f.context.decode = () => gate.promise;
    try {
      await f.runtime.unlock(); f.runtime.updateFrame(frame());
      if (condition === "zero") f.runtime.setSettings({ buses: { ambience: 0 } });
      if (condition === "menu") f.runtime.updateFrame(frame([], { soundscape: false }));
      f.runtime.play({ id: `water-${condition}`, cueId: "water.drop", maxAgeMs: 250 });
      await flush();
      if (condition === "zero-pending") f.runtime.setSettings({ buses: { ambience: 0 } });
      if (condition === "menu-pending") f.runtime.updateFrame(frame([], { soundscape: false }));
      gate.resolve({ length: 44100, numberOfChannels: 1, duration: 1 });
      await flush(); assert.equal(f.context.started.length, 0, condition);
      if (!condition.endsWith("pending")) assert.equal(f.requests.length, 0, condition);
    } finally { f.runtime.dispose(); }
  }
});

test("native audio interruption restores the current mix without another scene frame or gesture", async () => {
  const f = fixture([cue("wind", "loop", { bus: "weather", maxInstances: 1 }), cue("song", "music")]);
  await f.runtime.unlock();
  f.runtime.updateFrame(frame([target("wind", "wind"), target("song", "song")]));
  await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 2);
  f.context.state = "suspended"; f.context.onstatechange();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
  f.context.state = "running"; f.context.onstatechange();
  await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 2);
  assert.equal(f.context.started.length, 2, "wind is recreated once after native interruption");
  f.context.onstatechange(); await flush();
  assert.equal(f.context.started.length, 2, "duplicate running notification cannot add a second wind");
  f.runtime.setSettings({ enabled: false });
  f.context.state = "suspended"; f.context.onstatechange();
  f.context.state = "running"; f.context.onstatechange(); await flush();
  assert.equal(f.runtime.getDiagnostics().activeVoices, 0, "native resume cannot override mute");
  f.runtime.dispose();
});

test("a visible phone interruption retains authorization and retries after resume resolves before the device is ready", async t => {
  const f = fixture([cue("theme", "music"), cue("tap")]);
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "theme")])); await flush();
    f.media[0].currentTime = 36;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let ready = false;
    f.context.resume = async () => {
      f.context.resumes++;
      if (ready) { f.context.state = "running"; f.context.onstatechange(); }
    };
    f.context.state = "interrupted"; f.context.onstatechange();
    f.runtime.play({ id: "missed-during-call", cueId: "tap" });
    t.mock.timers.tick(250); await flush();
    assert.equal(f.context.resumes, 2);
    assert.equal(f.runtime.getDiagnostics().state, "suspended", "authorization is retained even when native resume is not ready");
    ready = true; f.context.state = "suspended"; f.context.onstatechange();
    t.mock.timers.tick(1000); await flush();
    assert.equal(f.context.resumes, 3);
    assert.equal(f.runtime.getDiagnostics().state, "running");
    assert.equal(f.media.length, 2); assert.equal(f.media[1].currentTime, 36);
    assert.equal(f.context.started.length, 0, "missed actions are consumed, not replayed after the call");
    t.mock.timers.tick(60_000); await flush();
    assert.equal(f.context.resumes, 3, "healthy playback cancels recovery work");
  } finally { f.runtime.dispose(); }
});

test("interruption recovery is bounded and a foreground notification reopens the retry window without changing settings", async t => {
  const f = fixture([cue("theme", "music")]);
  try {
    await f.runtime.unlock(); t.mock.timers.enable({ apis: ["setTimeout"] });
    f.context.resume = async () => { f.context.resumes++; throw Error("Call still owns the device"); };
    f.context.state = "interrupted"; f.context.onstatechange();
    for (const delay of [250, 1000, 2500, 5000, 60_000]) { t.mock.timers.tick(delay); await flush(); }
    assert.equal(f.context.resumes, 5, "one interruption cannot poll the device forever");
    f.context.resume = async () => { f.context.resumes++; f.context.state = "running"; f.context.onstatechange(); };
    const settings = f.runtime.getSettings();
    f.runtime.setVisible(true); t.mock.timers.tick(250); await flush();
    assert.equal(f.context.resumes, 6); assert.equal(f.runtime.getDiagnostics().state, "running");
    assert.equal(f.runtime.getSettings(), settings);
  } finally { f.runtime.dispose(); }
});

test("muting or hiding cancels pending interruption recovery and foreground cannot acquire initial permission", async t => {
  for (const action of ["locked", "mute", "master-zero", "hidden", "dispose"]) {
    const f = fixture();
    try {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      if (action !== "locked") {
        await f.runtime.unlock(); f.context.state = "interrupted"; f.context.onstatechange();
      }
      if (action === "mute") f.runtime.setSettings({ enabled: false });
      if (action === "master-zero") f.runtime.setSettings({ master: 0 });
      if (action === "hidden") f.runtime.setVisible(false);
      if (action === "dispose") f.runtime.dispose();
      if (action !== "hidden") f.runtime.setVisible(true);
      t.mock.timers.tick(60_000); await flush();
      assert.equal(f.context.resumes, action === "locked" ? 0 : 1, action);
    } finally { f.runtime.dispose(); t.mock.timers.reset(); }
  }
});

test("preparation warms every small UI variant without waiting for autoplay permission", async () => {
  const f = fixture([cue("tap", "one-shot", { bus: "ui", assets: ["tap-a", "tap-b", "tap-c"] })]);
  const permission = deferred(); f.context.resume = () => permission.promise;
  await f.runtime.prepare(["tap", "tap"]);
  assert.equal(f.contextCount, 1);
  assert.equal(f.context.state, "suspended");
  assert.equal(f.context.decoded, 3);
  assert.equal(f.context.started.length, 0);
  assert.equal(f.runtime.getDiagnostics().state, "locked");
  await f.runtime.prepare(["tap"]);
  assert.equal(f.requests.length, 3, "warm preparation neither fetches nor decodes again");
  f.context.state = "running"; permission.resolve(); await flush();
  assert.equal(f.context.started.length, 0, "preparation never queues a sound for later authorization");
  f.runtime.play({ id: "next-real-tap", cueId: "tap" }); await flush();
  assert.equal(f.context.started.length, 1);
  assert.equal(f.requests.length, 3);
  f.runtime.dispose();
});

test("aborting one preparation caller preserves an overlapping live decode", async () => {
  const f = fixture([cue("tap", "one-shot", { bus: "ui" })]);
  const decoded = deferred(); f.context.decode = () => decoded.promise;
  const controller = new AbortController();
  const first = f.runtime.prepare(["tap"], { signal: controller.signal });
  const second = f.runtime.prepare(["tap"]);
  await flush(); controller.abort(); await first;
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].config.signal.aborted, false);
  decoded.resolve({ length: 4800, numberOfChannels: 1, duration: .1 }); await second;
  f.runtime.play({ id: "ready-tap", cueId: "tap" }); await flush();
  assert.equal(f.context.started.length, 1);
  assert.equal(f.context.decoded, 1);
  f.runtime.dispose();
});

test("muted preparation downloads encoded files without acquiring an audio device", async () => {
  const f = fixture([cue("tap", "one-shot", { bus: "ui" }), cue("song", "music")],
    { initialSettings: { ...DEFAULT_AUDIO_SETTINGS, enabled: false } });
  await f.runtime.prepare(["tap", "song"]);
  assert.equal(f.contextCount, 0);
  assert.equal(f.context.decoded, 0);
  assert.equal(f.requests.length, 2);
  assert.ok(f.media.every(player => player.plays === 0));
  f.runtime.dispose();
});

test("prepared supported music is consumed as a Blob without decoding a long song", async () => {
  const chosen = cue("song", "music");
  const catalog = { version: 1, cues: [chosen], profiles: [], assets: [{ ...asset("song-a"),
    src: "/audio/song.opus", fallbackSrc: "/audio/song.m4a" }] };
  const media = [];
  const f = fixture([chosen], { catalog, createMediaElement: () => {
    const player = new Media(); player.canPlayType = type => type.includes("mp4") ? "probably" : "";
    media.push(player); return player;
  } });
  await f.runtime.prepare(["song"]);
  assert.deepEqual(f.requests.map(request => request.url), ["/audio/song.m4a"]);
  assert.equal(f.context.decoded, 0);
  assert.ok(media.every(player => player.plays === 0));
  f.runtime.updateFrame(frame([target("music", "song")])); await flush();
  const player = media.find(item => item.plays);
  assert.ok(player.src.startsWith("blob:"), "no initial network attempt for an unsupported codec");
  const cachedUrl = player.src;
  await f.runtime.prepare(["song"]); await flush();
  assert.equal(player.src, cachedUrl);
  assert.equal(player.plays, 1, "preparing a playing song cannot restart it");
  assert.equal(f.context.decoded, 0);
  f.runtime.dispose();
});

test("default context keeps authored 48 kHz buffers and requests balanced latency", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  let requested;
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, writable: true,
    value: class extends Context { constructor(options) { super(); requested = options; } } });
  const runtime = createAudioRuntime({ initialSettings: { ...DEFAULT_AUDIO_SETTINGS, enabled: true } });
  try {
    await runtime.unlock();
    assert.deepEqual(requested, { latencyHint: "balanced", sampleRate: 48000 });
  } finally {
    runtime.dispose();
    if (descriptor) Object.defineProperty(globalThis, "AudioContext", descriptor); else delete globalThis.AudioContext;
  }
});

test("a restricted CacheStorage getter cannot prevent the browser audio service from starting", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let runtime;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {
    navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    get caches() { throw new DOMException("Storage denied", "SecurityError"); },
  } });
  try {
    assert.doesNotThrow(() => { runtime = getAudioRuntime(); });
    assert.equal(runtime.getDiagnostics().state, "locked");
  } finally {
    runtime?.dispose();
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else delete globalThis.window;
  }
});

test("rejected preload responses cannot poison a later music or muted UI preparation", async () => {
  for (const mode of ["music", "one-shot"]) for (const failure of ["missing", "oversized"]) {
    let requests = 0;
    const f = fixture([cue("warm", mode, { bus: mode === "music" ? "music" : "ui" })], {
      initialSettings: { ...DEFAULT_AUDIO_SETTINGS, enabled: mode === "music" },
      fetchAsset: async () => {
        requests++;
        return requests === 1
          ? new Response(new Uint8Array([1]), failure === "missing" ? { status: 503 }
            : { headers: { "content-length": String(13 * 1024 * 1024) } })
          : new Response(new Uint8Array([1, 2, 3]));
      },
    });
    try {
      await f.runtime.prepare(["warm"]);
      await f.runtime.prepare(["warm"]);
      assert.equal(requests, 2, `${mode}/${failure}: the discarded body must release its shared request`);
      if (mode === "music") {
        f.runtime.updateFrame(frame([target("song", "warm")])); await flush();
        assert.ok(f.media.find(player => player.plays)?.src.startsWith("blob:"));
      } else assert.equal(f.contextCount, 0);
    } finally { f.runtime.dispose(); }
  }
});

test("a transient menu music failure recovers without another frame, gesture or navigation", async t => {
  let attempts = 0;
  const f = fixture([cue("theme", "music")], { createMediaElement: () => {
    const player = new Media();
    player.play = async () => { player.plays++; if (++attempts === 1) throw new Error("Temporary stream failure"); };
    return player;
  } });
  try {
    await f.runtime.unlock();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.runtime.updateFrame(frame([target("song", "theme")], { soundscape: false, ownerId: "menu" }));
    await flush();
    assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
    f.advance(1000); t.mock.timers.tick(1000); await flush();
    assert.equal(attempts, 2, "the still-current menu owns one bounded retry even without frame updates");
    assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
    assert.deepEqual(f.runtime.getDiagnostics().failedAssets, []);
  } finally { f.runtime.dispose(); }
});

test("an unexpected native music pause resumes the same menu deck and playhead once", async t => {
  const f = fixture([cue("theme", "music")]);
  try {
    await f.runtime.unlock();
    f.runtime.updateFrame(frame([target("song", "theme")], { soundscape: false, ownerId: "menu" })); await flush();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const player = f.media[0]; player.currentTime = 28; player.paused = true;
    player.play = async () => { player.plays++; player.paused = false; };
    for (let event = 0; event < 10; event++) player.onpause?.();
    t.mock.timers.tick(250); await flush();
    assert.equal(player.plays, 2, "native pause events coalesce into one recovery of the existing deck");
    assert.equal(player.currentTime, 28);
    assert.equal(f.media.length, 1);
    assert.equal(f.runtime.getDiagnostics().playback.musicStarts, 1);
  } finally { f.runtime.dispose(); }
});

test("a media error after playback preserves the menu playhead when retrying", async t => {
  const f = fixture([cue("theme", "music")]);
  try {
    await f.runtime.unlock();
    f.runtime.updateFrame(frame([target("song", "theme")], { soundscape: false })); await flush();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = f.media[0]; original.currentTime = 31; original.onerror();
    f.advance(1000); t.mock.timers.tick(1000); await flush();
    assert.equal(f.media.length, 2);
    assert.equal(f.media[1].currentTime, 31);
    assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
    assert.equal(original.onpause, null, "cleaning an old deck must remove its recovery handler before pause()");
  } finally { f.runtime.dispose(); }
});

test("stream recovery backs off despite frequent frames and never auto-retries denied autoplay", async t => {
  for (const blocked of [false, true]) {
    let attempts = 0;
    const f = fixture([cue("theme", "music")], { createMediaElement: () => {
      const player = new Media();
      player.play = async () => { attempts++; throw blocked ? new DOMException("Gesture required", "NotAllowedError") : new Error("Offline"); };
      return player;
    } });
    try {
      await f.runtime.unlock(); t.mock.timers.enable({ apis: ["setTimeout"] });
      const current = frame([target("song", "theme")], { soundscape: false }); f.runtime.updateFrame(current); await flush();
      for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
        const before = attempts;
        for (let tick = 0; tick < 300; tick++) f.runtime.updateFrame(current);
        assert.equal(attempts, before, "unchanged render frames never retry early");
        f.advance(delay); t.mock.timers.tick(delay); await flush();
        assert.equal(attempts, before + Number(!blocked));
      }
      assert.equal(attempts, blocked ? 1 : 7);
      assert.equal(f.runtime.getDiagnostics().activeVoices, 0);
    } finally { f.runtime.dispose(); t.mock.timers.reset(); }
  }
});

test("pending failed-stream and native-pause recovery cannot outlive its current menu", async t => {
  for (const recovery of ["failure", "pause"]) for (const action of ["mute", "music-zero", "hidden", "clear", "account", "dispose"]) {
    const f = fixture([cue("theme", "music")]);
    try {
      await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "theme")], { soundscape: false })); await flush();
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const original = f.media[0];
      if (recovery === "failure") original.onerror();
      else { original.paused = true; original.onpause(); }
      if (action === "mute") f.runtime.setSettings({ enabled: false });
      if (action === "music-zero") f.runtime.setSettings({ buses: { music: 0 } });
      if (action === "hidden") f.runtime.setVisible(false);
      if (action === "clear") f.runtime.clearFrame("user-a");
      if (action === "account") f.runtime.updateFrame(frame([], { sceneId: "another-account", soundscape: false }));
      if (action === "dispose") f.runtime.dispose();
      f.advance(60_000); t.mock.timers.tick(60_000); await flush();
      assert.equal(f.media.length, 1, `${recovery}/${action}: must not create a replacement stream`);
      assert.equal(original.plays, 1, `${recovery}/${action}: must not resume a released stream`);
    } finally { f.runtime.dispose(); t.mock.timers.reset(); }
  }
});

test("autoplay denial during native pause recovery waits for a gesture; old tracks do not block a new song", async t => {
  const f = fixture([cue("day", "music"), cue("night", "music")]);
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("day", "day")], { soundscape: false })); await flush();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const day = f.media[0]; day.currentTime = 14; day.paused = true;
    day.play = async () => { day.plays++; throw new DOMException("Gesture required", "NotAllowedError"); };
    day.onpause(); t.mock.timers.tick(250); await flush();
    assert.equal(f.runtime.getDiagnostics().state, "suspended");
    f.advance(60_000); t.mock.timers.tick(60_000); await flush();
    assert.equal(day.plays, 2, "denied native resume is never hammered by a timer");
    f.runtime.updateFrame(frame([target("night", "night")], { soundscape: false })); await flush();
    assert.equal(f.runtime.getDiagnostics().state, "running", "a blocked obsolete day theme must not suspend healthy night music");
    assert.equal(f.media.length, 2);
    assert.equal(f.media[1].plays, 1);
  } finally { f.runtime.dispose(); }
});

test("a native codec error can fall back while an earlier play promise is still pending", async () => {
  const music = cue("theme", "music"); const player = new Media(); const first = deferred();
  player.play = () => { player.plays++; return player.plays === 1 ? first.promise : Promise.resolve(); };
  const f = fixture([music], { createMediaElement: () => player, catalog: { version: 1, cues: [music], profiles: [],
    assets: [{ ...asset("theme-a"), src: "/audio/theme.opus", fallbackSrc: "/audio/theme.m4a" }] } });
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "theme")]));
    player.onerror(); await flush();
    assert.equal(player.plays, 2); assert.equal(player.src, "/audio/theme.m4a");
    first.reject(new DOMException("Old source replaced", "AbortError")); await flush();
    assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
    assert.deepEqual(f.runtime.getDiagnostics().failedAssets, []);
  } finally { f.runtime.dispose(); }
});

test("a retired pending music denial cannot block the next account or a newly reopened menu", async () => {
  for (const nextScene of ["account-a", "account-b"]) {
    const pending = deferred(); const players = [];
    const f = fixture([cue("theme", "music")], { createMediaElement: () => {
      const player = new Media(); const first = players.length === 0; players.push(player);
      player.play = () => { player.plays++; return first ? pending.promise : Promise.resolve(); };
      return player;
    } });
    try {
      await f.runtime.unlock();
      f.runtime.updateFrame(frame([target("song", "theme")], { sceneId: "account-a", soundscape: false }));
      f.runtime.updateFrame(frame([], { sceneId: nextScene, soundscape: false }));
      pending.reject(new DOMException("Retired player denied", "NotAllowedError")); await flush();
      f.runtime.updateFrame(frame([target("song", "theme")], { sceneId: nextScene, soundscape: false })); await flush();
      assert.equal(players.length, 2, "the retired promise cannot poison the shared autoplay state");
      assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
      assert.equal(f.runtime.getDiagnostics().state, "running");
      assert.deepEqual(f.runtime.getDiagnostics().failedAssets, []);
    } finally { f.runtime.dispose(); }
  }
});

test("a retired music success cannot erase the current account's retry or autoplay denial", async t => {
  for (const blocked of [false, true]) {
    const oldPlay = deferred(); const players = [];
    const f = fixture([cue("theme", "music")], { createMediaElement: () => {
      const player = new Media(); const index = players.length; players.push(player);
      player.play = () => {
        player.plays++;
        if (index === 0) return oldPlay.promise;
        if (index === 1) return Promise.reject(blocked ? new DOMException("Current player denied", "NotAllowedError") : new Error("Temporary current stream failure"));
        return Promise.resolve();
      };
      return player;
    } });
    try {
      await f.runtime.unlock(); t.mock.timers.enable({ apis: ["setTimeout"] });
      f.runtime.updateFrame(frame([target("song", "theme")], { sceneId: "account-a", soundscape: false }));
      f.runtime.updateFrame(frame([target("song", "theme")], { sceneId: "account-b", soundscape: false })); await flush();
      oldPlay.resolve(); await flush();
      assert.deepEqual(f.runtime.getDiagnostics().failedAssets, ["theme-a"], "stale success must not clear the current player's failure");
      if (blocked) {
        assert.equal(f.runtime.getDiagnostics().state, "suspended");
        f.advance(60_000); t.mock.timers.tick(60_000); await flush();
        assert.equal(players.length, 2, "a stale success must not unlock the newly denied account");
        await f.runtime.unlock(); await flush();
      } else { f.advance(1000); t.mock.timers.tick(1000); await flush(); }
      assert.equal(players.length, 3);
      assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
    } finally { f.runtime.dispose(); t.mock.timers.reset(); }
  }
});

test("retiring a music deck detaches native callbacks and rejects a queued stale codec failure", async () => {
  const music = cue("theme", "music"); const pending = deferred(); const players = [];
  const f = fixture([music], { createMediaElement: () => {
    const player = new Media(); const first = players.length === 0; players.push(player);
    player.play = () => { player.plays++; return first ? pending.promise : Promise.resolve(); };
    return player;
  }, catalog: { version: 1, cues: [music], profiles: [],
    assets: [{ ...asset("theme-a"), src: "/audio/theme.opus", fallbackSrc: "/audio/theme.m4a" }] } });
  try {
    await f.runtime.unlock(); f.runtime.updateFrame(frame([target("song", "theme")], { sceneId: "account-a" }));
    const original = players[0]; const oldError = original.onerror;
    f.runtime.updateFrame(frame([], { sceneId: "account-b" }));
    assert.equal(original.onerror, null); assert.equal(original.onpause, null); assert.equal(original.onloadedmetadata, null);
    oldError(); pending.reject(new DOMException("Old source replaced", "AbortError")); await flush();
    assert.equal(original.plays, 1, "a queued old callback cannot start its fallback codec");
    assert.deepEqual(f.runtime.getDiagnostics().failedAssets, []);
    f.runtime.updateFrame(frame([target("song", "theme")], { sceneId: "account-b" })); await flush();
    assert.equal(players.length, 2); assert.equal(f.runtime.getDiagnostics().activeVoices, 1);
  } finally { f.runtime.dispose(); }
});
