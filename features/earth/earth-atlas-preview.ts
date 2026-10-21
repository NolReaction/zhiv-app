import { earthAtlasCandidate, earthAtlasEntry, type EarthAtlasView } from "./earth-atlas";
import { EARTH_MODEL_PREVIEW_MIN_ZOOM } from "./landmark-model-view";

export type EarthAtlasPreview = Readonly<{
  entryId: string;
  requestId: number;
  status: "moving" | "loading" | "ready" | "away" | "unavailable";
}>;
export type EarthAtlasPreviewInput = Readonly<{
  entryId: string;
  requestId: number;
  view: EarthAtlasView | null;
  moving: boolean;
  mapReady: boolean;
  targetVisible: boolean;
  modelDrawn: boolean;
  modelFailed?: boolean;
  /** Internal minimum derived from this request's fitted model and free viewport. */
  minimumZoom?: number;
}>;
export const EARTH_ATLAS_LANDMARK_PREVIEW_MIN_ZOOM = 15.6;

/** A transient view of a canonical catalogue entry, never a visit or a save.
 * Camera arrival alone cannot make a landmark ready: the map supplies evidence
 * from its actual renderer and the unobscured viewport after the current frame.
 */
export function evaluateEarthAtlasPreview(input: EarthAtlasPreviewInput): EarthAtlasPreview {
  const { entryId, requestId, view } = input;
  const entry = earthAtlasEntry(entryId);
  const result = (status: EarthAtlasPreview["status"]): EarthAtlasPreview => Object.freeze({ entryId, requestId, status });
  if (!entry || entry.kind === "meeting" || !entry.center || entry.zoom === null
    || !Number.isSafeInteger(requestId) || requestId < 1) return result("unavailable");
  if (input.moving) return result("moving");
  if (!view) return result("loading");
  if (!Number.isFinite(view.zoom) || !view.center.every(Number.isFinite) || Math.abs(view.center[1]) > 90) return result("unavailable");
  const requestedMinimum = Number.isFinite(input.minimumZoom) ? input.minimumZoom! : EARTH_ATLAS_LANDMARK_PREVIEW_MIN_ZOOM;
  const minimumZoom = entry.kind === "landmark"
    ? Math.max(EARTH_MODEL_PREVIEW_MIN_ZOOM, Math.min(EARTH_ATLAS_LANDMARK_PREVIEW_MIN_ZOOM, requestedMinimum)) : 2.2;
  if (view.zoom < minimumZoom || earthAtlasCandidate(view)?.id !== entryId || !input.targetVisible) return result("away");
  if (!input.mapReady) return result("loading");
  if (entry.kind === "landmark" && !input.modelDrawn) return result(input.modelFailed ? "unavailable" : "loading");
  // A successfully drawn procedural fallback is still a meaningful preview,
  // even if an optional imported asset failed to load.
  return result("ready");
}
