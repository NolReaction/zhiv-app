import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import Point from "@mapbox/point-geometry";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
const loadSdk = path => vite.ssrLoadModule(`/node_modules/maplibre-gl/src/${path}.ts`);
const { installEarthGlobeCamera } = await vite.ssrLoadModule("/features/earth/globe-camera.ts");
const { Camera } = await loadSdk("ui/camera");
const { createProjectionFromName } = await loadSdk("geo/projection/projection_factory");
const { ClickZoomHandler } = await loadSdk("ui/handler/click_zoom");
const { TapZoomHandler } = await loadSdk("ui/handler/tap_zoom");
const { HandlerInertia } = await loadSdk("ui/handler_inertia");
const { getZoomAdjustment } = await loadSdk("geo/projection/globe_utils");
const time = await loadSdk("util/time_control");
after(() => vite.close());

// Use the pinned SDK's real globe camera and native gesture handlers, without
// needing a WebGL renderer. Only animation timing is collapsed to its last frame.
function fixture(initial = {}) {
  const camera = new Camera({ minZoom: -1.5, maxZoom: 18, minPitch: 0, maxPitch: 60,
    bearingSnap: 0, zoomSnap: 0, terrain: null, transformConstrain: null,
    requestRenderFrame: () => 0, cancelRenderFrame: () => {} });
  camera.transform.resize(512, 512, true);
  const globe = createProjectionFromName("globe", undefined, {});
  camera.migrateProjection(globe.transform, globe.cameraHelper);
  camera.jumpTo({ center: [0, 0], zoom: 0, ...initial });
  const calls = [];
  const map = {
    _camera: camera,
    getProjection: () => ({ type: "globe" }),
    getCenter: () => camera.getCenter(), getZoom: () => camera.getZoom(),
    getBearing: () => camera.getBearing(), getPitch: () => camera.transform.pitch,
    getRoll: () => camera.transform.roll, getZoomSnap: () => 0,
    project: location => camera.transform.locationToScreenPoint(location),
    unproject: point => camera.transform.screenPointToLocation(point),
    calculateAnchoredCameraOptions: options => camera.calculateAnchoredCameraOptions(options),
    easeTo(options, eventData) {
      assert.equal(this, map, "native method keeps the map receiver");
      calls.push({ options, eventData });
      camera.easeTo({ ...options, duration: 0, essential: true }, eventData);
      return map;
    },
  };
  const transformProvider = { get transform() { return camera.transform; }, get zoom() { return camera.getZoom(); }, unproject: map.unproject };
  return { map, camera, calls, transformProvider };
}

function assertAnchor(map, location, expected) {
  const actual = map.project(location);
  assert.ok(actual.dist(expected) < 0.01, `anchor drifted by ${actual.dist(expected)}px`);
}

test("native double-click and shift-double-click keep the geographic zoom anchor using supported globe easing", () => {
  for (const shiftKey of [false, true]) {
    const s = fixture({ zoom: shiftKey ? 2 : 0 });
    installEarthGlobeCamera(s.map);
    const handler = new ClickZoomHandler(s.map, s.transformProvider);
    const point = new Point(280, 230), anchor = s.map.unproject(point);
    const event = { shiftKey, preventDefault() {} }, previousZoom = s.map.getZoom();
    handler.dblclick(event, point).cameraAnimation(s.map);
    const call = s.calls.at(-1);
    assert.equal("around" in call.options, false);
    assert.equal(call.options.duration, 300);
    assert.equal(call.eventData.originalEvent, event);
    assert.ok(shiftKey ? s.map.getZoom() < previousZoom : s.map.getZoom() > previousZoom);
    assertAnchor(s.map, anchor, point);
  }
});

