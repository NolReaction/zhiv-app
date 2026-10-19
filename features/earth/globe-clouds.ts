import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { earthCloudBankPixels, earthCloudSeed } from "./cloud-art";
import styles from "./globe-clouds.module.css";

export type EarthClouds = {
  update(elapsedMs: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
};
export const EARTH_DECORATIVE_CLOUD_COUNT = 5;
const FADE_START_ZOOM = 2.5, HIDDEN_ZOOM = 4.2;
const DISTANT_HIDDEN_ZOOM = -.2, DISTANT_VISIBLE_ZOOM = .6;
const POSITION_INTERVAL_MS = 125;
// Original overview atmosphere, deliberately separate from forecast weather.
const CLOUDS = [
  { longitude: -28, latitude: 31, width: 148, speed: .035, phase: .3, tilt: -19 },
  { longitude: 42, latitude: 57, width: 124, speed: .025, phase: 2.1, tilt: 14 },
  { longitude: 112, latitude: -24, width: 164, speed: .04, phase: 4.2, tilt: -8 },
  { longitude: -109, latitude: 13, width: 136, speed: .03, phase: 3.7, tilt: 21 },
  { longitude: -72, latitude: -46, width: 118, speed: .024, phase: 5.4, tilt: -15 },
] as const;

function createCloudElement(owner: Document, index: number) {
  const cloud = CLOUDS[index], element = owner.createElement("div");
  element.className = styles.marker; element.dataset.earthCloud = "decorative";
  element.setAttribute("aria-hidden", "true"); element.style.pointerEvents = "none";
  element.style.width = `${cloud.width}px`; element.style.height = `${cloud.width * .56}px`;
  const visual = owner.createElement("div"); visual.className = styles.visual;
  const bank = owner.createElement("canvas"); bank.width = 256; bank.height = 128; bank.className = styles.bank;
  const context = bank.getContext("2d");
  if (context) {
    const image = context.createImageData(bank.width, bank.height);
    image.data.set(earthCloudBankPixels(earthCloudSeed(`earth-overview-bank-${index}`), bank.width, bank.height));
    context.putImageData(image, 0, 0);
  }
  bank.style.transform = `rotate(${cloud.tilt}deg)`;
  visual.append(bank); element.append(visual);
  return { element, visual, bank };
}

/** Five soft unique banks; SDK owns globe occlusion, projection and outer opacity. */
export function createEarthClouds(map: MapLibreMap, MarkerConstructor: typeof Marker): EarthClouds {
  const owner = map.getContainer().ownerDocument;
  const clouds: Array<ReturnType<typeof createCloudElement> & { marker: Marker }> = [];
  let visible = true, disposed = false, attached = false, drawing = false;
  let elapsedMs = 0, lastPositionStep = -1, lastOpacity = -1;
  function updatePositions() {
    if (!drawing || disposed) return;
    const step = Math.floor(elapsedMs / POSITION_INTERVAL_MS);
    if (step === lastPositionStep) return;
    lastPositionStep = step;
    const seconds = step * POSITION_INTERVAL_MS / 1000;
    for (const [index, { marker, bank }] of clouds.entries()) {
      const cloud = CLOUDS[index];
      const longitude = ((cloud.longitude + seconds * cloud.speed + 180) % 360 + 360) % 360 - 180;
      marker.setLngLat([longitude, cloud.latitude]);
      bank.style.transform = `translateY(${(Math.sin(seconds / 17 + cloud.phase) * .8).toFixed(2)}px) rotate(${cloud.tilt}deg)`;
    }
  }
  function updateVisibility() {
    if (disposed) return;
    const zoom = map.getZoom();
    const progress = Math.min(1, Math.max(0, (zoom - FADE_START_ZOOM) / (HIDDEN_ZOOM - FADE_START_ZOOM)));
    const approach = Math.min(1, Math.max(0, (zoom - DISTANT_HIDDEN_ZOOM) / (DISTANT_VISIBLE_ZOOM - DISTANT_HIDDEN_ZOOM)));
    const opacity = visible && Number.isFinite(progress) && Number.isFinite(approach)
      ? (1 - progress * progress * (3 - 2 * progress)) * approach * approach * (3 - 2 * approach) : 0;
    const wasDrawing = drawing; drawing = opacity > 0;
    if (opacity !== lastOpacity) {
      lastOpacity = opacity;
      for (const { element, visual } of clouds) { element.style.display = drawing ? "" : "none"; visual.style.opacity = String(opacity); }
    }
    if (drawing && !wasDrawing) { lastPositionStep = -1; updatePositions(); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (attached) map.off("zoom", updateVisibility);
    for (const { marker, bank } of clouds) { marker.remove(); bank.width = 1; bank.height = 1; }
    clouds.length = 0;
  }
  try {
    for (const [index, cloud] of CLOUDS.entries()) {
      const elements = createCloudElement(owner, index);
      const marker = new MarkerConstructor({ element: elements.element, anchor: "center", draggable: false,
        pitchAlignment: "viewport", rotationAlignment: "viewport", opacityWhenCovered: 0, subpixelPositioning: true });
      clouds.push({ ...elements, marker }); marker.setLngLat([cloud.longitude, cloud.latitude]).addTo(map);
    }
    map.on("zoom", updateVisibility); attached = true; updateVisibility();
  } catch (error) { dispose(); throw error; }
  return {
    update(value) { if (disposed || !Number.isFinite(value) || value < 0) return; elapsedMs = value; updatePositions(); },
    setVisible(value) { if (disposed || visible === value) return; visible = value; updateVisibility(); },
    dispose,
  };
}
