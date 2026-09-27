import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";
import sharp from "sharp";
import { encodeTerrainMaster, findTerrainMaster } from "../scripts/lib/world-assets.mjs";

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
  const source = await readFile(await findTerrainMaster(`${root}/art/world/prototype`));
  const bytes = await readFile(`${root}/public${assets.map.split("?")[0]}`);
  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  assert.equal(assets.map, `/world/prototype/forest-ground.webp?v=${version}`);
  for (const name of ["mapPreview", "homePreview", "homeDetail"]) assert.equal(assets[name], assets.map);
  const [master, exported] = await Promise.all([
    sharp(source).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  assert.equal(master.info.width, 2560);
  assert.equal(master.info.height, 2560);
  assert.deepEqual(exported.info, master.info);
  assert.ok(exported.data.equals(master.data), "the WebP must preserve every decoded, oriented master pixel");
  assert.deepEqual((await readdir(`${root}/public/world/prototype`)).filter(name => /^forest-ground.*\.webp$/.test(name)), ["forest-ground.webp"]);
});

test("terrain master selection accepts PNG and JPEG and rejects stale competing sources", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zhiv-terrain-master-"));
  try {
    await writeFile(path.join(directory, "bushv1.png"), "unrelated artwork");
    await assert.rejects(findTerrainMaster(directory), /Terrain master missing/);
    for (const extension of ["png", "jpg", "jpeg", "JPG"]) {
      const name = `forest-ground.${extension}`;
      await writeFile(path.join(directory, name), "source");
      assert.equal(await findTerrainMaster(directory), path.join(directory, name));
      await rm(path.join(directory, name));
    }
    await writeFile(path.join(directory, "forest-ground.png"), "old source");
    await writeFile(path.join(directory, "forest-ground.jpg"), "new source");
    await assert.rejects(findTerrainMaster(directory), /Ambiguous terrain masters: forest-ground.jpg, forest-ground.png/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("lossless terrain conversion preserves decoded JPEG pixels with EXIF orientation and PNG alpha", async () => {
  const pixels = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    255, 255, 0, 128, 0, 255, 255, 64, 255, 0, 255, 255,
  ]);
  const input = () => sharp(pixels, { raw: { width: 3, height: 2, channels: 4 } });
  const sources = [await input().png().toBuffer(), await input().jpeg().withMetadata({ orientation: 6 }).toBuffer()];
  for (const source of sources) {
    const bytes = await encodeTerrainMaster(source);
    const expected = await sharp(source).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const actual = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual(actual, expected);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.orientation, undefined, "orientation is baked into exported pixels");
  }
  const oriented = await sharp(await encodeTerrainMaster(sources[1])).metadata();
  assert.equal(oriented.width, 2); assert.equal(oriented.height, 3);
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
