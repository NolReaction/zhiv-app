import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { WorldPoint } from "./tiled/types";

export type FaunaActor = WorldPoint & {
  size: number; direction?: PixelDirection; lift?: number; compression?: number; breathe?: number;
};
export type HeroAnchorPose = { pose: PixelPose; frame: number; direction: PixelDirection };

/** Same 48px source rig, sole and squash transform as drawGroundedHero. */
export function heroSourceAnchor(actor: FaunaActor, source: WorldPoint, pose: HeroAnchorPose): WorldPoint {
  const compression = Math.max(0, Math.min(1, actor.compression ?? 0));
  const breathe = Math.max(-.008, Math.min(.008, actor.breathe ?? 0));
  const walking = pose.pose === "walk" || pose.pose === "carry" || pose.pose === "fishing-walk";
  const sole = 45 + (walking && Math.abs(Math.trunc(pose.frame) % 2) === 1 ? 1 : 0);
  return {
    x: actor.x + (source.x - 24) * actor.size * (1 - .14 * compression) / 48,
    y: actor.y - Math.max(0, Math.min(actor.size, actor.lift ?? 0))
      + (source.y - sole) * actor.size * (1 + breathe) * (1 - .35 * compression) / 48,
  };
}

/** Contact is on the visible raised right paw, not an offset from the hero's centre.
 * The pixel rig keeps that paw at source x34 in all four viewing directions. */
export function heroHandAnchor(actor: FaunaActor, pose: HeroAnchorPose): WorldPoint {
  const frame = ((Math.trunc(pose.frame) % 4) + 4) % 4;
  const y = pose.pose === "greet" ? 22 + frame % 2 * 2
    : pose.pose === "hold" ? [37, 34, 31, 29][frame]
      : pose.pose === "chew" ? 29 + frame % 2
        : pose.pose === "reach" ? 35 + frame : 27;
  const held = ["hold", "chew", "reach"].includes(pose.pose);
  return heroSourceAnchor(actor, { x: held ? 24 : 34, y }, pose);
}
