import { shipColors, shipFace, shipGrain, shipLine, shipPoint, shipPolygon } from "./trade-ship-art";
import type { ShipArtOptions, ShipColors, ShipPoint, ShipVertex } from "./trade-ship-art";

const DECK_ANGLE = Math.atan2(shipPoint(1, 0).y - shipPoint(0, 0).y, shipPoint(1, 0).x - shipPoint(0, 0).x);

function ellipse(ctx: CanvasRenderingContext2D, p: ShipPoint, rx: number, ry: number,
  fill: string | CanvasGradient, stroke: string, width = 1.5, rotation = 0) {
  ctx.beginPath(); ctx.ellipse(p.x, p.y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  if (width > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

function bolt(ctx: CanvasRenderingContext2D, p: ShipPoint, c: ShipColors, radius = 2) {
  ellipse(ctx, p, radius, radius, c.iron, c.outline, .8);
  shipLine(ctx, [{ x: p.x - radius * .5, y: p.y - radius * .3 },
    { x: p.x + radius * .4, y: p.y - radius * .6 }], c.ironLight, .9);
}

function shadow(ctx: CanvasRenderingContext2D, p: ShipPoint, rx: number, ry: number) {
  const fill = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rx);
  fill.addColorStop(0, "rgba(48,35,19,.25)"); fill.addColorStop(1, "rgba(48,35,19,0)");
  ellipse(ctx, p, rx, ry, fill, "", 0, DECK_ANGLE);
}

function curvePoints(start: ShipPoint, control: ShipPoint, end: ShipPoint, steps = 18) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, u = 1 - t;
    return { x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
      y: u * u * start.y + 2 * u * t * control.y + t * t * end.y };
  });
}

/** A fixed braid follows the rope, rather than producing random detail each frame. */
function rope(ctx: CanvasRenderingContext2D, points: readonly ShipPoint[], width: number, c: ShipColors) {
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  shipLine(ctx, points, c.outline, width + .85);
  shipLine(ctx, points, c.ropeDark, width);
  shipLine(ctx, points.map(p => ({ x: p.x - .55, y: p.y - .5 })), c.rope, width * .78);
  let distance = 0, next = 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    while (next <= distance + length) {
      const t = (next - distance) / length, x = a.x + dx * t, y = a.y + dy * t;
      const nx = -dy / length, ny = dx / length, tx = dx / length, ty = dy / length;
      shipLine(ctx, [{ x: x - nx * width * .34 - tx, y: y - ny * width * .34 - ty },
        { x: x + nx * width * .34 + tx, y: y + ny * width * .34 + ty }], c.ropeDark, .85);
      shipLine(ctx, [{ x: x - nx * width * .24 - tx * 1.7, y: y - ny * width * .24 - ty * 1.7 },
        { x: x + nx * width * .2, y: y + ny * width * .2 }], c.rope, .65);
      next += width * .95 + 1.3;
    }
    distance += length;
  }
  ctx.restore();
}

function woodFace(ctx: CanvasRenderingContext2D, vertices: readonly ShipVertex[],
  fill: string | CanvasGradient, c: ShipColors, seed: number) {
  shipFace(ctx, vertices, fill, c.outline, 1.1);
  shipGrain(ctx, vertices.map(([x, d, h]) => shipPoint(x, d, h)), seed, .1);
}

