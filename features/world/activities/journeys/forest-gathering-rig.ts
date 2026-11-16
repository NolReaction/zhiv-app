import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { ForestGardenVisualFrame } from "@/features/world/activities/garden/forest-garden-painter";
import { basketEase, forestBasketRig, forestBasketPickHands, mixBasketPoint }
  from "@/features/world/activities/garden/forest-basket-motion";
import { FORAGING_BASKET_CYCLE, GATHERING_PACK_SECONDS, type ForestGatheringFrame } from "./forest-gathering";

const unit = (n: number) => Math.max(0, Math.min(1, n));

/** Only the activity clock and safe parking point differ from ordinary berry
 * gathering. Pixel shoulders, grips, pass between paws and basket rim are shared. */
export function forestGatheringBasketVisual(frame: ForestGatheringFrame, still = false): ForestGardenVisualFrame {
  const actor = { x: frame.x, y: frame.y, size: frame.size };
  const activity = frame.basketActivity ?? { phase: frame.action === "walk" ? "carry" : "collect",
    elapsed: 0, ground: { x: frame.basket.x, y: frame.basket.y } };
  const t = Math.max(0, activity.elapsed), size = frame.basket.size, ground = activity.ground;
  const side = ground.x < actor.x ? 1 : -1;
  const source = activity.phase === "stow" ? activity.source : undefined;
  const direction: PixelDirection = source?.direction ?? (activity.phase === "carry" ? frame.direction
    : activity.phase === "pickup" || activity.phase === "deposit"
      ? (activity.from ?? ground).x < actor.x ? "left" : "right" : side < 0 ? "left" : "right");
  const pose: PixelPose = activity.phase === "carry" ? "carry" : "idle";
  const step = activity.phase === "carry" && !still ? frame.frame : 0;
  const crouch = activity.phase === "pickup" ? Math.round(2 * basketEase(t / .24) * (1 - basketEase((t - .3) / .5)))
    : activity.phase === "deposit" ? Math.round(2 * basketEase(t / .8) * (1 - basketEase((t - 1.2) / .3)))
      : source ? (source.rig?.crouch ?? 0) * (1 - basketEase(t / GATHERING_PACK_SECONDS)) : 0;
  const rig = forestBasketRig(actor, { pose, frame: step, direction }, size, crouch);
  let position = rig.held, grounded = false, hands = rig.hands(position);
  let pickedBerry: ForestGardenVisualFrame["pickedBerry"] = null;
  if (activity.phase === "pickup") {
    position = mixBasketPoint(activity.from ?? ground, rig.held, (t - .24) / .76); grounded = t <= .24;
    hands = rig.hands(position);
    if (t < .24) hands = rig.rests.map((rest, index) => mixBasketPoint(rest, hands[index], t / .24));
  } else if (activity.phase === "deposit") {
    position = mixBasketPoint(activity.from ?? rig.held, ground, t / 1.2); grounded = t >= 1.2;
    hands = rig.hands(position);
    if (t > 1.2) hands = hands.map((hand, index) => mixBasketPoint(hand, rig.rests[index], (t - 1.2) / .3));
  } else if (activity.phase === "collect" && !activity.keepHeld) {
    const clock = FORAGING_BASKET_CYCLE, endPick = clock.pickStart + clock.pickSeconds;
    position = t < clock.lowerEnd ? mixBasketPoint(activity.from ?? rig.held, ground, t / clock.lowerEnd)
      : t > clock.liftStart ? mixBasketPoint(ground, rig.held, (t - clock.liftStart) / (clock.end - clock.liftStart)) : ground;
    grounded = t >= clock.lowerEnd && t <= clock.liftStart;
    hands = rig.hands(position);
    if (grounded) {
      const groundHands = rig.hands(ground);
      if (t < clock.pickStart) hands = groundHands.map((hand, index) => mixBasketPoint(hand, rig.rests[index], (t - clock.lowerEnd) / .35));
      else if (t >= endPick) hands = rig.rests.map((rest, index) => mixBasketPoint(rest, groundHands[index], (t - endPick) / (clock.liftStart - endPick)));
      else {
        const fruit = { x: actor.x + side * actor.size * .3, y: actor.y - actor.size * .08 };
        const lowering = side < 0 ? 1 : 0, rim = { x: ground.x, y: ground.y - size * 8 / 14 };
        // A very small DEV hero cannot reach a full-size physical basket.
        // Keep the prop in place and decline that cosmetic pick, never stretch
        // a paw or discard the finding before reaching the opening.
        if (Math.hypot(rim.x - rig.shoulders[lowering].x, rim.y - rig.shoulders[lowering].y) <= actor.size * .4) {
          const transfer = forestBasketPickHands(actor, rig.rests, fruit, ground, size, side, (t - clock.pickStart) / clock.pickSeconds);
          hands = transfer.hands;
          if (transfer.picked) pickedBerry = { ...transfer.picked, size: actor.size * .035 };
        } else hands = rig.rests;
      }
    }
  } else if (activity.phase === "stow" && source?.basket) {
    const p = unit(t / GATHERING_PACK_SECONDS);
    // Preserve the displayed frame at interruption, including both hands and
    // the held finding; a command must not snap the prop or reset a bent body.
    if (p === 0 && source.actor.size === actor.size) return { ...source, elapsed: t, still };
    const start = source.basket, lift = source.basket.grounded ? unit((p - .55) / .45) : p;
    position = mixBasketPoint(start, rig.held, lift); grounded = source.basket.grounded && lift === 0;
    const grip = rig.hands(position), startHands = source.arms.map(arm => arm.hand);
    hands = grip.map((hand, index) => mixBasketPoint(startHands[index] ?? rig.rests[index], hand, p / .55));
    if (source.pickedBerry && p < .55) {
      const rim = { x: start.x, y: start.y - size * 8 / 14 };
      const finding = mixBasketPoint(source.pickedBerry, rim, p / .45);
      const holding = startHands.reduce((best, hand, index) => Math.hypot(hand.x - source.pickedBerry!.x, hand.y - source.pickedBerry!.y)
        < Math.hypot(startHands[best].x - source.pickedBerry!.x, startHands[best].y - source.pickedBerry!.y) ? index : best, 0);
      hands[holding] = p < .45 ? finding : mixBasketPoint(rim, grip[holding], (p - .45) / .1);
      if (p < .45) pickedBerry = { ...finding, size: source.pickedBerry.size };
    }
  }
  return { actor, pose, frame: step, direction, rig: { gardening: true, crouch }, arms: rig.arms(hands),
    basket: { ...frame.basket, ...position, berries: frame.basket.berries ?? 0, grounded,
      behind: grounded ? position.y < actor.y : direction === "back" }, pickedBerry, can: null, elapsed: t, still };
}

/** A DEV hero-size change does not resize or drag the one world-space basket. */
export function resizeForestGatheringFrame(frame: ForestGatheringFrame, size: number): ForestGatheringFrame {
  if (frame.size === size) return frame;
  const resized = { ...frame, size };
  if (frame.tool === "shovel") return resized;
  const visual = forestGatheringBasketVisual(resized);
  return { ...resized, basket: { ...frame.basket, x: visual.basket!.x, y: visual.basket!.y }, held: !visual.basket!.grounded };
}