test("native double-tap and two-finger tap use the same anchor conversion", () => {
  for (const fingers of [1, 2]) {
    const s = fixture({ zoom: 2 });
    installEarthGlobeCamera(s.map);
    const handler = new TapZoomHandler(s.map, s.transformProvider);
    const point = new Point(275, 240), anchor = s.map.unproject(point);
    let action;
    for (let tap = 0; tap < (fingers === 1 ? 2 : 1); tap++) {
      handler.touchstart({ timeStamp: tap * 100 }, Array.from({ length: fingers }, () => point),
        Array.from({ length: fingers }, (_, identifier) => ({ identifier })));
      action = handler.touchend({ timeStamp: tap * 100 + 30, preventDefault() {} }, [], []);
    }
    assert.ok(action);
    action.cameraAnimation(s.map);
    assert.equal("around" in s.calls[0].options, false);
    assert.ok(fingers === 1 ? s.map.getZoom() > 2 : s.map.getZoom() < 2);
    assertAnchor(s.map, anchor, point);
  }
});

test("native rotation and combined pan/zoom inertia preserve targets and gesture lifecycle without unsupported around", () => {
  for (const settings of [{ bearingDelta: 5 }, { zoomDelta: 0.1, panDelta: new Point(2, 1) }]) {
    const s = fixture({ zoom: 2, bearing: 25 });
    installEarthGlobeCamera(s.map);
    const inertia = new HandlerInertia(s.map);
    try {
      time.setNow(0); inertia.record({ around: new Point(270, 250) });
      time.setNow(20); inertia.record(settings);
      time.setNow(40);
      const options = inertia._onMoveEnd();
      assert.ok(options.around, "exercise the SDK's unsupported native path");
      const expected = { ...options };
      delete expected.around;
      const eventData = { originalEvent: { type: "touchend" } };
      assert.equal(s.map.easeTo(options, eventData), s.map);
      assert.deepEqual(s.calls[0].options, expected);
      assert.equal(s.calls[0].eventData, eventData);
      assert.equal(s.calls[0].options.noMoveStart, true);
      assert.ok(Number.isFinite(s.map.getZoom()));
    } finally { time.restoreNow(); }
  }
});

test("anchored zoom remains finite near the pole/horizon and respects camera limits", () => {
  for (const initial of [{ center: [0, 80], zoom: 0.5 }, { center: [175, 0], zoom: 0 }]) {
    for (const targetZoom of [-20, 1.5, 30]) {
      const s = fixture(initial);
      installEarthGlobeCamera(s.map);
      const anchor = s.map.unproject(new Point(256, 205));
      s.map.easeTo({ around: anchor, zoom: targetZoom });
      assert.equal("around" in s.calls[0].options, false);
      const center = s.map.getCenter(), zoom = s.map.getZoom();
      assert.ok(Number.isFinite(center.lng) && Number.isFinite(center.lat) && Number.isFinite(zoom));
      // Globe's lower zoom limit is latitude-adjusted to constrain apparent size.
      assert.ok(zoom >= -1.5 + getZoomAdjustment(0, center.lat) - 1e-9 && zoom <= 18);
      assert.ok(Math.abs(center.lat) <= 90);
    }
  }
});

test("center animations and Mercator calls pass through unchanged; disposal restores the instance method", () => {
  const s = fixture(), original = s.map.easeTo;
  const restore = installEarthGlobeCamera(s.map);
  const options = { center: [5, 4], zoom: 2, bearing: 45, pitch: 20, duration: 400 };
  s.map.easeTo(options);
  assert.equal(s.calls.at(-1).options, options);
  s.map.getProjection = () => ({ type: "mercator" });
  // The globe camera fixture must not execute a Mercator-only around animation.
  s.camera.easeTo = () => s.camera;
  const mercatorOptions = { around: s.map.getCenter(), zoom: 3 };
  s.map.easeTo(mercatorOptions);
  assert.equal(s.calls.at(-1).options, mercatorOptions);
  restore(); restore();
  assert.equal(s.map.easeTo, original);
});

test("disposal restores a prototype method and does not replace a later owner", () => {
  const s = fixture(), original = s.map.easeTo;
  delete s.map.easeTo;
  Object.setPrototypeOf(s.map, { easeTo: original });
  const restore = installEarthGlobeCamera(s.map);
  restore();
  assert.equal(Object.hasOwn(s.map, "easeTo"), false);
  assert.equal(s.map.easeTo, original);
  const restoreAgain = installEarthGlobeCamera(s.map);
  const nextOwner = () => s.map;
  s.map.easeTo = nextOwner;
  restoreAgain();
  assert.equal(s.map.easeTo, nextOwner);
});
