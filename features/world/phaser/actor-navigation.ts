import {
  canTraverse,
  createWorldNavigation,
  findWorldPath,
  isWalkable,
  type WorldNavigation,
} from "@/features/world/navigation/navigation";
import type { FixedSite, FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

const SPEED = 64;
const MAX_DELTA_MS = 50;
const finite = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
export type PhaserSiteApproach = { kind: "entry" | "near-entry"; point: WorldPoint };

function approachCandidates(world: FixedWorldScene, navigation: WorldNavigation, site: FixedSite): WorldPoint[] {
  const radius = Math.min(96, Math.max(16, (world.actor?.size ?? 50) * 1.2));
  const withinRange = (point: WorldPoint) => finite(point)
    && Math.hypot(point.x - site.entry.x, point.y - site.entry.y) <= radius;
  // Authored destinations already express where somebody can stand to work.
  const authored = (world.destinations ?? []).filter(item => item.siteId === site.id && withinRange(item.position))
    .sort((a, b) => Number(b.id === site.id) - Number(a.id === site.id))
    .map(item => item.position);
  const grid: WorldPoint[] = [];
  const { origin, columns, walkable } = navigation.grid;
  for (let index = 0; index < walkable.length; index++) {
    if (!walkable[index]) continue;
    const point = { x: origin.x + index % columns * navigation.cellSize,
      y: origin.y + Math.floor(index / columns) * navigation.cellSize };
    if (withinRange(point)) grid.push(point);
  }
  grid.sort((a, b) => Math.hypot(a.x - site.entry.x, a.y - site.entry.y) - Math.hypot(b.x - site.entry.x, b.y - site.entry.y));
  // Bound failed A* attempts in disconnected/invalid editor geometry.
  return [...authored.slice(0, 4), ...grid.slice(0, 12)];
}

/** Editor changes may cover the previous position. Relocate only when applying
 * a new snapshot/reset; normal movement always follows checked path segments. */
function safeSpawn(navigation: WorldNavigation | null, requested: WorldPoint): WorldPoint | null {
  if (!navigation || !finite(requested)) return null;
  if (isWalkable(navigation, requested)) return { ...requested };
  let closest: WorldPoint | null = null, closestDistance = Infinity;
  const { origin, columns, walkable } = navigation.grid;
  for (let index = 0; index < walkable.length; index++) {
    if (!walkable[index]) continue;
    const point = { x: origin.x + index % columns * navigation.cellSize,
      y: origin.y + Math.floor(index / columns) * navigation.cellSize };
    const distance = (point.x - requested.x) ** 2 + (point.y - requested.y) ** 2;
    if (distance < closestDistance) { closest = point; closestDistance = distance; }
  }
  return closest;
}

/** Local preview locomotion, independent of the persistent forest session. */
export function createPhaserActorNavigation(initialWorld: FixedWorldScene) {
  let world = initialWorld;
  let navigation = createWorldNavigation(world);
  let position: WorldPoint = { ...(world.actor?.spawn ?? { x: 0, y: 0 }) };
  let active = false;
  let route: WorldPoint[] = [];

  const relocate = (preservePosition: boolean) => {
    route = [];
    const requested = preservePosition && navigation && isWalkable(navigation, position)
      ? position : world.actor?.spawn ?? position;
    const next = world.actor ? safeSpawn(navigation, requested) : null;
    active = next !== null;
    if (next) position = next;
  };
  relocate(false);

  return {
    get position(): WorldPoint { return { ...position }; },
    get moving() { return active && route.length > 0; },
    get active() { return active; },
    walkTo(target: WorldPoint): boolean {
      if (!active || !navigation || !finite(target)) return false;
      const path = findWorldPath(navigation, position, target);
      if (!path) return false;
      route = path.slice(1);
      return true;
    },
    walkToSite(requested: FixedSite): PhaserSiteApproach | null {
      const site = world.sites.find(item => item.id === requested.id);
      if (!active || !navigation || !site || !finite(site.entry)) return null;
      const exact = findWorldPath(navigation, position, site.entry);
      if (exact) {
        route = exact.slice(1);
        return { kind: "entry", point: { ...site.entry } };
      }
      for (const target of approachCandidates(world, navigation, site)) {
        const path = findWorldPath(navigation, position, target);
        if (!path) continue;
        route = path.slice(1);
        return { kind: "near-entry", point: { ...target } };
      }
      return null;
    },
    /** A suspended tab never contributes a giant movement step on return. */
    update(delta: number): WorldPoint {
      const previous = position;
      let remaining = SPEED * Math.min(MAX_DELTA_MS, Math.max(0, Number.isFinite(delta) ? delta : 0)) / 1_000;
      while (active && navigation && route.length && remaining > 0) {
        const target = route[0];
        const distance = Math.hypot(target.x - position.x, target.y - position.y);
        if (distance < 1e-7) { route.shift(); continue; }
        const fraction = Math.min(1, remaining / distance);
        const next = { x: position.x + (target.x - position.x) * fraction,
          y: position.y + (target.y - position.y) * fraction };
        // Keep the swept-circle guard even for a previously accepted route.
        if (!canTraverse(navigation, position, next)) { route = []; break; }
        position = next;
        remaining -= distance * fraction;
        if (fraction === 1) route.shift();
      }
      return { x: position.x - previous.x, y: position.y - previous.y };
    },
    updateWorld(next: FixedWorldScene) {
      world = next;
      navigation = createWorldNavigation(world);
      relocate(true);
    },
    reset() { relocate(false); },
    stop() { route = []; },
  };
}
