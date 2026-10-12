import type { FixedWorldScene } from "@/features/world/tiled/types";
import { previewPointInPolygon } from "@/features/world/tiled/preview-state";
import type { ForestAirParticle } from "./forest-wildlife";

/** Leaf depth follows the same bush/actor relationship as the cutout. A hand
 * partner and a free airborne insect have no leaf support and retain their pass. */
export function faunaBehindHero(particle: ForestAirParticle, scene: FixedWorldScene, actorY: number,
  activeBush?: { id: string; occlude: boolean }): boolean {
  if (!particle.support) return false;
  const bush = scene.bushes?.find(item => previewPointInPolygon(particle.support!, item.points));
  if (!bush) return false;
  return activeBush?.id === bush.id ? !activeBush.occlude : bush.hide.y < actorY;
}
