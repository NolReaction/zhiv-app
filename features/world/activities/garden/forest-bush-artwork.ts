import type { FixedWorldScene, WorldBush } from "@/features/world/tiled/types";

/** An omitted reference retains baked artwork. An explicit reference may be staged
 * before its image is placed; metadata and saved crop remain intact meanwhile. */
export function forestBushArtworkAvailable(scene: Pick<FixedWorldScene, "terrain">, bush: WorldBush): boolean {
  if (bush.imageId === undefined) return true;
  const image = scene.terrain.find(item => item.id === bush.imageId);
  if (!image || !bush.points.length) return false;
  const { x, y, width, height } = image.bounds;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false;
  // A tile placed elsewhere must not activate the old empty patch of ground.
  const epsilon = 1e-6;
  return bush.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= x - epsilon && point.x <= x + width + epsilon
    && point.y >= y - epsilon && point.y <= y + height + epsilon);
}
