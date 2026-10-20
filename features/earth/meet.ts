import { EARTH_POSITION_FUTURE_MS, EARTH_POSITION_MAX_AGE_MS, EARTH_POSITION_TTL_MS,
  type EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";

const EARTH_RADIUS_METERS = 6_371_008.8;
const RAD = Math.PI / 180;
const ROUTE_MAX_AGE_MS = 5 * 60_000;
const ROUTE_MAX_ACCURACY_METERS = 200;
const DIRECTIONS = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"] as const;

export type EarthMeetDetails = {
  /** Great-circle distance to the last received point, never a walking route. */
  distanceMeters: number;
  bearingDegrees: number | null;
  direction: typeof DIRECTIONS[number] | null;
  /** Sum of both uncertainty radii; overlapping areas have no reliable bearing. */
  accuracyMeters: number;
};

function validCoordinates(latitude: number, longitude: number, accuracy: number) {
  return Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && Number.isFinite(longitude) && Math.abs(longitude) <= 180
    && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100_000;
}

function validFriend(friend: EarthMapPerson, monotonicNow: number, wallNow: number) {
  const updatedAt = Date.parse(friend.updatedAt), expiresAt = Date.parse(friend.expiresAt);
  return Number.isFinite(monotonicNow) && Number.isFinite(wallNow)
    && validCoordinates(friend.latitude, friend.longitude, friend.accuracyMeters)
    && (friend.precision === "PRECISE" || friend.precision === "APPROXIMATE")
    && Number.isFinite(updatedAt) && updatedAt >= 0 && updatedAt <= wallNow + EARTH_POSITION_FUTURE_MS
    && Number.isFinite(expiresAt) && expiresAt > wallNow && expiresAt > updatedAt
    && expiresAt - updatedAt <= EARTH_POSITION_TTL_MS
    && Number.isFinite(friend.expiresAtMonotonic) && friend.expiresAtMonotonic > monotonicNow;
}

/** Local calculation only. Sharing mode and publication permissions are untouched. */
export function earthMeetDetails(position: EarthPosition | null, friend: EarthMapPerson,
  monotonicNow: number, wallNow = Date.now()): EarthMeetDetails | null {
  if (!position || !validFriend(friend, monotonicNow, wallNow)
    || !validCoordinates(position.latitude, position.longitude, position.accuracy)
    || !Number.isFinite(position.timestamp) || position.timestamp < 0
    || wallNow - position.timestamp > EARTH_POSITION_MAX_AGE_MS
    || position.timestamp - wallNow > EARTH_POSITION_FUTURE_MS) return null;

  const latitude = position.latitude * RAD, targetLatitude = friend.latitude * RAD;
  const deltaLatitude = targetLatitude - latitude;
  // The short arc crosses the antimeridian instead of circling the globe.
  const deltaLongitude = (((friend.longitude - position.longitude) + 540) % 360 - 180) * RAD;
  const haversine = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude) * Math.cos(targetLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  const arc = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, haversine))));
  const distanceMeters = EARTH_RADIUS_METERS * arc;
  const accuracyMeters = position.accuracy + friend.accuracyMeters;
  const y = Math.sin(deltaLongitude) * Math.cos(targetLatitude);
  const x = Math.cos(latitude) * Math.sin(targetLatitude)
    - Math.sin(latitude) * Math.cos(targetLatitude) * Math.cos(deltaLongitude);
  // Coincident/antipodal points and an exact pole have no unique useful bearing.
  const bearingDegrees = distanceMeters > accuracyMeters && Math.hypot(x, y) > 1e-12 && Math.abs(position.latitude) < 90
    ? (Math.atan2(y, x) / RAD + 360) % 360 : null;
  return { distanceMeters, accuracyMeters, bearingDegrees,
    direction: bearingDegrees === null ? null : DIRECTIONS[Math.round(bearingDegrees / 45) % 8] };
}

/** Google Maps receives only a destination, and only when the user opens this URL.
 * Its route is separate from our straight-line estimate. Never append our private origin.
 * https://developers.google.com/maps/documentation/urls/guide#directions
 */
export function walkingRouteUrl(friend: EarthMapPerson, monotonicNow: number, wallNow = Date.now()): string | null {
  if (!validFriend(friend, monotonicNow, wallNow) || friend.precision !== "PRECISE"
    || friend.accuracyMeters > ROUTE_MAX_ACCURACY_METERS || wallNow - Date.parse(friend.updatedAt) > ROUTE_MAX_AGE_MS) return null;
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${friend.latitude},${friend.longitude}`);
  url.searchParams.set("travelmode", "walking");
  return url.toString();
}
