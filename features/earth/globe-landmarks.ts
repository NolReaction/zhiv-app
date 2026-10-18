import type { Map as LibreMap, Marker } from "maplibre-gl";
import { EARTH_LANDMARKS, type EarthLandmark, type EarthLandmarkKind } from "./landmark-catalog";
import { earthEuropeLandmarkArt } from "./landmark-art-europe";
import { earthWorldLandmarkArt } from "./landmark-art-world";
import { EARTH_LANDMARK_HEIGHT, earthLandmarkView, layoutEarthLandmarks } from "./landmark-layout";
import styles from "./globe-landmarks.module.css";

type LandmarkEntry = {
  landmark: EarthLandmark;
  element: HTMLButtonElement;
  visual: HTMLSpanElement;
  label: HTMLSpanElement;
  marker: Marker;
  removeListeners: () => void;
};

// Measured SVG geometry in the shared viewBox, before a 1.5-unit stroke margin.
// Update alongside the drawings: transparent canvas margins must not hide a
// neighbouring monument. These bounds affect collision only, never map anchors.
const inkBounds: Record<EarthLandmarkKind, readonly [number, number, number, number]> = {
  "giza-pyramids": [3, 26, 92, 86],
  "eiffel-tower": [14, 5, 72, 110],
  colosseum: [6, 25, 88, 94.701],
  "saint-basils": [7, 2, 86, 114],
  "taj-mahal": [5, 15.4, 90, 96.6],
  "great-wall": [5, 39.4, 92, 72.6],
  "statue-of-liberty": [9, 6, 82, 106],
  "christ-redeemer": [8, 23.5, 84, 88.5],
  "sydney-opera": [5, 20, 91, 92],
};

