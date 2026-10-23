import type { GeoJSONSource, Map as LibreMap, PaddingOptions } from "maplibre-gl";
import type { FeatureCollection, LineString, MultiLineString } from "geojson";
import { type EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";
import { earthLastKnownMeetDetails } from "./meet";
import { canUseEarthWalkingRoute, type EarthWalkingRoute } from "./walking-route";

export const EARTH_MEET_SOURCE = "earth-meet-line";
const HALO = "earth-meet-halo";
const LINE = "earth-meet-dashes";
type MeetingLine = FeatureCollection<LineString | MultiLineString>;
const EMPTY: MeetingLine = { type: "FeatureCollection", features: [] };

type MeetMap = Pick<LibreMap, "getSource" | "addSource" | "removeSource" | "getLayer" | "addLayer" | "removeLayer" | "fitBounds" | "getContainer">;
type Environment = {
  now: () => number;
  wallNow: () => number;
  reducedMotion: () => boolean;
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

/** A direct connection, never a road or walking route. Split at the date line. */
export function earthMeetLine(position: EarthPosition, friend: EarthMapPerson): FeatureCollection<MultiLineString> {
  const start: [number, number] = [position.longitude, position.latitude];
  const delta = ((friend.longitude - position.longitude + 540) % 360) - 180;
  const end: [number, number] = [position.longitude + delta, friend.latitude];
  let coordinates: number[][][] = [[start, end]];
  if (end[0] > 180 || end[0] < -180) {
    const border = end[0] > 180 ? 180 : -180;
    const latitude = start[1] + (end[1] - start[1]) * (border - start[0]) / delta;
    coordinates = [[start, [border, latitude]], [[-border, latitude], [friend.longitude, friend.latitude]]];
  }
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates } }] };
}

/** Preserve every road bend without drawing a long segment across the date line. */
function walkingLine(route: EarthWalkingRoute): MeetingLine {
  const segments: number[][][] = [[]];
  for (const point of route.geometry.coordinates) {
    const current = segments[segments.length - 1];
    const previous = current[current.length - 1];
    if (previous) {
      const delta = ((point[0] - previous[0] + 540) % 360) - 180;
      if (Math.abs(point[0] - previous[0]) > 180) {
        const border = previous[0] > 0 ? 180 : -180;
        const latitude = delta === 0 ? point[1] : previous[1] + (point[1] - previous[1]) * (border - previous[0]) / delta;
        current.push([border, latitude]);
        segments.push([[-border, latitude]]);
      }
    }
    segments[segments.length - 1].push([...point]);
  }
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {},
    geometry: { type: "MultiLineString", coordinates: segments } }] };
}

