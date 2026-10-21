export const EARTH_FRIEND_MARKER_LIMIT = 24;
export const EARTH_FRIEND_MARKER_MIN_ZOOM = -0.2;
export const EARTH_FRIEND_CLUSTER_RADIUS = 64;
export const EARTH_FRIEND_MARKER_WIDTH = 44;
export const EARTH_FRIEND_MARKER_HEIGHT = 44;

export type EarthFriendPoint = { circleId: string; x: number; y: number };
export type EarthFriendGroup = { anchorId: string; circleIds: string[]; x: number; y: number };
type Viewport = { width: number; height: number };

/** Clusters stand on a real member's point. Decluttering never moves coordinates. */
export function layoutEarthFriends(points: readonly EarthFriendPoint[], viewport: Viewport,
  self: { x: number; y: number } | null): EarthFriendGroup[] {
  if (![viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return [];
  const groups: EarthFriendGroup[] = [];
  const seen = new Set<string>();
  for (const point of [...points].sort((a, b) => a.circleId.localeCompare(b.circleId))) {
    if (seen.has(point.circleId) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    seen.add(point.circleId);
    if (point.x + EARTH_FRIEND_MARKER_WIDTH / 2 <= 0 || point.x - EARTH_FRIEND_MARKER_WIDTH / 2 >= viewport.width
      || point.y <= 0 || point.y - EARTH_FRIEND_MARKER_HEIGHT >= viewport.height) continue;
    // The private GPS pin remains usable even when a friend shares the same fix.
    // Such friends remain available in the compact map participant picker.
    if (self && Number.isFinite(self.x) && Number.isFinite(self.y)
      && point.x - EARTH_FRIEND_MARKER_WIDTH / 2 < self.x + 30
      && point.x + EARTH_FRIEND_MARKER_WIDTH / 2 > self.x - 30
      && point.y - EARTH_FRIEND_MARKER_HEIGHT < self.y + 8 && point.y > self.y - 68) continue;
    const group = groups.find(item => Math.abs(item.x - point.x) < EARTH_FRIEND_CLUSTER_RADIUS
      && Math.abs(item.y - point.y) < EARTH_FRIEND_CLUSTER_RADIUS);
    if (group) group.circleIds.push(point.circleId);
    else groups.push({ anchorId: point.circleId, circleIds: [point.circleId], x: point.x, y: point.y });
  }
  return groups.sort((a, b) => Math.hypot(a.x - viewport.width / 2, a.y - viewport.height / 2)
    - Math.hypot(b.x - viewport.width / 2, b.y - viewport.height / 2) || a.anchorId.localeCompare(b.anchorId))
    .slice(0, EARTH_FRIEND_MARKER_LIMIT);
}
