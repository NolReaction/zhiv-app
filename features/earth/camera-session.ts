import type { EarthLightingCenter, EarthLightingMode } from "./globe-lighting";

export type EarthCameraSnapshot = {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
};

export type EarthMapPreferences = {
  weatherEnabled: boolean;
  lightingMode: EarthLightingMode;
  buildings3d: boolean;
  eveningCenter: EarthLightingCenter | null;
};

const DEFAULT_PREFERENCES: EarthMapPreferences = { weatherEnabled: false, lightingMode: "auto", buildings3d: true, eveningCenter: null };

export type EarthCameraSession = {
  read(): EarthCameraSnapshot | null;
  /** Save a prepared map's camera before releasing its rendering resources. */
  save(camera: EarthCameraSnapshot): void;
  readPreferences(): EarthMapPreferences;
  savePreferences(preferences: EarthMapPreferences): void;
};

function validCamera(camera: EarthCameraSnapshot): boolean {
  return !!camera && Array.isArray(camera.center) && camera.center.length === 2
    && camera.center.every(Number.isFinite) && Math.abs(camera.center[1]) <= 90
    && Number.isFinite(camera.zoom) && camera.zoom >= -1.5 && camera.zoom <= 18
    && Number.isFinite(camera.bearing) && Number.isFinite(camera.pitch) && camera.pitch >= 0 && camera.pitch <= 60;
}

function copy(camera: EarthCameraSnapshot): EarthCameraSnapshot {
  return { center: [...camera.center], zoom: camera.zoom, bearing: camera.bearing, pitch: camera.pitch };
}

/** In-memory camera/settings for one account session; no GPS fix, storage, map or timer. */
export function createEarthCameraSession(owner: string | null) {
  let snapshot: EarthCameraSnapshot | null = null;
  let preferences = { ...DEFAULT_PREFERENCES };
  let active = false;
  let generation = 0;
  const session: EarthCameraSession = {
    read() { return active && snapshot ? copy(snapshot) : null; },
    save(camera) { if (active && validCamera(camera)) snapshot = copy(camera); },
    readPreferences() {
      const value = active ? preferences : DEFAULT_PREFERENCES;
      return { ...value, eveningCenter: value.eveningCenter ? { ...value.eveningCenter } : null };
    },
    savePreferences(value) {
      if (!active || !value || typeof value.weatherEnabled !== "boolean" || typeof value.buildings3d !== "boolean"
        || !["auto", "day", "evening"].includes(value.lightingMode)
        || value.eveningCenter !== null && (!value.eveningCenter || !Number.isFinite(value.eveningCenter.lng)
          || !Number.isFinite(value.eveningCenter.lat) || Math.abs(value.eveningCenter.lat) > 90)) return;
      preferences = { weatherEnabled: value.weatherEnabled, lightingMode: value.lightingMode, buildings3d: value.buildings3d,
        eveningCenter: value.eveningCenter ? { ...value.eveningCenter } : null };
    },
  };
  return {
    session,
    activate() {
      const current = ++generation;
      active = Boolean(owner);
      // A replaced owner's late map cleanup cannot restore its former camera.
      // The generation also makes Strict Mode's old cleanup harmless on replay.
      return () => {
        if (current !== generation) return;
        generation += 1;
        active = false;
        snapshot = null;
        preferences = { ...DEFAULT_PREFERENCES };
      };
    },
  };
}
