import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createEarthMapDiagnostics } = await vite.ssrLoadModule("/features/earth/map-diagnostics.ts");
const state = () => ({ phase: "ready", stage: "render", recovery: "idle", visible: true, retained: false,
  documentHidden: false, online: true, loaded: false, tilesLoaded: false, cartographyReady: true,
  cache: { storage: "device", persistence: "best-effort", storageIssue: null,
    pending: 0, completed: 12, failed: 0, cacheHits: 10, networkBytes: 2000,
    storedBytes: 3000, storedEntries: 7, memoryBytes: 200, memoryEntries: 2 } });

test("diagnostics distinguish real cartography readiness, dormant lifecycle and bounded repair history", () => {
  let now = 100_000;
  const diagnostics = createEarthMapDiagnostics(() => now);
  diagnostics.record("created");
  for (let index = 0; index < 60; index++) {
    now += 100; diagnostics.record(index % 2 ? "foreground" : "background");
  }
  diagnostics.record("recovery-retrying"); diagnostics.record("source-refresh"); diagnostics.record("recovery-idle");
  diagnostics.record("context-lost");
  for (const outcome of ["completed", "completed", "aborted", "timeout", "error"]) diagnostics.resource(outcome);
  const report = JSON.parse(diagnostics.report({ ...state(), visible: false, retained: true }));
  assert.equal(report.events.length, 40);
  assert.equal(report.counters.created, 1, "bounded events retain the full lifecycle totals");
  assert.equal(report.counters.background, 30); assert.equal(report.counters.foreground, 30);
  assert.equal(report.counters["recovery-retrying"], 1); assert.equal(report.counters["recovery-idle"], 1);
  assert.equal(report.counters["context-lost"], 1);
  assert.equal(report.elapsedMs, 6000); assert.equal(report.events.at(-1).elapsedMs, 6000);
  assert.equal(report.map.cartographyReady, true); assert.equal(report.map.loaded, false);
  assert.equal(report.map.retained, true); assert.equal(report.map.visible, false);
  assert.deepEqual(report.resources, { completed: 2, aborted: 1, timeout: 1, error: 1 });
  assert.match(report.appVersion, /^\d+\.\d+\.\d+$/); assert.equal(report.maplibreVersion, "6.15.0");
});

test("reports project only fixed safe fields, never coordinates, URLs, identity, arbitrary errors or storage quota", () => {
  const diagnostics = createEarthMapDiagnostics(() => 0), value = state();
  const privateText = "https://private.test/tile/55.7522/37.6156?owner=some-user";
  Object.assign(value, { latitude: 55.7522, longitude: 37.6156, user: "some-user", url: privateText,
    error: new Error(privateText), stack: privateText });
  Object.assign(value.cache, { quotaBytes: 987654321, usageBytes: 99999999, url: privateText });
  value.location = { status: "unavailable", hasPosition: true, secure: true, supported: true,
    latitude: 55.7522, longitude: 37.6156, error: privateText };
  diagnostics.record(privateText); diagnostics.resource(privateText);
  const report = diagnostics.report(value);
  assert.deepEqual(JSON.parse(report).location, { status: "unavailable", hasPosition: true, secure: true, supported: true });
  for (const forbidden of ["latitude", "longitude", "some-user", "private.test", "55.7522", "37.6156", "quotaBytes", "usageBytes", "987654321", "99999999", "stack"])
    assert.equal(report.includes(forbidden), false, forbidden);
  value.phase = privateText; value.cache.storage = privateText; value.cache.pending = Infinity;
  value.location.status = privateText;
  const invalid = JSON.parse(diagnostics.report(value));
  assert.equal(invalid.map.phase, null); assert.equal(invalid.cache.storage, null); assert.equal(invalid.cache.pending, 0);
  assert.equal(invalid.location.status, null);
});
