import { getGarageNodeMatrix, inverseGaragePoint, setGarageNodeWorldMatrix, transformGaragePoint } from "./garage-scene-model.mjs";

/** @typedef {import('./garage-scene-types').GarageScene} GarageScene */
/** @typedef {import('./garage-scene-types').GaragePoint} GaragePoint */
/** @typedef {'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'} GarageResizeHandle */
/** @type {{id: GarageResizeHandle, x: number, y: number}[]} */
export const GARAGE_RESIZE_HANDLES = [
  { id: "nw", x: 0, y: 0 }, { id: "n", x: .5, y: 0 }, { id: "ne", x: 1, y: 0 }, { id: "e", x: 1, y: .5 },
  { id: "se", x: 1, y: 1 }, { id: "s", x: .5, y: 1 }, { id: "sw", x: 0, y: 1 }, { id: "w", x: 0, y: .5 },
];
const factor = value => Math.abs(value) < .001 ? (value < 0 ? -.001 : .001) : Math.max(-1000, Math.min(1000, value));

/** The opposite edge/corner stays fixed, including through arbitrary affine parents.
 * Pointer coordinates are world coordinates; dimensions and hierarchy are unchanged.
 * @param {GarageScene} scene @param {string} id @param {GarageResizeHandle} handleId
 * @param {GaragePoint} pointer @param {{proportional?:boolean}} [options] */
export function resizeGarageNode(scene, id, handleId, pointer, { proportional = false } = {}) {
  const node = scene.nodes.find(item => item.id === id), handle = GARAGE_RESIZE_HANDLES.find(item => item.id === handleId);
  if (!node || !handle) throw new Error("Слой или ручка растягивания не найдены.");
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) throw new Error("Неверная точка растягивания.");
  const matrix = getGarageNodeMatrix(scene, id), local = inverseGaragePoint(matrix, pointer);
  const anchor = { x: (1 - handle.x) * node.width, y: (1 - handle.y) * node.height };
  let sx = handle.x === .5 ? 1 : factor((local.x - anchor.x) / (handle.x * node.width - anchor.x));
  let sy = handle.y === .5 ? 1 : factor((local.y - anchor.y) / (handle.y * node.height - anchor.y));
  if (proportional) {
    const dominant = handle.x === .5 ? sy : handle.y === .5 ? sx : Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    sx = dominant; sy = dominant;
  }
  const [a, b, c, d, e, f] = matrix;
  return setGarageNodeWorldMatrix(scene, id, [a * sx, b * sx, c * sy, d * sy,
    e + a * anchor.x * (1 - sx) + c * anchor.y * (1 - sy),
    f + b * anchor.x * (1 - sx) + d * anchor.y * (1 - sy)]);
}

/** Rotation is around the authored pivot, applied in world space so stretched
 * or reflected parents cannot turn a circular drag into an elliptical one.
 * @param {GarageScene} scene @param {string} id @param {GaragePoint} start
 * @param {GaragePoint} pointer @param {{snap?:boolean}} [options] */
export function rotateGarageNode(scene, id, start, pointer, { snap = false } = {}) {
  const node = scene.nodes.find(item => item.id === id);
  if (!node) throw new Error("Слой не найден.");
  if (![start.x, start.y, pointer.x, pointer.y].every(Number.isFinite)) throw new Error("Неверная точка поворота.");
  const matrix = getGarageNodeMatrix(scene, id), pivot = transformGaragePoint(matrix, { x: node.pivotX * node.width, y: node.pivotY * node.height });
  if (Math.hypot(start.x - pivot.x, start.y - pivot.y) < 1e-7 || Math.hypot(pointer.x - pivot.x, pointer.y - pivot.y) < 1e-7) return scene;
  let delta = Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x) - Math.atan2(start.y - pivot.y, start.x - pivot.x);
  if (snap) {
    const angle = Math.atan2(matrix[1], matrix[0]);
    const step = Math.PI / 12;
    delta = Math.round((angle + delta) / step) * step - angle;
  }
  const cosine = Math.cos(delta), sine = Math.sin(delta), [a, b, c, d, e, f] = matrix;
  return setGarageNodeWorldMatrix(scene, id, [cosine * a - sine * b, sine * a + cosine * b,
    cosine * c - sine * d, sine * c + cosine * d,
    pivot.x + cosine * (e - pivot.x) - sine * (f - pivot.y),
    pivot.y + sine * (e - pivot.x) + cosine * (f - pivot.y)]);
}

/** Uniform world-space scaling keeps the authored pivot fixed even through affine parents.
 * @param {GarageScene} scene @param {string} id @param {GaragePoint} start
 * @param {GaragePoint} pointer @param {{snap?:boolean}} [options] */
export function scaleGarageNodeAroundPivot(scene, id, start, pointer, { snap = false } = {}) {
  const node = scene.nodes.find(item => item.id === id);
  if (!node) throw new Error("Слой не найден.");
  if (![start.x, start.y, pointer.x, pointer.y].every(Number.isFinite)) throw new Error("Неверная точка масштабирования.");
  const matrix = getGarageNodeMatrix(scene, id);
  const pivot = transformGaragePoint(matrix, { x: node.pivotX * node.width, y: node.pivotY * node.height });
  const initial = Math.hypot(start.x - pivot.x, start.y - pivot.y);
  if (initial < 1e-7) return scene;
  let ratio = Math.hypot(pointer.x - pivot.x, pointer.y - pivot.y) / initial;
  if (snap) ratio = Math.round(ratio * 10) / 10;
  ratio = Math.max(.001, Math.min(1000, ratio));
  if (Math.abs(ratio - 1) < 1e-12) return scene;
  const [a, b, c, d, e, f] = matrix;
  return setGarageNodeWorldMatrix(scene, id, [a * ratio, b * ratio, c * ratio, d * ratio,
    pivot.x + (e - pivot.x) * ratio, pivot.y + (f - pivot.y) * ratio]);
}

/** @param {GarageScene} scene @param {string} id @param {GaragePoint} point */
export function pointInsideGarageNode(scene, id, point) {
  const node = scene.nodes.find(item => item.id === id);
  if (!node) return false;
  const local = inverseGaragePoint(getGarageNodeMatrix(scene, id), point);
  return local.x >= 0 && local.y >= 0 && local.x <= node.width && local.y <= node.height;
}

/** Readable screen-size handles even when artwork is mirrored or skewed.
 * @param {GarageScene} scene @param {string} id @param {number} [screenScale] */
export function garageTransformHandles(scene, id, screenScale = 1) {
  const node = scene.nodes.find(item => item.id === id);
  if (!node) return null;
  const matrix = getGarageNodeMatrix(scene, id), center = transformGaragePoint(matrix, { x: node.width / 2, y: node.height / 2 });
  const top = transformGaragePoint(matrix, { x: node.width / 2, y: 0 });
  let nx = -matrix[1], ny = matrix[0];
  if (nx * (top.x - center.x) + ny * (top.y - center.y) < 0) { nx *= -1; ny *= -1; }
  const length = Math.hypot(nx, ny) || 1, distance = 32 / Math.max(.001, screenScale);
  return { handles: GARAGE_RESIZE_HANDLES.map(handle => ({ ...handle, ...transformGaragePoint(matrix, { x: handle.x * node.width, y: handle.y * node.height }) })),
    top, rotation: { x: top.x + nx / length * distance, y: top.y + ny / length * distance }, center };
}
