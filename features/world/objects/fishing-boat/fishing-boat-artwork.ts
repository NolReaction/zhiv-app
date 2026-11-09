/** Editable side-profile masters share one transform in the workshop and on the river.
 * The simulation retains its 1000×650 rig; native 1600×640 SVGs use scale .625 and Y +185. */
export type BoatArtModule = "repair" | "oars" | "crate" | "landing_net" | "telescope";
export type BoatArtPartId = Exclude<BoatArtModule, "crate"> | "fuel_hose" | "engine" | "tank";
export type BoatArtLayer = { id: BoatArtPartId; src: string; source: readonly [number, number];
  crop: readonly [number, number, number, number]; box: readonly [number, number, number, number] };
export const BOAT_ASSEMBLY = { width: 1000, height: 650, waterline: 535, foredeck: 356 } as const;
export const BOAT_PASSENGER_SEAT = { x: 600, y: 400 } as const;
export const BOAT_SIDE_VIEWPORT = [0, 185, 1000, 400] as const;
const root = "/world/boat/";
const modular = `${root}modular/`;

/** L2–L5 are artwork choices for the studio, not additional paid upgrades. */
export const BOAT_SIDE_LEVELS = [0, 1, 2, 3, 4, 5] as const;
export type BoatSideLevel = typeof BOAT_SIDE_LEVELS[number];
export function boatSideArtworkPart(kind: "hull" | "engine" | "tank", level: BoatSideLevel): BoatArtLayer {
  const source = kind === "hull" ? [1600, 640] as const : kind === "engine" ? [260, 570] as const : [300, 230] as const;
  const box = kind === "hull" ? [0, 185, 1000, 400] as const
    : kind === "engine" ? [0, 219.375, 162.5, 356.25] as const : [218.75, 222.5, 187.5, 143.75] as const;
  return { id: kind === "hull" ? "repair" : kind, src: `${modular}${kind}_l${level}.svg`, source,
    crop: [0, 0, ...source], box };
}

export const BOAT_ART_PARTS: Record<BoatArtPartId, BoatArtLayer> = {
  repair: boatSideArtworkPart("hull", 1),
  fuel_hose: { id: "fuel_hose", src: `${modular}fuel_hose_aligned.svg`, source: [1600, 640], crop: [0, 0, 1600, 640], box: [0, 185, 1000, 400] },
  engine: boatSideArtworkPart("engine", 0),
  tank: boatSideArtworkPart("tank", 0),
  // The existing oars upgrade remains a pair of stowed oars; it never changes engine power.
  oars: { id: "oars", src: `${root}module-oars.webp`, source: [1774, 887], crop: [18, 207, 1739, 545], box: [695, 382, 200, 62.68] },
  landing_net: { id: "landing_net", src: `${root}module-landing-net.webp`, source: [1254, 1254], crop: [23, 139, 1216, 1077], box: [805, 212, 150, 132.86] },
  telescope: { id: "telescope", src: `${root}module-telescope.webp`, source: [1254, 1254], crop: [26, 56, 1207, 1118], box: [685, 235, 120, 111.15] },
};
export const BOAT_BROKEN_HULL = boatSideArtworkPart("hull", 0);
export type BoatArtLoadout = { repaired: boolean; upgrades?: readonly string[]; artifacts?: readonly string[]; previewModule?: BoatArtModule };
export function boatArtworkLayers({ repaired, upgrades = [], artifacts = [], previewModule }: BoatArtLoadout): BoatArtLayer[] {
  const fixed = repaired || previewModule === "repair";
  const owned = new Set([...upgrades, ...artifacts, previewModule]);
  return [fixed ? BOAT_ART_PARTS.repair : BOAT_BROKEN_HULL, BOAT_ART_PARTS.fuel_hose, BOAT_ART_PARTS.engine, BOAT_ART_PARTS.tank,
    ...(["telescope", "landing_net", "oars"] as const).filter(id => owned.has(id)).map(id => BOAT_ART_PARTS[id])];
}
