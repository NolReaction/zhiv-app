import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createAudioAssetTransport } = await vite.ssrLoadModule("/features/audio/runtime/audio-asset-transport.ts");
const { createAudioRuntime } = await vite.ssrLoadModule("/features/audio/runtime/audio-runtime.ts");
const { getAudioRuntime } = await vite.ssrLoadModule("/features/audio/runtime/audio-service.ts");
const { configureClientPlatform, getClientPlatform } = await vite.ssrLoadModule("/lib/client-platform.ts");
const { AUDIO_CATALOG } = await vite.ssrLoadModule("/features/audio/catalog/catalog.ts");
const base = "capacitor://localhost";
const path = "/audio/originals-v1/effect/ui.click.01.soft-v2.wav";
const wav = await readFile(new URL(`../public${path}`, import.meta.url));
const flush = () => new Promise(resolve => setImmediate(resolve));

// Capacitor's iOS media handler returns URLResponse, rather than HTTPURLResponse:
// WebKit exposes a readable basic response with status 0 and ok false.
// Keep real Response body/clone semantics; only replace its native metadata.
function nativeResponse({ url = `${base}${path}`, type = "basic", body = wav, headers = { "content-type": "audio/wav" } } = {}) {
  const annotate = response => {
    const clone = response.clone.bind(response);
    Object.defineProperties(response, {
      status: { value: 0 }, ok: { value: false }, url: { value: url }, type: { value: type },
      clone: { value: () => annotate(clone()) },
    });
    return response;
  };
  return annotate(new Response(body, { headers }));
}

test("bundled iOS WAV is readable by concurrent consumers despite its non-HTTP status", async () => {
  let requests = 0;
  const transport = createAudioAssetTransport({ bundledAudioBaseUrl: base, fetchAsset: async () => { requests++; return nativeResponse({ headers: {} }); } });
  try {
    const responses = await Promise.all([transport.fetch(path), transport.fetch(path)]);
    assert.equal(requests, 1);
    for (const response of responses) {
      assert.equal(response.ok, true);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
    }
  } finally { transport.dispose(); }
});

test("status zero never turns remote, mismatched, opaque, or non-audio requests into successes", async () => {
  const cases = [
    { label: "web browser", baseUrl: undefined },
    { label: "HTTPS base", baseUrl: "https://localhost" },
    { label: "remote request", request: `https://remote.invalid${path}`, response: { url: `https://remote.invalid${path}` } },
    { label: "remote response", response: { url: `https://remote.invalid${path}` } },
    { label: "different native host", response: { url: `capacitor://other${path}` } },
    { label: "different custom scheme", response: { url: `file://localhost${path}` } },
    { label: "different asset", response: { url: `${base}/audio/other.wav` } },
    { label: "different version", response: { url: `${base}${path}?v=other` } },
    { label: "opaque response", response: { type: "opaque" } },
    { label: "opaque redirect", response: { type: "opaqueredirect" } },
    { label: "error response", response: { type: "error" } },
    { label: "HTML response", response: { headers: { "content-type": "text/html" } } },
    { label: "missing body", response: { body: null } },
    { label: "outside audio", request: "/api/asset.wav", response: { url: `${base}/api/asset.wav` } },
    { label: "traversal outside audio", request: "/audio/../api/asset.wav", response: { url: `${base}/api/asset.wav` } },
    { label: "POST", init: { method: "POST" } },
  ];
  for (const scenario of cases) {
    const transport = createAudioAssetTransport({
      bundledAudioBaseUrl: Object.hasOwn(scenario, "baseUrl") ? scenario.baseUrl : base,
      fetchAsset: async () => nativeResponse(scenario.response),
    });
    try {
      // Rejection or the original unsuccessful response are both valid. The
      // regression would be exposing untrusted status-zero data as successful.
      let result;
      try { result = await transport.fetch(scenario.request ?? path, scenario.init); } catch { continue; }
      assert.equal(result.ok, false, scenario.label);
      await result.body?.cancel();
    } finally { transport.dispose(); }
  }
});

