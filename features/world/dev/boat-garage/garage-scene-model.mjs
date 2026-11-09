/** @typedef {import('./garage-scene-types').GarageScene} GarageScene */
/** @typedef {import('./garage-scene-types').GarageNode} GarageNode */
/** @typedef {import('./garage-scene-types').GarageMatrix} GarageMatrix */
/** @typedef {import('./garage-scene-types').GaragePoint} GaragePoint */
/** @typedef {import('./garage-scene-types').GarageViewportMode} GarageViewportMode */

import { garageOcclusionPolygonProblem, garageOcclusionTargetIds } from "./garage-occlusion.mjs";

/** @type {GarageMatrix} */
const IDENTITY = [1, 0, 0, 1, 0, 0];
export const GARAGE_MAX_DEPTH = 100_000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SHIPPED_SIDE_SOURCE_PATTERN = /^\/world\/boat\/modular\/(?:(?:hull|engine|tank)_l[0-5]|fuel_hose_aligned)\.svg$/;
const SOURCE_PATTERN = /^\/world\/boat-garage\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|webp|jpe?g)$/i;

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: ожидается объект.`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} label @param {number} min @param {number} max */
function number(value, label, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label}: ожидается число от ${min} до ${max}.`);
  return value;
}

/** @param {unknown} value @param {string} label @param {number} max */
function text(value, label, max = 120) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max)
    throw new Error(`${label}: ожидается непустая строка длиной до ${max} символов.`);
  return value;
}

/** @param {unknown} value @param {string} label */
function id(value, label) {
  const result = text(value, label, 80);
  if (!ID_PATTERN.test(result)) throw new Error(`${label}: недопустимый идентификатор.`);
  return result;
}

/** @param {unknown} value @param {string} label */
function nullableId(value, label) { return value === null ? null : id(value, label); }

/** @param {unknown} value @param {string} label */
function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label}: ожидается логическое значение.`);
  return value;
}

/** @param {unknown} value @param {string} label @param {number} limit @returns {unknown[]} */
function list(value, label, limit) {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label}: допускается не больше ${limit} элементов.`);
  return value;
}

/** @param {{id: string}[]} items @param {string} label */
function unique(items, label) {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`${label}: идентификаторы должны быть уникальны.`);
}

/** Validate imports and create an owned copy; unknown fields are never persisted.
 * @param {unknown} input @returns {GarageScene} */
