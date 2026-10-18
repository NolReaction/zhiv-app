import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { browser, finishVillagerArtwork, modules, options, quietClearing, sceneClock } from "./helpers/new-map-scene.mjs";

const authored = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
const live = await modules(structuredClone(authored));
const quiet = { ...quietClearing, autoLife: true, lightShadows: false, puddles: false, waterFish: false };
function initial(key) {
  const buildings = { home: 3, quarry: 1, woodlot: 3 };
  const production = { ownerPublicId: key, revision: 1, jobs: [] };
  return { ...options, view: "world", reducedMotion: false, serverNow: 100_000, presenceKey: key,
    economyBuildings: buildings, economyResidents: { ...production, buildings, production }, economyProduction: production,
    lopukhArrival: { seen: true, enabled: false }, residentArrival: { seen: true, enabled: false }, merchantArrival: { seen: true, enabled: false } };
}
function probeFor(settings) {
  const world = live.previewWorldScene(live.TILED_WORLD,
    live.accountSceneLevels(live.TILED_WORLD, undefined, live.worldDevStore.getSnapshot(), settings.economyBuildings));
  return live.connectForestSession(settings.presenceKey, world, "circle", 100_000, 0, () => {});
}
const callbacks = { activity() {}, ready() {}, failure: assert.fail };

test("the real scene skips closed diagnostics, records its owner, freezes on pause and ignores passive disposal", async () => {
  const env = browser(), settings = initial("private-observability-owner");
  const store = live.residentDiagnosticsStore, originalReport = store.report;
  let world, circle, probe, unsubscribe, reports = 0;
  store.report = (...args) => { reports++; return originalReport(...args); };
  try {
    live.worldDevStore.patch(quiet);
    world = live.mountHabitat(env.surface(), settings, callbacks); await finishVillagerArtwork(env);
    probe = probeFor(settings);
    const clock = sceneClock(env); clock.advance(.8);
    assert.equal(reports, 0, "the closed inspector is gated before constructing its sampled arguments");
    assert.equal(store.getSnapshot(), null);
    unsubscribe = store.subscribe(() => {}); store.setRecording(true); clock.advance(1.2);
    const report = store.exportReport();
    assert.ok(reports > 0); assert.ok(report);
    const payload = JSON.parse(report.json);
    assert.equal(payload.schemaVersion, 1); assert.equal(payload.scene.source, "world");
    assert.equal(payload.residents.length, 6); assert.ok(payload.events.length >= 6);
    assert.ok(!report.json.includes(settings.presenceKey), "the runtime presence key is not an exported identity");
    assert.equal(payload.context.settings.weather, "clear");
    world.configure({ ...settings, paused: true }); clock.advance(2);
    assert.equal(store.exportReport().json, report.json, "paused frames cannot create journal time or new events");
    world.configure(settings); clock.advance(.8);
    circle = live.mountHabitat(env.surface(), { ...settings, view: "circle" }, callbacks); await finishVillagerArtwork(env);
    clock.advance(.8);
    const before = store.getSnapshot(); assert.ok(before);
    circle.dispose(); circle = null;
    assert.equal(store.getSnapshot(), before, "a passive canvas sharing the source cannot erase the active owner's capture");
    unsubscribe(); unsubscribe = null;
    const count = reports; clock.advance(1);
    assert.equal(store.getSnapshot(), null); assert.equal(store.exportReport(), null);
    assert.equal(reports, count, "closing the last inspector removes the whole sampling path");
  } finally {
    unsubscribe?.(); circle?.dispose(); world?.dispose(); probe?.release();
    store.report = originalReport; live.forgetForestSession(settings.presenceKey); live.worldDevStore.reset(); env.restore();
  }
});

test("opt-in timings cover the actual CPU stages without creating RAFs or changing actor state during paint", async () => {
  const env = browser(), settings = initial("timing-owner");
  const profiler = live.forestPerformanceProfiler;
  let world, probe;
  try {
    live.worldDevStore.patch(quiet); profiler.setEnabled(false); profiler.reset();
    world = live.mountHabitat(env.surface(), settings, callbacks); await finishVillagerArtwork(env);
    probe = probeFor(settings); const clock = sceneClock(env); clock.advance(.8);
    assert.deepEqual(profiler.getSnapshot().summaries, []);
    const frames = env.frames.size; profiler.setEnabled(true);
    assert.equal(profiler.isEnabled(), true); assert.equal(env.frames.size, frames, "profiling has no scheduling owner");
    clock.advance(1.5);
    const state = probe.state, before = JSON.stringify({ hero: state.clearing.position, plesk: state.pleskMind.position,
      builder: state.builderMind.position, elapsed: state.elapsed });
    world.paintWorld(env.surface().context); world.paintWorld(env.surface().context);
    assert.equal(JSON.stringify({ hero: state.clearing.position, plesk: state.pleskMind.position,
      builder: state.builderMind.position, elapsed: state.elapsed }), before);
    live.findWorldPath(state.clearing.navigation, state.clearing.position, state.clearing.home);
    profiler.flush();
    const snapshot = profiler.getSnapshot();
    for (const stage of ["ai", "navigation", "water", "render", "occupancy"]) {
      const row = snapshot.summaries.find(row => row.stage === stage && row.source === "world");
      assert.ok(row?.count > 0, `missing actual ${stage} stage`);
      assert.ok(Number.isFinite(row.p95Ms) && row.p95Ms >= 0 && row.maxMs >= row.p95Ms);
      assert.ok(row.count <= 240, "each duration sample ring is bounded");
    }
    profiler.setEnabled(false); const stopped = profiler.getSnapshot(); clock.advance(.8);
    assert.equal(profiler.getSnapshot(), stopped, "disabled instrumentation collects no durations");
  } finally {
    profiler.setEnabled(false); profiler.reset(); world?.dispose(); probe?.release();
    live.forgetForestSession(settings.presenceKey); live.worldDevStore.reset(); env.restore();
  }
});

test("cold rehearsal planning belongs to its own timing source before its first simulation tick", async () => {
  const env = browser(), profiler = live.forestPerformanceProfiler;
  const settings = live.rehearsalSceneOptions(initial("original-owner"), { id: 9100, scenario: "walk", actor: "lopukh", seed: 17 });
  let world;
  try {
    live.worldDevStore.patch(quiet); profiler.reset(); profiler.setEnabled(true);
    world = live.mountHabitat(env.surface(), settings, callbacks); await finishVillagerArtwork(env);
    profiler.flush();
    const rows = profiler.getSnapshot().summaries;
    assert.ok(rows.some(row => row.stage === "navigation" && row.count > 0));
    assert.ok(rows.length > 0 && rows.every(row => row.source === "rehearsal"), JSON.stringify(rows));
  } finally {
    profiler.setEnabled(false); profiler.reset(); world?.dispose();
    live.forgetForestSession(settings.presenceKey); live.worldDevStore.reset(); env.restore();
  }
});