function crane(ctx: CanvasRenderingContext2D, c: ShipColors) {
  const base = shipPoint(235, 20), foot = shipPoint(235, 20, 9);
  shadow(ctx, { x: base.x + 4, y: base.y + 3 }, 32, 11);
  // A low shoe and one timber mast keep the little loading crane readable.
  ellipse(ctx, base, 19, 10, c.iron, c.outline, 1.4, DECK_ANGLE);
  shipFace(ctx, [[217, 20, 1], [253, 20, 1], [253, 20, 10], [217, 20, 10]], c.iron, c.outline);
  ellipse(ctx, foot, 19, 9, c.ironLight, c.outline, 1.1, DECK_ANGLE);
  const mastFill = ctx.createLinearGradient(base.x - 8, 0, base.x + 8, 0);
  mastFill.addColorStop(0, c.woodDark); mastFill.addColorStop(.36, c.wood); mastFill.addColorStop(1, c.woodDark);
  woodFace(ctx, [[228, 13, 9], [242, 13, 9], [242, 13, 140], [228, 13, 140]], mastFill, c, 71);
  woodFace(ctx, [[242, 13, 9], [242, 27, 9], [242, 27, 140], [242, 13, 140]], c.woodDark, c, 72);
  shipFace(ctx, [[228, 13, 140], [242, 13, 140], [242, 27, 140], [228, 27, 140]], c.woodLight, c.outline);
  shipLine(ctx, [shipPoint(230, 14, 20), shipPoint(230, 14, 126)], c.woodLight, .7);
  for (const h of [19, 128]) {
    shipFace(ctx, [[227, 12, h], [243, 12, h], [243, 12, h + 8], [227, 12, h + 8]], c.iron, c.outline, 1);
    shipLine(ctx, [shipPoint(228, 12, h + 7), shipPoint(242, 12, h + 7)], c.ironLight, .7);
    bolt(ctx, shipPoint(235, 12, h + 4), c, 1.5);
  }
  // Tapered horizontal boom: its depth faces make it a beam rather than a line.
  woodFace(ctx, [[235, 13, 126], [104, -18, 164], [104, -18, 176], [235, 13, 143]], c.wood, c, 73);
  woodFace(ctx, [[235, 13, 143], [104, -18, 176], [104, -6, 176], [235, 27, 143]], c.woodLight, c, 74);
  shipFace(ctx, [[104, -18, 164], [104, -6, 164], [104, -6, 176], [104, -18, 176]], c.copperDark, c.outline, 1.2);
  shipLine(ctx, [shipPoint(231, 14, 140), shipPoint(108, -17, 172)], c.woodLight, .8);
  const pivot = shipPoint(237, 30, 134);
  ellipse(ctx, pivot, 10, 11, c.iron, c.outline, 1.3);
  ellipse(ctx, { x: pivot.x - 1, y: pivot.y - 1 }, 7.1, 8, c.ironLight, c.iron, .8);
  bolt(ctx, pivot, c, 3.2);
  const pulley = shipPoint(105, -9, 169);
  ellipse(ctx, pulley, 6.4, 7.2, c.iron, c.outline, 1.7);
  ellipse(ctx, { x: pulley.x - .7, y: pulley.y - .6 }, 3.8, 4.5, c.ironLight, c.outline, .7);
  bolt(ctx, pulley, c, 1.2);
  const winch = shipPoint(239, 29, 50), hook = shipPoint(105, -12, 95);
  rope(ctx, curvePoints({ x: winch.x - 2, y: winch.y },
    { x: pulley.x + 60, y: pulley.y + 107 }, { x: pulley.x + 4, y: pulley.y + 4 }), 3.8, c);
  rope(ctx, curvePoints({ x: pulley.x - 3, y: pulley.y + 3 },
    { x: hook.x - 2, y: hook.y - 36 }, { x: hook.x, y: hook.y - 9 }), 3.2, c);
  ellipse(ctx, winch, 8, 9, c.iron, c.outline, 1.5);
  ellipse(ctx, winch, 4.5, 5.4, c.copper, c.copperLight, 1);
  shipLine(ctx, [winch, { x: winch.x + 12, y: winch.y - 3 },
    { x: winch.x + 12, y: winch.y + 3 }], c.outline, 3.5);
  shipLine(ctx, [{ x: winch.x + 12, y: winch.y - 3 }, { x: winch.x + 12, y: winch.y + 3 }], c.woodLight, 2);
  ellipse(ctx, { x: hook.x, y: hook.y - 6 }, 3.5, 4.5, c.ironLight, c.outline, 1.2);
  ctx.beginPath(); ctx.moveTo(hook.x, hook.y - 2); ctx.lineTo(hook.x, hook.y + 3);
  ctx.bezierCurveTo(hook.x - 9, hook.y + 10, hook.x + 8, hook.y + 15, hook.x + 7, hook.y + 5);
  ctx.strokeStyle = c.outline; ctx.lineWidth = 5; ctx.stroke();
  ctx.strokeStyle = c.ironLight; ctx.lineWidth = 2.8; ctx.stroke();
}

