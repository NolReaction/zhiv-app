import { pixelSprite } from "@/features/mochlik/pixel-sprite";
import { mossPalette } from "@/features/mochlik/appearance-palette";
import { fishingArm } from "@/features/world/activities/fishing/fishing-shore-rig";
import { FISHING_SCENE_RIG, type FishingSceneFrame, type FishingScenePoint, type FishingActorPose } from "./fishing-scene-types";

const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** Authored beats use bounded phase time. Runtime eases these targets without changing game coordinates. */
export function fishingBoatActorPose(stage: FishingSceneFrame["stage"], castElapsed: number, held: boolean, time: number, still: boolean, stageElapsed = 0): FishingActorPose {
  if (still) return { angle: stage === "reeling" ? held ? -.64 : -.4 : stage === "caught" || stage === "landed" ? -.5 : .075,
    effort: stage === "reeling" ? held ? 1 : .15 : 0, lean: 0 };
  const age = Math.max(0, stageElapsed);
  if (stage === "casting") {
    const backswing = smooth(castElapsed / .25), release = smooth((castElapsed - .25) / .48), follow = smooth((castElapsed - .73) / .47);
    return { angle: .075 - 1.8 * backswing + 1.9 * release - .1 * follow,
      effort: Math.sin(Math.PI * Math.max(0, Math.min(1, castElapsed / 1.2))) * .7,
      lean: -.45 * backswing + .75 * release - .3 * follow };
  }
  if (stage === "bite") {
    const notice = age < .5 ? Math.sin(Math.PI * age / .5) : 0;
    return { angle: -.11 - notice * .12, effort: .18, lean: notice * .22 };
  }
  if (stage === "reeling") {
    const strike = age < .55 ? Math.sin(Math.PI * age / .55) : 0;
    return { angle: (held ? -.64 : -.4) - strike * .38 + Math.sin(time * 11) * (held ? .015 : .005),
      effort: held ? 1 : .15, lean: (held ? -.23 : -.05) - strike * .28 };
  }
  if (stage === "caught" || stage === "landed") {
    const delight = age < .9 ? Math.sin(Math.PI * age / .9) : 0;
    return { angle: -.68 + smooth(age / 1.15) * .17, effort: .15 + delight * .3, lean: -.18 - delight * .12 };
  }
  return { angle: .075, effort: 0, lean: 0 };
}

/** All anchors live in the hull assembly, below the face. Both hands are the rod's real pivots. */
export function fishingBoatActorRig(stage: FishingSceneFrame["stage"], castElapsed: number, held: boolean, time: number, still: boolean, pose?: FishingActorPose, stageElapsed = 0) {
  const base = FISHING_SCENE_RIG.actor, size = base.size;
  const motion = pose ?? fishingBoatActorPose(stage, castElapsed, held, time, still, stageElapsed);
  const breath = still ? 0 : Math.sin(time * 1.7) * 1.35;
  const actor = { ...base, foot: { x: base.foot.x + motion.lean * 3, y: base.foot.y + breath + motion.effort * .7 } };
  const bodyAngle = motion.lean * .035;
  const bodyPoint = (x: number, y: number) => ({ x: actor.foot.x + x * Math.cos(bodyAngle) - y * Math.sin(bodyAngle),
    y: actor.foot.y + x * Math.sin(bodyAngle) + y * Math.cos(bodyAngle) });
  const nearShoulder = bodyPoint(size * .1, -size * .28);
  const farShoulder = bodyPoint(-size * .03, -size * .28);
  const desiredGrip = { x: actor.foot.x + size * .205, y: actor.foot.y - size * .18 };
  const nearArm = fishingArm(nearShoulder, desiredGrip, size, 1, { upper: .12, lower: .13 });
  const grip = nearArm.hand, angle = motion.angle;
  const length = 360;
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const tip = { x: grip.x + axis.x * length, y: grip.y + axis.y * length };
  const reel = { x: grip.x - axis.x * 15 - axis.y * 12, y: grip.y - axis.y * 15 + axis.x * 12 };
  const crank = still ? 0 : Math.sin(time * 9) * 3 * motion.effort;
  const farTarget = { x: reel.x - 4, y: reel.y + crank };
  const farArm = fishingArm(farShoulder, farTarget, size, 1, { upper: .16, lower: .17 });
  return { actor, nearArm, farArm, grip, reel, tip, angle, bodyAngle, effort: motion.effort };
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
  ctx.save(); ctx.translate(actor.foot.x, actor.foot.y); ctx.rotate(rig.bodyAngle);
  ctx.drawImage(body, -actor.size / 2, -actor.pivot.y / 48 * actor.size, actor.size, actor.size); ctx.restore();
}

export function paintFishingBoatPaws(ctx: CanvasRenderingContext2D, rig: ActorRig) {
  const pixel = rig.actor.size / 48;
  ctx.fillStyle = "#f4e4ae";
  for (const point of [rig.grip, rig.farArm.hand]) {
    const x = Math.round(point.x / pixel) * pixel, y = Math.round(point.y / pixel) * pixel;
    ctx.fillRect(x - pixel, y - pixel, pixel * 2, pixel * 2);
  }
}
