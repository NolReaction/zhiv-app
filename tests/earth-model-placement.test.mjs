import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { EARTH_MODEL_PLACEMENT_IDS, parseEarthModelPlacementDocument } from "../lib/earth-model-placement-contract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaults = JSON.parse(await readFile(`${root}/features/earth/data/model-placements.json`, "utf8"));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const state = await vite.ssrLoadModule("/features/earth/model-placement.ts");

test("published placements validate and malformed imports cannot partially alter a live scene", () => {
  assert.deepEqual(parseEarthModelPlacementDocument(defaults), defaults);
  assert.equal(defaults.placements.length, 9);
  assert.deepEqual(defaults.placements.map(row => row.id).sort(), [...EARTH_MODEL_PLACEMENT_IDS].sort());
  const snapshot = state.getEarthModelPlacements();
  for (const patch of [{ latitude: 86 }, { longitude: 181 }, { heightMeters: 0 }, { heightMeters: 1001 },
    { headingDegrees: Infinity }, { elevationMeters: -101 }, { exclusionRadiusMeters: 301 },
    { heightMeters: "330" }, { excludeBuildings: "yes" }, { unknown: 1 }]) {
    assert.throws(() => state.updateEarthModelPlacement("eiffel-tower", patch));
    assert.equal(state.getEarthModelPlacements(), snapshot);
  }
  for (const document of [{ ...defaults, version: 2 }, { ...defaults, path: "/tmp/other" },
    { version: 1, placements: [] }, { version: 1, placements: [...defaults.placements, ...defaults.placements] },
    { version: 1, placements: [{ ...defaults.placements[0], id: "unregistered-model" }] },
    { version: 1, placements: [defaults.placements[1]] },
    { version: 1, placements: defaults.placements.slice(0, 2) },
    { version: 1, placements: [{ ...defaults.placements[0], path: "/tmp/other" }] }])
    assert.throws(() => state.importEarthModelPlacements(document));
  assert.throws(() => state.updateEarthModelPlacement("missing", { heightMeters: 20 }));
  assert.equal(state.getEarthModelPlacements(), snapshot);
});

test("historical Eiffel drafts and exports merge new defaults without discarding other edited models", () => {
  state.resetEarthModelPlacements();
  try {
    const old = { version: 1, placements: [{ ...defaults.placements[0], heightMeters: 280, headingDegrees: 73 }] };
    assert.throws(() => parseEarthModelPlacementDocument(old), "the project writer must require the complete document");
    state.hydrateEarthModelPlacementDraft({ getItem: () => JSON.stringify(old) });
    let rows = state.getEarthModelPlacements();
    assert.equal(rows.length, 9);
    assert.equal(rows[0].heightMeters, 280);
    assert.equal(rows[0].headingDegrees, 73);
    assert.deepEqual(rows.slice(1), defaults.placements.slice(1), "previously absent IDs start at their published defaults");
    state.updateEarthModelPlacement("colosseum", { heightMeters: 51, headingDegrees: 120 });
    state.importEarthModelPlacements({ version: 1, placements: [{ ...old.placements[0], heightMeters: 285 }] });
    rows = state.getEarthModelPlacements();
    assert.equal(rows[0].heightMeters, 285);
    assert.equal(rows.find(row => row.id === "colosseum").heightMeters, 51);
    assert.equal(rows.find(row => row.id === "colosseum").headingDegrees, 120);
    assert.equal(JSON.parse(state.exportEarthModelPlacements()).placements.length, 9);
    for (const patch of [{ latitude: 90 }, { heightMeters: undefined }, { unknown: true }]) {
      const before = state.getEarthModelPlacements();
      assert.throws(() => state.importEarthModelPlacements({ version: 1, placements: [{ ...old.placements[0], ...patch }] }));
      assert.equal(state.getEarthModelPlacements(), before);
    }
  } finally { state.resetEarthModelPlacements(); }
});

test("live placement editing publishes stable immutable snapshots and unsubscribe releases scene listeners", () => {
  state.resetEarthModelPlacements();
  let notifications = 0;
  const release = state.subscribeEarthModelPlacements(() => notifications++);
  try {
    const initial = state.getEarthModelPlacements();
    state.updateEarthModelPlacement("eiffel-tower", { headingDegrees: 90, heightMeters: 250, longitude: 2.295 });
    const changed = state.getEarthModelPlacements();
    assert.notEqual(initial, changed);
    assert.equal(changed[0].headingDegrees, 90);
    assert.equal(state.getEarthModelPlacementDefaults()[0].headingDegrees, defaults.placements[0].headingDegrees);
    assert.throws(() => { changed[0].latitude = 0; });
    assert.throws(() => { changed.push(changed[0]); });
    state.updateEarthModelPlacement("eiffel-tower", { headingDegrees: 90 });
    assert.equal(state.getEarthModelPlacements(), changed);
    assert.equal(notifications, 1);
    release();
    state.resetEarthModelPlacements();
    assert.equal(notifications, 1);
  } finally { release(); state.resetEarthModelPlacements(); }
});

test("explicit development draft hydration/export roundtrips without storing camera, GPS or account data", () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  try {
    state.updateEarthModelPlacement("eiffel-tower", { headingDegrees: -45, exclusionRadiusMeters: 75, excludeBuildings: false });
    state.persistEarthModelPlacementDraft(storage);
    assert.equal(entries.size, 1);
    const exported = state.exportEarthModelPlacements();
    assert.deepEqual(Object.keys(JSON.parse(exported)).sort(), ["placements", "version"]);
    state.resetEarthModelPlacements();
    state.hydrateEarthModelPlacementDraft(storage);
    assert.equal(state.getEarthModelPlacements()[0].headingDegrees, -45);
    state.resetEarthModelPlacements();
    state.importEarthModelPlacements(exported);
    assert.equal(state.getEarthModelPlacements()[0].exclusionRadiusMeters, 75);
    const before = state.getEarthModelPlacements();
    storage.setItem(state.EARTH_MODEL_PLACEMENT_DRAFT_KEY, "{broken");
    assert.throws(() => state.hydrateEarthModelPlacementDraft(storage));
    assert.equal(state.getEarthModelPlacements(), before);
  } finally { state.resetEarthModelPlacements(); }
});

test("standalone map workshop is reachable in development and framework-404 in production", async () => {
  const { default: Page } = await vite.ssrLoadModule("/app/prototype/earth-models/page.tsx");
  const mode = process.env.NODE_ENV;
  try {
    for (const value of ["production", "test", undefined]) {
      if (value === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = value;
      assert.throws(() => Page(), error => error.digest === "NEXT_HTTP_ERROR_FALLBACK;404");
    }
    process.env.NODE_ENV = "development";
    assert.ok(Page().type);
  } finally { if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode; }
});
