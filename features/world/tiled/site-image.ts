import type { SiteGeometry } from "./types";

/** Markers stay in world space; only the image uses the authored Tiled transform. */
export function drawSiteImage(ctx: CanvasRenderingContext2D, site: Pick<SiteGeometry, "bounds" | "imagePlacement">, image: CanvasImageSource) {
  const placement = site.imagePlacement;
  if (!placement) {
    const { x, y, width, height } = site.bounds;
    ctx.drawImage(image, x, y, width, height);
    return;
  }
  ctx.save();
  ctx.translate(placement.x, placement.y);
  ctx.rotate((placement.rotation % 360) * Math.PI / 180);
  ctx.drawImage(image, 0, 0, placement.width, placement.height);
  ctx.restore();
}
