import type { FixedWorldScene, WorldLight, WorldPoint, WorldShadowCaster } from "@/features/world/tiled/types";
import type { ForestCampfire } from "@/features/world/activities/campfire/forest-campfire";
import type { ForestLightSource } from "./forest-building-lights";
import { forestLightPulse } from "./forest-lighting";
import { createForestActorShadow } from "./forest-shadow-geometry";
import type { ForestShadowFrame, ForestShadowSource } from "./forest-shadow-painter";

export type ForestShadowActor = WorldPoint & { id: string; size: number; opacity?: number; lift?: number };
export type ForestTestLamp = WorldPoint & { height: number };
type ShadowSceneOptions = {
  night: number; elapsed: number; reducedMotion: boolean;
  lights: readonly ForestLightSource[]; fires: readonly ForestCampfire[]; actors: readonly ForestShadowActor[];
  azimuth?: number; elevation?: number; quality?: "low" | "high"; showBuildings?: boolean; buildingShadows?: boolean;
  /** Runtime/editor geometry version; omitted callers retain mutable compatibility. */
  geometryRevision?: number;
  testLamp?: ForestTestLamp;
};
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** The exact projection height used for an authored or artwork-attached lamp. */
export function forestShadowLightHeight(scene: FixedWorldScene, light: ForestLightSource | WorldLight): number {
  const siteId = "siteId" in light ? light.siteId : undefined;
  const site = siteId ? scene.sites.find(site => site.id === siteId) : undefined;
  return light.height ?? (light.kind === "torch" ? 17 : site
    ? clamp(site.entry.y - light.position.y, 12, 90) : 24);
}

/** Artwork positions mark the glass. The shadow solver uses its ground position
 * plus an independent height; both therefore follow the selected building PNG. */
export function createForestShadowFrame(scene: FixedWorldScene, options: ShadowSceneOptions): ForestShadowFrame {
  const sources: ForestShadowSource[] = options.lights.map(light => {
    const height = forestShadowLightHeight(scene, light);
    return { id: light.id, position: { x: light.position.x, y: light.position.y + height }, height,
      radius: light.radius, color: light.color, ownerSiteId: light.siteId,
      intensity: light.intensity * forestLightPulse(light, options.elapsed, options.reducedMotion) };
  });
  for (const fire of options.fires) {
    if (fire.flame <= .015 && fire.embers <= .02) continue;
    const phase = fire.position.x * .073 + fire.position.y * .041;
    const pulse = options.reducedMotion ? 1 : 1 + Math.sin(options.elapsed * 2.3 + phase) * .035
      + Math.sin(options.elapsed * 4.7 + phase * .7) * .018;
    sources.push({ id: `fire:${fire.id}`, position: { ...fire.position }, height: Math.max(4, fire.radius * .8),
      radius: fire.radius * 6.5, color: "#ffa449", intensity: (fire.flame * 1.05 + fire.embers * .06) * pulse });
  }
  if (options.testLamp) sources.push({ id: "dev:test-lamp", position: { x: options.testLamp.x, y: options.testLamp.y },
    height: options.testLamp.height, radius: 170, intensity: 1.1, color: "#ffda9d" });
  const actors: WorldShadowCaster[] = options.actors.filter(actor => actor.size > 0 && (actor.opacity ?? 1) > .01).map(actor => ({
    ...createForestActorShadow(actor, actor.size * .2, actor.id), height: actor.size * .72,
    baseHeight: Math.max(0, actor.lift ?? 0), opacity: clamp(actor.opacity ?? 1, 0, 1),
  }));
  return { night: options.night, azimuth: options.azimuth ?? 225, elevation: options.elevation ?? 40,
    quality: options.quality ?? "low", showBuildings: options.showBuildings, buildingShadows: options.buildingShadows,
    geometryRevision: options.geometryRevision, sources, actors };
}

/** A small developer marker ties the movable lamp to its ground anchor. */
export function drawForestTestLamp(ctx: CanvasRenderingContext2D, lamp: ForestTestLamp) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,221,152,.6)"; ctx.lineWidth = .65;
  ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(lamp.x, lamp.y); ctx.lineTo(lamp.x, lamp.y - lamp.height); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = "rgba(255,214,119,.55)";
  ctx.beginPath(); ctx.ellipse(lamp.x, lamp.y, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffe1a4"; ctx.strokeStyle = "#6e4726"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(lamp.x, lamp.y - lamp.height, 3.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}
