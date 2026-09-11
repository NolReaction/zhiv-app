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
