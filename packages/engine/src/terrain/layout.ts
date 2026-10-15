/** Geometry is measured in world pixels: extending the viewport never changes it. */
export type Point = readonly [number, number];
export type GroundSample = { path: number; water: number; clearing: number };
export type TerrainDefinition = {
  sampleGround: (x: number, y: number, includeTrails?: boolean) => GroundSample;
  sampleWaterSignedDistance: (x: number, y: number) => number;
  trails: readonly { width: number; points: readonly Point[] }[];
};
export const EMPTY_TERRAIN_DEFINITION: TerrainDefinition = Object.freeze({
  sampleGround: () => ({ path: 0, water: -256, clearing: 0 }), sampleWaterSignedDistance: () => -256, trails: [],
});

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
