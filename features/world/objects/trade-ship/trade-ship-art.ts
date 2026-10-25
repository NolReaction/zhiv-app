/** Shared illustration space. No DOM, images, account state or simulation. */
export const TRADE_SHIP_ART = { width: 800, height: 500, originX: 400, originY: 300 } as const;
export type ShipPoint = { x: number; y: number };
export type ShipVertex = readonly [length: number, depth: number, height?: number];
export type ShipArtOptions = { time: number; night: number; still: boolean; cargo: number };

/** Orthographic projection shared by hull, cabin, gate, crane and cargo. */
export function shipPoint(length: number, depth: number, height = 0): ShipPoint {
  return { x: TRADE_SHIP_ART.originX + length - depth * .45,
    y: TRADE_SHIP_ART.originY + depth * .5 + length * .075 - height };
}

export function shipPolygon(ctx: CanvasRenderingContext2D, points: readonly ShipPoint[],
  fill: string | CanvasGradient, stroke = "#352c20", lineWidth = 1.6) {
  if (!points.length) return;
  ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  if (lineWidth > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

export function shipFace(ctx: CanvasRenderingContext2D, vertices: readonly ShipVertex[],
  fill: string | CanvasGradient, stroke = "#352c20", lineWidth = 1.6) {
  shipPolygon(ctx, vertices.map(([x, d, h]) => shipPoint(x, d, h)), fill, stroke, lineWidth);
}

export function shipLine(ctx: CanvasRenderingContext2D, points: readonly ShipPoint[], color: string, width = 1) {
  if (points.length < 2) return;
  ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
}

/** Repeatable grain: a paused drawing does not shimmer or consume randomness. */
export function shipGrain(ctx: CanvasRenderingContext2D, points: readonly ShipPoint[], seed = 1, opacity = .12) {
  if (!points.length) return;
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
  const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  let value = seed >>> 0;
  const random = () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
  ctx.save(); ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath(); ctx.clip(); ctx.globalAlpha *= opacity; ctx.strokeStyle = "#4b301c"; ctx.lineWidth = .65;
  for (let i = 0; i < Math.min(100, Math.ceil((right - left) * (bottom - top) / 120)); i++) {
    const x = left + random() * (right - left), y = top + random() * (bottom - top), length = 7 + random() * 27;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x + length * .3, y - 1.4, x + length * .7, y + 1.5, x + length, y + .5); ctx.stroke();
  }
  ctx.restore();
}

function shade(hex: string, night: number) {
  const rgb = Number.parseInt(hex.slice(1), 16), mix = Math.max(0, Math.min(1, night)) * .63;
  const r = Math.round((rgb >> 16) * (1 - mix) + 20 * mix);
  const g = Math.round((rgb >> 8 & 255) * (1 - mix) + 35 * mix);
  const b = Math.round((rgb & 255) * (1 - mix) + 54 * mix);
  return `rgb(${r}, ${g}, ${b})`;
}

export function shipColors(night = 0) {
  return {
    outline: shade("#302c20", night), wood: shade("#b57737", night), woodLight: shade("#e2ad62", night),
    woodDark: shade("#74502c", night), deck: shade("#d5a15c", night), deckLight: shade("#efd08b", night),
    green: shade("#456b3a", night), greenLight: shade("#76934d", night), greenDark: shade("#294b34", night),
    copper: shade("#b87d3a", night), copperLight: shade("#edbd63", night), copperDark: shade("#77512e", night),
    iron: shade("#38484a", night), ironLight: shade("#71817b", night), glass: shade("#284e59", night),
    glassLight: shade("#74a4a6", night), rope: shade("#b49458", night), ropeLight: shade("#ead19a", night),
    ropeDark: shade("#6f613d", night), linen: shade("#d9c89d", night), linenDark: shade("#aa9773", night),
  };
}

export type ShipColors = ReturnType<typeof shipColors>;
