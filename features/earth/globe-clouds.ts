import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import styles from "./globe-clouds.module.css";

export type EarthClouds = {
  /** Absolute scene time supplied by the map's shared, pausable motion clock. */
  update(elapsedMs: number): void;
  /** Visibility only: this never starts a clock or changes reduced-motion policy. */
  setVisible(visible: boolean): void;
  dispose(): void;
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const FADE_START_ZOOM = 2.5;
const HIDDEN_ZOOM = 4.2;
const DISTANT_HIDDEN_ZOOM = -0.2;
const DISTANT_VISIBLE_ZOOM = 0.6;
const POSITION_INTERVAL_MS = 100;

// Original vector puffs, not weather data. A small fixed population gives the
// overview some life without adding map sources, images, workers or requests.
const CLOUDS = [
  { longitude: -28, latitude: 31, width: 40, speed: 0.13, phase: 0.3, tilt: -5 },
  { longitude: 42, latitude: 57, width: 34, speed: 0.10, phase: 2.1, tilt: 4 },
  { longitude: 78, latitude: 4, width: 44, speed: 0.16, phase: 4.2, tilt: -3 },
  { longitude: 12, latitude: -32, width: 32, speed: 0.12, phase: 1.6, tilt: 6 },
  { longitude: -109, latitude: 13, width: 46, speed: 0.14, phase: 3.7, tilt: 3 },
  { longitude: -78, latitude: -46, width: 36, speed: 0.09, phase: 5.4, tilt: -4 },
  { longitude: 146, latitude: 43, width: 38, speed: 0.11, phase: 0.9, tilt: -6 },
  { longitude: 166, latitude: -23, width: 42, speed: 0.15, phase: 2.8, tilt: 5 },
] as const;

const PUFF_PATHS = [
  "M18 46C9 46 4 41 4 34C4 27 10 22 17 22C17 13 24 7 33 7C42 7 48 13 49 20C53 15 59 13 65 15C72 17 76 22 77 28C84 26 92 31 92 38C92 43 88 47 81 47Z",
  "M17 46C9 46 4 41 5 34C5 27 11 23 18 24C20 17 25 13 32 14C36 5 48 3 56 9C62 13 64 19 63 24C69 19 78 22 80 29C87 29 92 33 92 39C92 44 87 47 80 47Z",
  "M18 46C10 46 5 41 5 35C5 29 10 24 17 24C17 17 23 12 30 12C36 12 40 15 43 20C43 11 51 6 59 8C67 10 71 16 71 23C77 22 82 25 83 30C89 31 92 35 91 40C90 45 86 47 79 47Z",
] as const;

function svgElement<K extends keyof SVGElementTagNameMap>(
  owner: Document,
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const element = owner.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function createCloudElement(owner: Document, index: number) {
  const cloud = CLOUDS[index];
  const element = owner.createElement("div");
  element.className = styles.marker;
  element.setAttribute("aria-hidden", "true");
  element.style.pointerEvents = "none";
  element.style.width = `${cloud.width}px`;
  element.style.height = `${cloud.width * 0.7}px`;

  // Keep the zoom fade inside the SDK element: its own opacity hides clouds on
  // the back of the globe and must never be overwritten by our animation.
  const visual = owner.createElement("div");
  visual.className = styles.visual;
  const shadow = svgElement(owner, "svg", { viewBox: "0 0 96 26", focusable: "false" });
  shadow.setAttribute("class", styles.shadow);
  for (const [rx, ry, opacity] of [[40, 11, 0.035], [32, 8, 0.045], [24, 5, 0.055]]) {
    shadow.append(svgElement(owner, "ellipse", {
      cx: "48", cy: "13", rx: `${rx}`, ry: `${ry}`, fill: "#174a55", opacity: `${opacity}`,
    }));
  }

  const puff = svgElement(owner, "svg", { viewBox: "0 0 96 56", focusable: "false" });
  puff.setAttribute("class", styles.puff);
  puff.style.transform = `rotate(${cloud.tilt}deg)`;
  puff.append(
    svgElement(owner, "path", { d: PUFF_PATHS[index % PUFF_PATHS.length], fill: "#eef7ee" }),
    svgElement(owner, "path", {
      d: "M8 37C20 43 33 40 46 42C62 45 77 40 90 37C92 43 87 47 79 47H18C12 47 8 43 8 37Z",
      fill: "#c8dedb", opacity: "0.72",
    }),
    svgElement(owner, "path", {
      d: index % 3 === 1 ? "M37 15C42 8 52 9 57 16" : index % 3 === 2
        ? "M49 17C54 10 63 12 66 19" : "M23 19C25 12 36 10 42 17",
      fill: "none", stroke: "#ffffff", "stroke-width": "4", "stroke-linecap": "round", opacity: "0.85",
    }),
  );
  visual.append(shadow, puff);
  element.append(visual);
  return { element, visual, puff };
}

/** Lightweight native markers; no timers, animation frames or map-source writes. */
export function createEarthClouds(map: MapLibreMap, MarkerConstructor: typeof Marker): EarthClouds {
  const owner = map.getContainer().ownerDocument;
  const clouds: Array<ReturnType<typeof createCloudElement> & { marker: Marker }> = [];
  let visible = true;
  let disposed = false;
  let zoomListenerAttached = false;
  let elapsedMs = 0;
  let lastPositionStep = -1;
  let lastOpacity = -1;
  let drawing = false;

  const updatePositions = () => {
    if (!drawing || disposed) return;
    const step = Math.floor(elapsedMs / POSITION_INTERVAL_MS);
    if (step === lastPositionStep) return;
    lastPositionStep = step;
    const seconds = step * POSITION_INTERVAL_MS / 1_000;
    clouds.forEach(({ marker, puff }, index) => {
      const cloud = CLOUDS[index];
      const longitude = ((cloud.longitude + seconds * cloud.speed + 180) % 360 + 360) % 360 - 180;
      marker.setLngLat([longitude, cloud.latitude]);
      const lift = Math.sin(seconds / 7 + cloud.phase) * 1.4;
      puff.style.transform = `translateY(${lift.toFixed(2)}px) rotate(${cloud.tilt}deg)`;
    });
  };

  const updateVisibility = () => {
    if (disposed) return;
    const zoom = map.getZoom();
    const progress = Math.min(1, Math.max(0, (zoom - FADE_START_ZOOM) / (HIDDEN_ZOOM - FADE_START_ZOOM)));
    const approach = Math.min(1, Math.max(0, (zoom - DISTANT_HIDDEN_ZOOM) / (DISTANT_VISIBLE_ZOOM - DISTANT_HIDDEN_ZOOM)));
    const opacity = visible && Number.isFinite(progress) && Number.isFinite(approach)
      ? (1 - progress * progress * (3 - 2 * progress)) * approach * approach * (3 - 2 * approach) : 0;
    const wasDrawing = drawing;
    drawing = opacity > 0;
    if (opacity !== lastOpacity) {
      lastOpacity = opacity;
      for (const { element, visual } of clouds) {
        element.style.display = drawing ? "" : "none";
        visual.style.opacity = `${opacity}`;
      }
    }
    if (drawing && !wasDrawing) {
      lastPositionStep = -1;
      updatePositions();
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (zoomListenerAttached) map.off("zoom", updateVisibility);
    for (const { marker } of clouds) marker.remove();
    clouds.length = 0;
  };

  try {
    CLOUDS.forEach((cloud, index) => {
      const elements = createCloudElement(owner, index);
      const marker = new MarkerConstructor({
        element: elements.element,
        anchor: "center",
        draggable: false,
        pitchAlignment: "viewport",
        rotationAlignment: "viewport",
        subpixelPositioning: true,
        opacity: 1,
        opacityWhenCovered: 0,
      });
      // Retain ownership before attachment, so a failed partial setup cleans up.
      clouds.push({ ...elements, marker });
      marker.setLngLat([cloud.longitude, cloud.latitude]).addTo(map);
    });
    updateVisibility();
    // A stopped clock (including reduced motion) still fades on manual zoom.
    map.on("zoom", updateVisibility);
    zoomListenerAttached = true;
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    update(nextElapsedMs) {
      if (disposed || !Number.isFinite(nextElapsedMs) || nextElapsedMs < 0) return;
      elapsedMs = nextElapsedMs;
      updatePositions();
    },
    setVisible(nextVisible) {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      updateVisibility();
    },
    dispose,
  };
}
