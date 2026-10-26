import { drawTradeShipWater } from "./trade-ship-water";

/** The supplied PNG is the single master; all coordinates below refer to its unchanged pixels. */
export const TRADE_SHIP_SPRITE = {
  src: "/world/ships/trade-ship.png?v=608f97253e98", width: 800, height: 500,
  sourceWidth: 1774, sourceHeight: 887,
  image: { x: 70, y: 60, width: 660, height: 330 },
  pivot: { x: 400, y: 350 }, baseHeading: .12, maxHeading: Math.PI / 3,
} as const;

export type TradeShipSpriteFrame = {
  /** Position of the shared 800×500 placement box, not the trimmed PNG bounds. */
  x: number; y: number; width: number;
  time?: number; night?: number; still?: boolean; facing?: "left" | "right"; heading?: number;
  water?: boolean; velocityX?: number; velocityY?: number;
};

const finite = (value: number | undefined, fallback = 0) => Number.isFinite(value) ? value! : fallback;

/** Shared raster transform for effects authored against the native PNG. */
export function tradeShipSpritePose(frame: TradeShipSpriteFrame) {
  if (![frame.x, frame.y, frame.width].every(Number.isFinite) || frame.width <= 0) return null;
  const sprite = TRADE_SHIP_SPRITE;
  const time = Math.max(0, finite(frame.time)) % 1e6;
  return { scale: frame.width / sprite.width, time,
    night: Math.max(0, Math.min(1, finite(frame.night))),
    heading: sprite.baseHeading + Math.max(-sprite.maxHeading, Math.min(sprite.maxHeading, finite(frame.heading))),
    facing: frame.facing === "right" ? 1 : -1, bob: frame.still ? 0 : Math.sin(time * 1.45) * .8 };
}

/** Caller saves/restores Canvas. Water uses bob=false; artwork and its lamps use the same bob. */
export function applyTradeShipSpriteTransform(ctx: CanvasRenderingContext2D, frame: TradeShipSpriteFrame, bob = true) {
  const pose = tradeShipSpritePose(frame); if (!pose) return null;
  const sprite = TRADE_SHIP_SPRITE;
  ctx.translate(frame.x, frame.y); ctx.scale(pose.scale, pose.scale);
  ctx.translate(sprite.pivot.x, sprite.pivot.y); ctx.rotate(pose.heading);
  ctx.translate(-sprite.pivot.x, -sprite.pivot.y);
  if (pose.facing < 0) { ctx.translate(sprite.width, 0); ctx.scale(-1, 1); }
  if (bob) ctx.translate(0, pose.bob);
  return pose;
}

function paintSteam(ctx: CanvasRenderingContext2D, time: number) {
  const sprite = TRADE_SHIP_SPRITE, ratio = sprite.image.width / sprite.sourceWidth;
  const x = sprite.image.x + 588 * ratio, y = sprite.image.y + 139 * ratio;
  for (let i = 0; i < 5; i++) {
    const t = ((time * .16 + i / 5) % 1 + 1) % 1;
    const radius = 4 + t * 14, cx = x - t * 20, cy = y - 7 - t * 47;
    const cloud = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    cloud.addColorStop(0, `rgba(223,231,221,${.19 * (1 - t)})`);
    cloud.addColorStop(1, "rgba(223,231,221,0)");
    ctx.fillStyle = cloud; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
  }
}

/** One raster ship, shared by the real scene and workshop. Loading and simulation belong to the caller. */
export function drawTradeShipSprite(ctx: CanvasRenderingContext2D, image: CanvasImageSource, frame: TradeShipSpriteFrame) {
  const pose = tradeShipSpritePose(frame); if (!pose) return;
  const sprite = TRADE_SHIP_SPRITE, { scale, night, time, heading, facing } = pose;
  ctx.save();
  try {
    applyTradeShipSpriteTransform(ctx, frame, false);
    if (frame.water) {
      const vx = finite(frame.velocityX), vy = finite(frame.velocityY);
      // World velocity must use the same inverse scale/rotation/mirror as the painted hull.
      drawTradeShipWater(ctx, { time, night, still: frame.still,
        velocityX: (vx * Math.cos(heading) + vy * Math.sin(heading)) * facing / scale,
        velocityY: (-vx * Math.sin(heading) + vy * Math.cos(heading)) / scale });
    }
    ctx.translate(0, pose.bob);
    // The forest scene passes night=0: its own common lighting already shades the ship.
    ctx.filter = night ? `brightness(${1 - night * .52}) saturate(${1 - night * .12})` : "none";
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const box = sprite.image;
    ctx.drawImage(image, box.x, box.y, box.width, box.height);
    ctx.filter = "none";
    if (!frame.still) paintSteam(ctx, time);
  } finally { ctx.restore(); }
}