export function validateGarageScene(input) {
  const scene = record(input, "Сцена");
  if (scene.schemaVersion !== 1) throw new Error("Неподдерживаемая версия сцены гаража.");
  const canvas = record(scene.canvas, "Холст"), cameras = record(scene.cameras, "Камеры");
  const camera = mode => {
    const value = record(cameras[mode], `Камера ${mode}`);
    return { x: number(value.x, "Камера X", -200_000, 200_000), y: number(value.y, "Камера Y", -200_000, 200_000),
      width: number(value.width, "Ширина камеры", 1, 40_000) };
  };
  const assets = list(scene.assets, "Изображения", 64).map((value, index) => {
    const asset = record(value, `Изображение ${index + 1}`), src = text(asset.src, "Путь изображения", 240);
    if ((!SOURCE_PATTERN.test(src) && !SHIPPED_SIDE_SOURCE_PATTERN.test(src)) || src.includes("..")) throw new Error("Изображения должны быть PNG, WebP или JPEG из /world/boat-garage/ либо готовыми SVG-модулями лодки.");
    return { id: id(asset.id, "ID изображения"), name: text(asset.name, "Название изображения"), src,
      width: number(asset.width, "Ширина изображения", 1, 20_000), height: number(asset.height, "Высота изображения", 1, 20_000) };
  });
  const nodes = list(scene.nodes, "Слои", 128).map((value, index) => {
    const node = record(value, `Слой ${index + 1}`);
    const sockets = list(node.sockets, "Крепления", 32).map(value => {
      const socket = record(value, "Крепление");
      return { id: id(socket.id, "ID крепления"), name: text(socket.name, "Название крепления"),
        x: number(socket.x, "Крепление X", 0, 1), y: number(socket.y, "Крепление Y", 0, 1) };
    });
    unique(sockets, "Крепления слоя");
    const zIndex = number(node.zIndex, "Порядок слоя", -GARAGE_MAX_DEPTH, GARAGE_MAX_DEPTH);
    if (!Number.isInteger(zIndex)) throw new Error("Порядок слоя должен быть целым числом.");
    let occlusion;
    if (node.occlusion !== undefined) {
      const value = record(node.occlusion, "Перекрытие бортом");
      const points = list(value.points, "Точки контура борта", 64).map(value => {
        const point = record(value, "Точка контура борта");
        return { x: number(point.x, "Контур борта X", 0, 1), y: number(point.y, "Контур борта Y", 0, 1) };
      });
      const problem = garageOcclusionPolygonProblem(points);
      if (problem) throw new Error(problem);
      const targetIds = list(value.targetIds, "Предметы за бортом", 128).map(value => id(value, "Предмет за бортом"));
      if (new Set(targetIds).size !== targetIds.length) throw new Error("Предметы за бортом не должны повторяться.");
      occlusion = { enabled: boolean(value.enabled, "Видимость перекрытия бортом"), points, targetIds };
    }
    return { id: id(node.id, "ID слоя"), name: text(node.name, "Название слоя"), assetId: nullableId(node.assetId, "Изображение слоя"),
      parentId: nullableId(node.parentId, "Родитель слоя"), socketId: nullableId(node.socketId, "Крепление слоя"),
      x: number(node.x, "Слой X", -200_000, 200_000), y: number(node.y, "Слой Y", -200_000, 200_000),
      width: number(node.width, "Ширина слоя", .001, 20_000), height: number(node.height, "Высота слоя", .001, 20_000),
      scale: number(node.scale, "Масштаб слоя", .001, 100), rotation: number(node.rotation, "Поворот слоя", -36_000, 36_000),
      ...(node.scaleX === undefined ? {} : { scaleX: number(node.scaleX, "Ширина слоя по X", .001, 1000) }),
      ...(node.scaleY === undefined ? {} : { scaleY: number(node.scaleY, "Высота слоя по Y", .001, 1000) }),
      ...(node.flipX === undefined ? {} : { flipX: boolean(node.flipX, "Отражение X") }),
      ...(node.flipY === undefined ? {} : { flipY: boolean(node.flipY, "Отражение Y") }),
      ...(node.skewX === undefined ? {} : { skewX: number(node.skewX, "Наклон перспективы", -89.9999, 89.9999) }),
      pivotX: number(node.pivotX, "Опора X", 0, 1), pivotY: number(node.pivotY, "Опора Y", 0, 1), zIndex,
      visible: boolean(node.visible, "Видимость слоя"), locked: boolean(node.locked, "Блокировка слоя"), sockets,
      ...(occlusion ? { occlusion } : {}) };
  });
  unique(assets, "Изображения"); unique(nodes, "Слои");
  const byId = new Map(nodes.map(node => [node.id, node])), assetIds = new Set(assets.map(asset => asset.id));
  for (const node of nodes) {
    if (node.assetId !== null && !assetIds.has(node.assetId)) throw new Error(`Слой «${node.name}» ссылается на неизвестное изображение.`);
    if (node.parentId !== null && !byId.has(node.parentId)) throw new Error(`Слой «${node.name}» ссылается на неизвестного родителя.`);
    if (node.socketId !== null && !byId.get(node.parentId)?.sockets.some(socket => socket.id === node.socketId))
      throw new Error(`Слой «${node.name}» ссылается на неизвестное крепление родителя.`);
    const visited = new Set([node.id]);
    let parentId = node.parentId, worldScale = node.scale;
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error("В иерархии слоёв обнаружен цикл.");
      visited.add(parentId);
      const parent = byId.get(parentId);
      worldScale *= parent?.scale ?? 1;
      parentId = parent?.parentId ?? null;
    }
    if (worldScale < 1e-6 || worldScale > 1e6) throw new Error("Суммарный масштаб вложенных слоёв выходит за допустимые пределы.");
  }
  let waterPreview;
  if (scene.waterPreview !== undefined) {
    const value = record(scene.waterPreview, "Предпросмотр воды");
    const rootId = id(value.rootId, "Группа лодки на воде");
    if (!byId.has(rootId)) throw new Error("Группа лодки на воде не найдена.");
    waterPreview = { rootId, waterlineY: number(value.waterlineY, "Линия воды", -200_000, 200_000),
      beam: number(value.beam, "Длина опоры на воде", 1, 40_000), amplitude: number(value.amplitude, "Высота волн", 0, 30),
      ...(value.effectsEnabled === undefined ? {} : { effectsEnabled: boolean(value.effectsEnabled, "Эффекты у корпуса") }),
      ...(value.effectOpacity === undefined ? {} : { effectOpacity: number(value.effectOpacity, "Интенсивность эффектов", 0, 1) }),
      ...(value.effectOffsetY === undefined ? {} : { effectOffsetY: number(value.effectOffsetY, "Смещение эффектов по Y", -2000, 2000) }),
      ...(value.immersionEnabled === undefined ? {} : { immersionEnabled: boolean(value.immersionEnabled, "Эффект погружения") }) };
  }
  const result = { schemaVersion: 1, canvas: { width: number(canvas.width, "Ширина холста", 1, 20_000),
    height: number(canvas.height, "Высота холста", 1, 20_000) }, cameras: { portrait: camera("portrait"), landscape: camera("landscape") }, assets, nodes,
    ...(waterPreview ? { waterPreview } : {}) };
  for (const node of nodes) {
    if (!node.occlusion) continue;
    if (node.assetId === null) throw new Error("Контур борта можно задать только слою с изображением.");
    const allowed = new Set(garageOcclusionTargetIds(result, node.id));
    for (const targetId of node.occlusion.targetIds) {
      if (!byId.has(targetId)) throw new Error(`Контур борта «${node.name}» ссылается на неизвестный предмет.`);
      if (!allowed.has(targetId)) throw new Error("Контур борта не может скрывать свой слой или его родительскую группу.");
    }
  }
  for (const node of nodes) {
    const [a, b, c, d] = getGarageNodeMatrix(result, node.id);
    const maximum = (Math.hypot(a + d, b - c) + Math.hypot(a - d, b + c)) / 2;
    const minimum = Math.abs(a * d - b * c) / maximum;
    if (!Number.isFinite(maximum) || minimum < 1e-6 || maximum > 1e6)
      throw new Error("Суммарный масштаб вложенных слоёв выходит за допустимые пределы.");
  }
  return /** @type {GarageScene} */ (result);
}

