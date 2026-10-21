import type { LineString } from "geojson";
import { EARTH_POSITION_MAX_AGE_MS, type EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";
import { earthMeetDetails } from "./meet";

export const EARTH_WALKING_ROUTE_COOLDOWN_MS = 5_000;
export const EARTH_WALKING_ROUTE_TIMEOUT_MS = 10_000;
const FRIEND_FRESH_MS = 5 * 60_000;
const ROUTE_TTL_MS = 2 * 60_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_POINTS = 10_000;
type Coordinate = [number, number];
export type EarthWalkingRouteEndpoints = { origin: Coordinate; destination: Coordinate };
export type EarthWalkingRouteBinding = EarthWalkingRouteEndpoints & {
  ownerPublicId: string; circleId: string; friendPublicId: string;
  createdAt: number; createdAtMonotonic: number;
  expiresAt: number; expiresAtMonotonic: number;
};
export type EarthWalkingRouteData = { geometry: LineString; distanceMeters: number; durationSeconds: number };
export type EarthWalkingRoute = EarthWalkingRouteBinding & EarthWalkingRouteData;
export type EarthWalkingRouteState = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  route: EarthWalkingRoute | null; error: string | null; canRequest: boolean;
}>;
type ErrorCode = "unavailable" | "no_route" | "rate_limit" | "timeout" | "cancelled" | "invalid_response";
const ERRORS: Record<ErrorCode, string> = {
  unavailable: "Сервис маршрутов недоступен. Попробуйте позже или откройте внешние карты.",
  no_route: "Пеший путь не найден. Попробуйте внешние карты.",
  rate_limit: "Сервис маршрутов занят. Подождите перед новой попыткой.",
  timeout: "Маршрут не успел загрузиться. Попробуйте позже.",
  cancelled: "Построение маршрута отменено.",
  invalid_response: "Не удалось проверить маршрут. Попробуйте внешние карты.",
};
export class EarthWalkingRouteError extends Error {
  constructor(readonly code: ErrorCode) { super(ERRORS[code]); this.name = "EarthWalkingRouteError"; }
}
export const earthWalkingRouteErrorMessage = (error: unknown) => error instanceof EarthWalkingRouteError ? ERRORS[error.code] : ERRORS.unavailable;

