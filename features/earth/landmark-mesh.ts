import type { EarthLandmarkKind } from "./landmark-catalog";

type Point = readonly [number, number, number];
type Color = readonly [number, number, number];
export type EarthLandmarkDetail = "overview" | "detail";
const cream: Color = [0.94, 0.86, 0.65];
const stone: Color = [0.78, 0.59, 0.39];
const white: Color = [0.96, 0.95, 0.84];
const copper: Color = [0.37, 0.69, 0.57];
const red: Color = [0.78, 0.28, 0.22];
const gold: Color = [1, 0.69, 0.22];

/** Original low-poly architecture, in a local east/north/up frame. No fetched models. */
export function createEarthLandmarkMesh(kind: EarthLandmarkKind, detail: EarthLandmarkDetail = "detail"): Float32Array {
  const vertices: number[] = [];
  function triangle(a: Point, b: Point, c: Point, color: Color) {
    const u = b.map((value, axis) => value - a[axis]);
    const v = c.map((value, axis) => value - a[axis]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal);
    if (length < 1e-9) return;
    // Soft local sunlight makes every face dimensional even in a still frame.
    const shade = 0.68 + 0.32 * Math.max(0, (normal[0] * -0.35 + normal[1] * -0.45 + normal[2] * 0.82) / length);
    for (const point of [a, b, c]) vertices.push(...point, ...color.map(value => value * shade));
  }
  function quad(a: Point, b: Point, c: Point, d: Point, color: Color) {
    triangle(a, b, c, color); triangle(a, c, d, color);
  }
  function box(x: number, y: number, z: number, width: number, depth: number, height: number, color: Color) {
    const p: Point[] = [[x - width / 2, y - depth / 2, z], [x + width / 2, y - depth / 2, z],
      [x + width / 2, y + depth / 2, z], [x - width / 2, y + depth / 2, z]];
    for (let index = 0; index < 4; index++) {
      const a = p[index], b = p[(index + 1) % 4];
      quad(a, b, [b[0], b[1], z + height], [a[0], a[1], z + height], color);
    }
    quad([p[0][0], p[0][1], z + height], [p[1][0], p[1][1], z + height],
      [p[2][0], p[2][1], z + height], [p[3][0], p[3][1], z + height], color);
  }
  function rings(x: number, y: number, profile: readonly (readonly [number, number])[], color: Color,
    sides = 10, depthRatio = 1) {
    for (let ring = 1; ring < profile.length; ring++) {
      const [bottom, radius] = profile[ring - 1], [top, nextRadius] = profile[ring];
      for (let segment = 0; segment < sides; segment++) {
        const a = segment / sides * Math.PI * 2, b = (segment + 1) / sides * Math.PI * 2;
        quad([x + Math.cos(a) * radius, y + Math.sin(a) * radius * depthRatio, bottom],
          [x + Math.cos(b) * radius, y + Math.sin(b) * radius * depthRatio, bottom],
          [x + Math.cos(b) * nextRadius, y + Math.sin(b) * nextRadius * depthRatio, top],
          [x + Math.cos(a) * nextRadius, y + Math.sin(a) * nextRadius * depthRatio, top], color);
      }
    }
  }
  function dome(x: number, y: number, z: number, radius: number, height: number, color: Color) {
    rings(x, y, [[z, radius * 0.7], [z + height * 0.2, radius], [z + height * 0.55, radius * 0.85],
      [z + height * 0.82, radius * 0.45], [z + height, 0]], color);
  }
  function beam(a: Point, b: Point, width: number, color: Color) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const length = Math.hypot(dx, dy, dz), horizontal = Math.hypot(dx, dy);
    const side: Point = horizontal > 1e-6 ? [-dy / horizontal * width / 2, dx / horizontal * width / 2, 0] : [width / 2, 0, 0];
    const other: Point = [(dy * side[2] - dz * side[1]) / length, (dz * side[0] - dx * side[2]) / length,
      (dx * side[1] - dy * side[0]) / length];
    const corners = (point: Point): Point[] => [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([s, o]) =>
      point.map((value, axis) => value + side[axis] * s + other[axis] * o) as unknown as Point);
    const bottom = corners(a), top = corners(b);
    for (let index = 0; index < 4; index++) quad(bottom[index], bottom[(index + 1) % 4], top[(index + 1) % 4], top[index], color);
    quad(...top as [Point, Point, Point, Point], color);
  }

  if (kind === "eiffel-tower") {
    // Recognizable engineering silhouette: 330 m / 125 m; platforms at
    // 57, 115 and 276 m. Detail is original geometry, not a surveyed model.
    const iron: Color = [0.67, 0.53, 0.38], edge: Color = [0.83, 0.68, 0.48];
    const fine = detail === "detail";
    const legs = [[0.012, 0.17], [0.065, 0.143], [0.12, 0.113], [57 / 330, 0.088],
      [0.25, 0.069], [115 / 330, 0.051], [0.48, 0.037], [0.61, 0.027],
      [0.73, 0.02], [276 / 330, 0.014]] as const;
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      box(x * 0.17, y * 0.17, 0, 0.038, 0.038, 0.012, stone);
      for (let index = 1; index < legs.length; index++) {
        const [z, radius] = legs[index - 1], [nextZ, nextRadius] = legs[index];
        const width = z < 0.18 ? 0.021 : z < 0.35 ? 0.014 : 0.009;
        beam([x * radius, y * radius, z], [x * nextRadius, y * nextRadius, nextZ], width, iron);
      }
    }
    // Four open arches, recessed towards the first-floor corners as they rise.
    // The opening stays empty all the way through, including the far facade.
    const archSegments = 8;
    const face = (side: number, across: number, radius: number, z: number): Point => side < 2
      ? [across, (side === 0 ? -1 : 1) * radius, z]
      : [(side === 2 ? -1 : 1) * radius, across, z];
    const arch = (side: number, t: number): Point => {
      const rise = Math.sin(t * Math.PI) * 0.092;
      return face(side, -Math.cos(t * Math.PI) * 0.139, 0.139 - rise * 0.48, 0.058 + rise);
    };
    for (let side = 0; side < 4; side++) {
      for (let segment = 1; segment <= archSegments; segment++) {
        beam(arch(side, (segment - 1) / archSegments), arch(side, segment / archSegments), 0.01, edge);
      }
      // Lattice on the tapering shaft, never across the ground-level arch.
      for (let index = 4; index < legs.length; index++) {
        const [z, radius] = legs[index - 1], [nextZ, nextRadius] = legs[index];
        beam(face(side, -radius, radius, z), face(side, nextRadius, nextRadius, nextZ), 0.0045, edge);
        beam(face(side, radius, radius, z), face(side, -nextRadius, nextRadius, nextZ), 0.0045, iron);
      }
    }
    const platforms = [[57 / 330, 0.23], [115 / 330, 0.137], [276 / 330, 0.057]];
    for (const [z, size] of platforms) box(0, 0, z, size, size, 0.011, iron);
    box(0, 0, 0.848, 0.029, 0.029, 0.037, iron);
    rings(0, 0, [[0.885, 0.024], [0.907, 0.006]], edge, 4);
    beam([0, 0, 0.904], [0, 0, 1], 0.004, iron);
    // Append-only detail: the overview is an exact prefix of this same buffer.
    // Camera movement can change vertex count without duplicating/uploading it.
    if (fine) {
      for (let side = 0; side < 4; side++) {
        for (const [z, radius] of legs.slice(4))
          beam(face(side, -radius, radius, z), face(side, radius, radius, z), 0.0045, edge);
        for (const t of [0.25, 0.5, 0.75]) {
          const start = arch(side, t);
          beam(start, face(side, start[side < 2 ? 0 : 1], 0.088, 57 / 330), 0.0045, iron);
        }
      }
      for (const [z, size] of platforms) {
        for (const sign of [-1, 1]) {
          box(0, sign * size / 2, z + 0.023, size, 0.004, 0.004, edge);
          box(sign * size / 2, 0, z + 0.023, 0.004, size, 0.004, edge);
        }
        for (const x of [-1, 1]) for (const y of [-1, 1])
          box(x * size / 2, y * size / 2, z + 0.011, 0.004, 0.004, 0.016, iron);
      }
    }
  } else if (kind === "giza-pyramids") {
    box(0, 0, 0, 1.22, 0.78, 0.025, cream);
    for (const [x, y, size] of [[-0.3, 0.1, 0.6], [0.23, -0.1, 0.48], [0.48, 0.24, 0.25]]) {
      const points: Point[] = [[x - size / 2, y - size / 2, 0.025], [x + size / 2, y - size / 2, 0.025],
        [x + size / 2, y + size / 2, 0.025], [x - size / 2, y + size / 2, 0.025]];
      for (let index = 0; index < 4; index++) triangle(points[index], points[(index + 1) % 4], [x, y, size * 0.8], cream);
    }
  } else if (kind === "colosseum") {
    rings(0, 0, [[0, 0.57], [0.05, 0.57], [0.05, 0.32]], cream, 24, 0.75);
    for (let level = 0; level < 3; level++) {
      const z = 0.05 + level * 0.13;
      rings(0, 0, [[z + 0.1, 0.52], [z + 0.13, 0.52], [z + 0.13, 0.42], [z + 0.1, 0.42]], cream, 24, 0.75);
      for (let index = 0; index < 24; index++) {
        const angle = index / 24 * Math.PI * 2;
        box(Math.cos(angle) * 0.47, Math.sin(angle) * 0.35, z, 0.065, 0.065, 0.11, stone);
      }
    }
  } else if (kind === "saint-basils" || kind === "taj-mahal") {
    const basil = kind === "saint-basils";
    box(0, 0, 0, 1, 0.85, 0.07, cream);
    box(0, 0, 0.07, 0.58, 0.49, 0.29, basil ? red : white);
    const roofs: Color[] = [copper, red, gold, [0.22, 0.59, 0.78]];
    const centers = basil ? [[0, 0], [-0.27, -0.22], [0.27, -0.22], [-0.27, 0.22], [0.27, 0.22]]
      : [[0, 0], [-0.42, -0.32], [0.42, -0.32], [-0.42, 0.32], [0.42, 0.32]];
    centers.forEach(([x, y], index) => {
      const center = index === 0, radius = center ? 0.19 : basil ? 0.12 : 0.047;
      const top = center ? 0.61 : basil ? 0.45 : 0.47;
      rings(x, y, [[0.07, radius * 0.8], [top, radius * 0.8], [top, 0]], basil ? red : white, 8);
      dome(x, y, top, radius, center ? 0.27 : basil ? 0.2 : 0.095, basil ? roofs[index % roofs.length] : white);
      beam([x, y, top + (center ? 0.27 : basil ? 0.2 : 0.095)], [x, y, top + (center ? 0.34 : basil ? 0.26 : 0.13)], 0.012, gold);
    });
  } else if (kind === "great-wall") {
    const points = [[-0.55, -0.18], [-0.26, 0.12], [0.04, -0.1], [0.34, 0.16], [0.55, 0.06]];
    for (let index = 1; index < points.length; index++) {
      const [x, y] = points[index - 1], [nextX, nextY] = points[index];
      beam([x, y, 0.12], [nextX, nextY, 0.12], 0.18, stone);
      beam([x, y - 0.07, 0.24], [nextX, nextY - 0.07, 0.24], 0.035, cream);
      beam([x, y + 0.07, 0.24], [nextX, nextY + 0.07, 0.24], 0.035, cream);
    }
    for (const [x, y] of [points[0], points[2], points[4]]) {
      box(x, y, 0, 0.23, 0.25, 0.29, stone);
      box(x, y, 0.29, 0.27, 0.29, 0.04, cream);
      for (const dx of [-0.095, 0, 0.095]) for (const dy of [-0.1, 0.1]) box(x + dx, y + dy, 0.33, 0.05, 0.05, 0.065, cream);
    }
  } else if (kind === "statue-of-liberty") {
    box(0, 0, 0, 0.5, 0.46, 0.1, cream); box(0, 0, 0.1, 0.28, 0.26, 0.2, stone);
    rings(0, 0, [[0.3, 0.16], [0.73, 0.08], [0.78, 0.04]], copper, 7);
    dome(0, 0, 0.77, 0.065, 0.11, copper);
    beam([-0.06, 0, 0.7], [-0.19, 0, 1.03], 0.06, copper);
    beam([-0.19, 0, 1.03], [-0.19, 0, 1.13], 0.035, stone);
    dome(-0.19, 0, 1.12, 0.045, 0.08, gold);
    beam([0.065, 0, 0.7], [0.15, -0.06, 0.54], 0.065, copper);
    box(0.13, -0.08, 0.51, 0.11, 0.04, 0.2, copper);
    for (let index = 0; index < 7; index++) {
      const angle = index / 6 * Math.PI;
      beam([Math.cos(angle) * 0.04, 0, 0.85], [Math.cos(angle) * 0.12, 0, 0.85 + Math.sin(angle) * 0.13], 0.012, copper);
    }
  } else if (kind === "christ-redeemer") {
    box(0, 0, 0, 0.4, 0.33, 0.1, stone);
    rings(0, 0, [[0.1, 0.14], [0.64, 0.09], [0.69, 0.06]], white, 6, 0.7);
    beam([-0.44, 0, 0.63], [0.44, 0, 0.63], 0.095, white);
    dome(0, 0, 0.69, 0.06, 0.13, white);
  } else if (kind === "sydney-opera") {
    box(0, 0, 0, 1.1, 0.62, 0.08, stone);
    for (const [x, y, size] of [[-0.29, 0.13, 0.46], [0.03, 0.13, 0.55], [0.31, 0.13, 0.39], [-0.15, -0.16, 0.37], [0.2, -0.16, 0.43]]) {
      for (let index = 0; index < 6; index++) {
        const a = index / 6 * Math.PI, b = (index + 1) / 6 * Math.PI;
        quad([x - size * 0.34, y + Math.cos(a) * size * 0.32, 0.08 + Math.sin(a) * size],
          [x - size * 0.34, y + Math.cos(b) * size * 0.32, 0.08 + Math.sin(b) * size],
          [x + size * 0.45, y, 0.08], [x + size * 0.45, y, 0.08], white);
      }
    }
  }
  // One normalized, bounded CPU buffer per model. Its origin remains the exact
  // catalog anchor; only its drawing scale is exaggerated in the atlas view.
  const extent = Math.max(...vertices.filter((_, index) => index % 6 < 3).map(Math.abs));
  const divisor = Math.max(1, extent);
  return new Float32Array(vertices.map((value, index) => index % 6 < 3 ? value / divisor : value));
}
