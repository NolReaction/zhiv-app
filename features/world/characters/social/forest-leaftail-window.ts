import { createWorldNavigation, isWalkable } from "@/features/world/navigation/navigation";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export type ForestLeaftailWindow = { position: WorldPoint; approach: WorldPoint; speechAnchor: WorldPoint; size: number };
const cache = new WeakMap<FixedWorldScene, ForestLeaftailWindow | null>();

/** The round end window is an annotation on the existing caravan artwork, not a
 * physical actor or a new walkable corridor through its collision polygon. */
export function forestLeaftailWindow(scene: FixedWorldScene): ForestLeaftailWindow | null {
  if (cache.has(scene)) return cache.get(scene)!;
  const site = scene.sites.find(site => site.id === "leaftail-caravan"), size = 44;
  if (!site || ![site.bounds.x, site.bounds.y, site.bounds.width, site.bounds.height].every(Number.isFinite)
    || site.bounds.width <= 0 || site.bounds.height <= 0) { cache.set(scene, null); return null; }
  const navigation = createWorldNavigation(scene, size * .13);
  if (!navigation) { cache.set(scene, null); return null; }
  const position = { x: site.bounds.x + site.bounds.width * .33, y: site.bounds.y + site.bounds.height * .65 };
  const candidates = [1, 1.3, 1.6, 1.9].flatMap(depth => [[-1, -.2], [-1, -.45], [-.8, -.7], [0, -1], [1, -.2]].map(([x, y]) => ({
    x: position.x + size * depth * x, y: position.y + size * depth * y,
  })));
  const approach = candidates.find(point => isWalkable(navigation, point));
  if (!approach) { cache.set(scene, null); return null; }
  const result = { position, approach, speechAnchor: { x: position.x, y: position.y - size * .24 }, size };
  cache.set(scene, result); return result;
}
