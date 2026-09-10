/** Geometry authored against the approved 1254 × 1254 PNG, in source pixels.
 * Change the revision and recalibrate this manifest when changing the artwork. */
export type MapPoint = { x: number; y: number };
export const FOREST_MAP = {
  id: "forest-home-v2",
  image: "/world/maps/forest-home-v2.png",
  size: 1254,
  homeCrop: { x: 240, y: 270, size: 768 },
  house: {
    id: "home",
    inside: { x: 777, y: 546 },
    doorstep: { x: 752, y: 610 },
    marker: { x: 782, y: 469 },
    hitArea: [{ x: 641, y: 541 }, { x: 719, y: 408 }, { x: 850, y: 404 }, { x: 889, y: 501 }, { x: 976, y: 576 }, { x: 887, y: 622 }, { x: 713, y: 583 }],
    doorway: [{ x: 748, y: 550 }, { x: 748, y: 518 }, { x: 755, y: 503 }, { x: 769, y: 494 }, { x: 784, y: 494 }, { x: 800, y: 505 }, { x: 807, y: 519 }, { x: 807, y: 550 }],
    lamp: { x: 815, y: 542, width: 11, height: 15 },
    sleep: { x: 774, y: 485 },
    upgradeSlot: { x: 628, y: 352, width: 365, height: 302 },
    groundAnchor: { x: 777, y: 580 },
    mushroomSource: { x: 850, y: 547, width: 42, height: 64 },
  },
  bush: {
    id: "bush",
    inside: { x: 415, y: 569 },
    approach: { x: 488, y: 629 },
    marker: { x: 416, y: 550 },
    foliage: [{ x: 350, y: 567 }, { x: 355, y: 532 }, { x: 377, y: 507 }, { x: 410, y: 492 }, { x: 441, y: 500 }, { x: 475, y: 527 }, { x: 491, y: 569 }, { x: 478, y: 601 }, { x: 413, y: 614 }, { x: 364, y: 598 }],
  },
  cave: {
    id: "cave",
    marker: { x: 130, y: 270 },
    entrance: { x: 130, y: 281 },
    approach: { x: 136, y: 316 },
    hitArea: [{ x: 34, y: 261 }, { x: 52, y: 222 }, { x: 107, y: 202 }, { x: 153, y: 211 }, { x: 181, y: 247 }, { x: 197, y: 309 }, { x: 105, y: 326 }, { x: 46, y: 302 }],
  },
  water: {
    id: "water",
    marker: { x: 1160, y: 1167 },
    // Narrow shore tolerance; includes all water through the bottom/right edges.
    hitArea: [{ x: 1254, y: 963 }, { x: 1228, y: 971 }, { x: 1202, y: 985 }, { x: 1180, y: 1015 }, { x: 1182, y: 1034 }, { x: 1190, y: 1051 }, { x: 1178, y: 1078 }, { x: 1152, y: 1086 }, { x: 1128, y: 1098 }, { x: 1062, y: 1098 }, { x: 1032, y: 1110 }, { x: 1026, y: 1125 }, { x: 1002, y: 1139 }, { x: 1006, y: 1166 }, { x: 1010, y: 1180 }, { x: 1025, y: 1194 }, { x: 1032, y: 1214 }, { x: 1043, y: 1230 }, { x: 1044, y: 1254 }, { x: 1254, y: 1254 }],
  },
  clearing: {
    spawn: { x: 609, y: 724 },
    front: { x: 624, y: 839 },
    keepsake: { x: 724, y: 622 },
    // Convex ground: straight routes between accepted targets stay on grass.
    walkable: [{ x: 516, y: 596 }, { x: 705, y: 605 }, { x: 841, y: 655 }, { x: 859, y: 735 }, { x: 798, y: 826 }, { x: 680, y: 866 }, { x: 529, y: 816 }, { x: 452, y: 710 }],
  },
} as const;
