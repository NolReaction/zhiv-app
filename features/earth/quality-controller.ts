import type { Map as LibreMap, MapMovementEvent } from "maplibre-gl";
import { createEarthQualityPolicy, type EarthQualityLevel, type EarthQualityProfile } from "./quality-policy";

const ACTIVE_INPUT_TYPES = new Set(["mousemove", "pointermove", "touchmove", "wheel"]);
const MAX_INPUT_AGE_MS = 120;
type QualityOptions = {
  onChange: (level: EarthQualityLevel, profile: EarthQualityProfile) => void;
  now?: () => number;
};

/**
 * Reuses SDK frames with three bounded listeners and no clock/RAF of its own.
 * The scene enables sampling only while ready, foreground and motion is allowed.
 */
export function createEarthQualityController(map: LibreMap, { onChange, now = () => performance.now() }: QualityOptions) {
  const policy = createEarthQualityPolicy(onChange);
  let enabled = false, disposed = false, pendingFrame = false;

  function moving(event: MapMovementEvent) {
    if (!enabled || disposed) return;
    const input = event?.originalEvent;
    const age = input ? now() - input.timeStamp : Infinity;
    // Inertial mouseup/touchend, atlas flyTo, static held pointers and the 8 Hz
    // decorative clock cannot supply fresh input movement and are not measured.
    pendingFrame = !!input && ACTIVE_INPUT_TYPES.has(input.type) && Number.isFinite(age) && age >= -1 && age <= MAX_INPUT_AGE_MS;
    if (!pendingFrame) policy.breakSequence();
  }
  function rendered() {
    if (!enabled || disposed || !pendingFrame) return;
    pendingFrame = false; policy.observeFrame(now());
  }
  function ended() { pendingFrame = false; policy.breakSequence(); }

  map.on("move", moving); map.on("render", rendered); map.on("moveend", ended);
  return {
    getLevel: policy.getLevel,
    setEnabled(value: boolean) {
      if (disposed || enabled === value) return;
      enabled = value; pendingFrame = false; policy.reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false; pendingFrame = false; policy.reset();
      map.off("move", moving); map.off("render", rendered); map.off("moveend", ended);
    },
  };
}
