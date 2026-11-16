/** @typedef {import('./garage-scene-types').GarageScene} GarageScene */
/** @typedef {import('./garage-scene-types').GarageNode} GarageNode */
/** @typedef {import('./garage-scene-types').GaragePoint} GaragePoint */
/** @typedef {import('./garage-scene-types').GarageOcclusion} GarageOcclusion */

const EPSILON = 1e-10;

/** @param {GaragePoint} a @param {GaragePoint} b @param {GaragePoint} c */
function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }

/** @param {GaragePoint} a @param {GaragePoint} b @param {GaragePoint} p */
function onSegment(a, b, p) {
  return Math.abs(cross(a, b, p)) <= EPSILON && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
    && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}

/** @param {GaragePoint} a @param {GaragePoint} b @param {GaragePoint} c @param {GaragePoint} d */
function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON)))
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Checks imported and edited polygons without mutating their points.
 * Concave outlines and extra points on straight edges are supported.
 * @param {unknown} input @returns {string|null} */
export function garageOcclusionPolygonProblem(input) {
  if (!Array.isArray(input) || input.length < 3 || input.length > 64) return "Контур борта должен содержать от 3 до 64 точек.";
  for (const point of input) {
    if (!point || typeof point !== "object" || Array.isArray(point) || typeof point.x !== "number" || typeof point.y !== "number"
      || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)
      return "Точки контура борта должны находиться внутри изображения: X и Y от 0 до 1.";
  }
  const points = /** @type {GaragePoint[]} */ (input);
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length], c = points[(index + 2) % points.length];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-8) return "Соседние точки контура борта не должны совпадать.";
    if (Math.abs(cross(a, b, c)) <= EPSILON && (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) > EPSILON)
      return "Рёбра контура борта не должны накладываться друг на друга.";
    area += a.x * b.y - b.x * a.y;
    for (let other = index + 1; other < points.length; other++) {
      if (other === index + 1 || (index === 0 && other === points.length - 1)) continue;
      if (segmentsIntersect(a, b, points[other], points[(other + 1) % points.length])) return "Контур борта не должен пересекать сам себя.";
    }
  }
  if (Math.abs(area) <= EPSILON) return "Контур борта должен иметь ненулевую площадь.";
  return null;
}

/** @returns {GarageOcclusion} */
export function defaultGarageOcclusion() {
  return { enabled: true, points: [{ x: 0, y: .58 }, { x: 1, y: .58 }, { x: 1, y: 1 }, { x: 0, y: 1 }], targetIds: [] };
}

/** @param {Map<string, GarageNode>} byId @param {string} id @returns {Set<string>} */
function ancestors(byId, id) {
  const result = new Set();
  for (let node = byId.get(id); node && !result.has(node.id); node = node.parentId ? byId.get(node.parentId) : undefined) result.add(node.id);
  return result;
}

/** Returns selectable targets. An owner cannot mask itself or a group containing it.
 * @param {GarageScene} scene @param {string} ownerId @returns {string[]} */
export function garageOcclusionTargetIds(scene, ownerId) {
  const byId = new Map(scene.nodes.map(node => [node.id, node]));
  if (!byId.has(ownerId)) return [];
  const forbidden = ancestors(byId, ownerId);
  return scene.nodes.filter(node => !forbidden.has(node.id)).map(node => node.id);
}

/** Targeting a group clips its children too. Hidden owners never hide other art.
 * Mask source artwork is rendered directly, without recursively applying masks.
 * @param {GarageScene} scene @param {string} nodeId @returns {GarageNode[]} */
export function garageOccludersForNode(scene, nodeId) {
  const byId = new Map(scene.nodes.map(node => [node.id, node]));
  const targets = ancestors(byId, nodeId);
  if (!targets.size) return [];
  return scene.nodes.filter(owner => owner.occlusion?.enabled && owner.occlusion.targetIds.some(id => targets.has(id))
    && [...ancestors(byId, owner.id)].every(id => byId.get(id)?.visible));
}
