import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { accountSceneLevels } = await vite.ssrLoadModule("/features/world/economy-scene-state.ts");
const { initialPreviewLevels, previewWorldScene, previewPointInPolygon } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { createWorldNavigation, isWalkable, canTraverse, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { builderLocalPlaces } = await vite.ssrLoadModule("/features/world/builder-navigation.ts");
const { forestPointOccluded, forestVisibleSiteAt } = await vite.ssrLoadModule("/features/world/forest-occlusion.ts");
const map = JSON.parse(await readFile(new URL("../world/tiled/forest.tmj", import.meta.url), "utf8"));
const catalog = JSON.parse(await readFile(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const home = TILED_WORLD.sites.find(site => site.id === "builder-home");
const rest = TILED_WORLD.destinations.find(destination => destination.id === "builder-rest");
function objects(layers, offset = { x: 0, y: 0 }) {
  return layers.flatMap(layer => {
    const position = { x: offset.x + (layer.offsetx ?? 0), y: offset.y + (layer.offsety ?? 0) };
    return [...(layer.objects ?? []).map(object => ({ ...object, x: object.x + position.x, y: object.y + position.y })),
      ...objects(layer.layers ?? [], position)];
  });
}
const authoredObjects = objects(map.layers);
const property = (object, name) => object.properties?.find(value => value.name === name)?.value;
const imagePoint = (u, v) => ({ x: home.bounds.x + home.bounds.width * u, y: home.bounds.y + home.bounds.height * v });

// Sample a true interior intersection, including narrow overlaps after an editor move.
function overlapSample(left, right) {
  const edges = points => points.map((point, index) => [point, points[(index + 1) % points.length]]);
  const aEdges = edges(left), bEdges = edges(right), levels = [...left, ...right].map(point => point.y);
  const cross = (ax, ay, bx, by) => ax * by - ay * bx;
  for (const [a, b] of aEdges) for (const [c, d] of bEdges) {
    const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
    const denominator = cross(dx, dy, ex, ey);
    if (Math.abs(denominator) < 1e-12) continue;
    const t = cross(c.x - a.x, c.y - a.y, ex, ey) / denominator;
    const u = cross(c.x - a.x, c.y - a.y, dx, dy) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) levels.push(a.y + t * dy);
  }
  levels.sort((a, b) => a - b);
  for (let index = 1; index < levels.length; index++) {
    if (levels[index] - levels[index - 1] < 1e-10) continue;
    const y = (levels[index] + levels[index - 1]) / 2;
    const crossings = segments => segments.filter(([a, b]) => (a.y > y) !== (b.y > y))
      .map(([a, b]) => a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)).sort((a, b) => a - b);
    const a = crossings(aEdges), b = crossings(bEdges);
    for (let i = 0; i < a.length; i += 2) for (let j = 0; j < b.length; j += 2) {
      const start = Math.max(a[i], b[j]), end = Math.min(a[i + 1], b[j + 1]);
      if (end - start > 1e-10) return { x: (start + end) / 2, y };
    }
  }
  return null;
}

test("builder home preserves the authored PNG and ground placement as a permanent single-level site", () => {
  assert.ok(home);
  assert.equal(home.initialLevel, 1);
  assert.deepEqual(home.states.map(state => state.level), [1]);
  assert.match(home.states[0].image, /^\/world\/prototype\/Shishkolap_House\.png\?v=/);
  assert.equal(catalog.buildings.some(building => building.id === home.id), false,
    "the resident's permanent house is not an economic building or upgrade queue");
  for (const [name, role, exported] of [["builder-home", "site", home],
    ["builder-home-ground", "terrain", TILED_WORLD.terrain.find(image => image.id === "builder-home-ground")]]) {
    const image = authoredObjects.find(object => object.name === name && property(object, "role") === role);
    assert.ok(image);
    assert.ok(exported);
    assert.deepEqual(exported.bounds, { x: image.x, y: image.y, width: image.width, height: image.height });
  }
  for (const role of ["anchor", "entry", "doorway"]) {
    const marker = authoredObjects.find(object => object.name === `builder-home-${role}`
      && property(object, "role") === role && property(object, "siteId") === home.id);
    assert.ok(marker);
    assert.deepEqual(home[role], { x: marker.x, y: marker.y });
  }
  const restMarker = authoredObjects.find(object => object.name === "builder-rest" && property(object, "role") === "destination");
  assert.ok(restMarker);
  assert.deepEqual(rest.position, { x: restMarker.x, y: restMarker.y });
  assert.equal(rest.siteId, home.id);
});

test("every account level preserves the resident house independently of economy building levels", () => {
  for (let houseLevel = 1; houseLevel <= 5; houseLevel++) {
    for (const buildings of [undefined, {}, { home: houseLevel, workshop: 0, quarry: 0, woodlot: 0 },
      { home: houseLevel, workshop: 2, quarry: 1, woodlot: 1 }, { "builder-home": 0 }, { "builder-home": 99 }]) {
      const levels = accountSceneLevels(TILED_WORLD, houseLevel, undefined, buildings);
      assert.equal(levels[home.id], 1);
      assert.deepEqual(previewWorldScene(TILED_WORLD, levels).sites.find(site => site.id === home.id), home);
    }
  }
});

test("builder house keeps the authored tree mask ahead of its left wall and its doorway visible", () => {
  const tree = TILED_WORLD.occluders.find(mask => mask.id === "shishkolap-tree");
  const authored = authoredObjects.find(object => object.name === tree.id);
  assert.deepEqual(tree.points, authored.polygon.map(point => ({ x: authored.x + point.x, y: authored.y + point.y })));
  assert.ok(tree.frontY > home.anchor.y);
  const overlap = overlapSample(tree.points, home.hitArea);
  assert.ok(overlap, "the authored tree overlaps the house hit area");
  assert.equal(forestPointOccluded({ ...TILED_WORLD, occluders: [tree] }, home.anchor.y, overlap), true);
  assert.equal(forestPointOccluded(TILED_WORLD, home.anchor.y, home.doorway), false);
});

test("the house silhouette hides residents behind the roof while preserving its open entrance and foreground", () => {
  const silhouette = TILED_WORLD.occluders.find(mask => mask.id === "builder-home-silhouette");
  assert.ok(silhouette);
  assert.deepEqual(silhouette.when, { siteId: home.id, level: 1 });
  assert.equal(silhouette.frontY, home.anchor.y);
  const scene = { ...TILED_WORLD, occluders: [silhouette] };
  const roof = imagePoint(.51, .35), wall = imagePoint(.53, .67), openDoor = imagePoint(.66, .63);
  const behindDepth = home.anchor.y - home.bounds.height * .4, sideDepth = home.anchor.y - home.bounds.height * .06;
  assert.equal(forestPointOccluded(scene, behindDepth, roof), true, "a resident behind the footprint cannot paint over roof leaves");
  assert.equal(forestPointOccluded(scene, sideDepth, wall), true, "the side wall keeps its depth when a resident passes beside it");
  assert.equal(forestPointOccluded(scene, sideDepth, openDoor), false, "the door opening is excluded from the silhouette");
  assert.equal(forestPointOccluded(scene, sideDepth, home.doorway), false, "the porch and threshold stay visible during entry");
  assert.equal(forestPointOccluded(scene, home.entry.y, roof), false, "a foreground resident paints in front of the house");
  assert.equal(forestPointOccluded(scene, behindDepth, imagePoint(.01, .01)), false,
    "transparent image padding is not an occluding wall");
  assert.equal(forestVisibleSiteAt(scene, roof)?.id, home.id, "the level-owned mask never hides its own house hit area");
});

test("builder and ordinary actors can reach the exterior without walking through the house", () => {
  const presets = [initialPreviewLevels(TILED_WORLD),
    Object.fromEntries(TILED_WORLD.sites.map(site => [site.id, Math.max(...site.states.map(state => state.level))]))];
  for (const levels of presets) {
    const scene = previewWorldScene(TILED_WORLD, levels), places = builderLocalPlaces(scene);
    assert.deepEqual(places.rest.position, rest.position, "the authored exterior rest is accepted without relocating it");
    assert.deepEqual(places.home?.entry, home.entry, "the resident accepts this exact local door transition");
    assert.deepEqual(places.home?.doorway, home.doorway);
    assert.equal(previewPointInPolygon(home.doorway, home.collision), true);
    for (const radius of [4, scene.actor.size * .1]) {
      const navigation = createWorldNavigation(scene, radius);
      assert.ok(isWalkable(navigation, home.entry), "the whole foot radius fits outside the wall");
      assert.equal(isWalkable(navigation, home.doorway), false, "ordinary navigation retains the house collision");
      assert.equal(canTraverse(navigation, home.entry, home.doorway), false);
      const corridor = createWorldNavigation({ ...scene, sites: scene.sites.filter(site => site.id !== home.id) }, radius);
      assert.ok(canTraverse(corridor, home.entry, home.doorway), "only the owner's collider is removed from the short door corridor");
      const starts = [{ id: "actor-spawn", position: scene.actor.spawn }, ...scene.destinations.filter(destination =>
        ["home", "workshop", "quarry", "woodlot", "fishing", "plesk-rest"].includes(destination.id)
        || radius === 4 && destination.id.startsWith("builder-work-"))];
      for (const start of starts) {
        const path = findWorldPath(navigation, start.position, rest.position);
        assert.ok(path, `${start.id} reaches the exterior with radius ${radius}`);
        assert.deepEqual(path.at(-1), rest.position, "the final feet use the exact authored outdoor marker");
        for (let index = 1; index < path.length; index++)
          assert.ok(canTraverse(navigation, path[index - 1], path[index]), "every route segment respects all ordinary obstacles");
      }
    }
  }
});
