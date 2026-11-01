import { TRADE_SHIP_SPRITE, tradeShipSpritePose, type TradeShipSpriteFrame } from "@/features/world/objects/trade-ship/trade-ship-sprite";
import type { SceneTradeShipFrame } from "@/features/world/state/trade-ship-arrival";
import type { WorldPoint } from "@/features/world/tiled/types";
import { previewPointInPolygon } from "@/features/world/tiled/preview-state";
import type { MapInteractiveObject } from "./site-interactions";

/** Hull, cabin and chimney in the unchanged 1774×887 PNG. The water, transparent
 * corners, crane's empty opening and decorative steam are not touch targets. */
const contour = [
  [70, 430], [105, 320], [140, 310], [180, 235], [245, 175], [335, 165],
  [460, 177], [535, 200], [536, 133], [565, 112], [615, 113], [642, 137],
  [642, 208], [740, 230], [755, 255], [940, 286], [940, 337], [1065, 360],
  [1075, 309], [1105, 301], [1110, 338], [1555, 432], [1600, 480],
  [1700, 495], [1726, 532], [1695, 562], [1640, 660], [1555, 738],
  [1450, 780], [1290, 812], [1040, 815], [775, 792], [510, 754],
  [300, 705], [175, 655], [115, 565], [90, 525],
].map(([x, y]) => ({ x, y }));

/** Matches applyTradeShipSpriteTransform, including mirror, pivot, roll and bob. */
export function tradeShipSourceToWorld(point: WorldPoint, frame: TradeShipSpriteFrame): WorldPoint | null {
  const pose = tradeShipSpritePose(frame);
  if (!pose) return null;
  const sprite = TRADE_SHIP_SPRITE;
  const imageX = sprite.image.x + point.x * sprite.image.width / sprite.sourceWidth;
  const x = (pose.facing < 0 ? sprite.width - imageX : imageX) - sprite.pivot.x;
  const y = sprite.image.y + point.y * sprite.image.height / sprite.sourceHeight + pose.bob - sprite.pivot.y;
  return {
    x: frame.x + (sprite.pivot.x + x * Math.cos(pose.heading) - y * Math.sin(pose.heading)) * pose.scale,
    y: frame.y + (sprite.pivot.y + x * Math.sin(pose.heading) + y * Math.cos(pose.heading)) * pose.scale,
  };
}

export function tradeShipHitArea(frame: TradeShipSpriteFrame): readonly WorldPoint[] {
  if (!tradeShipSpritePose(frame)) return [];
  return contour.map(point => tradeShipSourceToWorld(point, frame)!);
}

export function tradeShipCanInteract(ship: SceneTradeShipFrame | null, access: {
  readOnly?: boolean; devRehearsal?: boolean; imageReady: boolean; view?: string;
}): ship is SceneTradeShipFrame {
  return Boolean(!access.readOnly && !access.devRehearsal && access.imageReady && access.view === "world"
    && ship?.kind === "arrival" && !ship.pending && ship.motion.visible
    && ship.motion.phase === "docked" && ship.motion.gangway === 1);
}

/** Marker/roof geometry stays stable while the current paint pose drives taps. */
export function createTradeShipMapObject(frame: TradeShipSpriteFrame, currentFrame: () => TradeShipSpriteFrame | null): MapInteractiveObject {
  const steady = { ...frame, still: true };
  return {
    id: "trade-ship", place: "trade-ship", label: "Порт · заказы корабля", kind: "ship",
    anchor: tradeShipSourceToWorld({ x: 1040, y: 480 }, steady)!, hitArea: tradeShipHitArea(steady),
    hitTest(point) {
      const current = currentFrame();
      return Boolean(current && previewPointInPolygon(point, tradeShipHitArea(current)));
    },
  };
}
