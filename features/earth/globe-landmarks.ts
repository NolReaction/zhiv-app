import type { Map as LibreMap, Marker } from "maplibre-gl";
import { EARTH_LANDMARKS, type EarthLandmark } from "./landmark-catalog";
import { EARTH_LANDMARK_HEIGHT, earthLandmarkView, layoutEarthLandmarks } from "./landmark-layout";
import { createEarthLandmarkMeshLayer, EARTH_LANDMARK_MESH_LAYER } from "./landmark-mesh-layer";
import { earthEiffelStreetOpacity, isEarthEiffelNearBounds, isEarthEiffelStreetZoom } from "./landmark-model-view";
import type { EarthModelEnvironment } from "./landmark-model";
import { getEarthModelPlacements, subscribeEarthModelPlacements } from "./model-placement";
import { createEarthBuildingModelMask } from "./building-model-mask";
import styles from "./globe-landmarks.module.css";

type LandmarkEntry = {
  landmark: EarthLandmark;
  element: HTMLButtonElement;
  visual: HTMLSpanElement;
  label: HTMLSpanElement;
  marker: Marker;
  location: readonly [number, number];
  removeListeners: () => void;
};

/** Native 3D meshes share the map depth/projection; buttons only provide labels. */
export function createEarthLandmarks(map: LibreMap, MarkerConstructor: typeof Marker, options: {
  modelEnvironment?: EarthModelEnvironment | null;
} = {}) {
  const owner = map.getContainer().ownerDocument;
  const entries: LandmarkEntry[] = [];
  const buildingMask = createEarthBuildingModelMask(map);
  const models = createEarthLandmarkMeshLayer(map, { onModelChange: () => reconcile(), environment: options.modelEnvironment });
  let visible = false;
  let buildingsEnabled = true;
  let disposed = false;
  let selectedId: string | null = null;
  let focusedId: string | null = null;
  let lastScale = -1;
  let lastOpacity = -1;
  const Observer = owner.defaultView?.MutationObserver;
  const coverageObserver = Observer ? new Observer(() => reconcile()) : null;

  function updateLabels() {
    for (const { landmark, element, label, location } of entries) {
      const open = !element.disabled && (selectedId === landmark.id || focusedId === landmark.id);
      label.hidden = !open;
      if (open) {
        const container = map.getContainer();
        const point = map.project([...location]);
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
    const zoom = map.getZoom();
    const street = isEarthEiffelStreetZoom(zoom);
    const view = street ? { ...earthLandmarkView(zoom), scale: 1, opacity: earthEiffelStreetOpacity(zoom) }
      : earthLandmarkView(zoom);
    const container = map.getContainer();
    const placements = getEarthModelPlacements();
    const placementById = new Map(placements.map(placement => [placement.id, placement]));
    const candidates = entries.map(entry => {
      const placement = placementById.get(entry.landmark.id);
      const location = placement ? [placement.longitude, placement.latitude] as const : entry.landmark.location;
      if (location[0] !== entry.location[0] || location[1] !== entry.location[1]) {
        entry.location = location;
        entry.marker.setLngLat([...location]);
      }
      return entry;
    }).map(({ landmark, element, location }, index) => {
      const point = map.project([...location]);
      // A radial 3D model can rise in any screen direction around its ground
      // point. Symmetric bounds prevent collisions while rotating the globe.
      return { id: landmark.id, x: point.x,
        y: point.y + view.height * 0.65,
        width: view.width * 1.3, height: view.height * 1.3, priority: entries.length - index,
        covered: element.classList.contains("maplibregl-marker-covered") };
    });
    const desired = new Set<string>();
    const shown = visible && !street ? layoutEarthLandmarks(candidates,
      { width: container.clientWidth, height: container.clientHeight }, view) : new Set<string>();
    if (visible && street && buildingsEnabled) {
      for (const placement of placements) {
        const tower = entries.find(entry => entry.landmark.id === placement.id);
        if (!tower || tower.element.classList.contains("maplibregl-marker-covered")) continue;
        const point = map.project([...tower.location]);
        let nearby = false;
        if (typeof map.getBounds === "function") {
          const bounds = map.getBounds();
          nearby = isEarthEiffelNearBounds(tower.location, {
            west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth(),
          }, { width: container.clientWidth, height: container.clientHeight, pitch: map.getPitch(),
            verticalFieldOfView: map.getVerticalFieldOfView(), padding: map.getPadding() }, placement.heightMeters, placement.elevationMeters);
        } else {
          // Compatibility with minimal map adapters: require a near screen
          // point and an independent front-side ground intersection.
          const radius = (placement.heightMeters + Math.abs(placement.elevationMeters)) * 512 * 2 ** zoom
            / (40_030_228.884 * Math.cos(tower.location[1] * Math.PI / 180));
          nearby = Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(radius)
            && point.x >= -radius && point.x <= container.clientWidth + radius
            && point.y >= -radius && point.y <= container.clientHeight + radius;
          try {
            const ground = nearby ? map.unproject([point.x, point.y]) : null;
            const longitudeError = ground ? Math.abs(((ground.lng - tower.location[0] + 180) % 360 + 360) % 360 - 180) : Infinity;
            nearby = !!ground && Number.isFinite(ground.lat) && longitudeError < .001
              && Math.abs(ground.lat - tower.location[1]) < .001;
          } catch { nearby = false; }
        }
        if (nearby) {
          desired.add(tower.landmark.id);
          // Loading does not create an invisible keyboard target. Keep the
          // button near the actual base, even when the visible roof is off-axis.
          if (models.isImportedModelReady(tower.landmark.id, "detail") && view.opacity > 0 && point.x >= 0
            && point.x <= container.clientWidth && point.y >= 0 && point.y <= container.clientHeight) shown.add(tower.landmark.id);
        }
      }
    }
    models.setVisible(visible, street ? desired : shown);
    buildingMask.setPlacements(placements, models.getActiveStreetModelIds());
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
    unsubscribePlacements();
    coverageObserver?.disconnect();
    buildingMask.dispose();
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
  const unsubscribePlacements = subscribeEarthModelPlacements(reconcile);

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
      const placement = getEarthModelPlacements().find(placement => placement.id === landmark.id);
      const location = placement ? [placement.longitude, placement.latitude] as const : landmark.location;
      entries.push({ landmark, element, visual, label, marker, location, removeListeners() {
        element.removeEventListener("click", onClick);
        element.removeEventListener("pointerdown", stopPointer);
        element.removeEventListener("mousedown", stopPointer);
        element.removeEventListener("touchstart", stopPointer);
        element.removeEventListener("focus", onFocus);
        element.removeEventListener("blur", onBlur);
        element.removeEventListener("keydown", onKeyDown);
      } });
      marker.setLngLat([...location]).addTo(map);
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
    setBuildingsEnabled(value: boolean) {
      if (disposed || buildingsEnabled === value) return;
      buildingsEnabled = value;
      reconcile();
    },
    dispose,
  };
}
