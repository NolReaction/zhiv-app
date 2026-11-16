import { heroSourceAnchor, type FaunaActor, type HeroAnchorPose } from "@/features/world/scene/hero-anchors";
import type { WorldPoint } from "@/features/world/tiled/types";

export type ForestBasketArm = { shoulder: WorldPoint; elbow: WorldPoint; hand: WorldPoint };
const unit = (value: number) => Math.max(0, Math.min(1, value));
export const basketEase = (value: number) => { const t = unit(value); return t * t * (3 - 2 * t); };
export const mixBasketPoint = (a: WorldPoint, b: WorldPoint, progress: number) => {
  const t = basketEase(progress); return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
};
export const forestBasketCarryPoint = (actor: FaunaActor) => ({ x: actor.x, y: actor.y - actor.size * .15 });

/** The garden's original two-link paw, shared by harvesting and woodland trips. */
export function forestBasketArm(shoulder: WorldPoint, hand: WorldPoint, side: number, size: number): ForestBasketArm {
  const dx = hand.x - shoulder.x, dy = hand.y - shoulder.y, distance = Math.hypot(dx, dy);
  const bend = Math.min(size * .065, Math.max(size * .02, (size * .29 - distance) * .45));
  return { shoulder, hand, elbow: { x: shoulder.x + dx * .48 + side * bend * .35,
    y: shoulder.y + dy * .48 + bend } };
}

/** Source-pixel shoulders, resting paws and reachable handle contacts are the
 * same for every owner of the physical garden basket. */
export function forestBasketRig(actor: FaunaActor, motion: HeroAnchorPose, basketSize: number, crouch = 0) {
  const anchor = (x: number, y: number) => heroSourceAnchor(actor, { x, y }, motion);
  const bob = motion.pose === "carry" && motion.frame % 2 ? -1 : 0;
  const shoulders = [anchor(14, 31 + bob + crouch), anchor(34, 31 + bob + crouch)];
  const rests = [anchor(14, 35 + bob + crouch), anchor(34, 35 + bob + crouch)];
  const hands = (position: WorldPoint) => [
    { x: position.x - basketSize * .23, y: position.y - basketSize * 12 / 14 },
    { x: position.x + basketSize * .23, y: position.y - basketSize * 12 / 14 },
  ].map((hand, index) => {
    const offset = position.x - actor.x, near = offset < 0 ? 0 : 1;
    const contact = index !== near ? hand : { ...hand,
      x: hand.x - Math.sign(offset) * basketSize * .46 * basketEase((Math.abs(offset) / actor.size - .08) / .2) };
    const distance = Math.hypot(contact.x - shoulders[index].x, contact.y - shoulders[index].y);
    return mixBasketPoint(rests[index], contact, 1 - unit((distance / actor.size - .21) / .045));
  });
  const arms = (points: WorldPoint[]) => shoulders.map((shoulder, index) =>
    forestBasketArm(shoulder, points[index], index ? 1 : -1, actor.size));
  return { shoulders, rests, hands, arms, held: forestBasketCarryPoint(actor) };
}

/** Reach, pass between the two paws, then lower exactly to the actual basket
 * opening. There is no assumed left/right parking point. */
export function forestBasketPickHands(actor: FaunaActor, rests: WorldPoint[], fruit: WorldPoint,
  basket: WorldPoint, basketSize: number, side: number, phase: number) {
  const reaching = side < 0 ? 0 : 1, lowering = 1 - reaching;
  const center = { x: actor.x, y: actor.y - actor.size * .24 };
  const rim = { x: basket.x, y: basket.y - basketSize * 8 / 14 };
  const hands = [...rests];
  hands[reaching] = phase < .25 ? mixBasketPoint(rests[reaching], fruit, phase / .25) : phase < .35 ? fruit
    : phase < .6 ? mixBasketPoint(fruit, center, (phase - .35) / .25) : mixBasketPoint(center, rests[reaching], (phase - .6) / .2);
  hands[lowering] = phase < .35 ? rests[lowering] : phase < .6 ? mixBasketPoint(rests[lowering], center, (phase - .35) / .25)
    : phase < .8 ? mixBasketPoint(center, rim, (phase - .6) / .2) : mixBasketPoint(rim, rests[lowering], (phase - .8) / .2);
  return { hands, picked: phase >= .3 && phase < .8 ? hands[phase < .6 ? reaching : lowering] : null, rim };
}
