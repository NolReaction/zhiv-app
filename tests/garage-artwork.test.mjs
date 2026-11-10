import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";

test("initial garage images match scene dimensions and the support keeps transparency", async () => {
  const root = new URL("../", import.meta.url);
  const scene = validateGarageScene(JSON.parse(await readFile(new URL("features/world/dev/boat-garage/garage-scene-default.json", root), "utf8")));
  for (const asset of scene.assets) {
    const file = new URL(`public${asset.src}`, root);
    const metadata = await sharp(await readFile(file)).metadata();
    assert.equal(metadata.width, asset.width, `${asset.id}: real raster width`);
    assert.equal(metadata.height, asset.height, `${asset.id}: real raster height`);
    if (asset.id === "stand" || asset.id === "side-stand") {
      assert.equal(metadata.hasAlpha, true);
      const stats = await sharp(await readFile(file)).stats();
      assert.equal(stats.channels[3].min, 0, "the stand must have fully transparent background pixels");
      assert.equal(stats.channels[3].max, 255, "the stand itself must remain opaque");
    }
  }
});
