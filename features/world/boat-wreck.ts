/** The wreck is an independent object: future repairs can replace its artwork
 * at this anchor without painting over the accepted map or moving the shore. */
export const BOAT_WRECK = {
  id: "river_wreck",
  anchor: { x: 898, y: 947 },
  bounds: { x: 872, y: 925, width: 52, height: 32 },
} as const;

/** Sample once at the map's pixel density; zoom uses the same grid as the shore. */
export function prepareBoatWreck(image: HTMLImageElement) {
  const canvas = document.createElement("canvas"), { width, height } = BOAT_WRECK.bounds;
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);
  return canvas;
}

export function drawBoatWreck(ctx: CanvasRenderingContext2D, art: CanvasImageSource) {
  const { anchor, bounds } = BOAT_WRECK;
  ctx.save();
  ctx.fillStyle = "rgba(14,46,43,.27)";
  ctx.beginPath(); ctx.ellipse(anchor.x, anchor.y + 4, 23, 5, .18, 0, Math.PI * 2); ctx.fill();
  ctx.drawImage(art, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
}
