/** Runtime artwork only. See public/world/README.md for previews and editing rules. */
export const WORLD_ART = {
  map: "/world/maps/forest-expanded.webp",
  home: "/world/maps/home-clearing.webp",
  houseDetails: "/world/buildings/house-details.webp",
  workshop: "/world/buildings/workshop-atlas.webp",
  settlement: {
    grass: "/world/settlement/grass.png",
    buildings: "/world/settlement/buildings.png",
    fence: "/world/settlement/fence.png",
  },
  routes: {
    trail: "/world/routes/trail.webp",
    river: "/world/routes/river.webp",
  },
} as const;
