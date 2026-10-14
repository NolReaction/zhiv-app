// Shared by the browser editor and Tiled/patch compiler; no DOM or Node imports.
export const FOREST_RECEIVER_MAX_HOLES = 16;
export const FOREST_RECEIVER_MAX_VERTICES = 64;
const epsilon = 1e-9;
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (a, b, point) => Math.abs(cross(a, b, point)) < epsilon
  && point.x >= Math.min(a.x, b.x) - epsilon && point.x <= Math.max(a.x, b.x) + epsilon
  && point.y >= Math.min(a.y, b.y) - epsilon && point.y <= Math.max(a.y, b.y) + epsilon;
function intersects(a, b, c, d) {
  const signs = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)]
    .map(value => Math.abs(value) < epsilon ? 0 : Math.sign(value));
  return signs[0] * signs[1] < 0 && signs[2] * signs[3] < 0
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function inside(point, polygon) {
  let result = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous], b = polygon[index];
    if (onSegment(a, b, point)) return false;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
function contoursIntersect(first, second) {
  return first.some((a, index) => second.some((c, other) =>
    intersects(a, first[(index + 1) % first.length], c, second[(other + 1) % second.length])));
}
function polygonError(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length > FOREST_RECEIVER_MAX_VERTICES)
    return "В исключении должно быть от 3 до 64 вершин.";
  if (points.some(point => !point || typeof point !== "object" || Array.isArray(point)
    || Object.keys(point).some(key => key !== "x" && key !== "y") || !Number.isFinite(point.x) || !Number.isFinite(point.y)))
    return "Вершины исключения должны иметь числовые координаты x и y.";
  if (new Set(points.map(point => `${point.x},${point.y}`)).size !== points.length)
    return "Вершины исключения не должны совпадать.";
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(area) <= 1e-6) return "Исключение должно иметь ненулевую площадь.";
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length], c = points[(index + 2) % points.length];
    if (Math.abs(cross(a, b, c)) < epsilon && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0)
      return "Рёбра исключения не должны перекрываться.";
    for (let other = index + 1; other < points.length; other++) {
      if ((index + 1) % points.length === other || (other + 1) % points.length === index) continue;
      if (intersects(a, b, points[other], points[(other + 1) % points.length]))
        return "Исключение не должно пересекать само себя.";
    }
  }
  return null;
}

/** Outer geometry is validated by the caller; exclusions must be simple, strictly
 * contained and disjoint. Touching edges are rejected to keep winding unambiguous. */
export function validateForestReceiverHoles(points, holes) {
  if (holes === undefined) return null;
  if (!Array.isArray(holes) || holes.length > FOREST_RECEIVER_MAX_HOLES)
    return "У поверхности может быть не больше 16 исключений.";
  for (let index = 0; index < holes.length; index++) {
    const hole = holes[index], error = polygonError(hole);
    if (error) return error;
    if (!hole.every(point => inside(point, points)) || contoursIntersect(hole, points))
      return "Исключение должно находиться строго внутри поверхности и не касаться её края.";
    for (let other = 0; other < index; other++) {
      const previous = holes[other];
      if (contoursIntersect(hole, previous) || inside(hole[0], previous) || inside(previous[0], hole))
        return "Исключения не должны пересекаться, касаться или находиться друг внутри друга.";
    }
  }
  return null;
}
