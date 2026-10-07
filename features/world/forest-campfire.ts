import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldCampfire, WorldPoint } from "./tiled/types";

export type ForestCampfire = WorldCampfire & {
  flame: number; embers: number; wetness: number; drySeconds: number; lit: boolean;
};
export type CampfireVisit = { id: string; elapsed: number; duration: number };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Decorative evening hearths; no inventory, fuel cost or offline simulation. */
export function campfireFootprint(fire: WorldCampfire): WorldPoint[] {
  return Array.from({ length: 12 }, (_, i) => ({
    x: fire.position.x + Math.cos(i * Math.PI / 6) * fire.radius,
    y: fire.position.y + Math.sin(i * Math.PI / 6) * fire.radius,
  }));
}
export function createForestCampfires(scene: FixedWorldScene): ForestCampfire[] {
  return (scene.campfires ?? []).map(fire => ({ ...fire, flame: 0, embers: 0, wetness: 0, drySeconds: 0, lit: false }));
}
export function advanceForestCampfires(fires: ForestCampfire[], delta: number, dusk: number, rain: number) {
  if (![delta, dusk, rain].every(Number.isFinite) || delta <= 0) return;
  const dt = Math.min(delta, .1), wet = clamp(rain);
  for (const fire of fires) {
    fire.wetness = clamp(fire.wetness + (wet > .15 ? wet * .08 : -.006) * dt);
    fire.drySeconds = wet < .2 ? fire.drySeconds + dt : 0;
    if (dusk < .4 || wet >= .45 || fire.wetness > .65) fire.lit = false;
    else if (dusk >= .55 && fire.drySeconds >= 3 && fire.wetness < .35) fire.lit = true;
    const target = fire.lit ? 1 - wet * 1.2 : 0;
    fire.flame += (target - fire.flame) * Math.min(1, dt * (target > fire.flame ? .65 : .9));
    fire.embers += (fire.flame - fire.embers) * Math.min(1, dt * (wet >= .45 ? .3 : .08));
  }
}
export function campfireReady(fire: ForestCampfire, rain: number, dusk: number) {
  return fire.lit && fire.flame >= .45 && rain < .35 && dusk >= .45;
}
export function campfireVisitFrame(visit: CampfireVisit, fire: ForestCampfire, actor: WorldPoint, still = false): {
  pose: PixelPose; frame: number; direction: PixelDirection;
} {
  const dx = fire.position.x - actor.x, dy = fire.position.y - actor.y;
  const direction: PixelDirection = Math.abs(dx) > Math.abs(dy) * .7 ? dx < 0 ? "left" : "right" : dy < 0 ? "back" : "front";
  const elapsed = still ? 2 : visit.elapsed;
  // Crouch keeps the existing grounded rig; enter and leave the rest with an idle pose.
  return { pose: elapsed < .6 || elapsed > visit.duration - .7 ? "idle" : "crouch",
    frame: still ? 0 : Math.floor(elapsed / 1.4) % 2, direction };
}
