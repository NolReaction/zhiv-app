import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { distanceGain, stereoPan, polygonDistance, zoneGain } = await vite.ssrLoadModule("/features/audio/domain/spatial.ts");
const { DEFAULT_AUDIO_SETTINGS, sanitizeAudioSettings, mergeAudioSettings } = await vite.ssrLoadModule("/features/audio/domain/settings.ts");
after(() => vite.close());

test("local sound is continuous, monotonic, full near source and silent beyond range", () => {
  let previous = 1;
  for (let distance = 0; distance <= 300; distance += .5) {
    const gain = distanceGain(distance, 60, 220);
    assert.ok(gain >= 0 && gain <= 1 && gain <= previous);
    if (distance <= 60) assert.equal(gain, 1);
    if (distance >= 220) assert.equal(gain, 0);
    previous = gain;
  }
  assert.ok(Math.abs(distanceGain(60.001, 60, 220) - 1) < .000001);
  assert.equal(distanceGain(NaN, 60, 220), 0);
  assert.equal(distanceGain(10, 60, 20), 0);
});

test("sound zones fade from the polygon boundary including concave regions", () => {
  const polygon = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 100 }, { x: 0, y: 100 }];
  assert.equal(zoneGain({ x: 10, y: 90 }, polygon, 10), 1);
  assert.equal(polygonDistance({ x: 60, y: 60 }, polygon), 40);
  assert.equal(zoneGain({ x: 60, y: 60 }, polygon, 10), 0);
  assert.equal(zoneGain({ x: 20, y: 90 }, polygon, 10), 1);
  assert.equal(zoneGain({ x: 25, y: 90 }, polygon, 10), .5);
  assert.equal(zoneGain({ x: 30, y: 90 }, polygon, 10), 0);
  assert.equal(zoneGain({ x: 5, y: 5 }, [], 20), 0);
});

test("stereo uses listener location and viewport, stays subtle and tolerates unavailable geometry", () => {
  const listener = { position: { x: 100, y: 0 }, viewportWidth: 200, zoom: 1, detail: 1 };
  assert.equal(stereoPan({ x: 100, y: 100 }, listener), 0);
  assert.equal(stereoPan({ x: 50, y: 0 }, listener), -.5);
  assert.equal(stereoPan({ x: 1000, y: 0 }, listener), .8);
  assert.equal(stereoPan({ x: 1000, y: 0 }, { ...listener, viewportWidth: 0 }), 0);
});

test("malformed or partial persisted settings never enable sound or produce invalid gains", () => {
  assert.deepEqual(sanitizeAudioSettings(null), DEFAULT_AUDIO_SETTINGS);
  const settings = sanitizeAudioSettings({ enabled: "yes", master: NaN, buses: { music: -1, world: 99, ui: "loud", characters: Infinity } });
  assert.equal(settings.enabled, false);
  assert.equal(settings.master, DEFAULT_AUDIO_SETTINGS.master);
  assert.equal(settings.buses.music, 0); assert.equal(settings.buses.world, 1);
  assert.equal(settings.buses.ui, DEFAULT_AUDIO_SETTINGS.buses.ui);
  const changed = mergeAudioSettings(settings, { buses: { music: .3 } });
  assert.equal(changed.buses.music, .3); assert.equal(changed.buses.world, 1);
  assert.equal(settings.buses.music, 0);
});