function barrel(ctx: CanvasRenderingContext2D, c: ShipColors) {
  const p = shipPoint(-45, 30), top = shipPoint(-45, 30, 45);
  shadow(ctx, { x: p.x + 1, y: p.y + 3 }, 27, 11);
  const fill = ctx.createLinearGradient(p.x - 20, 0, p.x + 20, 0);
  fill.addColorStop(0, c.woodDark); fill.addColorStop(.28, c.woodLight);
  fill.addColorStop(.67, c.wood); fill.addColorStop(1, c.woodDark);
  ctx.beginPath(); ctx.moveTo(top.x - 16, top.y);
  ctx.bezierCurveTo(p.x - 23, top.y + 16, p.x - 22, p.y - 9, p.x - 16, p.y);
  ctx.bezierCurveTo(p.x - 8, p.y + 8, p.x + 12, p.y + 8, p.x + 17, p.y);
  ctx.bezierCurveTo(p.x + 23, p.y - 13, p.x + 22, top.y + 14, top.x + 16, top.y);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = c.outline; ctx.lineWidth = 2; ctx.stroke();
  for (const offset of [-12, -5, 3, 11]) {
    ctx.beginPath(); ctx.moveTo(top.x + offset, top.y + 2);
    ctx.bezierCurveTo(p.x + offset * 1.2, top.y + 18, p.x + offset * 1.2, p.y - 10, p.x + offset, p.y + 3);
    ctx.strokeStyle = c.woodDark; ctx.lineWidth = 1; ctx.stroke();
    shipLine(ctx, [{ x: top.x + offset + 1.5, y: top.y + 10 },
      { x: p.x + offset * 1.12 + 1, y: p.y - 12 }], c.woodLight, .65);
  }
  for (const h of [7, 34]) {
    const y = p.y - h, radius = h === 7 ? 19 : 18.5;
    ctx.beginPath(); ctx.ellipse(p.x, y, radius, 7, .075, 0, Math.PI);
    ctx.strokeStyle = c.outline; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = c.ironLight; ctx.lineWidth = 4.6; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(p.x, y - 1, radius, 7, .075, .2, Math.PI - .2);
    ctx.strokeStyle = c.iron; ctx.lineWidth = 1.1; ctx.stroke();
    bolt(ctx, { x: p.x + 10, y: y + 6 }, c, 1.1);
  }
  ellipse(ctx, top, 17, 8, c.ironLight, c.outline, 2, DECK_ANGLE);
  ellipse(ctx, { x: top.x, y: top.y - .7 }, 13.8, 5.7, c.deck, c.woodDark, 1.2, DECK_ANGLE);
  for (const x of [-6, 1, 8]) shipLine(ctx, [{ x: top.x + x - 2, y: top.y - 5 },
    { x: top.x + x + 1, y: top.y + 4 }], c.woodDark, .9);
  shipLine(ctx, [{ x: top.x - 12, y: top.y - 3.4 }, { x: top.x + 8, y: top.y - 4 }], c.deckLight, .8);
}

function linenBundle(ctx: CanvasRenderingContext2D, c: ShipColors) {
  const p = shipPoint(220, -30), tie = { x: p.x - 1, y: p.y - 27 };
  shadow(ctx, { x: p.x + 3, y: p.y + 3 }, 34, 12);
  const fill = ctx.createRadialGradient(p.x - 9, p.y - 26, 2, p.x + 3, p.y - 12, 36);
  fill.addColorStop(0, c.linen); fill.addColorStop(.55, c.linen); fill.addColorStop(1, c.linenDark);
  ctx.beginPath(); ctx.moveTo(p.x - 28, p.y - 1);
  ctx.bezierCurveTo(p.x - 33, p.y - 9, p.x - 27, p.y - 25, p.x - 19, p.y - 28);
  ctx.bezierCurveTo(p.x - 9, p.y - 32, p.x + 2, p.y - 35, p.x + 14, p.y - 28);
  ctx.bezierCurveTo(p.x + 25, p.y - 26, p.x + 32, p.y - 11, p.x + 28, p.y - 2);
  ctx.bezierCurveTo(p.x + 14, p.y + 8, p.x - 12, p.y + 8, p.x - 28, p.y - 1);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = c.outline; ctx.lineWidth = 1.8; ctx.stroke();
  for (const [dx, dy] of [[-24, -1], [-23, -18], [-14, 4], [17, 3], [25, -9], [16, -27]]) {
    ctx.beginPath(); ctx.moveTo(tie.x, tie.y + 1);
    ctx.quadraticCurveTo(p.x + dx * .4, p.y + dy - 5, p.x + dx, p.y + dy);
    ctx.strokeStyle = c.linenDark; ctx.lineWidth = 1.4; ctx.stroke();
  }
  rope(ctx, curvePoints({ x: p.x - 27, y: p.y - 16 }, tie, { x: p.x + 28, y: p.y - 8 }), 2.8, c);
  rope(ctx, curvePoints({ x: p.x - 4, y: p.y + 4 },
    { x: p.x + 6, y: p.y - 13 }, tie), 3.1, c);
  rope(ctx, curvePoints(tie, { x: tie.x - 11, y: tie.y - 12 }, { x: tie.x - 3, y: tie.y - 1 }), 2.5, c);
  rope(ctx, curvePoints(tie, { x: tie.x + 10, y: tie.y - 9 }, { x: tie.x + 3, y: tie.y }), 2.5, c);
  ellipse(ctx, tie, 4, 3, c.rope, c.ropeDark, 1.1, -.4);
}

