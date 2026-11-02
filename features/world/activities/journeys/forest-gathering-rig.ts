import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { WorldPoint } from "@/features/world/tiled/types";
import type { ForestGatheringFrame } from "./forest-gathering";

type Body = WorldPoint & { direction: PixelDirection; pose: PixelPose; frame: number };
export type GatheringArm = { shoulder: WorldPoint; elbow: WorldPoint; hand: WorldPoint };

// A walking sprite rises one source pixel while its lower foot moves down one.
// Match that grounded shoulder movement; do not shift the feet or the basket's size.
const bodyBob = (body: Body, still: boolean) => !still && ["walk", "carry", "fishing-walk"].includes(body.pose)
  && body.frame % 2 === 1 ? -2 / 48 : 0;

/** The carried basket sits below the paw on the visible side, never across the chest. */
export function forestGatheringCarryPoint(body: Body, size: number, still = false): WorldPoint {
  const side = body.direction === "left" || body.direction === "back" ? -1 : 1;
  return { x: body.x + side * size * .36, y: body.y + size * (-.035 + bodyBob(body, still)) };
}

/** One paw owns the actual handle. The opposite arm stays relaxed at its side. */
export function forestGatheringArms(frame: ForestGatheringFrame, still = false): { holding: GatheringArm; free: GatheringArm } {
  const { x, y, size } = frame, bob = bodyBob(frame, still);
  const hand = frame.held ? { x: frame.basket.x, y: frame.basket.y - frame.basket.size * 12 / 14 }
    : { x: x + frame.hand.x * size, y: y + frame.hand.y * size };
  const side = Math.abs(hand.x - x) > size * .02 ? Math.sign(hand.x - x) : frame.direction === "left" ? -1 : 1;
  const lean = frame.lean / 48;
  const shoulder = { x: x + (side * .22 + lean) * size, y: y + (-.245 + frame.crouch / 85 + bob) * size };
  const elbow = { x: (shoulder.x + hand.x) / 2 + side * size * .025,
    y: Math.max(shoulder.y, hand.y) + size * .055 };
  const swing = !still && frame.action === "walk" ? [0, -1, 0, 1][frame.frame % 4] / 48 : 0;
  const freeShoulder = { x: x + (-side * .22 + lean) * size, y: shoulder.y };
  const freeHand = { x: x + (-side * (.28 + swing * .35) + lean) * size,
    y: y + (-.115 + frame.crouch / 85 + bob + swing) * size };
  return { holding: { shoulder, elbow, hand }, free: { shoulder: freeShoulder,
    elbow: { x: freeHand.x, y: (freeShoulder.y + freeHand.y) / 2 }, hand: freeHand } };
}
