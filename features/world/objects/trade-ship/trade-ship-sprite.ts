import { drawTradeShipWater } from "./trade-ship-water";

/** The supplied PNG is the single master; all coordinates below refer to its unchanged pixels. */
export const TRADE_SHIP_SPRITE = {
  src: "/world/ships/trade-ship.png?v=608f97253e98", width: 800, height: 500,
  sourceWidth: 1774, sourceHeight: 887,
  image: { x: 70, y: 60, width: 660, height: 330 },
  pivot: { x: 400, y: 350 }, baseHeading: .12,
} as const;

export type TradeShipSpriteFrame = {
  /** Position of the shared 800×500 placement box, not the trimmed PNG bounds. */
  x: number; y: number; width: number;
  time?: number; night?: number; still?: boolean; facing?: "left" | "right"; heading?: number;
  water?: boolean; velocityX?: number; velocityY?: number;
};

const finite = (value: number | undefined, fallback = 0) => Number.isFinite(value) ? value! : fallback;

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
  if (![frame.x, frame.y, frame.width].every(Number.isFinite) || frame.width <= 0) return;
  const sprite = TRADE_SHIP_SPRITE, scale = frame.width / sprite.width;
  const night = Math.max(0, Math.min(1, finite(frame.night)));
  const time = Math.max(0, finite(frame.time));
  const heading = sprite.baseHeading + Math.max(-.3, Math.min(.3, finite(frame.heading)));
  const facing = frame.facing === "right" ? 1 : -1;
  ctx.save();
  try {
    ctx.translate(frame.x, frame.y); ctx.scale(scale, scale);
    ctx.translate(sprite.pivot.x, sprite.pivot.y); ctx.rotate(heading);
    ctx.translate(-sprite.pivot.x, -sprite.pivot.y);
    if (facing < 0) { ctx.translate(sprite.width, 0); ctx.scale(-1, 1); }
    if (frame.water) {
      const vx = finite(frame.velocityX), vy = finite(frame.velocityY);
      drawTradeShipWater(ctx, { time, night,
        velocityX: (vx * Math.cos(heading) + vy * Math.sin(heading)) * facing,
        velocityY: -vx * Math.sin(heading) + vy * Math.cos(heading) });
    }
    if (!frame.still) ctx.translate(0, Math.sin(time * 1.45) * .8);
    // The forest scene passes night=0: its own common lighting already shades the ship.
    ctx.filter = night ? `brightness(${1 - night * .52}) saturate(${1 - night * .12})` : "none";
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const box = sprite.image;
    ctx.drawImage(image, box.x, box.y, box.width, box.height);
    ctx.filter = "none";
    if (!frame.still) paintSteam(ctx, time);
  } finally { ctx.restore(); }
}
