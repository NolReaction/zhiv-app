import type { Map as LibreMap, Marker } from "maplibre-gl";
import { EARTH_LANDMARKS, type EarthLandmark } from "./landmark-catalog";
import { EARTH_LANDMARK_HEIGHT, earthLandmarkView, layoutEarthLandmarks } from "./landmark-layout";
import { createEarthLandmarkMeshLayer, EARTH_LANDMARK_MESH_LAYER } from "./landmark-mesh-layer";
import styles from "./globe-landmarks.module.css";

type LandmarkEntry = {
  landmark: EarthLandmark;
  element: HTMLButtonElement;
  visual: HTMLSpanElement;
  label: HTMLSpanElement;
  marker: Marker;
  removeListeners: () => void;
};

/** Native 3D meshes share the map depth/projection; buttons only provide labels. */
export function createEarthLandmarks(map: LibreMap, MarkerConstructor: typeof Marker) {
  const owner = map.getContainer().ownerDocument;
  const entries: LandmarkEntry[] = [];
  const models = createEarthLandmarkMeshLayer(map);
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
        const inkHeight = earthLandmarkView(map.getZoom()).scale * EARTH_LANDMARK_HEIGHT;
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
      // A radial 3D model can rise in any screen direction around its ground
      // point. Symmetric bounds prevent collisions while rotating the globe.
      return { id: landmark.id, x: point.x,
        y: point.y + view.height * 0.65,
        width: view.width * 1.3, height: view.height * 1.3, priority: entries.length - index,
        covered: element.classList.contains("maplibregl-marker-covered") };
    });
    const shown = visible ? layoutEarthLandmarks(candidates,
      { width: container.clientWidth, height: container.clientHeight }, view) : new Set<string>();
    models.setVisible(visible, shown);
    for (const { landmark, element, visual } of entries) {
      const display = shown.has(landmark.id);
      element.style.display = display ? "" : "none";
      element.disabled = !display;
      element.tabIndex = display ? 0 : -1;
      element.setAttribute("aria-hidden", String(!display));
      if (view.scale !== lastScale) {
        element.style.setProperty("--landmark-scale", String(view.scale));
        element.style.setProperty("--landmark-label-height", `${view.scale * EARTH_LANDMARK_HEIGHT / 2}px`);
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
    if (map.getLayer(EARTH_LANDMARK_MESH_LAYER)) map.removeLayer(EARTH_LANDMARK_MESH_LAYER);
    models.dispose();
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
    map.addLayer(models.layer, map.getLayer("earth-evening-shade") ? "earth-evening-shade" : undefined);
    for (const landmark of EARTH_LANDMARKS) {
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
      visual.setAttribute("aria-hidden", "true");
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
      const marker = new MarkerConstructor({ element, anchor: "center", pitchAlignment: "viewport",
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
