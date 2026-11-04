import { garageEditorNodeBounds } from './garage-editor-view.mjs';

/** Resolve visual defaults without adding authored fields or changing physics.
 * @param {Partial<import('./garage-scene-types').GarageWaterPreviewConfig>} [config] */
export function garageWaterEffects(config = {}) {
  return { effectsEnabled: config.effectsEnabled ?? false, effectOpacity: config.effectOpacity ?? .65,
    effectOffsetY: config.effectOffsetY ?? 0, immersionEnabled: config.immersionEnabled ?? false };
}

/** An authored hierarchy defines one floating assembly, independently of z-order. */
export function garageWaterRigIds(scene, rootId) {
  const ids = new Set(scene.nodes.some(node => node.id === rootId) ? [rootId] : []);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const node of scene.nodes) if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  }
  return ids;
}

export function garageWaterSetup(scene) {
  const boat = scene.nodes.find(node => node.id === 'boat');
  const hull = scene.nodes.find(node => !node.locked && node.assetId && /hull|корпус/i.test(`${node.assetId} ${node.name}`));
  const root = scene.nodes.find(node => node.id === scene.waterPreview?.rootId) ?? boat ?? hull ?? scene.nodes.find(node => !node.locked) ?? scene.nodes[0];
  const ids = garageWaterRigIds(scene, root?.id);
  const visible = node => {
    for (let item = node; item; item = scene.nodes.find(parent => parent.id === item.parentId)) if (!item.visible) return false;
    return true;
  };
  const artwork = scene.nodes.filter(node => ids.has(node.id) && node.assetId && visible(node));
  const bounds = artwork.map(node => garageEditorNodeBounds(scene, node.id));
  const left = bounds.length ? Math.min(...bounds.map(box => box.x)) : 0;
  const right = bounds.length ? Math.max(...bounds.map(box => box.x + box.width)) : scene.canvas.width;
  const config = scene.waterPreview ?? { rootId: root?.id ?? '', waterlineY: scene.canvas.height * .62,
    beam: Math.max(1, Math.min(40000, (right - left) * .68)), amplitude: 7 };
  return { config, center: { x: (left + right) / 2, y: config.waterlineY }, ids, hasArtwork: artwork.length > 0 };
}
