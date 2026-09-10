/** Runtime artwork only. See public/world/README.md for previews and editing rules. */
import { FOREST_MAP } from "./map-manifest";
export const WORLD_ART = {
  map: FOREST_MAP.image,
  home: FOREST_MAP.image,
  houseDetails: "/world/buildings/house-details.webp",
  workshop: "/world/buildings/workshop-atlas.webp",
  routes: {
    trail: "/world/routes/trail.webp",
    river: "/world/routes/river.webp",
  },
} as const;
