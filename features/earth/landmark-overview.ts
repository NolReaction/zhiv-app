export type EarthLandmarkBounds = {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
};

/** Height-only source normalization makes broad buildings dwarf slender towers
 * when viewed from above. Fit both the full footprint (at any heading) and
 * height into one atlas unit, uniformly; real street metres remain untouched. */
export function earthLandmarkOverviewScale(bounds: EarthLandmarkBounds): number {
  const spans = bounds.max.map((value, axis) => value - bounds.min[axis]);
  if (![...bounds.min, ...bounds.max, ...spans].every(Number.isFinite) || spans.some(value => value < 0)) return 1;
  const extent = Math.max(Math.hypot(spans[0], spans[1]), spans[2]);
  return extent > 1e-6 ? 1 / extent : 1;
}

/** Used once for fixed fallback meshes or legacy assets without manifest bounds. */
export function earthLandmarkVertexBounds(vertices: Float32Array, stride: number): EarthLandmarkBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  if (Number.isInteger(stride) && stride >= 3 && vertices.length % stride === 0) {
    for (let index = 0; index < vertices.length; index += stride) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], vertices[index + axis]);
        max[axis] = Math.max(max[axis], vertices[index + axis]);
      }
    }
  }
  return { min, max };
}
