import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { WORLD_ART } = await vite.ssrLoadModule("/features/world/art.ts");
const { GAME_ACHIEVEMENTS } = await vite.ssrLoadModule("/features/game/game-rewards.ts");
const { AchievementMedal } = await vite.ssrLoadModule("/features/game/achievement-medal.tsx");
const { MAP_PLACES, worldToHome, homeToWorld, pointInPolygon, mapPlaceAt } = await vite.ssrLoadModule("/features/world/map-layout.ts");
const { HOUSE_ANCHORS, HOME_CANVAS_SIZE } = await vite.ssrLoadModule("/features/mochlik/home-layout.ts");

test("every achievement has one readable asset and a catalog description", async () => {
  const files = (await readdir(new URL("../public/achievements/", import.meta.url))).filter(name => /\.(svg|png)$/.test(name));
  assert.deepEqual(files.sort(), GAME_ACHIEVEMENTS.map(item => `${item.id}.${item.id === "full_collection" ? "png" : "svg"}`).sort());
  for (const item of GAME_ACHIEVEMENTS) {
    const medal = AchievementMedal({ id: item.id });
    assert.equal(medal.type, "img");
    assert.equal(medal.props.alt, "");
    if (item.id === "full_collection") {
      const bytes = await readFile(`${root}/public${medal.props.src}`);
      assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
      assert.ok(medal.props.style.clipPath.startsWith("circle("));
      continue;
    }
    const svg = await readFile(`${root}/public${medal.props.src}`, "utf8");
    assert.match(svg, /<svg\s/);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /viewBox=/);
    assert.ok(item.description && item.hint && item.target > 0);
  }
});

test("all registered maps and both journey cards exist", async () => {
  const paths = [WORLD_ART.map, WORLD_ART.home, WORLD_ART.homeDetail, ...Object.values(WORLD_ART.routes)];
  for (const path of paths) {
    const bytes = await readFile(`${root}/public${path.split("?")[0]}`);
    if (path.endsWith(".png")) assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a", path);
    else { assert.equal(bytes.toString("ascii", 0, 4), "RIFF", path); assert.equal(bytes.toString("ascii", 8, 12), "WEBP", path); }
  }
});

test("both terrain views share one full-resolution lossless export of the editable master", async () => {
  const assets = JSON.parse(await readFile(`${root}/features/world/runtime-art.json`, "utf8"));
  const source = await readFile(`${root}/art/world/prototype/forest-ground.png`);
  const bytes = await readFile(`${root}/public${assets.map.split("?")[0]}`);
  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  assert.equal(assets.map, `/world/prototype/forest-ground.webp?v=${version}`);
  for (const name of ["mapPreview", "homePreview", "homeDetail"]) assert.equal(assets[name], assets.map);
  const [master, exported] = await Promise.all([
    sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  assert.equal(master.info.width, 2560);
  assert.equal(master.info.height, 2560);
  assert.deepEqual(exported.info, master.info);
  assert.ok(exported.data.equals(master.data), "the WebP must preserve every PNG pixel");
  assert.deepEqual((await readdir(`${root}/public/world/prototype`)).filter(name => name.endsWith(".webp")), ["forest-ground.webp"]);
});

test("building markers target their hit areas and the pet enters the visible doorway", () => {
  for (const [id, place] of Object.entries(MAP_PLACES)) assert.equal(mapPlaceAt(place.marker), id);
  for (const point of [HOUSE_ANCHORS.inside, HOUSE_ANCHORS.doorstep]) {
    const roundTrip = worldToHome(homeToWorld(point));
    assert.ok(Math.abs(roundTrip.x - point.x) < 1e-12 && Math.abs(roundTrip.y - point.y) < 1e-12);
  }
  const inside = HOUSE_ANCHORS.inside;
  assert.ok(pointInPolygon({ x: inside.x * HOME_CANVAS_SIZE, y: inside.y * HOME_CANVAS_SIZE }, HOUSE_ANCHORS.doorway));
});
