import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { WORLD_ART } = await vite.ssrLoadModule("/features/world/art.ts");
const { GAME_ACHIEVEMENTS } = await vite.ssrLoadModule("/features/game/game-rewards.ts");
const { AchievementMedal } = await vite.ssrLoadModule("/features/game/achievement-medal.tsx");
const { MAP_PLACES, worldToHome, homeToWorld, pointInPolygon, mapPlaceAt } = await vite.ssrLoadModule("/features/world/map-layout.ts");
const { HOUSE_ANCHORS, HOME_CANVAS_SIZE } = await vite.ssrLoadModule("/features/mochlik/home-layout.ts");

test("every achievement has one readable SVG and a catalog description", async () => {
  const files = (await readdir(new URL("../public/achievements/", import.meta.url))).filter(name => name.endsWith(".svg"));
  assert.deepEqual(files.sort(), GAME_ACHIEVEMENTS.map(item => `${item.id}.svg`).sort());
  for (const item of GAME_ACHIEVEMENTS) {
    const medal = AchievementMedal({ id: item.id });
    assert.equal(medal.type, "img");
    assert.equal(medal.props.alt, "");
    const svg = await readFile(`${root}/public${medal.props.src}`, "utf8");
    assert.match(svg, /<svg\s/);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /viewBox=/);
    assert.ok(item.description && item.hint && item.target > 0);
  }
});

test("all registered maps, building atlases and both journey cards exist", async () => {
  const paths = [WORLD_ART.map, WORLD_ART.home, WORLD_ART.homeDetail, WORLD_ART.houseDetails, WORLD_ART.workshop, ...Object.values(WORLD_ART.routes)];
  for (const path of paths) {
    const bytes = await readFile(`${root}/public${path}`);
    if (path.endsWith(".png")) assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a", path);
    else { assert.equal(bytes.toString("ascii", 0, 4), "RIFF", path); assert.equal(bytes.toString("ascii", 8, 12), "WEBP", path); }
  }
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
