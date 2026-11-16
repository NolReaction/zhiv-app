import { reparentGarageNode, validateGarageScene } from "./garage-scene-model.mjs";

/** @typedef {import('./garage-scene-types').GarageScene} GarageScene */
/** @typedef {import('./garage-scene-types').GarageNode} GarageNode */

/** @param {GarageNode} node @param {Map<string, GarageNode>} byId @returns {GarageNode[]} */
function lineage(node, byId) {
  const path = [], seen = new Set();
  for (let current = node; current; current = current.parentId === null ? undefined : byId.get(current.parentId)) {
    if (seen.has(current.id)) throw new Error("В иерархии слоёв обнаружен цикл.");
    seen.add(current.id); path.push(current);
    if (current.parentId !== null && !byId.has(current.parentId)) throw new Error("Родитель слоя не найден.");
  }
  return path;
}

/** Explicit candidates only: no naming, asset-type or placement heuristics.
 * @param {GarageScene} scene @param {string} rootId @returns {GarageNode[]} */
export function eligibleGarageWaterParts(scene, rootId) {
  const byId = new Map(scene.nodes.map(node => [node.id, node]));
  const root = byId.get(rootId);
  if (!root) throw new Error("Группа лодки на воде не найдена.");
  if (root.locked) return [];
  const excluded = new Set(lineage(root, byId).map(node => node.id));
  return scene.nodes.filter(node => {
    if (node.locked || excluded.has(node.id)) return false;
    const path = lineage(node, byId);
    return path.every(item => item.visible) && !path.some(item => item.id === rootId);
  });
}

/** Join explicitly checked layers to the floating assembly without changing
 * their world placement, draw order or children. The returned scene is one undo
 * checkpoint; selecting both an ancestor and its child moves the ancestor once.
 * @param {GarageScene} scene @param {string} rootId @param {string[]} partIds
 * @returns {GarageScene} */
export function attachGarageWaterParts(scene, rootId, partIds) {
  if (!Array.isArray(partIds) || partIds.some(id => typeof id !== "string"))
    throw new Error("Выберите слои для группы лодки.");
  if (partIds.length === 0) return scene;
  const byId = new Map(scene.nodes.map(node => [node.id, node]));
  const root = byId.get(rootId);
  if (!root) throw new Error("Группа лодки на воде не найдена.");
  if (root.locked) throw new Error("Сначала открепите группу лодки.");
  const eligible = new Set(eligibleGarageWaterParts(scene, rootId).map(node => node.id));
  const selectedIds = new Set(partIds);
  for (const id of selectedIds) {
    if (!byId.has(id)) throw new Error("Выбранный слой не найден.");
    if (!eligible.has(id)) throw new Error("Выберите видимый незакреплённый слой вне группы лодки и её родителей.");
  }
  const topLevel = scene.nodes.filter(node => selectedIds.has(node.id)
    && !lineage(node, byId).slice(1).some(ancestor => selectedIds.has(ancestor.id)));
  let next = scene;
  for (const node of topLevel) next = reparentGarageNode(next, node.id, rootId);
  return validateGarageScene(next);
}
