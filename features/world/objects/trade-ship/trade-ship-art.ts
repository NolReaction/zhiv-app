/** Shared illustration space. No DOM, images, account state or simulation. */
export const TRADE_SHIP_ART = { width: 800, height: 500, originX: 400, originY: 300 } as const;
export type ShipPoint = { x: number; y: number };
export type ShipVertex = readonly [length: number, depth: number, height?: number];
export type ShipArtOptions = { time: number; night: number; still: boolean; cargo: number };

/** Orthographic projection shared by hull, cabin, gate, crane and cargo. */
export function shipPoint(length: number, depth: number, height = 0): ShipPoint {
  return { x: TRADE_SHIP_ART.originX + length - depth * .45,
    y: TRADE_SHIP_ART.originY + depth * .57 - length * .20 - height };
}

export function shipPolygon(ctx: CanvasRenderingContext2D, points: readonly ShipPoint[],
  fill: string | CanvasGradient, stroke = "#30392f", lineWidth = 1.2) {
  if (!points.length) return;
  ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  if (lineWidth > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

export function shipFace(ctx: CanvasRenderingContext2D, vertices: readonly ShipVertex[],
  fill: string | CanvasGradient, stroke = "#30392f", lineWidth = 1.2) {
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
    outline: shade("#26332e", night), wood: shade("#94704a", night), woodLight: shade("#c4a573", night),
    woodDark: shade("#5b4734", night), deck: shade("#af9369", night), deckLight: shade("#d5bf91", night),
    green: shade("#3d6252", night), greenLight: shade("#718773", night), greenDark: shade("#243d35", night),
    copper: shade("#99683f", night), copperLight: shade("#ceb17c", night), copperDark: shade("#5a4433", night),
    iron: shade("#293b3b", night), ironLight: shade("#6a7a73", night), glass: shade("#23454c", night),
    glassLight: shade("#719595", night), rope: shade("#95866a", night), ropeLight: shade("#c7b795", night),
    ropeDark: shade("#5b5845", night), linen: shade("#c9bea3", night), linenDark: shade("#948973", night),
  };
}

export type ShipColors = ReturnType<typeof shipColors>;
