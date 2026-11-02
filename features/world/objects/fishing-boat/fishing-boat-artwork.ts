/** Original raster parts share one assembly space in the workshop and on the river.
 * Crop rectangles only select existing pixels; replacing a part never requires redrawing the hull. */
export type BoatArtModule = "repair" | "oars" | "crate" | "landing_net" | "telescope";
export type BoatArtLayer = { id: BoatArtModule; src: string; source: readonly [number, number];
  crop: readonly [number, number, number, number]; box: readonly [number, number, number, number] };
export const BOAT_ASSEMBLY = { width: 1000, height: 650, waterline: 535, foredeck: 448 } as const;
const root = "/world/boat/";
export const BOAT_ART_PARTS: Record<BoatArtModule, BoatArtLayer> = {
  repair: { id: "repair", src: `${root}hull.webp`, source: [1536, 1024], crop: [15, 296, 1507, 459], box: [40, 290, 920, 280] },
  oars: { id: "oars", src: `${root}module-oars.webp`, source: [1774, 887], crop: [18, 207, 1739, 545], box: [170, 398, 510, 160] },
  crate: { id: "crate", src: `${root}module-crate.webp`, source: [1254, 1254], crop: [59, 215, 1135, 863], box: [565, 308, 170, 129] },
  landing_net: { id: "landing_net", src: `${root}module-landing-net.webp`, source: [1254, 1254], crop: [23, 139, 1216, 1077], box: [640, 130, 285, 252] },
  telescope: { id: "telescope", src: `${root}module-telescope.webp`, source: [1254, 1254], crop: [26, 56, 1207, 1118], box: [280, 178, 210, 195] },
};
export const BOAT_BROKEN_HULL: BoatArtLayer = { ...BOAT_ART_PARTS.repair, src: `${root}hull-broken.webp`, crop: [16, 296, 1505, 461] };
export type BoatArtLoadout = { repaired: boolean; upgrades?: readonly string[]; artifacts?: readonly string[]; previewModule?: BoatArtModule };
export function boatArtworkLayers({ repaired, upgrades = [], artifacts = [], previewModule }: BoatArtLoadout): BoatArtLayer[] {
  const fixed = repaired || previewModule === "repair";
  const owned = new Set([...upgrades, ...artifacts, previewModule]);
  return [fixed ? BOAT_ART_PARTS.repair : BOAT_BROKEN_HULL,
    ...(["crate", "telescope", "landing_net", "oars"] as const).filter(id => owned.has(id)).map(id => BOAT_ART_PARTS[id])];
}
