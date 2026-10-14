/** Geometry is measured in world pixels: extending the viewport never changes it. */
export type Point = readonly [number, number];
export type GroundSample = { path: number; water: number; clearing: number };

export function hash(x: number, y: number, seed: number): number {
  let value = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

export function smoothPoints(points: readonly Point[], closed = false, subdivisions = 8): Point[] {
  const result: Point[] = [];
  const at = (index: number) => points[closed ? (index + points.length) % points.length : Math.max(0, Math.min(points.length - 1, index))];
  for (let index = 0; index < points.length - (closed ? 0 : 1); index++) {
    const a = at(index - 1), b = at(index), c = at(index + 1), d = at(index + 2);
    for (let step = 0; step < subdivisions; step++) {
      const t = step / subdivisions, t2 = t * t, t3 = t2 * t;
      result.push([
        0.5 * ((2 * b[0]) + (-a[0] + c[0]) * t + (2 * a[0] - 5 * b[0] + 4 * c[0] - d[0]) * t2 + (-a[0] + 3 * b[0] - 3 * c[0] + d[0]) * t3),
        0.5 * ((2 * b[1]) + (-a[1] + c[1]) * t + (2 * a[1] - 5 * b[1] + 4 * c[1] - d[1]) * t2 + (-a[1] + 3 * b[1] - 3 * c[1] + d[1]) * t3),
      ]);
    }
  }
  if (!closed) result.push(points[points.length - 1]);
  return result;
}

export const TRAILS = [
  { width: 49, points: smoothPoints([[-140, 948], [60, 1000], [225, 1200], [368, 1410], [470, 1390], [685, 1240], [827, 1280], [1000, 1200], [1115, 1060], [1370, 1020], [1490, 856], [1490, 660], [1600, 710], [1800, 735], [1940, 585], [2220, 670], [2440, 830], [2710, 745], [3000, 680], [3360, 840]]) },
  { width: 44, points: smoothPoints([[352, 1730], [375, 1430], [435, 1300], [490, 1110], [565, 959], [620, 773], [682, 630], [620, 493], [475, 462], [383, 391], [457, 280], [430, 153], [291, 65], [235, -100]]) },
  { width: 43, points: smoothPoints([[620, 510], [737, 455], [836, 330], [839, 178], [750, 46], [762, -130]]) },
  { width: 41, points: smoothPoints([[677, 638], [830, 723], [960, 767], [1020, 602], [1098, 515], [1190, 386], [1280, 285], [1430, 328], [1680, 432], [1830, 390], [2030, 256], [2360, 310], [2630, 120], [2970, 246], [3310, 370]]) },
  { width: 35, points: smoothPoints([[1075, 1050], [974, 948], [872, 932], [755, 940], [599, 912]]) },
  { width: 35, points: smoothPoints([[2035, 262], [2110, 490], [2190, 690], [2170, 903], [2270, 1100], [2480, 1280]]) },
] as const;

/** One continuous coast includes both banks of the narrow southern tributary. */
export const SHORELINE = smoothPoints([
  [700, 1134], [730, 1170], [756, 1260], [813, 1320], [855, 1420], [922, 1460],
  [1060, 1490], [1160, 1480], [1200, 1437], [1150, 1400], [1132, 1335], [1070, 1290],
  [1015, 1270], [1027, 1215], [1070, 1175], [1172, 1195], [1270, 1190], [1320, 1130],
  [1340, 1060], [1430, 1010], [1490, 956], [1560, 929], [1660, 938], [1780, 1010],
  [1910, 1080], [2020, 1120], [2140, 1190], [2310, 1230], [2450, 1160], [2620, 1120],
  [2800, 1180], [2980, 1110], [3160, 1130], [3370, 1200], [3900, 1190], [4100, 3000],
  [895, 3000], [895, 1750], [850, 1560], [806, 1430], [761, 1370], [720, 1310], [704, 1220], [678, 1170],
], true, 5);

const CLEARINGS = [
  [630, 990, 214, 168], [794, 353, 175, 140], [1184, 310, 150, 115],
  [1320, 748, 178, 150], [276, 618, 154, 139], [205, 244, 120, 102],
  [449, 1190, 154, 180], [1130, 1100, 140, 100], [1045, 1380, 132, 90],
  [1760, 707, 190, 142], [1990, 293, 170, 135], [2370, 715, 190, 170],
  [2790, 729, 205, 169], [3140, 407, 175, 130], [2620, 1050, 185, 100],
] as const;

function segmentDistanceSquared(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const projection = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return (x - a[0] - projection * dx) ** 2 + (y - a[1] - projection * dy) ** 2;
}

export function sampleGround(x: number, y: number, includeTrails = true): GroundSample {
  let path = 0;
  for (const trail of includeTrails ? TRAILS : []) {
    let closest = Infinity;
    for (let index = 1; index < trail.points.length; index++) {
      const a = trail.points[index - 1], b = trail.points[index];
      if (x < Math.min(a[0], b[0]) - 65 || x > Math.max(a[0], b[0]) + 65 || y < Math.min(a[1], b[1]) - 65 || y > Math.max(a[1], b[1]) + 65) continue;
      closest = Math.min(closest, segmentDistanceSquared(x, y, a, b));
    }
    path = Math.max(path, Math.max(0, Math.min(1, (trail.width * 0.5 + 20 - Math.sqrt(closest)) / 25)));
  }

  let inside = false, coastDistance = Infinity;
  for (let index = 0; index < SHORELINE.length; index++) {
    const a = SHORELINE[index], b = SHORELINE[(index + 1) % SHORELINE.length];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    coastDistance = Math.min(coastDistance, segmentDistanceSquared(x, y, a, b));
  }

  let clearing = path;
  for (const [cx, cy, rx, ry] of CLEARINGS) {
    const distance = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
    clearing = Math.max(clearing, Math.min(1, Math.max(0, (1.14 - distance) * 3.3)));
  }
  return { path, water: Math.sqrt(coastDistance) * (inside ? 1 : -1), clearing };
}
