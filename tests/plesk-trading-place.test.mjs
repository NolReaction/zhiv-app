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
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const { createWorldNavigation, isWalkable, canTraverse, findWorldPath } = await vite.ssrLoadModule("/features/world/navigation.ts");
const { previewWorldScene, initialPreviewLevels, previewSiteAt } = await vite.ssrLoadModule("/features/world/tiled/preview-state.ts");
const { forestPointOccluded } = await vite.ssrLoadModule("/features/world/forest-occlusion.ts");
const layers = items => items.flatMap(layer => [layer, ...layers(layer.layers ?? [])]);
const shopLayer = layers(map.layers).find(layer => layer.name === "Shop");
const shop = TILED_WORLD.sites.find(site => site.id === "plesk-shop");
const destination = (scene, id) => scene.destinations.find(point => point.id === id).position;
const centroid = points => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length });
function assertPath(nav, start, end) {
  const route = findWorldPath(nav, start, end);
  assert.ok(route, `path unavailable: ${nav.stats.lastSearch?.reason}`);
  assert.deepEqual(route[0], start);
  assert.deepEqual(route.at(-1), end);
  for (let i = 1; i < route.length; i++) assert.ok(canTraverse(nav, route[i - 1], route[i]), `unsafe route segment ${i}`);
}

test("Tiled exports the placed stall as a clickable site with separate walkable ground", () => {
  const authored = shopLayer.objects.find(object => object.name === "plesk-shop");
  assert.ok(shop);
  assert.deepEqual(shop.bounds, { x: authored.x, y: authored.y, width: authored.width, height: authored.height });
  assert.match(shop.states[0].image, /^\/world\/prototype\/Pleska_FishingShop\.png\?v=/);
  assert.ok(TILED_WORLD.terrain.some(image => image.id === "plesk-shop-ground"));
  assert.ok(!TILED_WORLD.terrain.some(image => image.image.includes("Pleska_FishingShop.png")), "the stall keeps its own interaction and collision contract instead of becoming terrain-only artwork");
  const center = centroid(shop.collision);
  assert.equal(previewSiteAt(TILED_WORLD, center)?.id, "plesk-shop");
  assert.equal(isWalkable(createWorldNavigation(TILED_WORLD), center), false, "actors cannot cross the counter");
  assert.deepEqual(shop.entry, destination(TILED_WORLD, "plesk-customer"));
});

test("the authored clearing contour is exported without replacing its vertices by a rectangle", () => {
  const authored = shopLayer.objects.find(object => object.name === "pleska-cleaning");
  const area = TILED_WORLD.navigation.areas.find(item => item.id === authored.name);
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
  assert.ok(seller.x > shop.bounds.x + shop.bounds.width, "seller's face is beside the stall artwork");
  assert.ok(customer.y > shop.anchor.y, "customer approaches the front");
  assert.ok(Math.hypot(customer.x - seller.x, customer.y - seller.y) >= TILED_WORLD.actor.size * .6, "two actors have separate stops");
  assert.ok(customer.y > seller.y, "seller faces toward the viewer while serving");
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
  assert.deepEqual(site.collision, shop.collision.map(shift));
  assert.deepEqual(site.hitArea, shop.hitArea.map(shift));
  const silhouette = TILED_WORLD.occluders.find(mask => mask.id === "plesk-shop-silhouette");
  const movedSilhouette = moved.occluders.find(mask => mask.id === silhouette.id);
  assert.deepEqual(movedSilhouette.points, silhouette.points.map(shift));
  assert.equal(movedSilhouette.frontY, silhouette.frontY + 2);
  assert.deepEqual(site.entry, shift(shop.entry));
  for (const id of ["plesk-trade", "plesk-customer"]) assert.deepEqual(destination(moved, id), shift(destination(TILED_WORLD, id)));
  const currentArea = TILED_WORLD.navigation.areas.find(area => area.id === "pleska-cleaning");
  assert.deepEqual(moved.navigation.areas.find(area => area.id === currentArea.id).points, currentArea.points.map(shift));
});


test("the counter hides actors behind solid artwork while its open top and front approach remain visible", () => {
  const silhouette = TILED_WORLD.occluders.find(mask => mask.id === "plesk-shop-silhouette");
  assert.ok(silhouette, "site artwork alone does not depth-mask NPCs drawn in a later pass");
  assert.deepEqual(silhouette.when, { siteId: "plesk-shop", level: 1 });
  const scene = { ...TILED_WORLD, occluders: [silhouette] };
  const inImage = (x, y) => ({ x: shop.bounds.x + x / 1254 * shop.bounds.width,
    y: shop.bounds.y + y / 1254 * shop.bounds.height });
  const body = inImage(650, 920), emptyCenter = inImage(650, 250), openUnderLeg = inImage(510, 1120);
  assert.equal(forestPointOccluded(scene, silhouette.frontY - 10, body), true);
  assert.equal(forestPointOccluded(scene, silhouette.frontY - 10, emptyCenter), false, "transparent upper half must not erase the passing character");
  assert.equal(forestPointOccluded(scene, silhouette.frontY - 10, openUnderLeg), false, "the irregular outline keeps transparent space below the counter");
  assert.equal(forestPointOccluded(scene, silhouette.frontY, body), false);
  assert.equal(forestPointOccluded(scene, destination(TILED_WORLD, "plesk-customer").y, body), false, "the customer in front is never hidden by the counter");
  const seller = destination(TILED_WORLD, "plesk-trade");
  assert.equal(forestPointOccluded(scene, seller.y, { x: seller.x, y: seller.y - 30 }), false, "seller's face remains visible at the side");
});