/** @param {GarageMatrix} left @param {GarageMatrix} right @returns {GarageMatrix} */
function multiply(left, right) {
  const [a, b, c, d, e, f] = left, [g, h, i, j, k, l] = right;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}

/** @param {GarageNode} node @returns {GarageMatrix} */
function localMatrix(node) {
  const angle = node.rotation * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
  const sx = node.scale * (node.scaleX ?? 1) * (node.flipX ? -1 : 1);
  const sy = node.scale * (node.scaleY ?? 1) * (node.flipY ? -1 : 1);
  const shear = Math.tan((node.skewX ?? 0) * Math.PI / 180);
  const a = cosine * sx, b = sine * sx, c = (cosine * shear - sine) * sy, d = (sine * shear + cosine) * sy;
  return [a, b, c, d, node.x - a * node.pivotX * node.width - c * node.pivotY * node.height,
    node.y - b * node.pivotX * node.width - d * node.pivotY * node.height];
}

/** @param {GarageMatrix} matrix @param {GaragePoint} point @returns {GaragePoint} */
export function transformGaragePoint(matrix, point) {
  return { x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5] };
}

/** @param {GarageMatrix} matrix @returns {GarageMatrix} */
function inverseMatrix(matrix) {
  const [a, b, c, d, e, f] = matrix, determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-20) throw new Error("Невозможно обратить преобразование слоя.");
  return [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}

/** @param {GarageMatrix} matrix @param {GaragePoint} point @returns {GaragePoint} */
export function inverseGaragePoint(matrix, point) { return transformGaragePoint(inverseMatrix(matrix), point); }

