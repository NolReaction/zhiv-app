import type { FeatureCollection, Geometry } from "geojson";
import type { GeoJSONSource, Map as LibreMap, MapMouseEvent } from "maplibre-gl";
import { positionAccuracyData } from "../map-style";
import type { EarthModelPlacement } from "../model-placement";
import styles from "./earth-model-editor.module.css";

export const EARTH_MODEL_EDITOR_SOURCE = "earth-model-editor";
export const EARTH_MODEL_EDITOR_ANCHOR = "earth-model-editor-anchor";
const FILL = "earth-model-editor-zone";
const LINE = "earth-model-editor-line";
const LAYERS = [FILL, LINE, EARTH_MODEL_EDITOR_ANCHOR];

/** Frame the complete raised silhouette in the area left beside/above the
 * editor. Ground-only fitBounds cannot account for an imported model's height. */
export function earthModelEditorCamera(placement: EarthModelPlacement, viewport: {
  width: number; height: number; verticalFieldOfView: number;
  available: { left: number; top: number; right: number; bottom: number };
}) {
  const { width, height, available } = viewport;
  const usableWidth = Math.max(80, available.right - available.left);
  const usableHeight = Math.max(100, available.bottom - available.top);
  const modelHeight = placement.heightMeters + Math.abs(placement.elevationMeters);
  const fieldOfView = Math.max(20, Math.min(60, viewport.verticalFieldOfView)) * Math.PI / 180;
  const cameraDistancePixels = height / (2 * Math.tan(fieldOfView / 2));
  const metresAtZoomZero = 40_030_228.884 * Math.cos(placement.latitude * Math.PI / 180) / 512;
  let pitch = 55;
  let zoom = 15.6;
  // At street zoom, perspective makes a tall roof larger than a ground
  // footprint. Include that expansion plus margin; short phone viewports keep
  // a gentler 3D angle rather than magnifying the roof out of the screen.
  for (const angle of [55, 45, 35, 30]) {
    pitch = angle;
    const radians = angle * Math.PI / 180;
    const verticalScale = modelHeight * (Math.sin(radians) / (usableHeight * .76) + Math.cos(radians) / cameraDistancePixels);
    const horizontalScale = modelHeight * .7 / usableWidth;
    const metresPerPixel = 1.2 * Math.max(verticalScale, horizontalScale);
    zoom = Math.log2(metresAtZoomZero / metresPerPixel);
    if (zoom >= 15.6) break;
  }
  return {
    center: [placement.longitude, placement.latitude] as [number, number],
    zoom: Math.max(15.6, Math.min(19, zoom)), pitch,
    offset: [(available.left + available.right) / 2 - width / 2,
      available.top + usableHeight * .88 - height / 2] as [number, number],
  };
}

/** Public monument coordinates only; this source never reads the GPS marker. */
export function earthModelEditorData(placement: EarthModelPlacement | null): FeatureCollection<Geometry> {
  if (!placement) return { type: "FeatureCollection", features: [] };
  const { longitude, latitude, exclusionRadiusMeters, headingDegrees } = placement;
  const zone = positionAccuracyData({ longitude, latitude, accuracy: exclusionRadiusMeters, timestamp: 0 });
  const radians = Math.PI / 180;
  const distance = Math.max(12, exclusionRadiusMeters, placement.heightMeters * .2) / 6_371_008.8;
  const lat = latitude * radians;
  const bearing = headingDegrees * radians;
  const tipLat = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing));
  const tipLng = longitude + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat),
    Math.cos(distance) - Math.sin(lat) * Math.sin(tipLat)) / radians;
  return {
    type: "FeatureCollection",
    features: [
      ...zone.features.map(feature => ({ ...feature, properties: { role: "zone", enabled: placement.excludeBuildings } })),
      { type: "Feature", properties: { role: "heading" }, geometry: {
        type: "LineString", coordinates: [[longitude, latitude], [tipLng, tipLat / radians]],
      } },
      { type: "Feature", properties: { role: "anchor" }, geometry: { type: "Point", coordinates: [longitude, latitude] } },
    ],
  };
}

