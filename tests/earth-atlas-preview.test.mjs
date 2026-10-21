import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthAtlasEntry } = await vite.ssrLoadModule("/features/earth/earth-atlas.ts");
const { evaluateEarthAtlasPreview: evaluate, EARTH_ATLAS_LANDMARK_PREVIEW_MIN_ZOOM } = await vite.ssrLoadModule("/features/earth/earth-atlas-preview.ts");
const eiffel = earthAtlasEntry("landmark:eiffel-tower"), sahara = earthAtlasEntry("region:sahara");
const preview = (entry = eiffel, values = {}) => ({ entryId: entry.id, requestId: 7, view: { center: entry.center, zoom: entry.kind === "landmark" ? 16 : 3.5 },
  moving: false, mapReady: true, targetVisible: true, modelDrawn: true, ...values });

test("a geographic preview becomes ready only after explicit selection, settled cartography and a visible actual model draw", () => {
  const input = preview();
  assert.deepEqual(evaluate(input), { entryId: eiffel.id, requestId: 7, status: "ready" });
  assert.ok(Object.isFrozen(evaluate(input))); assert.deepEqual(evaluate(preview(eiffel, { moving: true })), { entryId: eiffel.id, requestId: 7, status: "moving" });
  assert.equal(evaluate(preview(eiffel, { mapReady: false })).status, "loading");
  assert.equal(evaluate(preview(eiffel, { modelDrawn: false })).status, "loading");
  assert.equal(evaluate(preview(eiffel, { view: null, mapReady: false })).status, "loading");
  assert.equal(evaluate(preview(eiffel, { targetVisible: false })).status, "away", "a landmark behind a mobile panel is not a meaningful preview");
  assert.equal(input.view.center, eiffel.center, "evaluation never adjusts the camera or mutates its input");
});

test("the old high-above overview and its former 139km allowance cannot grant landmark readiness", () => {
  assert.equal(EARTH_ATLAS_LANDMARK_PREVIEW_MIN_ZOOM, 15.6);
  for (const zoom of [2.2, 4.49, 4.6, 5.2, 14.99, 15.59]) {
    assert.equal(evaluate(preview(eiffel, { view: { center: eiffel.center, zoom } })).status, "away", `zoom ${zoom}`);
  }
  assert.equal(evaluate(preview(eiffel, { view: { center: eiffel.center, zoom: 15.6 } })).status, "ready");
  for (const center of [[eiffel.center[0] + 1, eiffel.center[1]], [eiffel.center[0], eiffel.center[1] + 1]]) {
    assert.equal(evaluate(preview(eiffel, { view: { center, zoom: 16 } })).status, "away");
  }
});

test("canonical IDs and the selected target are authoritative; forged catalogue data cannot replace them", () => {
  for (const entryId of ["unknown", "landmark:unknown", "meeting:friend", "", "region:unknown"]) {
    assert.equal(evaluate(preview(eiffel, { entryId })).status, "unavailable");
  }
  for (const requestId of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(evaluate(preview(eiffel, { requestId })).status, "unavailable");
  }
  const colosseum = earthAtlasEntry("landmark:colosseum");
  assert.equal(evaluate(preview(eiffel, { view: { center: colosseum.center, zoom: 16 },
    entry: { ...eiffel, center: colosseum.center }, targetVisible: true, modelDrawn: true })).status, "away");
  for (const view of [{ center: [NaN, 0], zoom: 16 }, { center: [0, 91], zoom: 16 }, { center: eiffel.center, zoom: NaN }]) {
    assert.equal(evaluate(preview(eiffel, { view })).status, "unavailable");
  }
});

test("selected regions use their actual clipped core at map scale without pretending to be GPS visits", () => {
  assert.equal(evaluate(preview(sahara, { modelDrawn: false })).status, "ready", "biome artwork does not depend on a 3D building");
  assert.equal(evaluate(preview(sahara, { view: { center: sahara.center, zoom: 2.19 } })).status, "away");
  assert.equal(evaluate(preview(sahara, { view: { center: sahara.center, zoom: 2.2 } })).status, "ready");
  assert.equal(evaluate(preview(sahara, { view: { center: [0, 0], zoom: 3.5 } })).status, "away");
  assert.equal(evaluate(preview(sahara, { targetVisible: false })).status, "away");
  assert.equal(evaluate(preview(sahara, { mapReady: false })).status, "loading");
});

test("a failed asset cannot be confused with a rendered view, while a valid drawn fallback remains meaningful", () => {
  assert.equal(evaluate(preview(eiffel, { modelFailed: true, modelDrawn: false })).status, "unavailable");
  assert.equal(evaluate(preview(eiffel, { modelFailed: true, modelDrawn: true })).status, "ready");
  assert.equal(evaluate(preview(eiffel, { modelFailed: true, modelDrawn: true, mapReady: false })).status, "loading");
  assert.equal(evaluate(preview(eiffel, { modelFailed: true, modelDrawn: true, moving: true })).status, "moving");
  assert.equal(evaluate(preview(eiffel, { requestId: 8 })).requestId, 8, "a new selection cannot reuse the previous request's readiness token");
});

test("a request-specific fitted minimum permits wide models without weakening ordinary landmark previews", () => {
  const giza = earthAtlasEntry("landmark:giza-pyramids");
  const fitted = preview(giza, { view: { center: giza.center, zoom: 13.8 }, minimumZoom: 13.55 });
  assert.equal(evaluate(fitted).status, "ready", "the actual wide detail model can be inspected at its fitted distance");
  assert.equal(evaluate({ ...fitted, minimumZoom: undefined }).status, "away", "ordinary landmark readiness retains the 15.6 minimum");
  assert.equal(evaluate({ ...fitted, modelDrawn: false }).status, "loading");
  assert.equal(evaluate({ ...fitted, targetVisible: false }).status, "away");
  assert.equal(evaluate({ ...fitted, view: { center: giza.center, zoom: 13.54 } }).status, "away", "zooming away from this request's fitted size invalidates readiness");
  for (const minimumZoom of [NaN, Infinity, -Infinity]) assert.equal(evaluate({ ...fitted, minimumZoom }).status, "away");
  assert.equal(evaluate({ ...fitted, minimumZoom: 0, view: { center: giza.center, zoom: 11.99 } }).status, "away", "even a malformed minimum cannot permit distant overview");
  assert.equal(evaluate(preview(eiffel, { view: { center: eiffel.center, zoom: 12 } })).status, "away", "Eiffel does not become a tiny point merely because wide models need a lower fitted zoom");
  assert.equal(evaluate(preview(sahara, { minimumZoom: 15.6, modelDrawn: false })).status, "ready", "model fitting does not alter biome discovery");
});