function ropeCoil(ctx: CanvasRenderingContext2D, c: ShipColors) {
  const p = shipPoint(170, 40);
  shadow(ctx, { x: p.x + 2, y: p.y + 1 }, 31, 10);
  for (let ring = 3; ring >= 0; ring--) {
    const rx = 11 + ring * 4.3, ry = 3.6 + ring * 2.3;
    const points = Array.from({ length: 57 }, (_, i) => {
      const a = i / 56 * Math.PI * 2;
      return { x: p.x + Math.cos(a) * rx, y: p.y - 4 + Math.sin(a) * ry + Math.cos(a) * 1.4 };
    });
    rope(ctx, points, 3.3, c);
  }
  rope(ctx, curvePoints({ x: p.x + 9, y: p.y - 4 },
    { x: p.x + 37, y: p.y + 5 }, { x: p.x + 32, y: p.y - 9 }), 3.2, c);
  // Small iron cleat nestled inside the coil.
  const cleat = shipPoint(169, 40, 7);
  ellipse(ctx, { x: cleat.x, y: cleat.y + 4 }, 9, 3.2, c.iron, c.outline, 1);
  shipLine(ctx, [{ x: cleat.x - 7, y: cleat.y + 2 }, { x: cleat.x - 7, y: cleat.y - 4 },
    { x: cleat.x + 7, y: cleat.y - 3 }, { x: cleat.x + 7, y: cleat.y + 3 }], c.outline, 5);
  shipLine(ctx, [{ x: cleat.x - 7, y: cleat.y + 1 }, { x: cleat.x - 7, y: cleat.y - 3 },
    { x: cleat.x + 7, y: cleat.y - 2 }, { x: cleat.x + 7, y: cleat.y + 2 }], c.ironLight, 2.8);
}