export function createEarthModelEditorMap(map: LibreMap, callbacks: {
  onMove: (longitude: number, latitude: number) => void;
  onPlace: (longitude: number, latitude: number) => void;
}) {
  let placement: EarthModelPlacement | null = null;
  let placing = false;
  let disposed = false;
  let dragging = false;
  let restorePan = false;
  const canvas = map.getCanvas();
  const container = map.getContainer();
  const activeAttribute = "data-earth-model-editor-active";
  const previousActive = container.getAttribute(activeAttribute);
  const hadEditingClass = container.classList.contains(styles.editing);
  // Native 44px monument buttons otherwise intercept the green handle's
  // pointer events before they can reach MapLibre's canvas. Friend markers keep
  // their normal interaction; only monument hit areas are released here.
  container.setAttribute(activeAttribute, "true");
  container.classList.add(styles.editing);
  const previousCursor = canvas.style.cursor;
  const ownerWindow = canvas.ownerDocument?.defaultView;
  function cursor(value = placing ? "crosshair" : previousCursor) { canvas.style.cursor = value; }
  function stopDragging() {
    if (!dragging) return;
    dragging = false;
    if (restorePan) map.dragPan.enable();
    restorePan = false;
    cursor();
  }
  function install() {
    // isStyleLoaded() also waits for every vector tile. During a camera flight
    // that can stay false even though the style accepts sources and layers.
    if (disposed || !map.getStyle()) return;
    if (!map.getSource(EARTH_MODEL_EDITOR_SOURCE)) map.addSource(EARTH_MODEL_EDITOR_SOURCE, {
      type: "geojson", data: earthModelEditorData(placement),
    });
    if (!map.getLayer(FILL)) map.addLayer({ id: FILL, type: "fill", source: EARTH_MODEL_EDITOR_SOURCE,
      filter: ["==", ["get", "role"], "zone"], paint: { "fill-color": "#ffbd69", "fill-opacity": ["case", ["==", ["get", "enabled"], true], .17, .04] } });
    if (!map.getLayer(LINE)) map.addLayer({ id: LINE, type: "line", source: EARTH_MODEL_EDITOR_SOURCE,
      filter: ["!=", ["get", "role"], "anchor"], paint: { "line-color": ["case", ["==", ["get", "role"], "heading"], "#d5ff94", "#ffbd69"],
        "line-width": 2, "line-dasharray": [2, 2] } });
    if (!map.getLayer(EARTH_MODEL_EDITOR_ANCHOR)) map.addLayer({ id: EARTH_MODEL_EDITOR_ANCHOR, type: "circle", source: EARTH_MODEL_EDITOR_SOURCE,
      filter: ["==", ["get", "role"], "anchor"], paint: { "circle-radius": 8, "circle-color": "#d5ff94", "circle-stroke-color": "#14372c", "circle-stroke-width": 3 } });
    (map.getSource(EARTH_MODEL_EDITOR_SOURCE) as GeoJSONSource).setData(earthModelEditorData(placement));
  }
  function coordinates(event: MapMouseEvent): [number, number] {
    return [((event.lngLat.lng + 180) % 360 + 360) % 360 - 180, event.lngLat.lat];
  }
  function onClick(event: MapMouseEvent) {
    if (!placing || disposed) return;
    placing = false;
    cursor();
    callbacks.onPlace(...coordinates(event));
  }
  function onDown(event: MapMouseEvent) {
    if (placing || disposed || !placement || event.originalEvent.button !== 0) return;
    event.preventDefault();
    dragging = true;
    restorePan = map.dragPan.isEnabled();
    if (restorePan) map.dragPan.disable();
    cursor("grabbing");
  }
  function onMove(event: MapMouseEvent) { if (dragging && !disposed) callbacks.onMove(...coordinates(event)); }
  function onEnter() { if (!placing && !dragging) cursor("grab"); }
  function onLeave() { if (!dragging) cursor(); }
  map.on("style.load", install);
  map.on("click", onClick);
  map.on("mousedown", EARTH_MODEL_EDITOR_ANCHOR, onDown);
  map.on("mouseenter", EARTH_MODEL_EDITOR_ANCHOR, onEnter);
  map.on("mouseleave", EARTH_MODEL_EDITOR_ANCHOR, onLeave);
  map.on("mousemove", onMove);
  map.on("mouseup", stopDragging);
  ownerWindow?.addEventListener("mouseup", stopDragging);
  ownerWindow?.addEventListener("blur", stopDragging);
  install();
  return {
    update(value: EarthModelPlacement | null, placeOnClick = false) {
      if (disposed) return;
      if (placement?.id !== value?.id || placeOnClick) stopDragging();
      placement = value;
      placing = placeOnClick;
      if (!dragging) cursor();
      install();
    },
    dispose() {
      if (disposed) return;
      stopDragging();
      disposed = true;
      map.off("style.load", install);
      map.off("click", onClick);
      map.off("mousedown", EARTH_MODEL_EDITOR_ANCHOR, onDown);
      map.off("mouseenter", EARTH_MODEL_EDITOR_ANCHOR, onEnter);
      map.off("mouseleave", EARTH_MODEL_EDITOR_ANCHOR, onLeave);
      map.off("mousemove", onMove);
      map.off("mouseup", stopDragging);
      ownerWindow?.removeEventListener("mouseup", stopDragging);
      ownerWindow?.removeEventListener("blur", stopDragging);
      cursor(previousCursor);
      if (previousActive === null) container.removeAttribute(activeAttribute);
      else container.setAttribute(activeAttribute, previousActive);
      if (!hadEditingClass) container.classList.remove(styles.editing);
      // The owning map can already have been removed by its React parent.
      if (!map.getStyle()) return;
      for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(EARTH_MODEL_EDITOR_SOURCE)) map.removeSource(EARTH_MODEL_EDITOR_SOURCE);
    },
  };
}
