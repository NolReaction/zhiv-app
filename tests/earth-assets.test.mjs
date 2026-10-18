import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareEarthAssets } from "../scripts/prepare-earth-assets.mjs";

test("Earth worker preparation copies the pinned installed worker and license for either bundler", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "zhiv-earth-assets-"));
  try {
    await writeFile(join(temporary, "package.json"), '{"private":true}');
    await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const version = manifest.dependencies["maplibre-gl"];
    const directory = await prepareEarthAssets(temporary);
    assert.equal(directory, join(temporary, "public/vendor", `maplibre-gl-${version}`));
    assert.deepEqual((await readdir(directory)).sort(), ["LICENSE.txt", "maplibre-gl-shared.mjs", "maplibre-gl-worker.mjs"]);
    for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
      assert.deepEqual(await readFile(join(directory, file)), await readFile(join(root, "node_modules/maplibre-gl/dist", file)));
    }
    assert.match(await readFile(join(directory, "LICENSE.txt"), "utf8"), /Redistribution/);
    assert.equal(await prepareEarthAssets(temporary), directory, "preparation can be repeated before dev or build");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
