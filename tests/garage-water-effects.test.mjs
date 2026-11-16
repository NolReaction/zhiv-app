import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";
import { garageWaterEffects, garageWaterSetup } from "../features/world/dev/boat-garage/garage-water-setup.mjs";
import { createGarageProjectFiles } from "../lib/dev/boat-garage-project-files.mjs";

const base = JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-example.json", import.meta.url), "utf8"));
const legacy = { rootId: "boat", waterlineY: 610, beam: 850, amplitude: 7 };
const scene = config => ({ ...structuredClone(base), waterPreview: config });

test("old scenes retain absent effect settings and default to a clean hull without changing the JSON", () => {
  assert.equal(garageWaterEffects().effectsEnabled, false, "garage mode has no water configuration");
  const original = JSON.stringify(base);
  assert.deepEqual(validateGarageScene(base), base);
  assert.equal(Object.hasOwn(validateGarageScene(base), "waterPreview"), false);
  const value = scene(legacy), before = JSON.stringify(value);
  const validated = validateGarageScene(value);
  assert.deepEqual(validated.waterPreview, legacy);
  assert.deepEqual(garageWaterEffects(garageWaterSetup(validated).config), {
    effectsEnabled: false, effectOpacity: .65, effectOffsetY: 0, immersionEnabled: false,
  });
  assert.equal(JSON.stringify(base), original);
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(validated, value);
  assert.equal(JSON.stringify(validated.waterPreview), JSON.stringify(legacy));
});

test("authored disabled flags and zero intensity round-trip instead of being replaced by defaults", () => {
  const config = { ...legacy, effectsEnabled: false, effectOpacity: 0, effectOffsetY: -2000, immersionEnabled: false };
  const validated = validateGarageScene(scene(config));
  assert.deepEqual(validated.waterPreview, config);
  assert.deepEqual(garageWaterEffects(validated.waterPreview), {
    effectsEnabled: false, effectOpacity: 0, effectOffsetY: -2000, immersionEnabled: false,
  });
  const enabled = { ...legacy, effectsEnabled: true, effectOpacity: 1, effectOffsetY: 2000, immersionEnabled: true };
  assert.deepEqual(validateGarageScene(scene(enabled)).waterPreview, enabled);
});

test("decorative position and visibility are independent of the actual waterline and buoyancy configuration", () => {
  const initial = garageWaterSetup(scene(legacy));
  const custom = garageWaterSetup(scene({ ...legacy, effectsEnabled: true, effectOpacity: .2, effectOffsetY: 500, immersionEnabled: true }));
  assert.deepEqual(custom.center, initial.center);
  assert.equal(custom.config.amplitude, initial.config.amplitude);
  assert.equal(custom.config.waterlineY, initial.config.waterlineY);
  assert.equal(custom.config.beam, initial.config.beam);
  assert.deepEqual([...custom.ids], [...initial.ids]);
  assert.equal(custom.hasArtwork, initial.hasArtwork);
});

test("imports reject unbounded, nonnumeric or malformed decorative water settings", () => {
  for (const key of ["effectsEnabled", "immersionEnabled"])
    for (const value of [null, 0, 1, "true", [], {}]) assert.throws(() => validateGarageScene(scene({ ...legacy, [key]: value })));
  for (const [key, values] of [
    ["effectOpacity", [-.001, 1.001, NaN, Infinity, -Infinity, null, "0.5", true, {}]],
    ["effectOffsetY", [-2000.1, 2000.1, NaN, Infinity, null, "12", true, []]],
  ]) for (const value of values) assert.throws(() => validateGarageScene(scene({ ...legacy, [key]: value })));
});

test("the local project API saves water effects and rejects invalid changes without replacing them", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "garage-water-effects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fallback = path.join(root, "features/world/dev/boat-garage");
  await mkdir(fallback, { recursive: true });
  await writeFile(path.join(fallback, "garage-scene-default.json"), JSON.stringify(base));
  const files = createGarageProjectFiles({ root }), initial = await files.read();
  const request = (value, revision) => new Request("http://localhost:3002/api/dev/boat-garage", {
    method: "POST", headers: { host: "localhost:3002", origin: "http://localhost:3002", "content-type": "application/json" },
    body: JSON.stringify({ scene: value, expectedRevision: revision }),
  });
  const authored = scene({ ...legacy, effectsEnabled: true, effectOpacity: .35, effectOffsetY: -25, immersionEnabled: false });
  const response = await files.handle(request(authored, initial.revision), "development");
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved.scene, authored);
  assert.deepEqual(await createGarageProjectFiles({ root }).read(), saved);
  const invalid = structuredClone(authored); invalid.waterPreview.effectOpacity = 4;
  assert.equal((await files.handle(request(invalid, saved.revision), "development")).status, 400);
  assert.deepEqual(await files.read(), saved);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "art/world/boat-garage/scene.json"), "utf8")), authored);
});
