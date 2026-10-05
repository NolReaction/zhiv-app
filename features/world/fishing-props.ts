import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { WorldBounds, WorldPoint } from "./tiled/types";
import { drawFishSprite } from "./fish-sprite";
import type { FishSpeciesId } from "./fish-species";
import { drawFishingRod } from "./fishing-rod-painter";
export { fishingRodAppearance, type FishingRodAppearance } from "./fishing-rod-art";

export type FishingAction = "walk" | "idle" | "cast" | "fish" | "bite" | "reel" | "catch" | "pack" | "trade" | "rest" | "greet";
export type FishingMotion = {
  castIndex?: number;
  variation?: "calm" | "check" | "nibble" | "struggle" | "escape";
  outcome?: "small" | "large" | "miss";
  catchScale?: number;
  species?: FishSpeciesId;
  basketSpecies?: FishSpeciesId;
  rodId?: string;
  carryingBasket?: boolean;
  /** A departing shore actor folds the exact visible pose on the shared clock. */
  settling?: { from: FishingPropFrame; phase: number };
};
export const FISHING_PACK_RELEASE = .68;
export const FISHING_REEL_HANDOFF = .78;
export const FISHING_REEL_HOOK = .16;
/** Shared tackle follows the hands of either resident rig, without an image or AI dependency. */
export type FishingPropFrame = WorldPoint & FishingMotion & {
  size: number; direction: PixelDirection; action: FishingAction; phase: number; frame: number;
  carryingFish: boolean; basketFilled?: boolean; waterTarget?: WorldPoint;
};
export type FishingPropAnchors = {
  grip?: WorldPoint; heldFish?: WorldPoint; basket?: WorldPoint; drawBasket?: boolean; hideRod?: boolean;
  /** A planted shore stance can aim an elevated rod independently of water below the feet. */
  rodAngle?: number; rodLength?: number; rodTip?: WorldPoint; castOrigin?: WorldPoint;
  settlingLine?: { bobber: WorldPoint; control: WorldPoint; floatPart: number };
  basketScale?: number; tautLine?: boolean; keepRod?: boolean;
  detailScale?: number; anatomicalSide?: number; castArc?: number;
};
const tau = Math.PI * 2;
const boundedPhase = (frame: FishingPropFrame) => Math.max(0, Math.min(1, Number.isFinite(frame.phase) ? frame.phase : 0));
const waterAction = (frame: FishingPropFrame) => ["cast", "fish", "bite", "reel"].includes(frame.action)
  && frame.waterTarget && Number.isFinite(frame.waterTarget.x) && Number.isFinite(frame.waterTarget.y);
const between = (a: WorldPoint, b: WorldPoint, part: number): WorldPoint => ({ x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part });
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const catchScale = (frame: FishingPropFrame) => Math.max(.7, Math.min(1.5, Number.isFinite(frame.catchScale) ? frame.catchScale! : frame.outcome === "large" ? 1.35 : 1));
const reelCrank = (frame: FishingPropFrame, still: boolean) => still ? 0
  : Math.min(1, boundedPhase(frame) / FISHING_REEL_HANDOFF) * tau * (frame.outcome === "large" ? 6 : 3);

/** Project a real elevated pole along feet→water, rather than treating the
 * screen-space height of a hand as a direction in the ground plane. */
export function projectFishingRod(frame: FishingPropFrame, grip: WorldPoint, elevation: number, length = .96): WorldPoint {
  const side = frame.direction === "left" ? -1 : 1;
  const dx = frame.waterTarget ? frame.waterTarget.x - grip.x : side;
  const dy = frame.waterTarget ? frame.waterTarget.y - frame.y : 0;
  const distance = Math.max(.001, Math.hypot(dx, dy));
  const reach = Math.min(frame.size * length * Math.cos(elevation), frame.waterTarget ? distance * .62 : Infinity);
  return { x: grip.x + dx / distance * reach,
    y: grip.y + dy / distance * reach - frame.size * length * Math.sin(elevation) * 1.15 };
}

export const fishingBasketFishCenter = (basket: WorldPoint, size: number, scale = 1): WorldPoint =>
  ({ x: basket.x + size * .0135 * scale, y: basket.y - size * .152 * scale });
export const fishingBasketHandle = (basket: WorldPoint, size: number, scale = 1): WorldPoint =>
  ({ x: basket.x, y: basket.y - size * .288 * scale });

