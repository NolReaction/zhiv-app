/** Each berth on the open deck represents one of the three personal orders.
 * Values are confirmed loaded fractions, not individual inventory quantities. */
export type TradeShipCargo = readonly number[];
type Point = readonly [number, number];
const positions = [[947, 473], [1140, 502], [1290, 572]] as const;

function polygon(ctx: CanvasRenderingContext2D, points: readonly Point[], fill: string, stroke = "#57452b") {
  ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 3;
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath(); ctx.fill(); ctx.stroke();
}
function line(ctx: CanvasRenderingContext2D, points: readonly Point[], color: string, width = 3) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
}
function crate(ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1) {
  ctx.save();
  try {
    ctx.translate(x, y); ctx.scale(scale, scale);
    polygon(ctx, [[-65,-80], [36,-67], [36,0], [-65,-13]], "#a7743c");
    polygon(ctx, [[36,-67], [65,-84], [65,-17], [36,0]], "#78532d");
    polygon(ctx, [[-65,-80], [-36,-97], [65,-84], [36,-67]], "#d4a15a");
    for (const y of [-60, -40, -20]) line(ctx, [[-60,y], [31,y+12]], "#79552f", 2);
    line(ctx, [[-56,-73], [-56,-20], [27,-8], [27,-60]], "#e2b775", 7);
    line(ctx, [[-54,-66], [25,-16]], "#e2b775", 8);
    line(ctx, [[43,-67], [43,-10]], "#b88b4a", 5);
    for (const [x,y] of [[-56,-72],[-56,-20],[27,-9],[27,-59]]) {
      ctx.fillStyle="#504536"; ctx.fillRect(x-2,y-2,4,4);
    }
  } finally { ctx.restore(); }
}
function sack(ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1) {
  ctx.save();
  try {
    ctx.translate(x, y); ctx.scale(scale, scale);
    polygon(ctx, [[-17,-70],[-30,-37],[-44,-23],[-39,-3],[-12,10],[23,5],[40,-8],[37,-32],[16,-66]], "#c9b486");
    polygon(ctx, [[-17,-70],[-21,-85],[0,-79],[20,-83],[16,-66]], "#dfcba0");
    line(ctx, [[-19,-67],[17,-65]], "#71623d", 5);
    line(ctx, [[-6,-61],[-19,-31],[-10,3]], "#ead4a4", 4);
    line(ctx, [[9,-59],[25,-30],[19,0]], "#a18c64", 4);
  } finally { ctx.restore(); }
}
function barrel(ctx: CanvasRenderingContext2D) {
  polygon(ctx, [[-44,-85],[-55,-52],[-49,-11],[-26,2],[25,7],[48,-5],[55,-47],[41,-74]], "#9b6b36");
  // The base silhouette is translated by the caller so all bands follow the hull.
  for (const shift of [-18, 12]) line(ctx, [[-49,-45+shift],[-30,-35+shift],[23,-29+shift],[50,-38+shift]], "#6d7770", 9);
  polygon(ctx, [[-44,-85],[-21,-98],[23,-92],[41,-74],[18,-62],[-25,-69]], "#c29250");
  line(ctx, [[-44,-85],[-25,-69],[18,-62],[41,-74]], "#aeb5a0", 6);
  line(ctx, [[-22,-57],[-24,-2]], "#c6995a", 4);
  line(ctx, [[11,-52],[12,2]], "#684a2c", 3);
}

/** Draw in native PNG pixels after the ship's shared transform. At most six
 * parcels; no timers, random placement, DOM or resource mutations. */
export function drawTradeShipCargo(ctx: CanvasRenderingContext2D, cargo: TradeShipCargo | undefined) {
  for (let index = 0; index < positions.length; index++) {
    const value = cargo?.[index], fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value!)) : 0;
    if (!fraction) continue;
    const [x, y] = positions[index];
    ctx.save();
    try {
      ctx.translate(x, y); ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.fillStyle = "rgba(49,37,18,.28)"; ctx.beginPath(); ctx.ellipse(0, -1, 70, 15, .11, 0, Math.PI * 2); ctx.fill();
      if (index === 1) barrel(ctx);
      else if (index === 2) sack(ctx, 0, -4, 1.25);
      else crate(ctx, 0, 0);
      if (fraction >= .5) {
        if (index === 0) sack(ctx, 7, -75, .68);
        else if (index === 1) sack(ctx, 48, 14, .62);
        else crate(ctx, -53, 0, .62);
      }
      if (fraction >= 1) {
        line(ctx, [[-26,-58],[28,-51]], "#ddc288", 4);
        line(ctx, [[-3,-63],[1,-48]], "#765a35", 3);
      }
    } finally { ctx.restore(); }
  }
}
