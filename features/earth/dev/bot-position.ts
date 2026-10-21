import type { EarthPosition } from "../location";

export type BotPosition = { latitude: number; longitude: number; accuracyMeters: number };
const EARTH_RADIUS = 6_371_008.8;

/** A manual synthetic step. No watch, route history or automatic publication. */
export function moveBotPosition(position: BotPosition, bearingDegrees: number, meters = 100): BotPosition {
  const angle = meters / EARTH_RADIUS, bearing = bearingDegrees * Math.PI / 180;
  const lat = position.latitude * Math.PI / 180, lng = position.longitude * Math.PI / 180;
  const nextLat = Math.asin(Math.sin(lat) * Math.cos(angle) + Math.cos(lat) * Math.sin(angle) * Math.cos(bearing));
  const nextLng = lng + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(lat), Math.cos(angle) - Math.sin(lat) * Math.sin(nextLat));
  return { latitude: nextLat * 180 / Math.PI, longitude: ((nextLng * 180 / Math.PI + 540) % 360) - 180,
    accuracyMeters: position.accuracyMeters };
}

export function nearbyBotPosition(position: EarthPosition | null, now: number): BotPosition | null {
  if (!position || !Number.isFinite(now) || !Number.isFinite(position.timestamp) || now - position.timestamp > 60_000 || position.timestamp > now + 10_000
    || !Number.isFinite(position.latitude) || Math.abs(position.latitude) > 90
    || !Number.isFinite(position.longitude) || Math.abs(position.longitude) > 180) return null;
  return moveBotPosition({ latitude: position.latitude, longitude: position.longitude, accuracyMeters: 20 }, 90, 200);
}

export function parseBotPosition(latitude: string, longitude: string, accuracy: string): BotPosition | null {
  const number = (value: string) => value.trim() ? Number(value.trim().replace(",", ".")) : NaN;
  const lat = number(latitude), lng = number(longitude), accuracyMeters = number(accuracy);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180
    || !Number.isFinite(accuracyMeters) || accuracyMeters < 1 || accuracyMeters > 50_000) return null;
  return { latitude: lat, longitude: lng, accuracyMeters };
}
