import { garageBranchIds, GARAGE_MAX_DEPTH } from "./garage-scene-model.mjs";

/** @typedef {import("./garage-scene-types").GarageScene} GarageScene */

/** At equal depth SVG paints the later saved node on top. @param {GarageScene} scene */
export function garagePaintOrder(scene) {
  return [...scene.nodes].sort((a, b) => a.zIndex - b.zIndex);
}

/** Frontmost first, for the layer panel and hit testing. @param {GarageScene} scene */
export function garageLayerStack(scene) {
  return garagePaintOrder(scene).reverse();
}

/** Image layers move independently. The group row carries all attached layers.
 * @param {GarageScene} scene @param {string} id @returns {Set<string>} */
export function garageMovingLayerIds(scene, id) {
  const source = scene.nodes.find(node => node.id === id);
  if (!source) return new Set();
  return source.assetId === null ? garageBranchIds(scene, id) : new Set([id]);
}

/** @param {GarageScene} scene @param {string} id */
export function canMoveGarageLayer(scene, id) {
  const moving = garageMovingLayerIds(scene, id);
  return moving.size > 0 && !scene.nodes.some(node => node.locked && moving.has(node.id));
}

/** Place a layer or an assembly in the global paint stack without reparenting.
 * @param {GarageScene} scene @param {string} id @param {string} targetId
 * @param {"above"|"below"} placement @returns {GarageScene} */
export function moveGarageLayer(scene, id, targetId, placement) {
  const ids = garageMovingLayerIds(scene, id);
  if (!ids.size || ids.has(targetId) || (placement !== "above" && placement !== "below")) return scene;
  const stack = garageLayerStack(scene);
  const moving = stack.filter(node => ids.has(node.id));
  if (moving.some(node => node.locked)) return scene;
  const rest = stack.filter(node => !ids.has(node.id));
  const targetIndex = rest.findIndex(node => node.id === targetId);
  if (targetIndex < 0) return scene;
  const above = placement === "above";
  const insertion = targetIndex + (above ? 0 : 1);
  const desired = [...rest.slice(0, insertion), ...moving, ...rest.slice(insertion)];
  if (desired.every((node, index) => node === stack[index])) return scene;

  const front = rest[insertion - 1]?.zIndex ?? GARAGE_MAX_DEPTH + 1;
  const back = rest[insertion]?.zIndex ?? -GARAGE_MAX_DEPTH - 1;
  if (front - back > moving.length) {
    const firstDepth = above ? back + moving.length : front - 1;
    const depths = new Map(moving.map((node, index) => [node.id, firstDepth - index]));
    return { ...scene, nodes: scene.nodes.map(node => {
      const depth = depths.get(node.id);
      return depth === undefined ? node : { ...node, zIndex: depth };
    }) };
  }

  // Adjacent, equal or extreme depths may leave no integer gap. Insert the
  // block beside the target at its depth, using the persisted SVG tie-breaker.
  const target = rest[targetIndex];
  const nodes = scene.nodes.filter(node => !ids.has(node.id));
  const block = moving.reverse().map(node => ({ ...node, zIndex: target.zIndex }));
  nodes.splice(nodes.indexOf(target) + (above ? 1 : 0), 0, ...block);
  return { ...scene, nodes };
}