/** Lift over the rim before lowering the fish into the opening. */
export function fishingPackCenter(start: WorldPoint, basket: WorldPoint, size: number, phase: number, scale = 1): WorldPoint {
  const t = smooth(phase / FISHING_PACK_RELEASE);
  const center = between(start, fishingBasketFishCenter(basket, size, scale), t);
  return { x: center.x, y: center.y - Math.sin(t * Math.PI) * size * .16 };
}

/** Land below the face before unhooking. Reeling never pulls a hooked fish
 * across the body toward the far paw or the basket. */
const fishingLandingCenter = (frame: FishingPropFrame, side: number): WorldPoint =>
  ({ x: frame.x + side * frame.size * .045, y: frame.y - frame.size * .22 });

/** A supporting wrist touches the lower outline, never the middle of a fish.
 * Reel and catch use the same size and vertical pose at their shared boundary. */
export function fishingCatchFrame(frame: FishingPropFrame, still: boolean, anchors: FishingPropAnchors = {}) {
  const phase = still ? .5 : boundedPhase(frame), side = frame.direction === "left" ? -1 : 1;
  const basketScale = anchors.basketScale ?? 1;
  const basket = anchors.basket ?? { x: frame.x + side * frame.size * .4, y: frame.y - frame.size * .08 };
  const resting = anchors.heldFish ?? { x: frame.x + side * frame.size * .24, y: frame.y - frame.size * .45 };
  const placing = frame.action === "pack" ? smooth(phase / FISHING_PACK_RELEASE) : 0;
  const landingSide = frame.direction === "left" || anchors.grip && anchors.grip.x < frame.x ? -1 : 1;
  const lifting = smooth((phase - .2) / .55);
  const center = frame.action === "reel" ? fishingLandingCenter(frame, landingSide)
    : frame.action === "catch" ? between(fishingLandingCenter(frame, landingSide), resting, lifting)
      : anchors.heldFish || frame.action !== "pack" ? resting : fishingPackCenter(resting, basket, frame.size, phase, basketScale);
  const horizontal = side > 0 ? -.12 : -Math.PI + .12;
  const angle = frame.action === "catch" ? -Math.PI / 2 + (horizontal + Math.PI / 2) * lifting
    : frame.action === "pack" ? horizontal + ((side > 0 ? -.2 : -Math.PI + .2) - horizontal) * placing : -Math.PI / 2;
  const size = frame.size * (.26 * catchScale(frame) * (1 - placing) + .22 * basketScale * placing);
  const underside = side;
  const wrist = { x: center.x - Math.sin(angle) * size * .22 * underside,
    y: center.y + Math.cos(angle) * size * .22 * underside };
  return { center, angle, size, wrist,
    visible: frame.outcome !== "miss" && (frame.action === "catch" || frame.action === "pack" && frame.carryingFish && phase < FISHING_PACK_RELEASE),
    attached: frame.action === "catch" && phase < .2 };
}

/** Contains the body, elevated legacy tackle and the low forward shore pole,
 * including its hanging float during idle/rest. Occlusion needs every prop
 * even when the resident's planted feet have already left the camera. */