test("iOS normalization preserves HTTP failures and fetch cancellation", async () => {
  const transport = createAudioAssetTransport({ bundledAudioBaseUrl: base,
    fetchAsset: async () => new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }),
  });
  try {
    const response = await transport.fetch(path);
    assert.equal(response.status, 404); assert.equal(response.ok, false);
    assert.equal(await response.text(), "missing");
  } finally { transport.dispose(); }

  let finish; let signal;
  const waiting = createAudioAssetTransport({ bundledAudioBaseUrl: base, fetchAsset: (_url, init) => {
    signal = init.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  try {
    const abort = new AbortController();
    const pending = waiting.fetch(path, { signal: abort.signal });
    await flush(); abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(signal.aborted, true);
    finish(nativeResponse()); await flush();
  } finally { waiting.dispose(); }
});

class Param {
  value = 0;
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
}
class Node {
  connections = [];
  connect(node) { this.connections.push(node); return node; }
  disconnect() {}
}
class Gain extends Node { gain = new Param(); }

function contextFixture() {
  const started = []; const decoded = [];
  const context = {
    currentTime: 0, state: "suspended", destination: new Node(),
    createGain: () => new Gain(),
    createBufferSource() {
      const source = new Node(); source.playbackRate = new Param();
      source.start = () => started.push(source); source.stop = () => {};
      return source;
    },
    async resume() { this.state = "running"; this.onstatechange?.(); },
    async close() { this.state = "closed"; },
    async decodeAudioData(data) {
      const bytes = Buffer.from(data);
      assert.deepEqual(bytes, wav, "the decoder must receive the whole bundled file");
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
      const buffer = { length: 4800, numberOfChannels: 1, duration: .1 };
      decoded.push(buffer); return buffer;
    },
  };
  return { context, started, decoded };
}

test("real HUD WAV reaches the decoder and starts an audible UI voice in native mode", async () => {
  const { context, started, decoded } = contextFixture();
  const original = AUDIO_CATALOG.cues.find(cue => cue.id === "ui.click");
  const asset = AUDIO_CATALOG.assets.find(asset => asset.src === path);
  assert.ok(original); assert.ok(asset);
  const runtime = createAudioRuntime({ bundledAudioBaseUrl: base,
    catalog: { version: 1, cues: [{ ...original, assets: [asset.id] }], assets: [asset], profiles: [] },
    createContext: () => context, fetchAsset: async () => nativeResponse(), random: () => .5,
  });
  try {
    assert.equal(await runtime.unlock(), true);
    await runtime.prepare(["ui.click"]);
    assert.equal(decoded.length, 1, "native status-zero audio must pass the transport and decode checks");
    runtime.play({ id: "menu-tap", cueId: "ui.click" });
    await flush();
    assert.equal(started.length, 1);
    assert.equal(started[0].buffer, decoded[0]);
    let output = started[0];
    while (output !== context.destination) {
      if (output.gain) assert.ok(output.gain.value > 0, "the UI signal must not hit a muted gain");
      output = output.connections[0]; assert.ok(output, "the UI voice must reach the audio output");
    }
    assert.equal(runtime.getDiagnostics().activeVoices, 1);
    assert.deepEqual(runtime.getDiagnostics().failedAssets, []);
  } finally { runtime.dispose(); }
});

test("the application audio service enables bundled media handling only for native iOS", async () => {
  const previousPlatform = getClientPlatform();
  const descriptors = new Map(["window", "fetch", "AudioContext"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [kind, location, expected] of [["ios", `${base}/index.html`, true], [null, `${base}/index.html`, false], ["android", `${base}/index.html`, false], ["ios", "https://localhost/index.html", false]]) {
      const { context, decoded } = contextFixture();
      configureClientPlatform(kind ? { kind, appVersion: "test" } : null);
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        navigator: {}, location: new URL(location), localStorage: { getItem: () => null, setItem() {} },
      } });
      Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: function () { return context; } });
      Object.defineProperty(globalThis, "fetch", { configurable: true,
        value: async url => nativeResponse({ url: new URL(url, location).href }),
      });
      const runtime = getAudioRuntime();
      try {
        assert.equal(await runtime.unlock(), true);
        await runtime.prepare(["ui.click"]);
        assert.equal(decoded.length > 0, expected, `${kind ?? "web"} at ${location}`);
      } finally { runtime.dispose(); }
    }
  } finally {
    configureClientPlatform(previousPlatform);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