function cargoCrate(ctx: CanvasRenderingContext2D, x: number, index: number, c: ShipColors) {
  const d = 0, h = 37, s = 19;
  shadow(ctx, shipPoint(x + 2, d + 3), 31, 13);
  const face: ShipVertex[] = [[x - s, d + s, 0], [x + s, d + s, 0], [x + s, d + s, h], [x - s, d + s, h]];
  woodFace(ctx, [[x + s, d - s, 0], [x + s, d + s, 0], [x + s, d + s, h], [x + s, d - s, h]], c.woodDark, c, 120 + index);
  const fill = ctx.createLinearGradient(0, shipPoint(x, d, h).y, 0, shipPoint(x, d).y);
  fill.addColorStop(0, c.woodLight); fill.addColorStop(1, c.wood);
  woodFace(ctx, face, fill, c, 130 + index);
  woodFace(ctx, [[x - s, d - s, h], [x + s, d - s, h], [x + s, d + s, h], [x - s, d + s, h]], c.deck, c, 140 + index);
  for (const offset of [-6, 6]) shipLine(ctx, [shipPoint(x + offset, d + s, 1), shipPoint(x + offset, d + s, h - 1)], c.woodDark, .9);
  for (const z of [3, 30]) {
    shipFace(ctx, [[x - s, d + s, z], [x + s, d + s, z], [x + s, d + s, z + 5], [x - s, d + s, z + 5]], c.woodLight, c.woodDark, 1);
    for (const offset of [-15, 15]) bolt(ctx, shipPoint(x + offset, d + s, z + 2.5), c, 1);
  }
  shipFace(ctx, [[x - 17, d + s, 8], [x - 13, d + s, 8], [x + 17, d + s, 30], [x + 13, d + s, 30]], c.deck, c.woodDark, 1);
  for (const offset of [-12, 12]) shipFace(ctx, [[x + offset - 2.5, d - s, h], [x + offset + 2.5, d - s, h],
    [x + offset + 2.5, d + s, h], [x + offset - 2.5, d + s, h]], c.woodLight, c.woodDark, .9);
  // Three different, restrained shipping marks, without UI-like labels on deck.
  const mark = shipPoint(x + 5, d + s, 19);
  ctx.save(); ctx.translate(mark.x, mark.y); ctx.rotate(DECK_ANGLE);
  ctx.strokeStyle = c.greenDark; ctx.fillStyle = c.greenDark; ctx.lineWidth = 1.4;
  if (index === 0) {
    ctx.beginPath(); ctx.moveTo(-3, 2); ctx.lineTo(0, -5); ctx.lineTo(3, 2); ctx.moveTo(0, -5); ctx.lineTo(0, 5); ctx.stroke();
  } else if (index === 1) {
    ctx.beginPath(); ctx.ellipse(0, 0, 3.5, 5, -.45, 0, Math.PI * 2); ctx.stroke();
    shipLine(ctx, [{ x: -2, y: 3 }, { x: 3, y: -3 }], c.greenDark, 1);
  } else {
    ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(4, 0); ctx.lineTo(0, 5); ctx.lineTo(-4, 0); ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}

function lantern(ctx: CanvasRenderingContext2D, options: ShipArtOptions, c: ShipColors) {
  const p = shipPoint(-78, 40, 70), night = Math.max(0, Math.min(1, options.night));
  const flicker = options.still ? 1 : 1 + Math.sin(options.time * 2.3) * .018 + Math.sin(options.time * 5.7) * .009;
  const radius = (26 + night * 23) * flicker;
  const glow = ctx.createRadialGradient(p.x, p.y + 3, 2, p.x, p.y + 3, radius);
  glow.addColorStop(0, `rgba(255,191,64,${(.1 + night * .2) * flicker})`);
  glow.addColorStop(.32, `rgba(255,170,42,${.045 + night * .11})`);
  glow.addColorStop(1, "rgba(255,155,37,0)");
  // Light falls on the cabin wall, never paints an orange disc behind its roof.
  ctx.save();
  const wall = [[-88, -48, 0], [-88, 50, 0], [-88, 50, 114], [-88, -48, 114]] as const;
  ctx.beginPath();
  wall.forEach(([x, d, h], i) => { const at = shipPoint(x, d, h); if (i) ctx.lineTo(at.x, at.y); else ctx.moveTo(at.x, at.y); });
  ctx.closePath(); ctx.clip();
  ellipse(ctx, { x: p.x, y: p.y + 3 }, radius, radius, glow, "", 0);
  ctx.restore();
  // Curved brass wall bracket and a separate ring above the small marine lamp.
  ctx.beginPath(); ctx.moveTo(p.x - 10, p.y - 17);
  ctx.bezierCurveTo(p.x - 14, p.y - 32, p.x + 5, p.y - 32, p.x + 3, p.y - 18);
  ctx.strokeStyle = c.outline; ctx.lineWidth = 4.5; ctx.stroke();
  ctx.strokeStyle = c.copperLight; ctx.lineWidth = 2.4; ctx.stroke();
  ellipse(ctx, { x: p.x + 1, y: p.y - 17 }, 3.2, 4.3, c.copperDark, c.outline, 1.2);
  shipPolygon(ctx, [{ x: p.x - 7, y: p.y - 9 }, { x: p.x - 5, y: p.y + 9 },
    { x: p.x, y: p.y + 13 }, { x: p.x + 6, y: p.y + 8 }, { x: p.x + 7, y: p.y - 9 }], "#f8b83c", c.outline, 1.5);
  const glass = ctx.createLinearGradient(p.x - 6, p.y, p.x + 6, p.y);
  glass.addColorStop(0, "#dd8b25"); glass.addColorStop(.38, "#ffeab0");
  glass.addColorStop(.6, "#ffd66c"); glass.addColorStop(1, "#e9a330");
  shipPolygon(ctx, [{ x: p.x - 5.8, y: p.y - 7 }, { x: p.x - 4, y: p.y + 7 },
    { x: p.x, y: p.y + 10 }, { x: p.x + 4.5, y: p.y + 6 }, { x: p.x + 5.5, y: p.y - 7 }], glass, c.copperDark, .8);
  shipLine(ctx, [{ x: p.x - 5, y: p.y - 8 }, { x: p.x - 4, y: p.y + 7 },
    { x: p.x, y: p.y + 10 }, { x: p.x + 5, y: p.y + 6 }, { x: p.x + 6, y: p.y - 8 }], c.copperDark, 1.8);
  shipLine(ctx, [{ x: p.x, y: p.y - 8 }, { x: p.x, y: p.y + 10 }], c.copper, 1.6);
  shipPolygon(ctx, [{ x: p.x - 8, y: p.y - 8 }, { x: p.x - 5, y: p.y - 13 },
    { x: p.x + 1, y: p.y - 15 }, { x: p.x + 6, y: p.y - 12 }, { x: p.x + 8, y: p.y - 8 }], c.copper, c.outline, 1.3);
  shipLine(ctx, [{ x: p.x - 5, y: p.y - 11 }, { x: p.x + 4, y: p.y - 12 }], c.copperLight, 1.1);
  shipPolygon(ctx, [{ x: p.x - 6, y: p.y + 8 }, { x: p.x, y: p.y + 12 },
    { x: p.x + 6, y: p.y + 7 }, { x: p.x + 5, y: p.y + 12 }, { x: p.x, y: p.y + 15 },
    { x: p.x - 5, y: p.y + 12 }], c.copperDark, c.outline, 1.2);
  shipLine(ctx, [{ x: p.x - 3, y: p.y + 10 }, { x: p.x, y: p.y + 12 },
    { x: p.x + 3, y: p.y + 10 }], c.copperLight, 1);
}

/** Deck furniture leaves the far rail's loading gate clear. */
export function drawTradeShipProps(ctx: CanvasRenderingContext2D, options: ShipArtOptions): void {
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  const c = shipColors(options.night);
  crane(ctx, c);
  const cargo = Math.max(0, Math.min(3, Math.floor(options.cargo || 0)));
  for (let index = 0; index < cargo; index++) cargoCrate(ctx, 10 + index * 65, index, c);
  linenBundle(ctx, c); barrel(ctx, c); ropeCoil(ctx, c); lantern(ctx, options, c);
  ctx.restore();
}

function fender(ctx: CanvasRenderingContext2D, x: number, c: ShipColors) {
  const p = shipPoint(x, 84, -31), tie = shipPoint(x, 80, 20);
  ellipse(ctx, { x: tie.x, y: tie.y }, 3.9, 3.2, c.iron, c.outline, .8, -.3);
  rope(ctx, curvePoints({ x: tie.x, y: tie.y - 1 },
    { x: tie.x - 5, y: tie.y + 8 }, { x: p.x - 1, y: p.y - 22 }), 3.7, c);
  // A heavy cylindrical rope fender, with close horizontal turns, not a fruit-like braid.
  const fill = ctx.createLinearGradient(p.x - 12, p.y, p.x + 13, p.y);
  fill.addColorStop(0, c.ropeDark); fill.addColorStop(.3, c.rope);
  fill.addColorStop(.54, c.ropeLight); fill.addColorStop(1, c.ropeDark);
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(.09);
  ctx.beginPath(); ctx.moveTo(-11, -18);
  ctx.bezierCurveTo(-12, -25, 12, -25, 12, -18);
  ctx.lineTo(13, 19); ctx.bezierCurveTo(13, 27, -12, 27, -12, 19); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = c.outline; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.clip();
  for (let y = -19; y < 24; y += 3.3) {
    ctx.beginPath(); ctx.moveTo(-14, y - 2);
    ctx.bezierCurveTo(-7, y + 3, 6, y + 5, 15, y - 1);
    ctx.strokeStyle = c.ropeDark; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-9, y - .4);
    ctx.bezierCurveTo(-4, y + 1.5, 2, y + 2, 7, y + .7);
    ctx.strokeStyle = c.rope; ctx.lineWidth = .8; ctx.stroke();
  }
  ctx.restore();
  rope(ctx, curvePoints({ x: p.x - 3, y: p.y - 23 },
    { x: p.x, y: p.y - 29 }, { x: p.x + 3, y: p.y - 22 }), 2.8, c);
}

/** Separate pass: these must cover the near rail, never disappear behind it. */
export function drawTradeShipFenders(ctx: CanvasRenderingContext2D, options: ShipArtOptions): void {
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  const c = shipColors(options.night);
  for (const x of [-175, 35, 210]) fender(ctx, x, c);
  ctx.restore();
}
