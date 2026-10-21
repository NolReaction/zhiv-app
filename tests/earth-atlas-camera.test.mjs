import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Point from "@mapbox/point-geometry";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthAtlasCameraFocus } = await vite.ssrLoadModule("/features/earth/atlas-camera-focus.ts");
const { EARTH_ATLAS_ENTRIES, earthAtlasCandidate } = await vite.ssrLoadModule("/features/earth/earth-atlas.ts");
const { earthViewportPadding } = await vite.ssrLoadModule("/features/earth/camera-viewport.ts");
const { MercatorTransform } = await vite.ssrLoadModule("/node_modules/maplibre-gl/src/geo/projection/mercator_transform.ts");
const { LngLat } = await vite.ssrLoadModule("/node_modules/maplibre-gl/src/geo/lng_lat.ts");
const { MercatorCoordinate } = await vite.ssrLoadModule("/node_modules/maplibre-gl/src/geo/mercator_coordinate.ts");
const placements = JSON.parse(readFileSync(new URL("../features/earth/data/model-placements.json", import.meta.url))).placements;
const viewports = [
  { width: 320, height: 600, available: { left: 12, top: 80, right: 308, bottom: 350 } },
  { width: 320, height: 568, available: { left: 12, top: 76, right: 308, bottom: 315 } },
  { width: 390, height: 844, available: { left: 12, top: 90, right: 378, bottom: 585 } },
  { width: 844, height: 390, available: { left: 12, top: 60, right: 610, bottom: 290 } },
  { width: 1280, height: 900, available: { left: 380, top: 80, right: 1200, bottom: 780 } },
].map(viewport => ({ ...viewport, verticalFieldOfView: 36.87,
  padding: earthViewportPadding(viewport.width, viewport.height, viewport.available) }));

function transformFor(camera, viewport) {
  const transform = new MercatorTransform();
  transform.resize(viewport.width, viewport.height);
  transform.setFov(viewport.verticalFieldOfView);
  transform.setPadding(viewport.padding);
  transform.setZoom(camera.zoom); transform.setPitch(camera.pitch); transform.setBearing(camera.bearing);
  const location = new LngLat(...camera.center);
  transform.setCenter(location);
  transform.setLocationAtPoint(location, transform.centerPoint.add(new Point(...camera.offset)));
  return transform;
}

function projectedGeometry(placement, transform) {
  const anchor = MercatorCoordinate.fromLngLat([placement.longitude, placement.latitude]);
  const unit = anchor.meterInMercatorCoordinateUnits();
  const bytes = readFileSync(new URL(`../public/earth/models/${placement.id}/detail.elm`, import.meta.url));
  const stride = bytes.readUInt32LE(4) === 2 ? 11 : 6, start = stride === 11 ? 88 : 16;
  const heading = placement.headingDegrees * Math.PI / 180;
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (let vertex = 0; vertex < bytes.readUInt32LE(8); vertex++) {
    const x = bytes.readFloatLE(start + vertex * stride * 4) * placement.heightMeters;
    const y = bytes.readFloatLE(start + (vertex * stride + 1) * 4) * placement.heightMeters;
    const z = bytes.readFloatLE(start + (vertex * stride + 2) * 4) * placement.heightMeters + placement.elevationMeters;
    const east = x * Math.cos(heading) + y * Math.sin(heading), north = -x * Math.sin(heading) + y * Math.cos(heading);
    const coordinate = new MercatorCoordinate(anchor.x + east * unit, anchor.y - north * unit);
    const point = transform.coordinatePoint(coordinate, z);
    bounds.left = Math.min(bounds.left, point.x); bounds.right = Math.max(bounds.right, point.x);
    bounds.top = Math.min(bounds.top, point.y); bounds.bottom = Math.max(bounds.bottom, point.y);
    const world = [coordinate.x * transform.worldSize, coordinate.y * transform.worldSize, z, 1];
    const matrix = transform.modelViewProjectionMatrix;
    const clip = [0, 1, 2, 3].map(row => world.reduce((sum, value, column) => sum + matrix[column * 4 + row] * value, 0));
    assert.ok(clip[3] > 0 && clip[2] >= -clip[3] && clip[2] <= clip[3], `${placement.id}: actual vertex must remain between native clipping planes`);
  }
  return bounds;
}

test("atlas frames every actual detail model above mobile panels with padding, tilt and no clipping", () => {
  for (const viewport of viewports) for (const placement of placements) {
    const id = `landmark:${placement.id}`, camera = earthAtlasCameraFocus(id, viewport);
    assert.ok(camera, `${id} ${viewport.width}×${viewport.height}: complete model must fit`);
    assert.ok(camera.zoom >= 12 && camera.zoom <= 18);
    assert.ok(camera.pitch >= 15 && camera.pitch <= 55);
    const transform = transformFor(camera, viewport), bounds = projectedGeometry(placement, transform), area = viewport.available;
    const label = `${id} ${viewport.width}×${viewport.height}: ${JSON.stringify(bounds)}`;
    assert.ok(bounds.left >= area.left && bounds.right <= area.right, label);
    assert.ok(bounds.top >= area.top && bounds.bottom <= area.bottom, label);
    assert.equal(earthAtlasCandidate({ center: [transform.center.lng, transform.center.lat], zoom: camera.zoom })?.id, id,
      `${label}: a centred raised silhouette cannot be rejected because its foot is below the focus point`);
  }
  assert.ok(earthAtlasCameraFocus("landmark:eiffel-tower", viewports[0]).zoom >= 15.6,
    "a tall landmark keeps ordinary street detail when it can fit");
  assert.ok(earthAtlasCameraFocus("landmark:giza-pyramids", viewports[0]).zoom < 15.6,
    "a wide complex may need a selected-model detail override to fit the same phone");
});

test("nature uses region extent and an overview rather than a street model or fixed city zoom", () => {
  const viewport = viewports[2];
  const cameras = EARTH_ATLAS_ENTRIES.filter(entry => entry.kind === "region").map(entry => {
    const camera = earthAtlasCameraFocus(entry.id, viewport);
    assert.ok(camera && camera.zoom >= 2.2 && camera.zoom <= 4.8);
    assert.equal(camera.pitch, 0); assert.equal(camera.bearing, 0);
    assert.equal(earthAtlasCandidate({ center: camera.center, zoom: camera.zoom })?.id, entry.id);
    return camera;
  });
  assert.ok(new Set(cameras.map(camera => camera.zoom)).size > 5, "different authored regions deserve their own geographic framing");
  for (const id of ["missing", "meeting:friend"]) assert.equal(earthAtlasCameraFocus(id, viewport), null);
  assert.equal(earthAtlasCameraFocus("landmark:eiffel-tower", { ...viewport, width: 0 }), null);
});
