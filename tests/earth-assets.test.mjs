import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStandaloneEarthModule, EARTH_RUNTIME_ASSET_FILES, EARTH_RUNTIME_ASSET_VERSION, prepareEarthAssets } from "../scripts/prepare-earth-assets.mjs";

test("Earth preparation copies the exact pinned production runtime and a verifiable manifest for either bundler", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "zhiv-earth-assets-"));
  try {
    await writeFile(join(temporary, "package.json"), '{"private":true}');
    await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const version = manifest.dependencies["maplibre-gl"];
    assert.equal(version, EARTH_RUNTIME_ASSET_VERSION);
    const directory = await prepareEarthAssets(temporary);
    assert.equal(directory, join(temporary, "public/vendor", `maplibre-gl-${version}`));
    assert.deepEqual((await readdir(directory)).sort(), [...EARTH_RUNTIME_ASSET_FILES, "manifest.json"].sort());
    const installed = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.deepEqual({ schemaVersion: installed.schemaVersion, version: installed.version }, { schemaVersion: 1, version });
    assert.deepEqual(installed.files.map(file => file.name), EARTH_RUNTIME_ASSET_FILES);
    for (const file of installed.files) {
      const bytes = await readFile(join(directory, file.name));
      assert.deepEqual(bytes, await readFile(join(root, "node_modules/maplibre-gl", file.name === "LICENSE.txt" ? file.name : `dist/${file.name}`)));
      assert.equal(file.bytes, bytes.byteLength);
      assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
    assert.match(await readFile(join(directory, "LICENSE.txt"), "utf8"), /Redistribution/);
    assert.equal(await prepareEarthAssets(temporary), directory, "preparation can be repeated before dev or build");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Blob runtime preparation rejects static module dependencies while allowing dynamic plugin code and lookalikes", () => {
  for (const source of ['import "./relative.mjs";', 'import { value } from "./relative.mjs";', 'export { value } from "./relative.mjs";', 'export * from "./relative.mjs";', 'export const broken = ;']) {
    assert.throws(() => assertStandaloneEarthModule("maplibre-gl.mjs", source), /standalone production module/);
  }
  for (const source of ["", 'export const text = "import scripts from test";', '/* import "./relative.mjs" */ export {};', 'export async function plugin(url) { return import(url); }']) {
    assert.doesNotThrow(() => assertStandaloneEarthModule("maplibre-gl.mjs", source));
  }
});

test("an SDK upgrade cannot silently change the pinned Blob installation contract", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "zhiv-earth-upgrade-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(join(temporary, "package.json"), '{"private":true}');
  const directory = join(temporary, "node_modules/maplibre-gl");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "maplibre-gl", version: "7.0.0" }));
  await assert.rejects(prepareEarthAssets(temporary), /review the Earth runtime installer before upgrading/);
});
