import { garageEditorArtworkBounds } from './garage-editor-view.mjs';
import { garageBranchIds as garageWaterRigIds } from './garage-scene-model.mjs';
export { garageWaterRigIds };

/** Resolve visual defaults without adding authored fields or changing physics.
 * @param {Partial<import('./garage-scene-types').GarageWaterPreviewConfig>} [config] */
export function garageWaterEffects(config = {}) {
  return { effectsEnabled: config.effectsEnabled ?? false, effectOpacity: config.effectOpacity ?? .65,
    effectOffsetY: config.effectOffsetY ?? 0, immersionEnabled: config.immersionEnabled ?? false };
}

export function garageWaterSetup(scene) {
  const boat = scene.nodes.find(node => node.id === 'boat');
  const hull = scene.nodes.find(node => !node.locked && node.assetId && /hull|корпус/i.test(`${node.assetId} ${node.name}`));
  const root = scene.nodes.find(node => node.id === scene.waterPreview?.rootId) ?? boat ?? hull ?? scene.nodes.find(node => !node.locked) ?? scene.nodes[0];
  const ids = garageWaterRigIds(scene, root?.id);
  const artworkBounds = garageEditorArtworkBounds(scene, ids);
  const width = artworkBounds?.width ?? scene.canvas.width;
  const config = scene.waterPreview ?? { rootId: root?.id ?? '', waterlineY: scene.canvas.height * .62,
    beam: Math.max(1, Math.min(40000, width * .68)), amplitude: 7 };
  return { config, center: { x: (artworkBounds?.x ?? 0) + width / 2, y: config.waterlineY }, ids, artworkBounds, hasArtwork: Boolean(artworkBounds) };
}
