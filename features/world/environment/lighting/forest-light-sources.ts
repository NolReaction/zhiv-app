import type { FixedWorldScene, PreviewLevels } from "@/features/world/tiled/types";
import { forestBuildingLights, type ForestLightSource } from "./forest-building-lights";

/** Authored positions are shared by every camera. Legacy site markers remain valid. */
export function forestLightSources(scene: FixedWorldScene, options: { showBuildings?: boolean; levels?: PreviewLevels } = {}): ForestLightSource[] {
  const buildingLights = forestBuildingLights(scene, options.levels);
  const sources: ForestLightSource[] = [...(scene.lights ?? [])];
  for (const light of buildingLights) {
    const index = sources.findIndex(source => source.id === light.id);
    // Authored sources can mute their automatic counterpart. Moving a bound
    // source explicitly detaches it; its old glass clip/beam must not follow.
    if (index >= 0) {
      const authored = sources[index];
      const merged: ForestLightSource = { ...light, ...authored,
        position: authored.manualPosition ? authored.position : light.position };
      if (authored.manualPosition) {
        delete merged.glass; delete merged.beamLength; delete merged.beamGround; delete merged.siteId;
      }
      sources[index] = merged;
    } else sources.push(light);
  }
  for (const site of scene.sites) {
    if (buildingLights.some(light => light.siteId === site.id)) continue;
    if (!site.light || (options.levels?.[site.id] ?? site.initialLevel) < 1) continue;
    if (sources.some(light => Math.hypot(light.position.x - site.light!.x, light.position.y - site.light!.y) < 2)) continue;
    sources.push({ id: `site:${site.id}`, position: site.light, kind: "lantern", radius: 70,
      intensity: 1, color: "#ffd28a", flicker: .04 });
  }
  return sources.filter(light => light.enabled !== false && (options.showBuildings !== false || light.manualPosition || !light.siteId && !scene.sites.some(site => {
    const p = light.position, b = site.bounds;
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  })));
}
