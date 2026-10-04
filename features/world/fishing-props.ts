import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { WorldBounds, WorldPoint } from "./tiled/types";
import { drawFishSprite } from "./fish-sprite";
import type { FishSpeciesId } from "./fish-species";

export type FishingAction = "walk" | "idle" | "cast" | "fish" | "bite" | "reel" | "catch" | "pack" | "trade" | "rest" | "greet";
export type FishingMotion = {
  variation?: "calm" | "check" | "nibble" | "struggle" | "escape";
  outcome?: "small" | "large" | "miss";
  catchScale?: number;
  species?: FishSpeciesId;
  basketSpecies?: FishSpeciesId;
  rodId?: string;
};
export const FISHING_PACK_RELEASE = .68;
export type FishingRodAppearance = Readonly<{
  shaft: string; highlight: string; handle: string; reel: string; metal: string; wrap: string | null;
}>;
const reedRod: FishingRodAppearance = Object.freeze({ shaft: "#62472d", highlight: "#d1b27c", handle: "#765639",
  reel: "#586861", metal: "#d4bf8c", wrap: null });
const riverRod: FishingRodAppearance = Object.freeze({ shaft: "#334d51", highlight: "#597779", handle: "#3c514a",
  reel: "#416260", metal: "#bad6c6", wrap: "#65b3aa" });
const willowRod: FishingRodAppearance = Object.freeze({ shaft: "#886240", highlight: "#c3a169", handle: "#786044",
  reel: "#bc7f4f", metal: "#e5bf88", wrap: "#75905a" });

/** Stable paint-only profiles: changing a rod never moves its shaft, line or
 * grip, nor creates extra body poses in the resident sprite caches. */
export function fishingRodAppearance(rodId?: string): FishingRodAppearance {
  return rodId === "river_rod" ? riverRod : rodId === "willow_rod" ? willowRod : reedRod;
}
/** Shared tackle follows the hands of either resident rig, without an image or AI dependency. */
export type FishingPropFrame = WorldPoint & FishingMotion & {
  size: number; direction: PixelDirection; action: FishingAction; phase: number; frame: number;
  carryingFish: boolean; basketFilled?: boolean; waterTarget?: WorldPoint;
};
export type FishingPropAnchors = { grip?: WorldPoint; heldFish?: WorldPoint; basket?: WorldPoint; drawBasket?: boolean };
const tau = Math.PI * 2;
const boundedPhase = (frame: FishingPropFrame) => Math.max(0, Math.min(1, Number.isFinite(frame.phase) ? frame.phase : 0));
const waterAction = (frame: FishingPropFrame) => ["cast", "fish", "bite", "reel"].includes(frame.action)
  && frame.waterTarget && Number.isFinite(frame.waterTarget.x) && Number.isFinite(frame.waterTarget.y);
const between = (a: WorldPoint, b: WorldPoint, part: number): WorldPoint => ({ x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part });
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const catchScale = (frame: FishingPropFrame) => Math.max(.7, Math.min(1.5, Number.isFinite(frame.catchScale) ? frame.catchScale! : frame.outcome === "large" ? 1.35 : 1));

/** Contains both a 48 px body and the complete cast/float arc, including rods
 * held overhead. The occluder painter needs this even when feet are offscreen. */
