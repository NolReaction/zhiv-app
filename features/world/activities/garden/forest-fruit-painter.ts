import type { WorldPoint } from "@/features/world/tiled/types";
import { forestFruitAppearance, forestFruitVisual, type FruitPalette } from "./forest-fruit-appearance";
import type { BerryLayout } from "./forest-garden-layout";

const TAU = Math.PI * 2;
function ellipse(ctx: CanvasRenderingContext2D, point: WorldPoint, rx: number, ry: number, color: string, tilt = 0) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(point.x, point.y, rx, ry, tilt, 0, TAU); ctx.fill();
}
function leafCap(ctx: CanvasRenderingContext2D, point: WorldPoint, radius: number, palette: FruitPalette, wide = false) {
  ctx.fillStyle = palette.stem;
  ctx.beginPath(); ctx.moveTo(point.x, point.y - radius * .57);
  for (const [x, y] of (wide ? [[-.82, -.84], [-.28, -.92], [-.4, -1.19], [0, -1.02], [.43, -1.18], [.32, -.92], [.82, -.79]]
    : [[-.36, -.85], [0, -.64], [.34, -.91], [0, -1.12]])) ctx.lineTo(point.x + radius * x, point.y + radius * y);
  ctx.closePath(); ctx.fill();
}
function roundFruit(ctx: CanvasRenderingContext2D, point: WorldPoint, radius: number, palette: FruitPalette, yScale = 1.08) {
  ellipse(ctx, point, radius, radius * yScale, palette.shade, -.16);
  ellipse(ctx, { x: point.x - radius * .12, y: point.y - radius * .13 }, radius * .82, radius * .85, palette.body, -.16);
  ellipse(ctx, { x: point.x - radius * .32, y: point.y - radius * .35 }, radius * .3, radius * .2, palette.light, -.6);
  ellipse(ctx, { x: point.x + radius * .32, y: point.y + radius * .28 }, radius * .12, radius * .11, palette.detail);
  ellipse(ctx, { x: point.x - radius * .25, y: point.y + radius * .5 }, radius * .09, radius * .08, palette.detail);
}

/** Centers are tied to the branch, never to growth or the render clock. */
export function forestClusterFruit(cluster: BerryLayout, index: number, itemId?: string) {
  const currant = forestFruitAppearance(itemId).shape === "currant";
  const offsets = currant ? [[-.12, -.47], [.12, .39], [-.05, 1.2]] : [[-.48, -.08], [.48, .06], [0, .75]];
  const [dx, dy] = offsets[Math.max(0, Math.min(2, index))];
  return { x: cluster.x + dx * cluster.radius, y: cluster.y + dy * cluster.radius,
    size: cluster.radius * (currant ? .43 : .58) };
}

/** Species detail shares the scene light and the saved crop stage, including held fruit. */
export function drawForestFruit(ctx: CanvasRenderingContext2D, point: WorldPoint, radius: number, growth: number,
  itemId?: string, clusterIndex = 0, fruitIndex = 0) {
  const appearance = forestFruitAppearance(itemId), visual = forestFruitVisual(growth, clusterIndex, fruitIndex, appearance);
  const { palette } = visual;
  radius *= visual.size * appearance.radiusScale;
  if (visual.opacity <= 0 || radius <= 0) return;
  ctx.save(); ctx.globalAlpha *= visual.opacity;
  if (appearance.shape === "raspberry" || appearance.shape === "blackberry") {
    const long = appearance.shape === "blackberry", yScale = long ? 1.34 : 1.05;
    ellipse(ctx, point, radius * .83, radius * yScale, palette.shade, -.08);
    // Rounded drupelets grow out of a compact green bud into a recognisable compound fruit.
    for (const [index, [x, y, size]] of [[-.38, -.62, .32], [.13, -.75, .33], [.5, -.47, .31],
      [-.63, -.13, .31], [-.12, -.2, .34], [.4, -.04, .34], [-.4, .35, .33], [.12, .36, .34], [0, .78, .3]].entries()) {
      const center = { x: point.x + x * radius, y: point.y + y * radius * yScale };
      ellipse(ctx, center, size * radius, size * radius * 1.03, palette.body);
      ellipse(ctx, { x: center.x - radius * size * .28, y: center.y - radius * size * .28 },
        radius * size * (index % 3 ? .25 : .38), radius * size * .2, palette.light, -.4);
    }
    leafCap(ctx, { x: point.x, y: point.y - radius * (long ? .36 : .08) }, radius, palette);
  } else if (appearance.shape === "strawberry") {
    const body = (x: number, y: number, r: number, color: string) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y + r * 1.2);
      ctx.bezierCurveTo(x - r * .6, y + r * .68, x - r * 1.05, y - r * .22, x - r * .67, y - r * .68);
      ctx.bezierCurveTo(x - r * .3, y - r * 1.05, x + r * .3, y - r * 1.05, x + r * .67, y - r * .68);
      ctx.bezierCurveTo(x + r * 1.05, y - r * .22, x + r * .6, y + r * .68, x, y + r * 1.2); ctx.fill();
    };
    body(point.x, point.y, radius, palette.shade);
    body(point.x - radius * .07, point.y - radius * .09, radius * .87, palette.body);
    ellipse(ctx, { x: point.x - radius * .35, y: point.y - radius * .35 }, radius * .16, radius * .3, palette.light, -.35);
    for (const [x, y] of [[-.42, -.35], [.3, -.43], [-.17, .13], [.4, .11], [-.3, .52], [.08, .68]])
      ellipse(ctx, { x: point.x + x * radius, y: point.y + y * radius }, radius * .055, radius * .11, palette.detail, -.18);
    leafCap(ctx, point, radius, palette, true);
  } else if (appearance.shape === "blueberry") {
    roundFruit(ctx, point, radius, palette, .97);
    // A dusty blue shell and recessed five-point crown distinguish it from round red berries.
    const crown = { x: point.x + radius * .18, y: point.y - radius * .32 };
    ctx.fillStyle = palette.detail; ctx.beginPath();
    for (let index = 0; index < 10; index++) {
      const angle = -.5 * Math.PI + index * Math.PI / 5, r = radius * (index % 2 ? .13 : .28);
      const x = crown.x + Math.cos(angle) * r, y = crown.y + Math.sin(angle) * r * .7;
      if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
    ellipse(ctx, crown, radius * .075, radius * .05, palette.shade);
  } else if (appearance.shape === "currant") {
    roundFruit(ctx, point, radius, palette, .97);
    // The light showing through its warm rim gives a small translucent bead rather than a solid drupelet.
    ellipse(ctx, { x: point.x + radius * .28, y: point.y + radius * .37 }, radius * .34, radius * .21, palette.light, -.45);
    ellipse(ctx, { x: point.x, y: point.y + radius * .83 }, radius * .12, radius * .075, palette.detail);
  } else {
    roundFruit(ctx, point, radius, palette, appearance.shape === "cranberry" ? 1.21 : 1.08);
    if (appearance.shape === "cranberry") {
      ellipse(ctx, { x: point.x + radius * .18, y: point.y + radius * .68 }, radius * .13, radius * .08, palette.shade);
      ellipse(ctx, { x: point.x - radius * .37, y: point.y - radius * .32 }, radius * .09, radius * .21, palette.light, -.35);
    }
    leafCap(ctx, point, radius, palette);
  }
  ctx.restore();
}
