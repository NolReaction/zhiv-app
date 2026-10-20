import type { BackgroundLayerSpecification, ExpressionSpecification, FillLayerSpecification, LngLat, Map as LibreMap, Marker, PointLike } from "maplibre-gl";
import styles from "./globe-ocean.module.css";

export const EARTH_OCEAN_MATERIAL_IMAGE = "earth-soft-ocean-v1";
export const EARTH_OCEAN_MATERIAL_SIZE = 128;
export const EARTH_OCEAN_MATERIAL_MAX_ZOOM = 8;
const textureInterval = 250;
const rippleDuration = 1_600;
const maxRipples = 3;
const tau = Math.PI * 2;
type OceanImage = { width: number; height: number; data: Uint8Array };

/** Periodic currents and soft crests, not geographic bathymetry. */
function paintOceanImage(image: OceanImage, timestamp: number): void {
  const phase = timestamp % 48_000 / 48_000 * tau;
  for (let y = 0; y < image.height; y += 1) {
    const v = y / image.height * tau;
    for (let x = 0; x < image.width; x += 1) {
      const u = x / image.width * tau;
      const depth = Math.sin(u + 0.8 * Math.sin(v)) * 0.55 + Math.cos(2 * v - u) * 0.25 + Math.sin(2 * u + v) * 0.2;
      const crest = Math.max(0, Math.sin(3 * v + u + 0.55 * Math.sin(2 * u - v) - phase)) ** 8;
      const crossing = Math.max(0, Math.sin(5 * v - 2 * u + 0.35 * Math.sin(u + v) + phase * 2)) ** 12;
      const light = Math.min(1, crest * 0.85 + crossing * 0.3);
      const index = (y * image.width + x) * 4;
      image.data[index] = Math.round(42 + depth * 16 + light * 154);
      image.data[index + 1] = Math.round(137 + depth * 18 + light * 100);
      image.data[index + 2] = Math.round(164 + depth * 13 + light * 63);
      image.data[index + 3] = 46;
    }
  }
}

/** One independent 64 KiB, seamless RGBA pattern; no canvas or network asset. */
export function createEarthOceanMaterialImage(timestamp = 0): OceanImage {
  const image = { width: EARTH_OCEAN_MATERIAL_SIZE, height: EARTH_OCEAN_MATERIAL_SIZE,
    data: new Uint8Array(EARTH_OCEAN_MATERIAL_SIZE ** 2 * 4) };
  paintOceanImage(image, Number.isFinite(timestamp) ? timestamp : 0);
  return image;
}

export function registerEarthOceanMaterialImage(map: Pick<LibreMap, "hasImage" | "addImage">): void {
  if (!map.hasImage(EARTH_OCEAN_MATERIAL_IMAGE)) {
    map.addImage(EARTH_OCEAN_MATERIAL_IMAGE, createEarthOceanMaterialImage(), { pixelRatio: 1 });
  }
}

function oceanOpacity(): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], 0, 0.68, 3, 0.68, 5, 0.5, EARTH_OCEAN_MATERIAL_MAX_ZOOM, 0];
}

/** Place after the ocean colour and before land, so the globe itself masks space. */
export function earthOceanBackgroundLayer(): BackgroundLayerSpecification {
  return { id: "earth-ocean-material", type: "background", maxzoom: EARTH_OCEAN_MATERIAL_MAX_ZOOM,
    paint: { "background-pattern": EARTH_OCEAN_MATERIAL_IMAGE, "background-opacity": oceanOpacity() } };
}

/** Place immediately after the matching lake/water fill to preserve its coastline. */
export function earthOceanWaterLayer(id: string, source: string, sourceLayer?: string,
  filter?: FillLayerSpecification["filter"]): FillLayerSpecification {
  return { id, type: "fill", source, ...(sourceLayer ? { "source-layer": sourceLayer, minzoom: 4 } : {}),
    ...(filter ? { filter } : {}), maxzoom: EARTH_OCEAN_MATERIAL_MAX_ZOOM,
    paint: { "fill-pattern": EARTH_OCEAN_MATERIAL_IMAGE, "fill-opacity": oceanOpacity(), "fill-antialias": false } };
}

const surfaceLayers = ["earth-water", "earth-overview-lakes", "earth-fallback-lakes", "earth-fallback-ice", "earth-land", "earth-overview-ice",
  "earth-detail-land", "earth-landcover", "earth-neighborhoods", "earth-parks", "earth-buildings"];
