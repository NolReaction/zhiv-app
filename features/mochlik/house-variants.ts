import { FOREST_MAP } from "@/features/world/map-manifest";
/** Future variants fit the source-pixel slot and preserve doorway/lamp geometry.
 * A replacement patch must cover the baked house; a smaller transparent sprite cannot erase it. */
export type HouseVariant = {
  mapRevision: typeof FOREST_MAP.id;
  level: number;
  image: string;
  slot: typeof FOREST_MAP.house.upgradeSlot;
  groundAnchor: typeof FOREST_MAP.house.groundAnchor;
};
// Level 1 is baked into the approved map. Register only reviewed, compatible art.
export const HOUSE_VARIANTS: readonly HouseVariant[] = [];
export function houseVariantFor(level: number): HouseVariant | null {
  return HOUSE_VARIANTS.find(variant => variant.mapRevision === FOREST_MAP.id && variant.level === level) ?? null;
}
