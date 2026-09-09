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
const { MAP_PLACES, worldToHome, homeToWorld, containsPoint } = await vite.ssrLoadModule("/features/world/map-layout.ts");
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
  const paths = [WORLD_ART.map, WORLD_ART.home, WORLD_ART.houseDetails, WORLD_ART.workshop, ...Object.values(WORLD_ART.routes)];
  for (const path of paths) {
    const bytes = await readFile(`${root}/public${path}`);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF", path);
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP", path);
  }
});

test("building markers target their hit areas and the pet enters the visible doorway", () => {
  assert.ok(containsPoint(worldToHome(MAP_PLACES.house.marker), MAP_PLACES.house.homeBounds));
  assert.ok(containsPoint(MAP_PLACES.workshop.marker, MAP_PLACES.workshop.worldBounds));
  for (const point of [HOUSE_ANCHORS.inside, HOUSE_ANCHORS.doorstep]) {
    const roundTrip = worldToHome(homeToWorld(point));
    assert.ok(Math.abs(roundTrip.x - point.x) < 1e-12 && Math.abs(roundTrip.y - point.y) < 1e-12);
  }
  const inside = HOUSE_ANCHORS.inside;
  assert.ok(HOUSE_ANCHORS.doorway.some(rect =>
    inside.x * HOME_CANVAS_SIZE >= rect.x && inside.x * HOME_CANVAS_SIZE <= rect.x + rect.width &&
    inside.y * HOME_CANVAS_SIZE >= rect.y && inside.y * HOME_CANVAS_SIZE <= rect.y + rect.height));
});
