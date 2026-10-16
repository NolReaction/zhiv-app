import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { compileTiledWorld } from "../scripts/lib/tiled-world.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const mapPath = path.join(root, "world/tiled/forest.tmj");
const map = JSON.parse(await readFile(mapPath, "utf8"));
const options = { mapPath, publicDir: path.join(root, "public") };
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/scene/presentation.ts");
const { createWorldNavigation, isWalkable, canTraverse, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation/navigation.ts");
const { previewWorldScene, initialPreviewLevels, previewSiteAt } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { forestPointOccluded } = await vite.ssrLoadModule("/features/world/scene/forest-occlusion.ts");
const layers = items => items.flatMap(layer => [layer, ...layers(layer.layers ?? [])]);
function objects(items, offset = { x: 0, y: 0 }) {
  return items.flatMap(layer => {
    const position = { x: offset.x + (layer.offsetx ?? 0), y: offset.y + (layer.offsety ?? 0) };
    return [...(layer.objects ?? []).map(object => ({ ...object, x: object.x + position.x, y: object.y + position.y })),
      ...objects(layer.layers ?? [], position)];
  });
}
const authoredObjects = objects(map.layers);
const property = (object, name) => object.properties?.find(value => value.name === name)?.value;
const shop = TILED_WORLD.sites.find(site => site.id === "plesk-shop");
const destination = (scene, id) => scene.destinations.find(point => point.id === id).position;
const centroid = points => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length });
const silhouettes = scene => scene.occluders.filter(mask => mask.when?.siteId === "plesk-shop" && mask.when.level === 1);
function imagePoint(x, y) {
  const placement = shop.imagePlacement ?? { ...shop.bounds, rotation: 0 }, angle = placement.rotation * Math.PI / 180;
  const dx = x / 1254 * placement.width, dy = y / 1254 * placement.height;
  return { x: placement.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: placement.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
}
function distanceToContour(point, points) {
  return Math.min(...points.map((a, index) => {
    const b = points[(index + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
  }));
}
function assertPath(nav, start, end) {
  const route = findWorldPath(nav, start, end);
  assert.ok(route, `path unavailable: ${nav.stats.lastSearch?.reason}`);
  assert.deepEqual(route[0], start);
  assert.deepEqual(route.at(-1), end);
  for (let i = 1; i < route.length; i++) assert.ok(canTraverse(nav, route[i - 1], route[i]), `unsafe route segment ${i}`);
}
function assertTranslatedPoints(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: vertex count stays unchanged`);
  actual.forEach((point, index) => {
    assert.deepEqual(Object.keys(point).sort(), ["x", "y"], `${label}: vertex ${index} keeps its coordinate shape`);
    for (const axis of ["x", "y"]) assert.ok(Number.isFinite(point[axis]) && Math.abs(point[axis] - expected[index][axis]) <= 1e-9,
      `${label}: vertex ${index}.${axis} differs from its ordered translation`);
  });
}

test("Tiled exports the rotated fishing shop as a clickable site with independent walkable ground", () => {
  const authored = authoredObjects.find(object => property(object, "role") === "site" && property(object, "siteId") === "plesk-shop");
  assert.ok(authored, "the nested shop image remains a registered authored site");
  assert.ok(shop);
  assert.deepEqual(shop.imagePlacement, { x: authored.x, y: authored.y, width: authored.width, height: authored.height,
    rotation: authored.rotation });
  const corners = [[0, 0], [1254, 0], [1254, 1254], [0, 1254]].map(([x, y]) => imagePoint(x, y));
  const x = Math.min(...corners.map(point => point.x)), y = Math.min(...corners.map(point => point.y));
  assert.deepEqual(shop.bounds, { x, y, width: Math.max(...corners.map(point => point.x)) - x,
    height: Math.max(...corners.map(point => point.y)) - y });
  assert.match(shop.states[0].image, /^\/world\/prototype\/pleska-market\.png\?v=/);
  assert.ok(TILED_WORLD.navigation.areas.some(area => area.id === "pleska-cleaning"));
  assert.ok(!TILED_WORLD.terrain.some(image => image.image.includes("pleska-market.png")), "the shop keeps its own interaction and collision contract instead of becoming terrain-only artwork");
  const center = centroid(shop.collision);
  assert.equal(previewSiteAt(TILED_WORLD, center)?.id, "plesk-shop");
  const navigation = createWorldNavigation(TILED_WORLD);
  assert.equal(isWalkable(navigation, center), false, "actors cannot cross the counter");
  assert.ok(isWalkable(navigation, shop.entry), "the shop door has its own safe approach");
  assert.ok(isWalkable(navigation, destination(TILED_WORLD, "plesk-customer")), "the separate customer stop stays safe");
});

test("the authored clearing contour is exported without replacing its vertices by a rectangle", () => {
  const authored = authoredObjects.find(object => object.name === "pleska-cleaning" && property(object, "role") === "walk-area");
  assert.ok(authored, "the nested shop tracing retains its authored ground contour");
  const area = TILED_WORLD.navigation.areas.find(item => item.id === authored.name);
  assert.ok(area);
  assert.deepEqual(area.points, authored.polygon.map(point => ({ x: authored.x + point.x, y: authored.y + point.y })));
  assert.ok(area.points.length > 4);
});

test("seller and customer are reachable from their existing starts through safe paths at every building level", () => {
  const initial = initialPreviewLevels(TILED_WORLD);
  const variants = [initial, ...TILED_WORLD.sites.flatMap(site => site.states.filter(state => state.level !== initial[site.id])
    .map(state => ({ ...initial, [site.id]: state.level })))];
  for (const levels of variants) {
    const scene = previewWorldScene(TILED_WORLD, levels), nav = createWorldNavigation(scene);
    const seller = destination(scene, "plesk-trade"), customer = destination(scene, "plesk-customer");
    assert.ok(isWalkable(nav, seller));
    assert.ok(isWalkable(nav, customer));
    assertPath(nav, destination(scene, "plesk-fishing"), seller);
    assertPath(nav, scene.actor.spawn, customer);
    assertPath(nav, customer, seller);
  }
});

test("trade stops leave room for both characters and keep the seller beside the counter", () => {
  const seller = destination(TILED_WORLD, "plesk-trade"), customer = destination(TILED_WORLD, "plesk-customer");
  assert.ok(distanceToContour(seller, shop.collision) <= TILED_WORLD.actor.size * .8, "the seller stays beside the actual counter footprint");
  assert.ok(seller.y > shop.anchor.y, "the seller stands in front of the enlarged shop's solid artwork");
  assert.ok(customer.y > shop.anchor.y, "customer approaches the front");
  assert.ok(Math.hypot(customer.x - seller.x, customer.y - seller.y) >= TILED_WORLD.actor.size * .6, "two actors have separate stops");
  assert.ok(customer.y > seller.y, "seller faces toward the viewer while serving");
  assert.equal(forestPointOccluded(TILED_WORLD, seller.y, { x: seller.x, y: seller.y - 30 }), false,
    "the seller's face is not hidden by either the shop or nearby trees");
});

test("moving the Pleska group keeps the bitmap, clearance, collision and both trade stops together", async () => {
  const translated = structuredClone(map);
  const group = layers(translated.layers).find(layer => layer.name === "Pleska");
  group.offsetx = -4; group.offsety = 2;
  const moved = await compileTiledWorld(translated, options);
  const site = moved.sites.find(item => item.id === shop.id);
  assert.equal(site.bounds.x, shop.bounds.x - 4);
  assert.equal(site.bounds.y, shop.bounds.y + 2);
  const shift = point => ({ x: point.x - 4, y: point.y + 2 });
  assertTranslatedPoints(site.collision, shop.collision.map(shift), "stall collision");
  assertTranslatedPoints(site.hitArea, shop.hitArea.map(shift), "stall hit area");
  const masks = silhouettes(TILED_WORLD);
  assert.ok(masks.length);
  for (const silhouette of masks) {
    const movedSilhouette = moved.occluders.find(mask => mask.id === silhouette.id);
    assert.ok(movedSilhouette);
    assertTranslatedPoints(movedSilhouette.points, silhouette.points.map(shift), "shop silhouette");
    assert.equal(movedSilhouette.frontY, silhouette.frontY + 2);
  }
  assert.deepEqual(site.entry, shift(shop.entry));
  for (const id of ["plesk-trade", "plesk-customer"]) assert.deepEqual(destination(moved, id), shift(destination(TILED_WORLD, id)));
  const currentArea = TILED_WORLD.navigation.areas.find(area => area.id === "pleska-cleaning");
  assertTranslatedPoints(moved.navigation.areas.find(area => area.id === currentArea.id).points, currentArea.points.map(shift), "trading clearing");
});


test("the roof and counter hide actors behind solid artwork while transparent padding and the front stay visible", () => {
  const masks = silhouettes(TILED_WORLD);
  assert.ok(masks.length, "site artwork alone does not depth-mask NPCs drawn in a later pass");
  for (const silhouette of masks) assert.deepEqual(silhouette.when, { siteId: "plesk-shop", level: 1 });
  const frontY = Math.max(...masks.map(mask => mask.frontY)), scene = { ...TILED_WORLD, occluders: masks };
  const body = imagePoint(650, 920), roof = imagePoint(600, 550), emptyCorner = imagePoint(1100, 200), belowSteps = imagePoint(1080, 1150);
  assert.equal(forestPointOccluded(scene, frontY - 10, body), true);
  assert.equal(forestPointOccluded(scene, frontY - 10, roof), true, "the new shop's roof is solid artwork");
  assert.equal(forestPointOccluded(scene, frontY - 10, emptyCorner), false, "transparent image padding must not erase the passing character");
  assert.equal(forestPointOccluded(scene, frontY - 10, belowSteps), false, "the irregular outline keeps transparent space below the steps");
  assert.equal(forestPointOccluded(scene, frontY, body), false);
  assert.equal(forestPointOccluded(scene, destination(TILED_WORLD, "plesk-customer").y, body), false, "the customer in front is never hidden by the counter");
  const seller = destination(TILED_WORLD, "plesk-trade");
  assert.equal(forestPointOccluded(scene, seller.y, { x: seller.x, y: seller.y - 30 }), false, "seller's face remains visible at the side");
});