const waterLayers = new Set(["earth-water", "earth-overview-lakes", "earth-fallback-lakes"]);
type SurfaceMap = Pick<LibreMap, "project" | "unproject" | "getLayer" | "queryRenderedFeatures">;

/** Background water has no feature; a visible land/ice fill always wins above it. */
export function earthOceanPoint(map: SurfaceMap, point: PointLike): LngLat | null {
  const x = Array.isArray(point) ? point[0] : point.x;
  const y = Array.isArray(point) ? point[1] : point.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const location = map.unproject(point);
  const projected = map.project(location);
  // Globe unproject clamps a point in space to its horizon. Reject that mismatch.
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || Math.hypot(projected.x - x, projected.y - y) > 2) return null;
  const layers = surfaceLayers.filter(id => map.getLayer(id));
  if (!layers.length) return null;
  const top = map.queryRenderedFeatures(point, { layers })[0];
  return !top || waterLayers.has(top.layer.id) ? location : null;
}

type Ripple = { marker: Marker; rings: HTMLSpanElement[]; started: number };

function paintRipple(ripple: Ripple, elapsed: number): void {
  for (let index = 0; index < ripple.rings.length; index += 1) {
    const progress = Math.max(0, (elapsed - index * 180) / rippleDuration);
    const ring = ripple.rings[index];
    ring.style.transform = `scale(${0.15 + Math.min(1, progress) * (index ? 0.85 : 1.05)})`;
    ring.style.opacity = String(elapsed < index * 180 ? 0 : Math.max(0, 1 - progress) ** 2 * (index ? 0.5 : 0.7));
  }
}

/**
 * Driven only by the shared Earth clock. Enable after initial readiness and
 * disable while hidden, reduced-motion or outside overview zooms.
 */
export function createEarthOceanMotion(map: LibreMap, MarkerConstructor: typeof Marker) {
  const image = createEarthOceanMaterialImage();
  const ripples: Ripple[] = [];
  let enabled = false;
  let disposed = false;
  let lastUpload = -Infinity;
  let lastRipple = -Infinity;
  const clearRipples = () => { for (const ripple of ripples) ripple.marker.remove(); ripples.length = 0; };

  return {
    setEnabled(value: boolean) {
      if (disposed) return;
      enabled = value;
      if (!value) clearRipples();
    },
    update(timestamp: number) {
      if (!enabled || disposed || !Number.isFinite(timestamp)) return;
      if (map.getZoom() >= EARTH_OCEAN_MATERIAL_MAX_ZOOM) { clearRipples(); return; }
      for (let index = ripples.length - 1; index >= 0; index -= 1) {
        const ripple = ripples[index];
        const elapsed = Math.max(0, timestamp - ripple.started);
        if (elapsed >= rippleDuration) { ripple.marker.remove(); ripples.splice(index, 1); }
        else paintRipple(ripple, elapsed);
      }
      if (timestamp - lastUpload < textureInterval || !map.hasImage(EARTH_OCEAN_MATERIAL_IMAGE)) return;
      paintOceanImage(image, timestamp);
      map.updateImage(EARTH_OCEAN_MATERIAL_IMAGE, image);
      lastUpload = timestamp;
      // SDK 6.15 updates the existing atlas image without dirtying tile sources.
      map.triggerRepaint();
    },
    ripple(point: PointLike, timestamp = performance.now()): boolean {
      if (!enabled || disposed || !Number.isFinite(timestamp) || map.getZoom() >= EARTH_OCEAN_MATERIAL_MAX_ZOOM || timestamp - lastRipple < 280) return false;
      const location = earthOceanPoint(map, point);
      if (!location) return false;
      const element = document.createElement("div");
      element.className = styles.ripple;
      element.setAttribute("aria-hidden", "true");
      const rings = [document.createElement("span"), document.createElement("span")];
      for (const ring of rings) { ring.className = styles.ring; element.append(ring); }
      const marker = new MarkerConstructor({ element, anchor: "center", pitchAlignment: "map", rotationAlignment: "map",
        subpixelPositioning: true, opacityWhenCovered: 0 }).setLngLat(location).addTo(map);
      const ripple = { marker, rings, started: timestamp };
      paintRipple(ripple, 0);
      if (ripples.length >= maxRipples) ripples.shift()?.marker.remove();
      ripples.push(ripple);
      lastRipple = timestamp;
      return true;
    },
    dispose() { disposed = true; enabled = false; clearRipples(); },
  };
}