export function fishingPropsBounds(frame: FishingPropFrame): WorldBounds {
  const size = frame.size;
  let left = frame.x - size * 1.5, right = frame.x + size * 1.5;
  let top = frame.y - size * 2.5, bottom = frame.y + size * .3;
  if (waterAction(frame)) {
    left = Math.min(left, frame.waterTarget!.x - size * .3);
    right = Math.max(right, frame.waterTarget!.x + size * .3);
    top = Math.min(top, frame.waterTarget!.y - size * 1.1);
    bottom = Math.max(bottom, frame.waterTarget!.y + size * .3);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function drawFish(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle = 0, species: FishSpeciesId = "fish", tailSwing = 0) {
  drawFishSprite(ctx, { x, y, size, angle, species, tailSwing });
}

function drawBasket(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, filled: boolean, species?: FishSpeciesId) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = "#715035"; ctx.lineWidth = size * .09; ctx.lineCap = "round";
  ctx.beginPath(); ctx.ellipse(0, -size * .38, size * .3, size * .34, 0, Math.PI, tau); ctx.stroke();
  ctx.fillStyle = "#705239"; ctx.beginPath(); ctx.ellipse(0, -size * .33, size * .5, size * .18, 0, 0, tau); ctx.fill();
  if (filled) drawFish(ctx, size * .05, -size * .38, size * .9, -.2, species);
  ctx.fillStyle = "#bd925c";
  ctx.beginPath(); ctx.moveTo(-size * .48, -size * .3); ctx.lineTo(size * .48, -size * .3);
  ctx.lineTo(size * .36, size * .29); ctx.quadraticCurveTo(0, size * .43, -size * .36, size * .29);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = "#86633c"; ctx.lineWidth = size * .055;
  for (const offset of [-.2, .04, .23]) {
    ctx.beginPath(); ctx.moveTo(-size * .39, size * offset); ctx.lineTo(size * .39, size * offset); ctx.stroke();
  }
  ctx.strokeStyle = "#dec088";
  for (const offset of [-.22, 0, .22]) {
    ctx.beginPath(); ctx.moveTo(size * offset, -size * .24); ctx.lineTo(size * offset * .8, size * .27); ctx.stroke();
  }
  ctx.restore();
}

export type FishingTackleFrame = {
  grip: WorldPoint; tip: WorldPoint; reel: WorldPoint; bobber: WorldPoint;
  side: number; tension: number; cast: number; active: boolean; visible: boolean;
  hookedFish: boolean; splash: number;
};

/** One geometric rig owns the handle, reel, rod and line. Body painters may use
 * the same reel anchor for a supporting paw instead of guessing its position. */
export function fishingTackleFrame(frame: FishingPropFrame, still: boolean, anchors: FishingPropAnchors = {}): FishingTackleFrame {
  const size = frame.size, phase = still ? .5 : boundedPhase(frame);
  const side = frame.direction === "left" || anchors.grip && anchors.grip.x < frame.x ? -1 : 1;
  const grip = anchors.grip ?? { x: frame.x + side * size * .3, y: frame.y - size * .28 };
  const active = Boolean(waterAction(frame));
  const visible = !["rest", "trade", "pack"].includes(frame.action);
  const large = frame.outcome === "large" || frame.variation === "struggle";
  const missed = frame.outcome === "miss";
  const casting = frame.action === "cast", reeling = frame.action === "reel";
  const cast = casting ? smooth((phase - .15) / .85) : 1;
  let tip = { x: grip.x + side * size * .25, y: grip.y - size * .94 };
  let bobber = { x: tip.x - side * size * .035, y: tip.y + size * .25 };
  let tension = 0, splash = 0;
  if (active) {
    const water = frame.waterTarget!;
    const distance = Math.max(1, Math.hypot(water.x - grip.x, water.y - grip.y));
    const reach = Math.min(distance * .68, size * .92);
    const end = { x: (water.x - grip.x) / distance * reach,
      y: (water.y - grip.y) / distance * reach - size * .43 };
    // Near-vertical/front targets can sit inside the gripping paw. The pole
    // still leans outside the head; only its flexible line turns to the float.
    end.x = side * Math.max(side * end.x, size * .22);
    const startAngle = -Math.PI / 2 + side * .24, endAngle = Math.atan2(end.y, end.x);
    let angleDelta = endAngle - startAngle;
    // The casting arc stays outside the face; its fixed length cannot collapse
    // into the grip when the target water lies below the feet.
    if (side > 0 && angleDelta < -.15) angleDelta += tau;
    if (side < 0 && angleDelta > .15) angleDelta -= tau;
    if (Math.abs(angleDelta) > Math.PI * 1.45) angleDelta += angleDelta > 0 ? -tau : tau;
    const length = Math.max(size * .68, Math.min(size, Math.hypot(end.x, end.y)));
    let angle = startAngle + angleDelta * (casting ? smooth(phase) : 1);
    if (!still && frame.variation === "check") angle -= side * Math.sin(phase * Math.PI) * .12;
    if (reeling) {
      // Lift the pole through the outside arc while reeling, finishing upright
      // beside the head. A small angular twitch leaves a front-facing pole
      // pointed at the ground after its fish has already reached the paw.
      let lift = -Math.PI / 2 + side * .25 - angle;
      if (side > 0 && lift > 0) lift -= tau;
      if (side < 0 && lift < 0) lift += tau;
      if (Math.abs(lift) > Math.PI * 1.5) lift += lift > 0 ? -tau : tau;
      angle += lift * smooth(phase);
    }
    tip = { x: grip.x + Math.cos(angle) * length, y: grip.y + Math.sin(angle) * length };
    const strain = still ? .4 : .5 + .5 * Math.sin(phase * tau * (large ? 3 : 2));
    tension = frame.action === "bite" ? .65 + strain * .3 : reeling ? (large ? .75 + strain * .55 : .55) * (1 - smooth(phase) * .6)
      : frame.variation === "nibble" ? strain * .25 : 0;
    if (missed && reeling) tension *= 1 - smooth((phase - .28) / .24);
    bobber = between(grip, water, cast);
    bobber.y -= Math.sin(cast * Math.PI) * size * .8;
    if (!still && frame.action === "fish") {
      const nibble = frame.variation === "nibble" ? (1 - Math.cos(phase * tau * 3)) * size * .025 : 0;
      bobber.y += Math.sin(phase * tau * 4) * size * .009 + nibble;
    }
    if (!still && frame.action === "bite") bobber.y += (1 - Math.cos(phase * tau * (large ? 4 : 3))) * size * (large ? .043 : .03);
    if (reeling) {
      const held = anchors.heldFish ?? { x: frame.x + side * size * .29, y: frame.y - size * .34 };
      bobber = between(water, { x: held.x, y: held.y - size * .13 * catchScale(frame) }, smooth(phase));
      if (!still && large) bobber.x += Math.sin(phase * tau * 4) * size * .075 * Math.sin(phase * Math.PI);
      if (missed) splash = Math.max(0, Math.sin(Math.PI * Math.max(0, Math.min(1, (phase - .25) / .55))));
    }
  }
  const length = Math.max(1, Math.hypot(tip.x - grip.x, tip.y - grip.y));
  const dx = (tip.x - grip.x) / length, dy = (tip.y - grip.y) / length;
  const reel = { x: grip.x - dx * size * .025 - dy * side * size * .043,
    y: grip.y - dy * size * .025 + dx * side * size * .043 };
  return { grip, tip, reel, bobber, side, tension, cast, active, visible,
    hookedFish: active && reeling && !missed && phase > .16, splash };
}

function drawRod(ctx: CanvasRenderingContext2D, rig: FishingTackleFrame, size: number, crank: number, appearance: FishingRodAppearance) {
  const { grip, tip, tension, reel } = rig, middle = between(grip, tip, .6);
  ctx.lineCap = "round"; ctx.strokeStyle = appearance.shaft; ctx.lineWidth = size * .045;
  ctx.beginPath(); ctx.moveTo(grip.x, grip.y); ctx.lineTo(middle.x, middle.y); ctx.stroke();
  ctx.strokeStyle = appearance.highlight; ctx.lineWidth = size * .028;
  ctx.beginPath(); ctx.moveTo(grip.x, grip.y); ctx.lineTo(middle.x, middle.y);
  ctx.quadraticCurveTo(tip.x, tip.y - size * .13 * tension, tip.x, tip.y); ctx.stroke();
  ctx.strokeStyle = appearance.handle; ctx.lineWidth = size * .078;
  const handle = between(grip, tip, .12), butt = between(grip, tip, -.045);
  ctx.beginPath(); ctx.moveTo(butt.x, butt.y); ctx.lineTo(handle.x, handle.y); ctx.stroke();
  if (appearance.wrap) {
    ctx.strokeStyle = appearance.wrap; ctx.lineWidth = size * .046;
    for (const offset of [.145, .183, .221]) {
      const from = between(grip, tip, offset), to = between(grip, tip, offset + .016);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    }
  }
  ctx.fillStyle = appearance.reel; ctx.beginPath(); ctx.arc(reel.x, reel.y, size * .043, 0, tau); ctx.fill();
  ctx.strokeStyle = appearance.metal; ctx.lineWidth = size * .015; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(reel.x, reel.y);
  ctx.lineTo(reel.x + Math.cos(crank) * size * .062, reel.y + Math.sin(crank) * size * .042); ctx.stroke();
}

function drawTackle(ctx: CanvasRenderingContext2D, frame: FishingPropFrame, phase: number, still: boolean, anchors: FishingPropAnchors) {
  const size = frame.size, rig = fishingTackleFrame(frame, still, anchors);
  if (!rig.visible) return;
  const { tip, bobber, tension, active, cast } = rig;
  const crank = !still && (frame.action === "reel" || frame.variation === "check") ? phase * tau * (frame.outcome === "large" ? 6 : 3) : .5;
  drawRod(ctx, rig, size, crank, fishingRodAppearance(frame.rodId));
  ctx.strokeStyle = active ? "#e4e3c4c0" : "#d4d4bda0"; ctx.lineWidth = size * .018;
  ctx.beginPath(); ctx.moveTo(tip.x, tip.y);
  ctx.quadraticCurveTo((tip.x + bobber.x) / 2, Math.max(tip.y, bobber.y) + size * .07 * (1 - tension), bobber.x, bobber.y); ctx.stroke();
  if (active && cast >= .99 && frame.action !== "reel") {
    const water = frame.waterTarget!;
    const ring = still ? .35 : phase * (frame.action === "bite" || frame.variation === "nibble" ? 4 : 7) % 1;
    ctx.strokeStyle = `rgba(218,238,212,${(1 - ring) * .6})`; ctx.lineWidth = size * .022;
    ctx.beginPath(); ctx.ellipse(water.x, water.y + size * .025, size * (.055 + ring * .17),
      size * (.025 + ring * .065), 0, 0, tau); ctx.stroke();
  }
  if (!still && rig.splash > 0 && frame.waterTarget) {
    const water = frame.waterTarget;
    ctx.strokeStyle = `rgba(228,243,227,${rig.splash * .8})`; ctx.lineWidth = size * .023;
    for (const offset of [-1, 0, 1]) {
      ctx.beginPath(); ctx.moveTo(water.x + offset * size * .05, water.y);
      ctx.lineTo(water.x + offset * size * .11, water.y - rig.splash * size * (.08 + (offset ? .02 : .07))); ctx.stroke();
    }
  }
  ctx.fillStyle = "#f7e6b9"; ctx.beginPath(); ctx.ellipse(bobber.x, bobber.y, size * .035, size * .05, 0, 0, tau); ctx.fill();
  ctx.fillStyle = "#d76c42"; ctx.beginPath(); ctx.ellipse(bobber.x, bobber.y - size * .035, size * .032, size * .028, 0, 0, tau); ctx.fill();
  if (rig.hookedFish) drawFish(ctx, bobber.x, bobber.y + size * .13 * catchScale(frame), size * .22 * catchScale(frame),
    -Math.PI / 2 + (still ? 0 : Math.sin(phase * tau * 3) * .22), frame.species, still ? 0 : Math.sin(phase * tau * 5));
  else if (active && frame.action === "reel" && frame.outcome === "miss") {
    ctx.strokeStyle = "#768681"; ctx.lineWidth = size * .017;
    ctx.beginPath(); ctx.arc(bobber.x, bobber.y + size * .115, size * .035, 0, Math.PI * 1.55); ctx.stroke();
  }
}

/** Reusable rod, line, float, catch and basket; all anchors are in world coordinates. */
export function drawFishingProps(ctx: CanvasRenderingContext2D, frame: FishingPropFrame, still: boolean,
  anchors: FishingPropAnchors = {}) {
  if (![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const phase = still ? .5 : boundedPhase(frame), size = frame.size, side = frame.direction === "left" ? -1 : 1;
  ctx.save();
  drawTackle(ctx, frame, phase, still, anchors);
  const basketOnGround = frame.action === "trade" || frame.action === "pack" || frame.action === "rest"
    || frame.action === "catch" || !!waterAction(frame);
  const basket = anchors.basket ?? { x: frame.x + side * size * (basketOnGround ? .4 : .23), y: frame.y - size * (basketOnGround ? .08 : .3) };
  if (anchors.drawBasket !== false && (frame.carryingFish || basketOnGround)) drawBasket(ctx, basket.x, basket.y, size * .27,
    frame.basketFilled ?? (frame.carryingFish && (frame.action !== "pack" || phase >= FISHING_PACK_RELEASE)), frame.basketSpecies ?? frame.species);
  if (frame.outcome !== "miss" && (frame.action === "catch" || frame.action === "pack" && frame.carryingFish && phase < FISHING_PACK_RELEASE)) {
    const held = anchors.heldFish ?? { x: frame.x + side * size * .24, y: frame.y - size * .45 };
    const at = anchors.heldFish || frame.action !== "pack" ? held
      : between(held, { x: basket.x, y: basket.y - size * .14 }, Math.min(1, phase / FISHING_PACK_RELEASE));
    drawFish(ctx, at.x, at.y, size * .28 * catchScale(frame), side * (still ? -.15 : -.15 + Math.sin(phase * tau * 2) * .14), frame.species, still ? 0 : Math.sin(phase * tau * 4));
  }
  ctx.restore();
}
