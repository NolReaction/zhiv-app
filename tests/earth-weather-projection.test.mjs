import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import Point from '@mapbox/point-geometry';
const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ appType: 'custom', configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthWeatherFootprint, earthWeatherFrame } = await vite.ssrLoadModule('/features/earth/weather-field.ts');
const { createGlobeTransform } = await vite.ssrLoadModule('/node_modules/maplibre-gl/src/geo/projection/globe_transform.ts');
const { createMercatorTransform } = await vite.ssrLoadModule('/node_modules/maplibre-gl/src/geo/projection/mercator_transform.ts');
const { LngLat } = await vite.ssrLoadModule('/node_modules/maplibre-gl/src/geo/lng_lat.ts');
const { earthWeatherArea } = await vite.ssrLoadModule('/features/earth/weather.ts');
function nativeCamera({ width = 390, height = 1600, longitude = 30.31, latitude = 59.93, pitch = 60, bearing = 0 } = {}) {
  const transform = createMercatorTransform({ minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 85, renderWorldCopies: true });
  transform.resize(width, height); transform.setZoom(16); transform.setCenter(new LngLat(longitude, latitude));
  transform.setPitch(pitch); transform.setBearing(bearing);
  return { width, height, area: earthWeatherArea(longitude, latitude), map: {
    getCenter: () => transform.center,
    project: point => transform.locationToScreenPoint(LngLat.convert(point)),
    unproject: point => transform.screenPointToLocation(Point.convert(point)),
  } };
}
test('native street cameras keep the visible forecast at supported pitch in tall portrait and landscape', () => {
  for (const [width, height] of [[390, 1600], [1440, 700]]) for (const pitch of [0, 30, 60]) for (const bearing of [0, 90]) {
    const camera = nativeCamera({ width, height, pitch, bearing });
    const footprint = earthWeatherFootprint(camera.map, camera.area, width, height);
    assert.ok(footprint, `${width}x${height}, pitch${pitch}, bearing${bearing}`);
    assert.ok(footprint.surface > width * height * .8);
    assert.ok(footprint.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= -1e-6 && point.x <= width + 1e-6 && point.y >= -1e-6 && point.y <= height + 1e-6));
    const frame = earthWeatherFrame(camera.map, camera.area, 16, footprint);
    assert.ok(frame); assert.ok(Object.values(frame.bounds).every(Number.isFinite));
  }
});
test('missing SDK ground rays are excluded from weather footprint and never dereferenced', () => {
  const camera = nativeCamera();
  const map = { ...camera.map, unproject(point) { return Point.convert(point).y < 200 ? undefined : camera.map.unproject(point); } };
  const footprint = earthWeatherFootprint(map, camera.area, camera.width, camera.height);
  assert.ok(footprint); assert.ok(footprint.points.every(point => point.y >= 200));
  assert.ok(earthWeatherFrame(map, camera.area, 16, footprint));
  const noGround = { ...map, unproject: () => undefined };
  assert.equal(earthWeatherFootprint(noGround, camera.area, camera.width, camera.height), null);
  assert.equal(earthWeatherFrame(noGround, camera.area, 16, footprint), null);
});
test('native camera footprint stays on ground beyond the horizon and across the date line', () => {
  for (const longitude of [179.93, -179.93]) {
    const camera = nativeCamera({ longitude, pitch: 80 });
    const footprint = earthWeatherFootprint(camera.map, camera.area, camera.width, camera.height);
    assert.ok(footprint); assert.ok(footprint.bounds.top > 0); assert.ok(footprint.surface < camera.width * camera.height);
    for (const point of footprint.points) {
      const roundTrip = camera.map.project(camera.map.unproject(point));
      assert.ok(Math.hypot(roundTrip.x - point.x, roundTrip.y - point.y) < 1);
    }
    assert.ok(earthWeatherFrame(camera.map, camera.area, 16, footprint));
  }
});

test('native globe coverage remains inside the visible forecast cell and rejects its far side', () => {
  for (const [longitude, latitude, zoom] of [[30, 60, 3], [179.93, 59.93, 3], [-179.93, 59.93, 3], [30, 85, 5], [30, -85, 5]]) {
    const transform = createGlobeTransform({ minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 85, renderWorldCopies: true });
    transform.resize(390, 1600); transform.setZoom(zoom); transform.setCenter(new LngLat(longitude, latitude)); transform.setTransitionState(1);
    const map = { getCenter: () => transform.center, project: point => transform.locationToScreenPoint(LngLat.convert(point)),
      unproject: point => transform.screenPointToLocation(Point.convert(point)) };
    const area = earthWeatherArea(longitude, latitude);
    const footprint = earthWeatherFootprint(map, area, 390, 1600);
    assert.ok(footprint); assert.ok(earthWeatherFrame(map, area, zoom, footprint));
    for (const point of footprint.points) {
      const location = map.unproject(point), expected = earthWeatherArea(location.lng, location.lat);
      assert.ok(Math.abs(((location.lng - area.longitude + 540) % 360) - 180) <= .501);
      assert.ok(Math.abs(location.lat - area.latitude) <= .501);
      assert.ok(expected);
    }
    const opposite = earthWeatherArea(longitude + 180, latitude);
    assert.equal(earthWeatherFootprint(map, opposite, 390, 1600), null);
  }
});
