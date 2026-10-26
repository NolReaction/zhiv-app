import { TRADE_SHIP_SPRITE, tradeShipSpritePose, type TradeShipSpriteFrame } from "@/features/world/objects/trade-ship/trade-ship-sprite";
import type { WorldAudioCamera } from "@/features/world/audio/world-audio-frame";
import type { WorldPoint } from "@/features/world/tiled/types";

const silhouettes = new WeakMap<HTMLImageElement, WorldPoint[]>();
/** Opaque samples prove visibility; the empty corners of a rotated art box do not. */
export function tradeShipOpaquePoints(data: ArrayLike<number>, width: number, height: number) {
  const points: WorldPoint[] = [];
  for (let x = 0; x < width; x += 8) {
    let first = -1, last = -1;
    for (let y = 0; y < height; y++) if (data[(y * width + x) * 4 + 3] > 64) {
      if (first < 0) first = y;
      last = y;
    }
    if (first >= 0) points.push({ x, y: first }, { x, y: last });
  }
  return points;
}

export function tradeShipPointsVisible(points: readonly WorldPoint[], frame: TradeShipSpriteFrame,
  camera: WorldAudioCamera | null | undefined, bounds: { width: number; height: number }) {
  const pose = tradeShipSpritePose(frame);
  if (!pose || !camera || !Number.isFinite(camera.zoom) || camera.zoom <= 0 || !camera.viewportHeight) return false;
  const sprite = TRADE_SHIP_SPRITE, halfX = camera.viewportWidth / camera.zoom / 2, halfY = camera.viewportHeight / camera.zoom / 2;
  return points.some(point => {
    const imageX = sprite.image.x + point.x * sprite.image.width / sprite.sourceWidth;
    const x = (pose.facing < 0 ? sprite.width - imageX : imageX) - sprite.pivot.x;
    const y = sprite.image.y + point.y * sprite.image.height / sprite.sourceHeight + pose.bob - sprite.pivot.y;
    const worldX = frame.x + (sprite.pivot.x + x * Math.cos(pose.heading) - y * Math.sin(pose.heading)) * pose.scale;
    const worldY = frame.y + (sprite.pivot.y + x * Math.sin(pose.heading) + y * Math.cos(pose.heading)) * pose.scale;
    return worldX >= 0 && worldX <= bounds.width && worldY >= 0 && worldY <= bounds.height
      && worldX >= camera.x - halfX && worldX <= camera.x + halfX && worldY >= camera.y - halfY && worldY <= camera.y + halfY;
  });
}

export function tradeShipImageVisible(image: HTMLImageElement, frame: TradeShipSpriteFrame,
  camera: WorldAudioCamera | null | undefined, bounds: { width: number; height: number }) {
  let points = silhouettes.get(image);
  if (!points) {
    points = [];
    try {
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (pixels?.data?.length) points = tradeShipOpaquePoints(pixels.data, canvas.width, canvas.height);
      }
    } catch { /* If pixels cannot be inspected, a horn must not assume visibility. */ }
    silhouettes.set(image, points);
  }
  return tradeShipPointsVisible(points, frame, camera, bounds);
}