function coordinate(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
    && typeof value[1] === "number" && Number.isFinite(value[1]) && Math.abs(value[1]) <= 90;
}
export function earthWalkingDistance(first: Coordinate, second: Coordinate) {
  const rad = Math.PI / 180, a = first[1] * rad, b = second[1] * rad;
  const h = Math.sin((b - a) / 2) ** 2 + Math.cos(a) * Math.cos(b) * Math.sin((second[0] - first[0]) * rad / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
function fresh(position: EarthPosition | null, person: EarthMapPerson | null, monotonicNow: number, wallNow: number) {
  if (!position || !person || !person.circleId || !person.user.publicId || person.precision !== "PRECISE"
    || position.accuracy > 200 || person.accuracyMeters > 200 || wallNow - position.timestamp >= EARTH_POSITION_MAX_AGE_MS
    || wallNow - Date.parse(person.updatedAt) >= FRIEND_FRESH_MS
    || monotonicNow >= friendFreshDeadline(person)) return false;
  return earthMeetDetails(position, person, monotonicNow, wallNow) !== null;
}
// The existing feed's monotonic access deadline is anchored to server time.
// Derive the capture deadline from it, so reopening after clock rollback cannot renew an old fix.
const friendFreshDeadline = (person: EarthMapPerson) => person.expiresAtMonotonic
  - (Date.parse(person.expiresAt) - Date.parse(person.updatedAt)) + FRIEND_FRESH_MS;
/** Same fresh points as the meeting UI, with a modest public-service distance cap. */
export function createEarthWalkingRouteBinding(owner: string | null, position: EarthPosition | null, person: EarthMapPerson | null,
  monotonicNow: number, wallNow: number): EarthWalkingRouteBinding | null {
  if (!owner || !position || !person || !fresh(position, person, monotonicNow, wallNow)) return null;
  const origin: Coordinate = [position.longitude, position.latitude], destination: Coordinate = [person.longitude, person.latitude];
  if (earthWalkingDistance(origin, destination) > 20_000) return null;
  const expiresAt = Math.min(position.timestamp + EARTH_POSITION_MAX_AGE_MS, Date.parse(person.updatedAt) + FRIEND_FRESH_MS,
    Date.parse(person.expiresAt), wallNow + ROUTE_TTL_MS);
  const remaining = Math.min(expiresAt - wallNow, person.expiresAtMonotonic - monotonicNow, friendFreshDeadline(person) - monotonicNow);
  if (!(remaining > 0)) return null;
  return { ownerPublicId: owner, circleId: person.circleId, friendPublicId: person.user.publicId, origin, destination,
    createdAt: wallNow, createdAtMonotonic: monotonicNow, expiresAt, expiresAtMonotonic: monotonicNow + remaining };
}
/** Renderer and controller both reject expired access or a moved endpoint. No refresh. */
export function canUseEarthWalkingRoute(route: EarthWalkingRouteBinding | null, position: EarthPosition | null,
  person: EarthMapPerson | null, monotonicNow: number, wallNow: number): boolean {
  return Boolean(route && position && person && fresh(position, person, monotonicNow, wallNow)
    && route.circleId === person.circleId && route.friendPublicId === person.user.publicId
    && Number.isFinite(route.createdAtMonotonic) && monotonicNow >= route.createdAtMonotonic
    && Number.isFinite(route.expiresAt) && wallNow < route.expiresAt
    && Number.isFinite(route.expiresAtMonotonic) && monotonicNow < route.expiresAtMonotonic
    && coordinate(route.origin) && coordinate(route.destination)
    && earthWalkingDistance(route.origin, [position.longitude, position.latitude]) <= 50
    && earthWalkingDistance(route.destination, [person.longitude, person.latitude]) <= 50);
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Only the route geometry and two numeric totals survive the provider boundary. */
export function parseEarthWalkingRoute(value: unknown, endpoints: EarthWalkingRouteEndpoints): EarthWalkingRouteData {
  const invalid = () => { throw new EarthWalkingRouteError("invalid_response"); };
  if (!object(value)) return invalid();
  if (value.code === "NoRoute" || value.code === "NoSegment") throw new EarthWalkingRouteError("no_route");
  if (value.code !== "Ok" || !Array.isArray(value.routes) || value.routes.length !== 1
    || !Array.isArray(value.waypoints) || value.waypoints.length !== 2) return invalid();
  for (const [index, point] of value.waypoints.entries()) {
    if (!object(point) || !coordinate(point.location) || earthWalkingDistance(point.location, index ? endpoints.destination : endpoints.origin) > 300) return invalid();
  }
  const route = value.routes[0];
  if (!object(route) || typeof route.distance !== "number" || !Number.isFinite(route.distance) || route.distance < 0 || route.distance > 1_000_000
    || typeof route.duration !== "number" || !Number.isFinite(route.duration) || route.duration < 0 || route.duration > 30 * 86400
    || !object(route.geometry) || route.geometry.type !== "LineString" || !Array.isArray(route.geometry.coordinates)
    || route.geometry.coordinates.length < 2 || route.geometry.coordinates.length > MAX_POINTS
    || !route.geometry.coordinates.every(coordinate)) return invalid();
  const points = route.geometry.coordinates as Coordinate[];
  if (earthWalkingDistance(points[0], endpoints.origin) > 300 || earthWalkingDistance(points[points.length - 1], endpoints.destination) > 300) return invalid();
  return { geometry: { type: "LineString", coordinates: points.map(point => [...point]) }, distanceMeters: route.distance, durationSeconds: route.duration };
}

export function earthWalkingRouteUrl(endpoints: EarthWalkingRouteEndpoints) {
  if (!coordinate(endpoints.origin) || !coordinate(endpoints.destination) || earthWalkingDistance(endpoints.origin, endpoints.destination) > 20_000)
    throw new EarthWalkingRouteError("invalid_response");
  const points = [endpoints.origin, endpoints.destination].map(point => point.map(number => number.toFixed(6)).join(",")).join(";");
  return `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${points}?overview=full&geometries=geojson&steps=false&alternatives=false&generate_hints=false`;
}

async function readBody(response: Response, signal: AbortSignal) {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES || !response.body) throw new EarthWalkingRouteError("invalid_response");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new EarthWalkingRouteError("cancelled");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new EarthWalkingRouteError("invalid_response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
}

/** Explicit caller only. Timeout covers fetch AND body; abort wins even if fetch ignores its signal.
 * FOSSGIS usage policy: https://routing.openstreetmap.de/about.html
 * OSRM Route API: https://project-osrm.org/docs/v5.24.0/api/#route-service
 */
export async function fetchEarthWalkingRoute(endpoints: EarthWalkingRouteEndpoints, signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch, timeoutMs = EARTH_WALKING_ROUTE_TIMEOUT_MS): Promise<EarthWalkingRouteData> {
  const url = earthWalkingRouteUrl(endpoints), controller = new AbortController();
  let rejectTermination: (error: EarthWalkingRouteError) => void = () => {};
  const termination = new Promise<never>((_, reject) => { rejectTermination = reject; });
  const stop = (code: "cancelled" | "timeout") => { rejectTermination(new EarthWalkingRouteError(code)); controller.abort(); };
  const cancel = () => stop("cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  try {
    if (signal.aborted) throw new EarthWalkingRouteError("cancelled");
    const operation = (async () => {
      const response = await fetcher(url, { signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", mode: "cors", referrerPolicy: "strict-origin" });
      try {
        if (controller.signal.aborted) throw new EarthWalkingRouteError("cancelled");
        if (response.status === 429) throw new EarthWalkingRouteError("rate_limit");
        if (response.status === 400) {
          const failure = await readBody(response, controller.signal);
          if (object(failure) && (failure.code === "NoRoute" || failure.code === "NoSegment")) throw new EarthWalkingRouteError("no_route");
        }
        if (!response.ok) throw new EarthWalkingRouteError("unavailable");
        return parseEarthWalkingRoute(await readBody(response, controller.signal), endpoints);
      } finally { if (!response.body?.locked) void response.body?.cancel().catch(() => {}); }
    })();
    return await Promise.race([operation, termination]);
  } catch (error) {
    throw error instanceof EarthWalkingRouteError ? error : new EarthWalkingRouteError("unavailable");
  } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); controller.abort(); }
}

/** Shared by all owner/controllers in this tab; cancellation never resets it. */
export function createEarthWalkingRouteLimiter() {
  let monotonicDeadline = -Infinity, wallDeadline = -Infinity;
  const remaining = (monotonicNow: number, wallNow: number) => Number.isFinite(monotonicNow) && Number.isFinite(wallNow)
    ? Math.max(0, monotonicDeadline - monotonicNow, wallDeadline - wallNow) : Infinity;
  return { remaining, take(monotonicNow: number, wallNow: number) {
    if (remaining(monotonicNow, wallNow) > 0) return false;
    monotonicDeadline = monotonicNow + EARTH_WALKING_ROUTE_COOLDOWN_MS; wallDeadline = wallNow + EARTH_WALKING_ROUTE_COOLDOWN_MS;
    return true;
  } };
}
export const earthWalkingRouteLimiter = createEarthWalkingRouteLimiter();
