import { pixelSprite } from "@/features/mochlik/pixel-sprite";
import { mossPalette } from "@/features/mochlik/appearance-palette";
import { fishingArm } from "@/features/world/activities/fishing/fishing-shore-rig";
import { FISHING_SCENE_RIG, type FishingSceneFrame, type FishingScenePoint } from "./fishing-scene-types";

const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** All anchors live in the hull assembly, below the face. Both hands are the rod's real pivots. */
export function fishingBoatActorRig(stage: FishingSceneFrame["stage"], castElapsed: number, held: boolean, time: number, still: boolean) {
  const actor = FISHING_SCENE_RIG.actor, size = actor.size;
  const nearShoulder = { x: actor.foot.x + size * .1, y: actor.foot.y - size * .28 };
  const farShoulder = { x: actor.foot.x - size * .03, y: actor.foot.y - size * .28 };
  const desiredGrip = { x: actor.foot.x + size * .205, y: actor.foot.y - size * .19 };
  const nearArm = fishingArm(nearShoulder, desiredGrip, size, 1, { upper: .12, lower: .13 });
  const grip = nearArm.hand;
  const casting = stage === "casting" && !still;
  const stroke = smooth((castElapsed - .22) / .8);
  const pulling = stage === "reeling" || stage === "caught" || stage === "landed";
  const angle = casting ? -1.85 + stroke * 1.93 : stage === "bite" ? -.48 : pulling ? held ? -.63 : -.4 : .075;
  const length = 360;
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const tip = { x: grip.x + axis.x * length, y: grip.y + axis.y * length };
  const reel = { x: grip.x - axis.x * 15 - axis.y * 12, y: grip.y - axis.y * 15 + axis.x * 12 };
  const crank = pulling && held && !still ? Math.sin(time * 9) * 3 : 0;
  const farTarget = { x: reel.x - 4, y: reel.y + crank };
  const farArm = fishingArm(farShoulder, farTarget, size, 1, { upper: .16, lower: .17 });
  return { actor, nearArm, farArm, grip, reel, tip, angle };
}

type ActorRig = ReturnType<typeof fishingBoatActorRig>;

/** Raster steps match the 48px body instead of drawing long smooth tubes across the face. */
export function paintFishingBoatArms(ctx: CanvasRenderingContext2D, rig: ActorRig, appearance: FishingSceneFrame["appearance"], foreground: boolean) {
  const size = rig.actor.size, pixel = size / 48;
  const origin = { x: rig.actor.foot.x - size / 2, y: rig.actor.foot.y - 44 / 48 * size };
  const palette = mossPalette(appearance?.palette);
  const segment = (from: FishingScenePoint, to: FishingScenePoint, width: number, color: string) => {
    const a = { x: Math.round((from.x - origin.x) / pixel), y: Math.round((from.y - origin.y) / pixel) };
    const b = { x: Math.round((to.x - origin.x) / pixel), y: Math.round((to.y - origin.y) / pixel) };
    const steps = Math.max(1, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.fillStyle = color;
    for (let i = 0; i <= steps; i++) ctx.fillRect(origin.x + (Math.round(a.x + (b.x - a.x) * i / steps) - 1) * pixel,
      origin.y + (Math.round(a.y + (b.y - a.y) * i / steps) - 1) * pixel, width * pixel, width * pixel);
  };
  for (const arm of [rig.farArm, rig.nearArm]) {
    if (!foreground) { segment(arm.shoulder, arm.elbow, 3, palette.mossDark); segment(arm.shoulder, arm.elbow, 2, "#d8bf83"); }
    segment(arm.elbow, arm.hand, 3, "#d8bf83"); segment(arm.elbow, arm.hand, 2, "#f4e4ae");
  }
}

export function paintFishingBoatBody(ctx: CanvasRenderingContext2D, rig: ActorRig, appearance: FishingSceneFrame["appearance"]) {
  const actor = rig.actor;
  // gardening already omits the cached palms. This scene supplies exactly two compact arms.
  const body = pixelSprite("fish", "right", 0, appearance, { gardening: true, fishingStance: true, crouch: 2 });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(body, actor.foot.x - actor.size / 2, actor.foot.y - actor.pivot.y / 48 * actor.size, actor.size, actor.size);
}

export function paintFishingBoatPaws(ctx: CanvasRenderingContext2D, rig: ActorRig) {
  const pixel = rig.actor.size / 48;
  ctx.fillStyle = "#f4e4ae";
  for (const point of [rig.grip, rig.farArm.hand]) {
    const x = Math.round(point.x / pixel) * pixel, y = Math.round(point.y / pixel) * pixel;
    ctx.fillRect(x - pixel, y - pixel, pixel * 2, pixel * 2);
  }
}