/** @param {GarageScene} scene @param {GarageNode} node @param {Set<string>} visited @returns {GarageMatrix} */
function parentMatrix(scene, node, visited) {
  if (node.parentId === null) {
    if (node.socketId !== null) throw new Error("Корневой слой не может иметь крепление родителя.");
    return [...IDENTITY];
  }
  const parent = scene.nodes.find(candidate => candidate.id === node.parentId);
  if (!parent) throw new Error("Родитель слоя не найден.");
  let matrix = worldMatrix(scene, parent, visited);
  if (node.socketId !== null) {
    const socket = parent.sockets.find(candidate => candidate.id === node.socketId);
    if (!socket) throw new Error("Крепление родителя не найдено.");
    matrix = multiply(matrix, [1, 0, 0, 1, socket.x * parent.width, socket.y * parent.height]);
  }
  return matrix;
}

/** @param {GarageScene} scene @param {GarageNode} node @param {Set<string>} visited @returns {GarageMatrix} */
function worldMatrix(scene, node, visited) {
  if (visited.has(node.id)) throw new Error("В иерархии слоёв обнаружен цикл.");
  const path = new Set(visited); path.add(node.id);
  return multiply(parentMatrix(scene, node, path), localMatrix(node));
}

/** Includes the parent's socket translation, so local pointer deltas work for attached nodes.
 * @param {GarageScene} scene @param {GarageNode} node @returns {GarageMatrix} */
export function getGarageParentMatrix(scene, node) { return parentMatrix(scene, node, new Set([node.id])); }

/** @param {GarageScene} scene @param {string} id @returns {GarageMatrix} */
export function getGarageNodeMatrix(scene, id) {
  const node = scene.nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error("Слой не найден.");
  return worldMatrix(scene, node, new Set());
}

/** @param {GarageScene} scene @param {string} id @returns {GarageScene} */
export function duplicateGarageNode(scene, id) {
  const source = scene.nodes.find(node => node.id === id);
  if (!source) throw new Error("Слой не найден.");
  if (scene.nodes.length >= 128) throw new Error("В сцене допускается не больше 128 слоёв.");
  let index = 2, nextId = `${id.slice(0, 65)}-copy`;
  while (scene.nodes.some(node => node.id === nextId)) nextId = `${id.slice(0, 60)}-copy-${index++}`;
  const duplicate = { ...source, id: nextId, name: `${source.name.slice(0, 110)} · копия`,
    x: source.x + 24, y: source.y + 24, locked: false, sockets: source.sockets.map(socket => ({ ...socket })) };
  return validateGarageScene({ ...scene, nodes: [...scene.nodes, duplicate] });
}

/** A root and its attached descendants, independently of their draw order.
 * @param {GarageScene} scene @param {string|undefined} rootId @returns {Set<string>} */
export function garageBranchIds(scene, rootId) {
  const ids = new Set();
  if (!scene.nodes.some(node => node.id === rootId)) return ids;
  ids.add(rootId);
  for (let previous = -1; previous !== ids.size;) {
    previous = ids.size;
    for (const node of scene.nodes) if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  }
  return ids;
}

/** @param {GarageScene} scene @param {string} id @returns {GarageScene} */
export function removeGarageNode(scene, id) {
  const removed = garageBranchIds(scene, id);
  const result = { ...scene, nodes: scene.nodes.filter(node => !removed.has(node.id)) };
  result.nodes = result.nodes.map(node => node.occlusion && node.occlusion.targetIds.some(id => removed.has(id))
    ? { ...node, occlusion: { ...node.occlusion, targetIds: node.occlusion.targetIds.filter(id => !removed.has(id)) } } : node);
  if (result.waterPreview && removed.has(result.waterPreview.rootId)) delete result.waterPreview;
  return result;
}

/** Reparent without jumping: express the original world transform in the new parent space.
 * @param {GarageScene} scene @param {string} id @param {string|null} parentId
 * @param {string|null} socketId @returns {GarageScene} */
