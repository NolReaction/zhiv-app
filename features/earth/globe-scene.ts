import type { Map as LibreMap, MapMouseEvent, Marker } from "maplibre-gl";
import { createEarthClouds } from "./globe-clouds";
import { createEarthOceanMotion } from "./globe-ocean";
import { createEarthLightingController, type EarthLightingMode } from "./globe-lighting";
import { createEarthSceneClock } from "./scene-clock";
import { createEarthLandmarks } from "./globe-landmarks";

export const EARTH_SCENE_MOTION_MAX_ZOOM = 4.2;

/** All decorative motion belongs to this map, never the app or the GPS watch. */
export function createEarthGlobeScene(map: LibreMap, MarkerConstructor: typeof Marker, mode: EarthLightingMode) {
  const clouds = createEarthClouds(map, MarkerConstructor);
  const ocean = createEarthOceanMotion(map, MarkerConstructor);
  const lighting = createEarthLightingController(map, { mode, center: map.getCenter() });
  const landmarks = createEarthLandmarks(map, MarkerConstructor);
  const motionPreference = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  let ready = false;
  let disposed = false;
  let elapsed = 0;
  const clock = createEarthSceneClock({
    now: () => performance.now(),
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    cancel: handle => window.clearTimeout(handle),
    step: time => {
      elapsed = time;
      clouds.update(time);
      ocean.update(time);
      lighting.update(Date.now());
    },
  });

  function synchronize() {
    if (disposed) return;
    const visible = ready && !document.hidden;
    const animate = visible && !motionPreference?.matches && map.getZoom() < EARTH_SCENE_MOTION_MAX_ZOOM;
    clouds.setVisible(visible);
    landmarks.setVisible(visible);
    ocean.setEnabled(animate);
    clock.setRunning(animate);
    if (visible) lighting.update(Date.now());
  }
  const onClick = (event: MapMouseEvent) => { ocean.ripple(event.point, elapsed); };
  clouds.update(0);
  clouds.setVisible(false);
  map.on("zoom", synchronize);
  map.on("click", onClick);
  document.addEventListener("visibilitychange", synchronize);
  motionPreference?.addEventListener("change", synchronize);

  return {
    setReady(value: boolean) { ready = value; synchronize(); },
    setLighting(value: EarthLightingMode) {
      lighting.setMode(value, map.getCenter());
      synchronize();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clock.dispose();
      map.off("zoom", synchronize);
      map.off("click", onClick);
      document.removeEventListener("visibilitychange", synchronize);
      motionPreference?.removeEventListener("change", synchronize);
      clouds.dispose();
      ocean.dispose();
      lighting.dispose();
      landmarks.dispose();
    },
  };
}
