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
  { x: 190, y: 216, height: 10 }, { x: 307, y: 332, height: 13 },
  { x: 808, y: 530, height: 12 }, { x: 853, y: 632, height: 13 },
  { x: 916, y: 742, height: 11 }, { x: 988, y: 804, height: 12 },
] as const;
export const TORCH_RADIUS = 62;

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

/** Low fixtures seated in small stones, with grass hiding the foot of the post. */
export function drawRouteProps(ctx: CanvasRenderingContext2D) {
  ctx.save(); ctx.globalAlpha = .52;
  stones.forEach((at, index) => {
    const offset = index % 2 ? 2 : -2;
    pixel(ctx, "#625b40", at.x - 2, at.y + 1, 5, 2);
    pixel(ctx, "#ac9b70", at.x - 2, at.y, 4, 2);
    pixel(ctx, "#bca780", at.x + offset, at.y - 2, 2, 1);
  });
  ctx.globalAlpha = 1;
  for (const at of ROUTE_TORCHES) {
    pixel(ctx, "#293b2c66", at.x - 4, at.y, 9, 2);
    pixel(ctx, "#5e6046", at.x - 3, at.y - 1, 6, 2);
    pixel(ctx, "#888366", at.x - 3, at.y - 1, 2, 1);
    pixel(ctx, "#443c2a", at.x - 1, at.y - at.height, 3, at.height);
    pixel(ctx, "#81633e", at.x, at.y - at.height + 1, 1, at.height - 2);
    pixel(ctx, "#544931", at.x - 2, at.y - at.height - 2, 5, 4);
    pixel(ctx, "#9d8053", at.x - 2, at.y - at.height + 1, 5, 1);
    pixel(ctx, "#4c6337", at.x + 2, at.y - 2, 1, 3);
    pixel(ctx, "#71824a", at.x - 2, at.y, 2, 1);
  }
  ctx.restore();
}

const flameFrames = [
  ["...o...", "...oo..", "..oy...", ".oyyo..", ".oyyyo.", "..yhy..", "..yy..."],
  ["....o..", "...oo..", "..oyo..", "..oyyo.", ".oyyyo.", "..yhy..", "..yy..."],
  ["..o....", "..oo...", "..oyo..", ".oyyo..", ".oyyyo.", "..yhy..", "..yy..."],
  [".......", "..o....", "..oo...", "..oyo..", ".oyyyo.", "..yhy..", "..yy..."],
  ["...o...", "..oo...", "..oyo..", ".oyyoo.", ".oyyyo.", "..yhy..", "..yy..."],
  ["....o..", "....o..", "...oo..", "..oyyo.", ".oyyyo.", "..yhy..", "..yy..."],
] as const;
const flameColors: Record<string, string> = { o: "#c77732", y: "#f3b74e", h: "#ffe3a0" };

/** Existing scene time animates actual flame silhouettes and their reflected light. */
export function drawRouteLights(ctx: CanvasRenderingContext2D, night: number, seconds: number, reducedMotion: boolean) {
  const strength = Number.isFinite(night) ? Math.max(0, Math.min(1, night)) : 0;
  if (strength <= .01) return;
  const time = reducedMotion || !Number.isFinite(seconds) ? 0 : seconds;
  ctx.save();
  ROUTE_TORCHES.forEach((at, index) => {
    const x = at.x, y = at.y - at.height - 2;
    const flicker = reducedMotion ? 1 : .97 + Math.sin(time * 4.1 + index * 2.4) * .03;
    ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = strength * flicker;
    const light = ctx.createRadialGradient(x, y, 0, x, y, TORCH_RADIUS);
    light.addColorStop(0, "rgba(255,180,78,.44)");
    light.addColorStop(.22, "rgba(247,163,61,.29)");
    light.addColorStop(.55, "rgba(226,139,49,.12)");
    light.addColorStop(1, "rgba(213,127,43,0)");
    ctx.fillStyle = light; ctx.fillRect(x - TORCH_RADIUS, y - TORCH_RADIUS, TORCH_RADIUS * 2, TORCH_RADIUS * 2);
    // The lower pool catches the ground; it is visibly connected to the post.
    ctx.save(); ctx.translate(x, at.y - 1); ctx.scale(1, .48);
    const ground = ctx.createRadialGradient(0, 0, 0, 0, 0, 28);
    ground.addColorStop(0, "rgba(243,171,77,.23)");
    ground.addColorStop(1, "rgba(227,145,55,0)");
    ctx.fillStyle = ground; ctx.fillRect(-28, -28, 56, 56); ctx.restore();
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = strength;
    const shape = flameFrames[(Math.floor(time * 7) + index * 2) % flameFrames.length];
    shape.forEach((row, rowIndex) => [...row].forEach((color, column) => {
      if (flameColors[color]) pixel(ctx, flameColors[color], x - 3 + column, y - 6 + rowIndex, 1, 1);
    }));
    if (!reducedMotion) {
      const ember = (time + index * .61) % 3.8;
      if (ember < .7) {
        ctx.globalAlpha = strength * (1 - ember / .7) * .65;
        pixel(ctx, "#f1bd68", x + Math.sin(index + ember * 4) * 2, y - 8 - ember * 9, 1, 1);
      }
    }
  });
  ctx.restore();
}
