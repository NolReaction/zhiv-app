import type { MapPoint } from "./map-manifest";

// Authored on forest-region-v3. The river route disappears behind the canopy;
// separate visible segments avoid painting a fake path across the treetops.
export const ROUTE_SEGMENTS: readonly (readonly MapPoint[])[] = [
  [[509,510],[502,494],[495,480],[499,462],[505,441],[517,418],[536,405]],
  [[536,405],[514,396],[493,382],[467,369],[443,363],[419,365],[394,374],[368,373],[344,363],[317,352],[297,338],[283,316],[274,293],[256,273],[232,257],[213,240],[201,225],[181,217],[163,209]],
  [[536,405],[560,402],[581,405],[601,412]],
  [[728,494],[753,512],[784,533],[806,556],[818,581],[825,607],[840,633],[852,655],[872,681],[896,709],[922,735],[949,759],[972,780],[970,799],[951,822],[928,840],[902,855],[923,872],[949,885],[974,899],[991,915]],
].map(segment => segment.map(([x, y]) => ({ x, y })));
export const ROUTE_TORCHES = [
  { x: 497, y: 447 }, { x: 198, y: 213 }, { x: 252, y: 282 }, { x: 329, y: 371 }, { x: 430, y: 351 },
  { x: 801, y: 530 }, { x: 853, y: 632 }, { x: 916, y: 742 }, { x: 988, y: 804 }, { x: 992, y: 901 },
] as const;
export const TORCH_RADIUS = 43;
const TORCH_HEIGHT = 20;

function routeStones(segment: readonly MapPoint[]) {
  const stones: MapPoint[] = [];
  let distance = 0, next = 14;
  for (let i = 1; i < segment.length; i++) {
    const a = segment[i - 1], b = segment[i], length = Math.hypot(b.x - a.x, b.y - a.y);
    while (next <= distance + length) {
      const fraction = (next - distance) / length;
      stones.push({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction }); next += 36;
    }
    distance += length;
  }
  return stones;
}
const stones = ROUTE_SEGMENTS.flatMap(routeStones);
const pixel = (ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number) => {
  ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h);
};

function sign(ctx: CanvasRenderingContext2D, x: number, y: number, fishingOnly = false) {
  pixel(ctx, "#37432a", x - 6, y, 12, 2);
  pixel(ctx, "#55442d", x, y - 19, 3, 20); pixel(ctx, "#a18550", x, y - 18, 1, 18);
  const board = (dy: number, direction: number, water: boolean) => {
    pixel(ctx, "#483d2b", x - 8, y + dy, 17, 6);
    pixel(ctx, "#977548", x - 7, y + dy + 1, 15, 4);
    pixel(ctx, "#ba9c68", x - 6, y + dy + 1, 12, 1);
    pixel(ctx, "#977548", x + (direction > 0 ? 9 : -10), y + dy + 2, 2, 2);
    if (water) {
      pixel(ctx, "#b7c7a0", x - 4, y + dy + 2, 4, 1); pixel(ctx, "#b7c7a0", x, y + dy + 3, 4, 1);
    } else {
      pixel(ctx, "#3b392c", x - 2, y + dy + 2, 4, 3); pixel(ctx, "#c4af7f", x - 3, y + dy + 2, 1, 3);
    }
  };
  if (!fishingOnly) board(-20, -1, false);
  board(fishingOnly ? -18 : -12, 1, true);
}

/** Small stone groups and unlit wooden fixtures; the accepted dirt paths remain visible. */
export function drawRouteProps(ctx: CanvasRenderingContext2D) {
  ctx.save(); ctx.globalAlpha = .65;
  stones.forEach((at, index) => {
    const offset = index % 2 ? 2 : -2;
    pixel(ctx, "#625b40", at.x - 2, at.y + 1, 5, 2);
    pixel(ctx, "#ac9b70", at.x - 2, at.y, 4, 2);
    pixel(ctx, "#bca780", at.x + offset, at.y - 2, 2, 1);
  });
  ctx.globalAlpha = 1;
  for (const at of ROUTE_TORCHES) {
    pixel(ctx, "#34432c", at.x - 5, at.y, 10, 2);
    pixel(ctx, "#51422d", at.x - 1, at.y - TORCH_HEIGHT, 3, TORCH_HEIGHT);
    pixel(ctx, "#99764b", at.x - 1, at.y - TORCH_HEIGHT + 3, 1, TORCH_HEIGHT - 4);
    pixel(ctx, "#403b2d", at.x - 3, at.y - TORCH_HEIGHT - 2, 7, 5);
    pixel(ctx, "#806345", at.x - 2, at.y - TORCH_HEIGHT - 1, 5, 2);
    pixel(ctx, "#a18a58", at.x - 2, at.y - TORCH_HEIGHT + 3, 5, 1);
  }
  sign(ctx, 551, 393); sign(ctx, 968, 886, true); ctx.restore();
}

/** Existing scene time drives tiny flame variation; daytime has no flame or emitted light. */
export function drawRouteLights(ctx: CanvasRenderingContext2D, night: number, seconds: number, reducedMotion: boolean) {
  const strength = Math.max(0, Math.min(1, night));
  if (strength <= .01) return;
  ctx.save();
  ROUTE_TORCHES.forEach((at, index) => {
    const x = at.x, y = at.y - TORCH_HEIGHT;
    const flicker = reducedMotion ? 1 : 1 + Math.sin(seconds * 3.1 + index * 2.4) * .025;
    ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = strength * flicker;
    const light = ctx.createRadialGradient(x, y, 0, x, y, TORCH_RADIUS);
    light.addColorStop(0, "rgba(230,171,87,.16)");
    light.addColorStop(.30, "rgba(222,159,73,.09)");
    light.addColorStop(.68, "rgba(210,154,76,.035)");
    light.addColorStop(1, "rgba(210,154,76,0)");
    ctx.fillStyle = light; ctx.fillRect(x - TORCH_RADIUS, y - TORCH_RADIUS, TORCH_RADIUS * 2, TORCH_RADIUS * 2);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = strength * .86;
    const lean = reducedMotion ? 0 : Math.sin(seconds * 4 + index) * .7;
    pixel(ctx, "#a66839", x - 2, y - 4, 5, 5);
    pixel(ctx, "#da9c46", x - 1, y - 6, 3, 6);
    pixel(ctx, "#da9c46", x + lean, y - 8, 1, 3);
    pixel(ctx, "#f1cb77", x, y - 3, 2, 3);
  });
  ctx.restore();
}