/** Ephemeral overlay; revoked, expired and backgrounded coordinates are removed. */
export function createEarthMeetMap(map: MeetMap, environment: Environment = {
  now: () => performance.now(), wallNow: () => Date.now(),
  reducedMotion: () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: id => clearTimeout(id),
}) {
  let position: EarthPosition | null = null;
  let friend: EarthMapPerson | null = null;
  let walkingRoute: EarthWalkingRoute | null = null;
  let visible = false;
  let disposed = false;
  let focusRequest = 0;
  let handledFocus = 0;
  let walkingFocusRequest = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cameraPadding: PaddingOptions | null = null;
  let prepareCamera: (() => void) | undefined;
  let writtenSource: GeoJSONSource | null = null;
  let writtenGeometry: string | null = null;

  function cancelTimer() {
    if (timer !== null) environment.clearTimeout(timer);
    timer = null;
  }
  function writeLine(data: MeetingLine, geometry: string | null) {
    const source = map.getSource<GeoJSONSource>(EARTH_MEET_SOURCE);
    if (!source) { writtenSource = null; writtenGeometry = null; return; }
    // Repeated UI snapshots do not change this geometry. Avoid restarting a
    // GeoJSON worker job until the line changes or a new style owns the source.
    if (source === writtenSource && geometry === writtenGeometry) return;
    source.setData(data);
    writtenSource = source;
    writtenGeometry = geometry;
  }
  function clearLine() { writeLine(EMPTY, null); }
  function reconcile() {
    cancelTimer();
    const now = environment.now();
    const wall = environment.wallNow();
    if (disposed || !visible || !position || !friend
      || !earthLastKnownMeetDetails(position, friend, now, wall)) { clearLine(); return; }
    const source = map.getSource<GeoJSONSource>(EARTH_MEET_SOURCE);
    if (!source) return;
    const route = canUseEarthWalkingRoute(walkingRoute, position, friend, now, wall) ? walkingRoute : null;
    const line = route ? walkingLine(route) : earthMeetLine(position, friend);
    writeLine(line, JSON.stringify(line.features[0].geometry));
    if (focusRequest > handledFocus || route && walkingFocusRequest === focusRequest && focusRequest > 0) {
      const delta = ((friend.longitude - position.longitude + 540) % 360) - 180;
      const longitude = position.longitude + delta;
      const originLongitude = position.longitude;
      const points = [[originLongitude, position.latitude], [longitude, friend.latitude], ...(route?.geometry.coordinates ?? []).map(([lng, lat]) => [
        originLongitude + ((lng - originLongitude + 540) % 360) - 180, lat,
      ])];
      const longitudes = points.map(point => point[0]), latitudes = points.map(point => point[1]);
      const container = map.getContainer();
      const width = container.clientWidth, height = container.clientHeight;
      if (width > 0 && height > 0) {
        prepareCamera?.();
        map.fitBounds([[Math.min(...longitudes), Math.min(...latitudes)],
          [Math.max(...longitudes), Math.max(...latitudes)]], {
          padding: cameraPadding ?? { top: Math.min(96, height * .15), bottom: Math.min(290, height * .45), left: Math.min(48, width * .15), right: Math.min(84, width * .25) },
          maxZoom: 15, pitch: 0, bearing: 0, duration: environment.reducedMotion() ? 0 : 900, essential: false,
        });
        handledFocus = focusRequest;
        if (route) walkingFocusRequest = 0;
      }
    }
    const remaining = Math.min(friend.expiresAtMonotonic - now, Date.parse(friend.expiresAt) - wall,
      route ? route.expiresAtMonotonic - now : Infinity, route ? route.expiresAt - wall : Infinity);
    timer = environment.setTimeout(reconcile, Math.max(1, remaining + 1));
  }
  return {
    /** Extra marker clearance inside the map's measured panel padding. */
    setCameraPadding(padding: PaddingOptions, prepare?: () => void) { cameraPadding = { ...padding }; prepareCamera = prepare; },
    install() {
      if (disposed) return;
      if (!map.getSource(EARTH_MEET_SOURCE)) map.addSource(EARTH_MEET_SOURCE, { type: "geojson", data: EMPTY });
      if (!map.getLayer(HALO)) map.addLayer({ id: HALO, type: "line", source: EARTH_MEET_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#f6ffe9", "line-opacity": .9, "line-width": 6 } });
      if (!map.getLayer(LINE)) map.addLayer({ id: LINE, type: "line", source: EARTH_MEET_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#388575", "line-width": 3, "line-dasharray": [1, 2] } });
      reconcile();
    },
    setSnapshot(nextPosition: EarthPosition | null, nextFriend: EarthMapPerson | null, request: number, route: EarthWalkingRoute | null = null) {
      if (disposed || !visible) return;
      position = nextPosition ? { ...nextPosition } : null;
      friend = nextFriend ? { ...nextFriend } : null;
      walkingRoute = route;
      const nextRequest = Number.isSafeInteger(request) && request >= 0 ? request : 0;
      // A manual build first frames the two points, then once more when its road
      // path arrives. Ordinary GPS snapshots and expiry never replay framing.
      if (nextRequest !== focusRequest) walkingFocusRequest = route ? 0 : nextRequest;
      focusRequest = nextRequest;
      reconcile();
    },
    setVisible(value: boolean) {
      if (disposed || visible === value) return;
      visible = value;
      if (!value) {
        position = null; friend = null; walkingRoute = null;
        handledFocus = Math.max(handledFocus, focusRequest); walkingFocusRequest = 0;
      }
      reconcile();
    },
    dispose() {
      if (disposed) return;
      disposed = true; visible = false; position = null; friend = null; walkingRoute = null;
      prepareCamera = undefined;
      cancelTimer(); clearLine();
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getLayer(HALO)) map.removeLayer(HALO);
      if (map.getSource(EARTH_MEET_SOURCE)) map.removeSource(EARTH_MEET_SOURCE);
      writtenSource = null; writtenGeometry = null;
    },
  };
}