export function fishingPropsBounds(frame: FishingPropFrame): WorldBounds {
  const size = frame.size;
  let left = frame.x - size * 1.5, right = frame.x + size * 1.5;
  // The shore shaft reaches .82size from the belly and its float hangs another
  // .16size below the tip. Keep painting padding through non-water phases too.
  let top = frame.y - size * 2.5, bottom = frame.y + size;
  if (waterAction(frame)) {
    left = Math.min(left, frame.waterTarget!.x - size * .3);
    right = Math.max(right, frame.waterTarget!.x + size * .3);
    top = Math.min(top, frame.waterTarget!.y - size * 1.1);
    bottom = Math.max(bottom, frame.waterTarget!.y + size * .3);
  }
  if (frame.settling?.from.waterTarget) {
    const water = frame.settling.from.waterTarget;
    left = Math.min(left, water.x - size * .3); right = Math.max(right, water.x + size * .3);
    top = Math.min(top, water.y - size * 1.1); bottom = Math.max(bottom, water.y + size * .3);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function drawFish(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle = 0, species: FishSpeciesId = "fish", tailSwing = 0, flipY = false) {
  drawFishSprite(ctx, { x, y, size, angle, species, tailSwing, flipY });
}

/** Only the catch is clipped: the basket's sides hide a long tail while the
 * recognisable head and back remain visible above the opening. */
function clipBasketFish(ctx: CanvasRenderingContext2D, basket: WorldPoint, size: number, part = 1) {
  const basketSize = size * .4, margin = size * 2 * (1 - smooth(part));
  ctx.beginPath();
  ctx.moveTo(basket.x - basketSize * .44 - margin, basket.y - basketSize * .8 - margin);
  ctx.lineTo(basket.x + basketSize * .44 + margin, basket.y - basketSize * .8 - margin);
  ctx.lineTo(basket.x + basketSize * .44 + margin, basket.y - basketSize * .3);
  ctx.lineTo(basket.x + basketSize * .32 + margin, basket.y + basketSize * .3 + margin);
  ctx.lineTo(basket.x - basketSize * .32 - margin, basket.y + basketSize * .3 + margin);
  ctx.lineTo(basket.x - basketSize * .44 - margin, basket.y - basketSize * .3);
  ctx.closePath(); ctx.clip();
}

function drawBasket(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, filled: boolean, species?: FishSpeciesId, foreground = false, side = 1) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = "#715035"; ctx.lineWidth = size * .09; ctx.lineCap = "round";
  if (!foreground) {
    ctx.beginPath(); ctx.ellipse(0, -size * .38, size * .3, size * .34, 0, Math.PI, tau); ctx.stroke();
    ctx.fillStyle = "#705239"; ctx.beginPath(); ctx.ellipse(0, -size * .33, size * .5, size * .18, 0, 0, tau); ctx.fill();
    if (filled) {
      ctx.save(); clipBasketFish(ctx, { x: 0, y: 0 }, size / .4);
      drawFish(ctx, size * .03375, -size * .38, size * .55, side > 0 ? -.2 : -Math.PI + .2, species, 0, side < 0);
      ctx.restore();
    }
  } else {
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
  const side = anchors.anatomicalSide ?? (frame.direction === "left" || anchors.grip && anchors.grip.x < frame.x ? -1 : 1);
  const grip = anchors.grip ?? { x: frame.x + side * size * .3, y: frame.y - size * .28 };
  const active = Boolean(waterAction(frame));
  const visible = !anchors.hideRod && (anchors.keepRod || !["rest", "trade"].includes(frame.action));
  const large = frame.outcome === "large" || frame.variation === "struggle";
  const missed = frame.outcome === "miss";
  const casting = frame.action === "cast", reeling = frame.action === "reel";
  const cast = casting ? Math.max(0, Math.min(1, (phase - (anchors.tautLine ? .34 : .15)) / (anchors.tautLine ? .66 : .85))) : 1;
  const posedTip = anchors.rodTip ?? (Number.isFinite(anchors.rodAngle) ? { x: grip.x + Math.cos(anchors.rodAngle!) * size * (anchors.rodLength ?? .94),
    y: grip.y + Math.sin(anchors.rodAngle!) * size * (anchors.rodLength ?? .94) } : undefined);
  let tip = posedTip ?? { x: grip.x + side * size * .25, y: grip.y - size * .94 };
  let bobber = { x: tip.x - (anchors.tautLine ? 0 : side * size * .035), y: tip.y + size * (anchors.tautLine ? .16 : .25) };
  let tension = 0, splash = 0;
  const landing = frame.action === "catch" || frame.action === "pack";
  if (active || landing && frame.waterTarget) {
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
    const length = Number.isFinite(anchors.rodAngle) ? size * (anchors.rodLength ?? .94)
      : Math.max(size * .68, Math.min(size, Math.hypot(end.x, end.y)));
    let angle = startAngle + angleDelta * (casting ? smooth(phase) : 1);
    if (!still && frame.variation === "check") angle -= side * Math.sin(phase * Math.PI) * .12;
    if (reeling || landing) {
      // Lift the pole through the outside arc while reeling, finishing upright
      // beside the head. A small angular twitch leaves a front-facing pole
      // pointed at the ground after its fish has already reached the paw.
      let lift = -Math.PI / 2 + side * .25 - angle;
      if (side > 0 && lift > 0) lift -= tau;
      if (side < 0 && lift < 0) lift += tau;
      if (Math.abs(lift) > Math.PI * 1.5) lift += lift > 0 ? -tau : tau;
      angle += lift * (landing ? 1 : smooth(phase));
    }
    if (Number.isFinite(anchors.rodAngle)) angle = anchors.rodAngle!;
    tip = posedTip ?? { x: grip.x + Math.cos(angle) * length, y: grip.y + Math.sin(angle) * length };
    const strain = still ? .4 : .5 + .5 * Math.sin(phase * tau * (large ? 3 : 2));
    tension = frame.action === "bite" ? .65 + strain * .3 : reeling ? (large ? .75 + strain * .55 : .55) * (1 - smooth(phase) * .6)
      : frame.variation === "nibble" ? strain * .25 : anchors.tautLine && frame.action === "fish" ? .12 : 0;
    if (missed && reeling) tension *= 1 - smooth((phase - .28) / .24);
    const hanging = { x: tip.x, y: tip.y + size * (anchors.tautLine ? .16 : .25) };
    bobber = between(casting && cast > 0 && anchors.castOrigin ? anchors.castOrigin : hanging, water, cast);
    const flightArc = anchors.castArc ?? size * 2.2;
    bobber.y -= cast * (1 - cast) * flightArc;
    if (!still && frame.action === "fish") {
      const nibble = frame.variation === "nibble" ? (1 - Math.cos(phase * tau * 3)) * size * .025 : 0;
      bobber.y += Math.sin(phase * tau * 4) * size * .009 + nibble;
    }
    if (!still && frame.action === "bite") bobber.y += (1 - Math.cos(phase * tau * (large ? 4 : 3))) * size * (large ? .043 : .03);
    if (reeling) {
      const held = fishingLandingCenter(frame, side);
      bobber = between(water, missed ? hanging
        : { x: held.x, y: held.y - size * .13 * catchScale(frame) }, smooth(phase));
      if (!still && large) bobber.x += Math.sin(phase * tau * 4) * size * .075 * Math.sin(phase * Math.PI);
      if (missed) splash = Math.max(0, Math.sin(Math.PI * Math.max(0, Math.min(1, (phase - .25) / .55))));
    } else if (landing) {
      const stowed = hanging;
      const landingPoint = fishingLandingCenter(frame, side);
      const unhooked = { x: landingPoint.x, y: landingPoint.y - size * .13 * catchScale(frame) };
      bobber = frame.action === "catch" ? between(unhooked, stowed, smooth((phase - .2) / .45)) : stowed;
    }
  }
  if (frame.settling) {
    const fromFrame = { ...frame.settling.from, settling: undefined };
    // The source anchors are supplied by the shore rig; its tip/grip already
    // interpolate. Retraction starts at the actual old float, including a cast.
    const origin = anchors.settlingLine?.bobber ?? fishingTackleFrame(fromFrame, false).bobber;
    bobber = between(origin, { x: tip.x, y: tip.y + size * .16 }, smooth(frame.settling.phase));
    tension = 0;
  }
  const length = Math.max(.001, Math.hypot(tip.x - grip.x, tip.y - grip.y));
  const dx = (tip.x - grip.x) / length, dy = (tip.y - grip.y) / length;
  // Compact fittings keep their mount away from the handle: shrinking the
  // spool must not stack the winding paw on top of the gripping paw.
  const mount = anchors.detailScale === undefined ? .043 : .06;
  const reel = { x: grip.x - dx * size * .025 - dy * side * size * mount,
    y: grip.y - dy * size * .025 + dx * side * size * mount };
  return { grip, tip, reel, bobber, side, tension, cast, active, visible,
    hookedFish: active && reeling && !missed && phase > FISHING_REEL_HOOK, splash };
}

/** The winding paw follows the actual crank drawn by the selected rod model. */
export function fishingReelHand(frame: FishingPropFrame, still: boolean, anchors: FishingPropAnchors = {}): WorldPoint {
  const rig = fishingTackleFrame(frame, still, anchors), crank = reelCrank(frame, still);
  const length = Math.max(.001, Math.hypot(rig.tip.x - rig.grip.x, rig.tip.y - rig.grip.y));
  const dx = (rig.tip.x - rig.grip.x) / length, dy = (rig.tip.y - rig.grip.y) / length;
  const local = frame.rodId === "river_rod" ? { x: .043 + Math.cos(crank) * .05, y: rig.side * (.02 + Math.sin(crank) * .04) }
    : frame.rodId === "willow_rod" ? { x: Math.cos(crank) * .09, y: Math.sin(crank) * .09 }
      : { x: Math.cos(crank) * .035, y: Math.sin(crank) * .025 };
  const detail = anchors.detailScale ?? 1;
  return { x: rig.reel.x + frame.size * detail * (local.x * dx - local.y * dy),
    y: rig.reel.y + frame.size * detail * (local.x * dy + local.y * dx) };
}

/** Float and line share a single curve: a lifted float cannot drift off its
 * thinner shore line during winding or retraction. */
export function fishingLineFrame(frame: FishingPropFrame, still: boolean, anchors: FishingPropAnchors = {},
  tackle = fishingTackleFrame(frame, still, anchors)) {
  const phase = still ? .5 : boundedPhase(frame), { tip, bobber, tension, active, side } = tackle, size = frame.size;
  const lifted = frame.action === "reel" || frame.action === "catch" && phase < .65;
  const slack = lifted ? .012 + (frame.action === "catch" ? .043 * smooth((phase - .2) / .45) : 0)
    : active && frame.action !== "cast" ? .018 * (1 - Math.min(1, tension)) : .055;
  let control = anchors.tautLine ? { x: (tip.x + bobber.x) / 2, y: (tip.y + bobber.y) / 2 + size * slack }
    : lifted ? { x: tip.x + side * size * .025, y: bobber.y }
      : { x: (tip.x + bobber.x) / 2, y: Math.max(tip.y, bobber.y) + size * .07 * (1 - tension) };
  let floatPart = lifted ? frame.action === "reel" ? 1 - .35 * smooth(phase / .45)
    : .65 + .35 * smooth((phase - .2) / .45) : 1;
  if (frame.settling && anchors.settlingLine) {
    const t = smooth(frame.settling.phase);
    control = between(anchors.settlingLine.control, control, t);
    floatPart = anchors.settlingLine.floatPart + (1 - anchors.settlingLine.floatPart) * t;
  }
  const before = 1 - floatPart;
  const float = { x: before * before * tip.x + 2 * before * floatPart * control.x + floatPart * floatPart * bobber.x,
    y: before * before * tip.y + 2 * before * floatPart * control.y + floatPart * floatPart * bobber.y };
  return { control, float, floatPart, width: size * (anchors.tautLine ? .0055 : .018) };
}

function drawTackle(ctx: CanvasRenderingContext2D, frame: FishingPropFrame, phase: number, still: boolean, anchors: FishingPropAnchors) {
  const size = frame.size, rig = fishingTackleFrame(frame, still, anchors);
  if (!rig.visible) return;
  const { tip, bobber, active, cast } = rig;
  const line = fishingLineFrame(frame, still, anchors, rig);
  const crank = frame.action === "reel" ? reelCrank(frame, still)
    : !anchors.tautLine && !still && frame.variation === "check" ? phase * tau * 3 : 0;
  drawFishingRod(ctx, { ...rig, size, crank, rodId: frame.rodId, detailScale: anchors.detailScale });
  ctx.strokeStyle = anchors.tautLine ? "#cbd9cba8" : active ? "#e4e3c4c0" : "#d4d4bda0";
  ctx.lineWidth = line.width;
  ctx.beginPath(); ctx.moveTo(tip.x, tip.y);
  ctx.quadraticCurveTo(line.control.x, line.control.y, bobber.x, bobber.y);
  ctx.stroke();
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
  // A float sits above the hook along the line, not on the fish's mouth or the
  // resident's chin. It reaches the short stowed line after unhooking.
  const { float } = line;
  ctx.fillStyle = "#f7e6b9"; ctx.beginPath(); ctx.ellipse(float.x, float.y, size * .035, size * .05, 0, 0, tau); ctx.fill();
  ctx.fillStyle = "#d76c42"; ctx.beginPath(); ctx.ellipse(float.x, float.y - size * .035, size * .032, size * .028, 0, 0, tau); ctx.fill();
  if (rig.hookedFish) drawFish(ctx, bobber.x, bobber.y + size * .13 * catchScale(frame), size * .26 * catchScale(frame),
    -Math.PI / 2 + (still ? 0 : Math.sin(phase * tau * 3) * .22 * (1 - smooth((phase - .75) / .25))),
    frame.species, still ? 0 : Math.sin(phase * tau * 5) * (1 - smooth((phase - .75) / .25)), frame.direction === "left");
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
  const showBasket = anchors.drawBasket !== false && (anchors.drawBasket === true || frame.carryingFish || basketOnGround);
  const basketScale = anchors.basketScale ?? 1;
  if (showBasket) drawBasket(ctx, basket.x, basket.y, size * .4 * basketScale,
    frame.basketFilled ?? (frame.carryingFish && (frame.action !== "pack" || phase >= FISHING_PACK_RELEASE)), frame.basketSpecies ?? frame.species, false, side);
  const fish = fishingCatchFrame(frame, still, { ...anchors, basket });
  if (fish.visible) {
    ctx.save();
    if (frame.action === "pack") clipBasketFish(ctx, basket, size * basketScale, (phase / FISHING_PACK_RELEASE - .55) / .45);
    drawFish(ctx, fish.center.x, fish.center.y, fish.size, fish.angle, frame.species,
      still || frame.action === "pack" ? 0 : Math.sin(phase * tau * 4) * .35, side < 0);
    ctx.restore();
  }
  if (showBasket) drawBasket(ctx, basket.x, basket.y, size * .4 * basketScale, false, undefined, true);
  ctx.restore();
}
