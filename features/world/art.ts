/** Runtime artwork only. See public/world/README.md for previews and editing rules. */
import { FOREST_MAP } from "./map-manifest";
import runtimeArt from "./runtime-art.json";
export const WORLD_ART = {
  map: FOREST_MAP.image,
  home: FOREST_MAP.image,
  mapPreview: runtimeArt.mapPreview,
  homePreview: runtimeArt.homePreview,
  homeDetail: FOREST_MAP.homeDetail.image,
  boatWreck: runtimeArt.boatWreck,
  routes: {
    trail: "/world/routes/trail.webp",
  },
} as const;

/** Isolated Tiled prototype registry. Actual versioned URLs are compiled from
 * world/tiled/forest.tmj; production WORLD_ART does not load these assets. */
export const TILED_PROTOTYPE_ART = {
  terrain: "/world/tiled/terrain.webp",
  home: ["/world/tiled/home-1.webp", "/world/tiled/home-2.webp", "/world/tiled/home-3.webp"],
  workshop: ["/world/tiled/workshop-0.webp", "/world/tiled/workshop-1.webp", "/world/tiled/workshop-2.webp"],
} as const;
