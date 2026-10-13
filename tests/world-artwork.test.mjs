import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
async function modules() {
  const vite = await createServer({ appType: "custom", configFile: false, root,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    return { ...await vite.ssrLoadModule("/features/world/scene/world-artwork.ts"),
      ...await vite.ssrLoadModule("/features/world/tiled/preview-state.ts") };
  } finally { await vite.close(); }
}

test("authored initial circle waits only for its five visible artwork URLs while keeping the complete scene", async () => {
  const { worldArtworkUrls, initialPreviewLevels, previewSiteVisual, previewWorldScene } = await modules();
  const source = JSON.parse(await readFile(new URL("../features/world/tiled/forest.generated.json", import.meta.url), "utf8"));
  const before = structuredClone(source), levels = initialPreviewLevels(source);
  const scene = previewWorldScene(source, levels);
  const visuals = Object.fromEntries(source.sites.map(site => [site.id, previewSiteVisual(site, levels)]));
  const all = worldArtworkUrls(scene, visuals), required = worldArtworkUrls(scene, visuals, scene.focus);
  const home = scene.sites.find(site => site.id === "home");
  const terrainUrls = ["forest-ground", "clearing-bush-image", "terrain-311", "terrain-314"]
    .map(id => scene.terrain.find(terrain => terrain.id === id).image);
  assert.deepEqual(new Set(required), new Set([...terrainUrls, visuals[home.id].image]));
  assert.equal(all.length, 16); assert.equal(required.length, 5);
  const bytes = async urls => (await Promise.all(urls.map(async url =>
    (await stat(new URL(`../public${url.split("?")[0]}`, import.meta.url))).size))).reduce((sum, size) => sum + size, 0);
  assert.ok(await bytes(all) - await bytes(required) >= 3_900_000, "remote buildings and ground do not consume the initial budget");
  assert.deepEqual(source, before, "selection does not prune shared geometry or mutate the authored source");
});

test("focus artwork includes terrain grounding and rotated site bounds at the compositor padding boundary", async () => {
  const { worldArtworkUrls } = await modules();
  const focus = { x: 100, y: 100, width: 100, height: 100 };
  const terrain = [
    { id: "backdrop", image: "/backdrop.webp", bounds: { x: 0, y: 0, width: 600, height: 600 } },
    { id: "foliage-edge", image: "/leaves.webp", bounds: { x: 224, y: 120, width: 80, height: 80 } },
    { id: "outside", image: "/outside.webp", bounds: { x: 225, y: 120, width: 80, height: 80 } },
    { id: "duplicate", image: "/leaves.webp", bounds: { x: 130, y: 130, width: 20, height: 20 } },
  ];
  const sites = [
    { id: "rotated", bounds: { x: 216, y: 150, width: 40, height: 40 }, imagePlacement: { x: 240, y: 150, width: 40, height: 40, rotation: 45 } },
    { id: "remote", bounds: { x: 217, y: 150, width: 40, height: 40 } },
  ];
  const scene = { terrain, sites, focus }, visuals = { rotated: { image: "/rotated.webp" }, remote: { image: "/remote.webp" } };
  assert.deepEqual(worldArtworkUrls(scene, visuals, focus), ["/backdrop.webp", "/leaves.webp", "/rotated.webp"]);
  assert.deepEqual(worldArtworkUrls(scene, visuals), ["/backdrop.webp", "/leaves.webp", "/outside.webp", "/rotated.webp", "/remote.webp"]);
});