/** Original local illustrations, geographically anchored; no model/texture fetches. */
export function createEarthLandmarks(map: LibreMap, MarkerConstructor: typeof Marker) {
  const owner = map.getContainer().ownerDocument;
  const entries: LandmarkEntry[] = [];
  let visible = false;
  let disposed = false;
  let selectedId: string | null = null;
  let focusedId: string | null = null;
  let lastScale = -1;
  let lastOpacity = -1;
  const Observer = owner.defaultView?.MutationObserver;
  const coverageObserver = Observer ? new Observer(() => reconcile()) : null;

  function updateLabels() {
    for (const { landmark, element, label } of entries) {
      const open = !element.disabled && (selectedId === landmark.id || focusedId === landmark.id);
      label.hidden = !open;
      if (open) {
        const container = map.getContainer();
        const point = map.project([...landmark.location]);
        const halfWidth = Math.min(190, Math.max(0, container.clientWidth - 16)) / 2;
        const center = Math.max(halfWidth + 8, Math.min(container.clientWidth - halfWidth - 8, point.x));
        label.style.setProperty("--landmark-label-shift", `${center - point.x}px`);
        label.style.maxWidth = `${halfWidth * 2}px`;
        const unit = earthLandmarkView(map.getZoom()).scale * EARTH_LANDMARK_HEIGHT / 120;
        const inkHeight = (112 - inkBounds[landmark.kind][1] + 1.5) * unit;
        label.dataset.placement = point.y < inkHeight + 45 ? "below" : "above";
      }
      element.setAttribute("aria-expanded", String(open));
      element.dataset.selected = String(open);
    }
  }
  function closeLabels() {
    if (selectedId === null && focusedId === null) return;
    selectedId = null;
    focusedId = null;
    updateLabels();
  }
  function reconcile() {
    if (disposed) return;
    const view = earthLandmarkView(map.getZoom());
    const container = map.getContainer();
    const candidates = entries.map(({ landmark, element }, index) => {
      const point = map.project([...landmark.location]);
      const [x, y, width, height] = inkBounds[landmark.kind];
      const unit = view.scale * EARTH_LANDMARK_HEIGHT / 120;
      return { id: landmark.id, x: point.x + (x + width / 2 - 50) * unit,
        y: point.y + (y + height - 112 + 1.5) * unit,
        width: (width + 3) * unit, height: (height + 3) * unit, priority: entries.length - index,
        covered: element.classList.contains("maplibregl-marker-covered") };
    });
    const shown = visible ? layoutEarthLandmarks(candidates,
      { width: container.clientWidth, height: container.clientHeight }, view) : new Set<string>();
    for (const { landmark, element, visual } of entries) {
      const display = shown.has(landmark.id);
      element.style.display = display ? "" : "none";
      element.disabled = !display;
      element.tabIndex = display ? 0 : -1;
      element.setAttribute("aria-hidden", String(!display));
      if (view.scale !== lastScale) {
        element.style.setProperty("--landmark-scale", String(view.scale));
        element.style.setProperty("--landmark-label-height", `${(112 - inkBounds[landmark.kind][1] + 1.5) * view.scale * EARTH_LANDMARK_HEIGHT / 120}px`);
      }
      if (view.opacity !== lastOpacity) visual.style.opacity = String(view.opacity);
      if (!display) {
        if (selectedId === landmark.id) selectedId = null;
        if (focusedId === landmark.id) focusedId = null;
      }
    }
    lastScale = view.scale;
    lastOpacity = view.opacity;
    updateLabels();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    coverageObserver?.disconnect();
    map.off("move", reconcile);
    map.off("resize", reconcile);
    map.off("idle", reconcile);
    map.off("movestart", closeLabels);
    map.off("click", closeLabels);
    for (const { marker, removeListeners } of entries) {
      removeListeners();
      marker.remove();
    }
    entries.length = 0;
  }

  try {
    for (const landmark of EARTH_LANDMARKS) {
      const art = earthEuropeLandmarkArt(landmark.kind) ?? earthWorldLandmarkArt(landmark.kind);
      if (!art) throw new Error(`Missing Earth landmark artwork: ${landmark.id}`);
      const element = owner.createElement("button");
      element.type = "button";
      element.className = styles.marker;
      element.dataset.earthLandmark = landmark.id;
      element.setAttribute("aria-label", landmark.nameRussian);
      element.setAttribute("aria-controls", `earth-landmark-label-${landmark.id}`);
      element.setAttribute("aria-expanded", "false");
      element.setAttribute("aria-hidden", "true");
      element.disabled = true;
      element.tabIndex = -1;
      element.style.display = "none";
      const visual = owner.createElement("span");
      visual.className = styles.visual;
      const svg = owner.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 120");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      // Markup is exclusively our constant path artwork, never catalog/user HTML.
      svg.innerHTML = art;
      visual.append(svg);
      const label = owner.createElement("span");
      label.className = styles.label;
      label.id = `earth-landmark-label-${landmark.id}`;
      label.textContent = landmark.nameRussian;
      label.hidden = true;
      element.append(visual, label);

      const stopPointer = (event: Event) => event.stopPropagation();
      const onClick = (event: Event) => {
        event.stopPropagation();
        if (element.disabled) return;
        focusedId = null;
        selectedId = selectedId === landmark.id ? null : landmark.id;
        updateLabels();
      };
      const onFocus = () => { if (!element.disabled) { selectedId = null; focusedId = landmark.id; updateLabels(); } };
      const onBlur = () => { if (focusedId === landmark.id) { focusedId = null; updateLabels(); } };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") { event.stopPropagation(); closeLabels(); }
        else if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      };
      element.addEventListener("click", onClick);
      element.addEventListener("pointerdown", stopPointer);
      element.addEventListener("mousedown", stopPointer);
      element.addEventListener("touchstart", stopPointer, { passive: true });
      element.addEventListener("focus", onFocus);
      element.addEventListener("blur", onBlur);
      element.addEventListener("keydown", onKeyDown);
      const marker = new MarkerConstructor({ element, anchor: "bottom", pitchAlignment: "viewport",
        rotationAlignment: "viewport", subpixelPositioning: true, opacityWhenCovered: 0 });
      entries.push({ landmark, element, visual, label, marker, removeListeners() {
        element.removeEventListener("click", onClick);
        element.removeEventListener("pointerdown", stopPointer);
        element.removeEventListener("mousedown", stopPointer);
        element.removeEventListener("touchstart", stopPointer);
        element.removeEventListener("focus", onFocus);
        element.removeEventListener("blur", onBlur);
        element.removeEventListener("keydown", onKeyDown);
      } });
      marker.setLngLat([...landmark.location]).addTo(map);
      coverageObserver?.observe(element, { attributes: true, attributeFilter: ["class"] });
    }
    map.on("move", reconcile);
    map.on("resize", reconcile);
    map.on("idle", reconcile);
    map.on("movestart", closeLabels);
    map.on("click", closeLabels);
    reconcile();
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value;
      if (!value) closeLabels();
      reconcile();
    },
    dispose,
  };
}