export function reparentGarageNode(scene, id, parentId, socketId = null) {
  const node = scene.nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error("Слой не найден.");
  const candidate = { ...node, parentId, socketId };
  const hierarchy = { ...scene, nodes: scene.nodes.map(value => value.id === id ? candidate : value) };
  const parent = getGarageParentMatrix(hierarchy, candidate);
  const local = multiply(inverseMatrix(parent), getGarageNodeMatrix(scene, id));
  const changed = nodeWithLocalMatrix(candidate, local);
  return validateGarageScene({ ...scene, nodes: scene.nodes.map(value => value.id === id ? changed : value) });
}

/** Canonical QR decomposition also preserves reflection and shear induced by a
 * rotated nonuniform parent. A scale/rotation-only decomposition loses pixels.
 * @param {GarageNode} node @param {GarageMatrix} matrix @returns {GarageNode} */
function nodeWithLocalMatrix(node, matrix) {
  const [a, b, c, d, e, f] = matrix, sx = Math.hypot(a, b), determinant = a * d - b * c;
  if (sx < 1e-12 || Math.abs(determinant) < 1e-20) throw new Error("Невозможно подогнать вырожденный слой.");
  const sy = determinant / sx, shear = (a * c + b * d) / determinant;
  const scale = Math.max(.001, Math.min(100, Math.sqrt(sx * Math.abs(sy))));
  return { ...node, scale, scaleX: sx / scale, scaleY: Math.abs(sy) / scale,
    flipX: false, flipY: sy < 0, skewX: Math.atan(shear) * 180 / Math.PI,
    rotation: Math.atan2(b, a) * 180 / Math.PI,
    x: e + a * node.pivotX * node.width + c * node.pivotY * node.height,
    y: f + b * node.pivotX * node.width + d * node.pivotY * node.height };
}

/** Apply an authored world transform without losing the node's parent, socket,
 * pivot or children. Resize/rotation handles may operate in world coordinates
 * even when an ancestor has a nonuniform scale, reflection or shear.
 * @param {GarageScene} scene @param {string} id @param {GarageMatrix} matrix
 * @returns {GarageScene} */
export function setGarageNodeWorldMatrix(scene, id, matrix) {
  const node = scene.nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error("Слой не найден.");
  if (node.locked) throw new Error("Сначала открепите слой.");
  if (!Array.isArray(matrix) || matrix.length !== 6 || matrix.some(value => typeof value !== "number" || !Number.isFinite(value)))
    throw new Error("Преобразование слоя должно содержать шесть конечных чисел.");
  const previous = getGarageNodeMatrix(scene, id);
  if (matrix.every((value, index) => value === previous[index])) return scene;
  const local = multiply(inverseMatrix(getGarageParentMatrix(scene, node)), matrix);
  const changed = nodeWithLocalMatrix(node, local);
  return validateGarageScene({ ...scene, nodes: scene.nodes.map(item => item.id === id ? changed : item) });
}

/** Change the normalized pivot while preserving the complete image and children.
 * @param {GarageScene} scene @param {string} id @param {GaragePoint} pivot @returns {GarageScene} */
export function moveGaragePivot(scene, id, pivot) {
  const node = scene.nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error("Слой не найден.");
  if (node.locked) throw new Error("Сначала открепите слой.");
  const pivotX = number(pivot.x, "Опора X", 0, 1), pivotY = number(pivot.y, "Опора Y", 0, 1);
  const [a, b, c, d] = localMatrix(node), dx = (pivotX - node.pivotX) * node.width, dy = (pivotY - node.pivotY) * node.height;
  const changed = { ...node, pivotX, pivotY, x: node.x + a * dx + c * dy, y: node.y + b * dx + d * dy };
  return validateGarageScene({ ...scene, nodes: scene.nodes.map(item => item.id === id ? changed : item) });
}

/** A one-shot world fit keeps supports independent of the hull hierarchy.
 * Source coordinates are image pixels; target coordinates are world pixels.
 * The existing fitted shape is rotated/scaled as a whole, never reset.
 * @param {GarageScene} scene @param {string} id
 * @param {[GaragePoint, GaragePoint]} source @param {[GaragePoint, GaragePoint]} target
 * @returns {GarageScene} */
