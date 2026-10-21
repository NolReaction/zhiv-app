import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Point from "@mapbox/point-geometry";
import { createServer } from "vite";
import { createEarthModelFraming } from "../scripts/prepare-earth-model-framing.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthModelEditorCamera } = await vite.ssrLoadModule("/features/earth/dev/earth-model-editor-map.ts");
const { MercatorTransform } = await vite.ssrLoadModule("/node_modules/maplibre-gl/src/geo/projection/mercator_transform.ts");
const { LngLat } = await vite.ssrLoadModule("/node_modules/maplibre-gl/src/geo/lng_lat.ts");
const { MercatorCoordinate } = await vite.ssrLoadModule("/node_modules/maplibre-gl/src/geo/mercator_coordinate.ts");
const published = JSON.parse(readFileSync(new URL("../features/earth/data/model-placements.json", import.meta.url)));
const viewports = [
  { width: 390, height: 844, verticalFieldOfView: 36.87, available: { left: 20, right: 370, top: 24, bottom: 340 } },
  { width: 1280, height: 900, verticalFieldOfView: 36.87, available: { left: 390, right: 1204, top: 32, bottom: 788 } },
];

// Project actual prepared vertices with the installed MapLibre camera, rather
// than repeating the fitting helper's pinhole equations as the test oracle.
function projectedGeometry(placement, viewport, bearing) {
  const camera = earthModelEditorCamera(placement, viewport), transform = new MercatorTransform();
  transform.resize(viewport.width, viewport.height);
  transform.setFov(viewport.verticalFieldOfView);
  transform.setZoom(camera.zoom); transform.setPitch(camera.pitch); transform.setBearing(bearing);
  const location = new LngLat(placement.longitude, placement.latitude);
  transform.setCenter(location);
  transform.setLocationAtPoint(location, new Point(viewport.width / 2 + camera.offset[0], viewport.height / 2 + camera.offset[1]));
  const anchor = MercatorCoordinate.fromLngLat(location), unit = anchor.meterInMercatorCoordinateUnits();
  const bytes = readFileSync(new URL(`../public/earth/models/${placement.id}/detail.elm`, import.meta.url));
  const stride = bytes.readUInt32LE(4) === 2 ? 11 : 6, start = stride === 11 ? 88 : 16;
  const heading = placement.headingDegrees * Math.PI / 180;
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (let vertex = 0; vertex < bytes.readUInt32LE(8); vertex++) {
    const x = bytes.readFloatLE(start + vertex * stride * 4) * placement.heightMeters;
    const y = bytes.readFloatLE(start + (vertex * stride + 1) * 4) * placement.heightMeters;
    const z = bytes.readFloatLE(start + (vertex * stride + 2) * 4) * placement.heightMeters + placement.elevationMeters;
    const east = x * Math.cos(heading) + y * Math.sin(heading), north = -x * Math.sin(heading) + y * Math.cos(heading);
    const point = transform.coordinatePoint(new MercatorCoordinate(anchor.x + east * unit, anchor.y - north * unit), z);
    bounds.left = Math.min(bounds.left, point.x); bounds.right = Math.max(bounds.right, point.x);
    bounds.top = Math.min(bounds.top, point.y); bounds.bottom = Math.max(bounds.bottom, point.y);
  }
  return { camera, bounds };
}

test("focus keeps every model's real ground footprint and roof outside the editor on phone and desktop", () => {
  for (const viewport of viewports) for (const placement of published.placements)
    for (const bearing of [0, 120, 270]) {
      const { camera, bounds } = projectedGeometry(placement, viewport, bearing), available = viewport.available;
      const label = `${placement.id}, ${viewport.width}px, bearing ${bearing}: ${JSON.stringify(bounds)}`;
      assert.ok(camera.zoom >= 15.6 && camera.pitch >= 30, label);
      assert.ok(bounds.left >= available.left && bounds.right <= available.right, label);
      assert.ok(bounds.top >= available.top && bounds.bottom <= available.bottom, label);
    }
});

test("the tapered camera envelope is pinned to the actual detail asset and encloses long triangles across empty slabs", () => {
  const manifest = JSON.parse(readFileSync(new URL("../features/earth/data/eiffel-model.json", import.meta.url)));
  const framing = JSON.parse(readFileSync(new URL("../features/earth/data/eiffel-model-framing.json", import.meta.url)));
  const bytes = readFileSync(new URL(`../public${manifest.detail.url}`, import.meta.url));
  assert.equal(framing.assetSha256, manifest.detail.sha256);
  assert.equal(framing.assetSha256, createHash("sha256").update(bytes).digest("hex"), "asset changes require framing regeneration");
  assert.deepEqual(createEarthModelFraming(bytes, manifest.detail), framing);
  const triangle = Buffer.alloc(16 + 3 * 24 + 3 * 4);
  [0x314d4c45, 1, 3, 3].forEach((value, index) => triangle.writeUInt32LE(value, index * 4));
  [[.7, 0, 0], [0, .4, 1], [0, 0, 1]].forEach((point, index) =>
    point.forEach((value, channel) => triangle.writeFloatLE(value, 16 + index * 24 + channel * 4)));
  [0, 1, 2].forEach((value, index) => triangle.writeUInt32LE(value, 16 + 3 * 24 + index * 4));
  const asset = { bytes: triangle.length, vertexCount: 3, indexCount: 3,
    sha256: createHash("sha256").update(triangle).digest("hex") };
  const synthetic = createEarthModelFraming(triangle, asset);
  assert.equal(synthetic.framingBands.length, 8);
  for (const band of synthetic.framingBands) assert.ok(band.radius >= .6999999,
    "a face crossing the entire model height cannot disappear from slabs without source vertices");
  const changed = Buffer.from(triangle); changed[20] ^= 1;
  assert.throws(() => createEarthModelFraming(changed, asset), /integrity/);
});
