/** @typedef {import('./garage-scene-types').GarageScene} GarageScene */
/** @typedef {import('./garage-scene-types').GarageNode} GarageNode */
/** @typedef {import('./garage-scene-types').GarageMatrix} GarageMatrix */
/** @typedef {import('./garage-scene-types').GaragePoint} GaragePoint */
/** @typedef {import('./garage-scene-types').GarageViewportMode} GarageViewportMode */

/** @type {GarageMatrix} */
const IDENTITY = [1, 0, 0, 1, 0, 0];
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
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
    if (!SOURCE_PATTERN.test(src) || src.includes("..")) throw new Error("Изображения должны находиться в /world/boat-garage/ и иметь формат PNG, WebP или JPEG.");
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
    const zIndex = number(node.zIndex, "Порядок слоя", -100_000, 100_000);
    if (!Number.isInteger(zIndex)) throw new Error("Порядок слоя должен быть целым числом.");
    return { id: id(node.id, "ID слоя"), name: text(node.name, "Название слоя"), assetId: nullableId(node.assetId, "Изображение слоя"),
      parentId: nullableId(node.parentId, "Родитель слоя"), socketId: nullableId(node.socketId, "Крепление слоя"),
      x: number(node.x, "Слой X", -200_000, 200_000), y: number(node.y, "Слой Y", -200_000, 200_000),
      width: number(node.width, "Ширина слоя", .001, 20_000), height: number(node.height, "Высота слоя", .001, 20_000),
      scale: number(node.scale, "Масштаб слоя", .001, 100), rotation: number(node.rotation, "Поворот слоя", -36_000, 36_000),
      pivotX: number(node.pivotX, "Опора X", 0, 1), pivotY: number(node.pivotY, "Опора Y", 0, 1), zIndex,
      visible: boolean(node.visible, "Видимость слоя"), locked: boolean(node.locked, "Блокировка слоя"), sockets };
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
  return { schemaVersion: 1, canvas: { width: number(canvas.width, "Ширина холста", 1, 20_000),
    height: number(canvas.height, "Высота холста", 1, 20_000) }, cameras: { portrait: camera("portrait"), landscape: camera("landscape") }, assets, nodes };
}

/** @param {GarageMatrix} left @param {GarageMatrix} right @returns {GarageMatrix} */
function multiply(left, right) {
  const [a, b, c, d, e, f] = left, [g, h, i, j, k, l] = right;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}

/** @param {GarageNode} node @returns {GarageMatrix} */
function localMatrix(node) {
  const angle = node.rotation * Math.PI / 180, a = Math.cos(angle) * node.scale, b = Math.sin(angle) * node.scale;
  return [a, b, -b, a, node.x - a * node.pivotX * node.width + b * node.pivotY * node.height,
    node.y - b * node.pivotX * node.width - a * node.pivotY * node.height];
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

/** @param {GarageScene} scene @param {string} id @returns {GarageScene} */
export function removeGarageNode(scene, id) {
  const removed = new Set([id]);
  for (let previous = -1; previous !== removed.size;) {
    previous = removed.size;
    for (const node of scene.nodes) if (node.parentId && removed.has(node.parentId)) removed.add(node.id);
  }
  return { ...scene, nodes: scene.nodes.filter(node => !removed.has(node.id)) };
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
  const scale = Math.hypot(local[0], local[1]);
  const changed = { ...candidate, scale, rotation: Math.atan2(local[1], local[0]) * 180 / Math.PI,
    x: local[4] + local[0] * node.pivotX * node.width + local[2] * node.pivotY * node.height,
    y: local[5] + local[1] * node.pivotX * node.width + local[3] * node.pivotY * node.height };
  return validateGarageScene({ ...scene, nodes: scene.nodes.map(value => value.id === id ? changed : value) });
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