export function alignGarageNodeToPoints(scene, id, source, target) {
  const node = scene.nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error("Слой не найден.");
  if (node.locked) throw new Error("Сначала открепите слой.");
  for (const point of [...source, ...target]) {
    number(point.x, "Точка X", -200_000, 200_000); number(point.y, "Точка Y", -200_000, 200_000);
  }
  const world = getGarageNodeMatrix(scene, id), from = source.map(point => transformGaragePoint(world, point));
  const dx = from[1].x - from[0].x, dy = from[1].y - from[0].y;
  const tx = target[1].x - target[0].x, ty = target[1].y - target[0].y, lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12 || tx * tx + ty * ty < 1e-12) throw new Error("Для подгонки выберите две разные точки.");
  const a = (tx * dx + ty * dy) / lengthSquared, b = (ty * dx - tx * dy) / lengthSquared;
  const fit = /** @type {GarageMatrix} */ ([a, b, -b, a,
    target[0].x - a * from[0].x + b * from[0].y, target[0].y - b * from[0].x - a * from[0].y]);
  const local = multiply(inverseMatrix(getGarageParentMatrix(scene, node)), multiply(fit, world));
  const changed = nodeWithLocalMatrix(node, local);
  return validateGarageScene({ ...scene, nodes: scene.nodes.map(item => item.id === id ? changed : item) });
}

/** Align a source socket (or pivot when null) to a target socket/pivot without
 * changing parent, scale, rotation or reflection. Supports do not follow boats.
 * @param {GarageScene} scene @param {string} id @param {string|null} sourceSocketId
 * @param {string} targetId @param {string|null} targetSocketId @returns {GarageScene} */
export function alignGarageNodeToSocket(scene, id, sourceSocketId, targetId, targetSocketId) {
  const node = scene.nodes.find(candidate => candidate.id === id), target = scene.nodes.find(candidate => candidate.id === targetId);
  if (!node || !target) throw new Error("Слой не найден.");
  if (node.locked) throw new Error("Сначала открепите слой.");
  let ancestor = target;
  while (ancestor) {
    if (ancestor.id === id) throw new Error("Точка назначения не может находиться на самом слое или его потомке.");
    ancestor = scene.nodes.find(candidate => candidate.id === ancestor.parentId);
  }
  const sourcePoint = garageNodeContactPoint(node, sourceSocketId), targetPoint = garageNodeContactPoint(target, targetSocketId);
  const from = transformGaragePoint(getGarageNodeMatrix(scene, id), sourcePoint);
  const to = transformGaragePoint(getGarageNodeMatrix(scene, targetId), targetPoint);
  const parent = getGarageParentMatrix(scene, node), localFrom = inverseGaragePoint(parent, from), localTo = inverseGaragePoint(parent, to);
  const changed = { ...node, x: node.x + localTo.x - localFrom.x, y: node.y + localTo.y - localFrom.y };
  return validateGarageScene({ ...scene, nodes: scene.nodes.map(item => item.id === id ? changed : item) });
}

/** @param {GarageNode} node @param {string|null} socketId @returns {GaragePoint} */
export function garageNodeContactPoint(node, socketId) {
  if (socketId === null) return { x: node.pivotX * node.width, y: node.pivotY * node.height };
  const socket = node.sockets.find(item => item.id === socketId);
  if (!socket) throw new Error("Крепление слоя не найдено.");
  return { x: socket.x * node.width, y: socket.y * node.height };
}

/** A viewport never stretches artwork. Its chosen camera defines visible world width.
 * @param {GarageScene} scene @param {number} width @param {number} height
 * @param {GarageViewportMode} mode @returns {{scale:number,x:number,y:number}} */
export function getGarageViewport(scene, width, height, mode) {
  number(width, "Ширина экрана", .001, 200_000); number(height, "Высота экрана", .001, 200_000);
  const camera = scene.cameras[mode];
  if (!camera) throw new Error("Камера не найдена.");
  const scale = width / camera.width;
  return { scale, x: width / 2 - camera.x * scale, y: height / 2 - camera.y * scale };
}
