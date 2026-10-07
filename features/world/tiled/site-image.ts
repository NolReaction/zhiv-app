import type { SiteGeometry, WorldPoint } from "./types";

/** Normalized artwork coordinates use exactly the same pivot as drawSiteImage. */
export function siteImagePoint(site: Pick<SiteGeometry, "bounds" | "imagePlacement">, u: number, v: number): WorldPoint {
  const placement = site.imagePlacement ?? site.bounds;
  const angle = (site.imagePlacement?.rotation ?? 0) % 360 * Math.PI / 180;
  const x = u * placement.width, y = v * placement.height;
  return { x: placement.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: placement.y + x * Math.sin(angle) + y * Math.cos(angle) };
}

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
