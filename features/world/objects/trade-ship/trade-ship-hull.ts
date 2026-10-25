import { shipColors, shipFace, shipLine, shipPoint } from "./trade-ship-art";
import type { ShipArtOptions, ShipColors, ShipPoint } from "./trade-ship-art";

type DeckPoint = readonly [length: number, depth: number];

const FAR_STERN: readonly DeckPoint[] = [
  [-296, -35], [-286, -53], [-269, -66], [-246, -74], [-220, -78],
  [-140, -78], [-60, -76], [20, -73],
];
const FAR_BOW: readonly DeckPoint[] = [
  [95, -73], [152, -75], [187, -72], [221, -62], [253, -45], [281, -23], [305, 2],
];

function curve(ctx: CanvasRenderingContext2D, a: DeckPoint, b: DeckPoint, c: DeckPoint, height = 0) {
  const p = shipPoint(a[0], a[1], height), q = shipPoint(b[0], b[1], height), r = shipPoint(c[0], c[1], height);
  ctx.bezierCurveTo(p.x, p.y, q.x, q.y, r.x, r.y);
}

/** One continuous, softly rounded stern and a fuller, tapered working bow. */
function deckPath(ctx: CanvasRenderingContext2D) {
  const start = shipPoint(-274, -64);
  ctx.beginPath(); ctx.moveTo(start.x, start.y);
  curve(ctx, [-300, -53], [-315, -27], [-308, 8]);
  curve(ctx, [-307, 43], [-281, 81], [-222, 84]);
  const end = shipPoint(150, 84); ctx.lineTo(end.x, end.y);
  curve(ctx, [218, 84], [275, 49], [306, 2]);
  curve(ctx, [278, -37], [219, -75], [152, -78]);
  const far = shipPoint(-224, -78); ctx.lineTo(far.x, far.y);
  curve(ctx, [-245, -78], [-265, -71], [-274, -64]);
  ctx.closePath();
}

function hullPoint(length: number, depth: number, height: number) {
  // Keep the visible stern silhouette vertical. Tapering its hidden back edge
  // inward makes the projected strakes fold across their own closing seam.
  const taper = Math.max(0, Math.min(1, (length + 304) / 120));
  return shipPoint(length * (1 + height * .0012 * taper), depth * (1 + height * .0015 * taper), height);
}

function nearEdge(ctx: CanvasRenderingContext2D, height: number, reverse = false) {
  const p = (length: number, depth: number) => hullPoint(length, depth, height);
  const line = (length: number, depth: number) => { const a = p(length, depth); ctx.lineTo(a.x, a.y); };
  const bend = (a: DeckPoint, b: DeckPoint, c: DeckPoint) => {
    const v = p(...a), w = p(...b), z = p(...c); ctx.bezierCurveTo(v.x, v.y, w.x, w.y, z.x, z.y);
  };
  if (reverse) {
    line(306, 2); bend([275, 49], [218, 84], [150, 84]);
    line(-222, 84); bend([-269, 81], [-296, 48], [-304, 31]);
  } else {
    line(-304, 31); bend([-296, 48], [-269, 81], [-222, 84]);
    line(150, 84); bend([218, 84], [275, 49], [306, 2]);
  }
}

function hullBand(ctx: CanvasRenderingContext2D, top: number, bottom: number,
  fill: string | CanvasGradient, outline: string, width = 1.4) {
  ctx.save(); ctx.beginPath();
  const start = hullPoint(-304, 31, top); ctx.moveTo(start.x, start.y);
  nearEdge(ctx, top); nearEdge(ctx, bottom, true); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = width; ctx.stroke(); ctx.restore();
}

function edgeStroke(ctx: CanvasRenderingContext2D, height: number, color: string, width: number) {
  ctx.save(); ctx.beginPath();
  const start = hullPoint(-304, 31, height); ctx.moveTo(start.x, start.y);
  nearEdge(ctx, height); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.restore();
}

function drawHullBody(ctx: CanvasRenderingContext2D, colors: ShipColors) {
  ctx.save();
  // The gradient follows the raked strakes instead of cutting horizontally
  // across the new camera angle. A broad dark belly gives the hull weight.
  const top = shipPoint(0, 82, 1), bottom = shipPoint(16, 82, -78);
  const paint = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y);
  paint.addColorStop(0, colors.greenLight); paint.addColorStop(.17, colors.green);
  paint.addColorStop(.58, colors.greenDark); paint.addColorStop(1, colors.outline);
  hullBand(ctx, 0, -79, paint, colors.outline, 2.5);
  hullBand(ctx, -4, -9, colors.woodDark, colors.outline, .8);
  edgeStroke(ctx, -5, colors.woodLight, 1.2);
  hullBand(ctx, -30, -35, colors.iron, colors.outline, 1.1);
  edgeStroke(ctx, -30, colors.ironLight, .85);
  hullBand(ctx, -65, -79, colors.iron, colors.outline, 1.1);
  edgeStroke(ctx, -65, colors.woodDark, 2.4);
  edgeStroke(ctx, -76, colors.outline, 2);

  // Subtle overlapping planks, with broad light variation and no gold stripes.
  for (const height of [-17, -29, -43, -55]) {
    edgeStroke(ctx, height, colors.greenDark, 1.4);
    ctx.globalAlpha = .28; edgeStroke(ctx, height - 1.4, colors.greenLight, 1);
    ctx.globalAlpha = 1;
  }
  ctx.beginPath(); const start = hullPoint(-304, 31, -10); ctx.moveTo(start.x, start.y);
  nearEdge(ctx, -10); nearEdge(ctx, -66, true); ctx.closePath(); ctx.clip();
  const rounding = ctx.createLinearGradient(80, 380, 715, 255);
  rounding.addColorStop(0, "rgba(9,22,22,.54)");
  rounding.addColorStop(.2, "rgba(18,31,27,.04)");
  rounding.addColorStop(.64, "rgba(188,191,143,.09)");
  rounding.addColorStop(.86, "rgba(18,31,27,.10)");
  rounding.addColorStop(1, "rgba(9,22,22,.48)");
  ctx.fillStyle = rounding; ctx.fillRect(30, 180, 720, 290);
  for (let row = 0; row < 10; row++) {
    for (let i = 0; i < 15; i++) {
      const x = -282 + i * 41 + Math.sin(i * 9.7 + row * 6) * 12;
      const h = -12 - row * 5.4;
      const length = 13 + ((i * 17 + row * 23) % 41);
      const a = hullPoint(x, 82, h), b = hullPoint(x + length, 82, h + .6);
      ctx.globalAlpha = row > 6 ? .12 : .08;
      shipLine(ctx, [a, { x: a.x + (b.x - a.x) * .48, y: a.y + (b.y - a.y) * .48 - .5 }, b],
        i % 3 === 0 ? colors.outline : colors.greenLight, i % 4 === 0 ? 1.7 : .65);
    }
  }
  ctx.globalAlpha = .34;
  for (const [length, height] of [[-245, -25], [-140, -53], [-12, -25], [101, -53], [211, -25]] as const) {
    const a = hullPoint(length, 83, height + 8), b = hullPoint(length + 1.5, 83, height - 2);
    shipLine(ctx, [a, b], colors.outline, .8);
    for (const offset of [-1, 6]) {
      const nail = hullPoint(length + 4, 83, height + offset);
      ctx.beginPath(); ctx.arc(nail.x, nail.y, .7, 0, Math.PI * 2); ctx.fillStyle = colors.outline; ctx.fill();
    }
  }
  // Worn patches are small, fixed strokes in the paint, never frame noise.
  ctx.globalAlpha = .2;
  for (const length of [-241, -184, -71, 45, 128, 205, 245]) {
    const height = -12 - Math.abs(length * 7 % 43);
    const a = hullPoint(length, 82, height), b = hullPoint(length + 8, 82, height + .4);
    shipLine(ctx, [a, b], colors.woodLight, 1.3);
  }
  ctx.restore();
}

function drawDeck(ctx: CanvasRenderingContext2D, colors: ShipColors) {
  ctx.save();
  const honey = ctx.createLinearGradient(160, 240, 540, 380);
  honey.addColorStop(0, colors.wood); honey.addColorStop(.33, colors.deck);
  honey.addColorStop(.7, colors.deck); honey.addColorStop(1, colors.wood);
  deckPath(ctx); ctx.fillStyle = honey; ctx.fill();
  ctx.strokeStyle = colors.outline; ctx.lineWidth = 2.4; ctx.stroke(); ctx.clip();

  for (let row = 0; row < 10; row++) {
    const depth = -79 + row * 16;
    ctx.globalAlpha = .15;
    shipFace(ctx, [[-330, depth], [330, depth], [330, depth + 16], [-330, depth + 16]],
      row % 3 === 0 ? colors.woodLight : colors.deckLight, colors.deck, 0);
    ctx.globalAlpha = 1;
    shipLine(ctx, [shipPoint(-330, depth), shipPoint(330, depth)], colors.woodDark, .85);
    shipLine(ctx, [shipPoint(-330, depth + 1.6), shipPoint(330, depth + 1.6)], colors.deckLight, .5);
    for (let joint = 0; joint < 3; joint++) {
      const x = -264 + joint * 196 + ((row * 83) % 141);
      shipLine(ctx, [shipPoint(x, depth + 1), shipPoint(x, depth + 15)], colors.woodDark, .9);
      for (const offset of [3.5, 12]) {
        for (const side of [-3.2, 3.2]) {
          const nail = shipPoint(x + side, depth + offset);
          ctx.beginPath(); ctx.arc(nail.x, nail.y, .66, 0, Math.PI * 2);
          ctx.fillStyle = colors.woodDark; ctx.fill();
          ctx.beginPath(); ctx.arc(nail.x - .2, nail.y - .35, .22, 0, Math.PI * 2);
          ctx.fillStyle = colors.deckLight; ctx.fill();
        }
      }
    }
    // Wispy, unequal grain, with no frame-dependent random source.
    ctx.globalAlpha = .17;
    for (let grain = 0; grain < 15; grain++) {
      const x = -312 + grain * 43 + Math.sin(row * 8.1 + grain * 2.8) * 15;
      const d = depth + 4 + ((grain * 13 + row * 7) % 8);
      const length = 11 + (grain * 7 + row * 13) % 29;
      const a = shipPoint(x, d), b = shipPoint(x + length, d + .6);
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(a.x + length * .3, a.y - .8, b.x - length * .3, b.y + .8, b.x, b.y);
      ctx.strokeStyle = grain % 4 === 0 ? colors.deckLight : colors.woodDark; ctx.lineWidth = .65; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  for (const [x, depth] of [[-130, -25], [-33, 49], [164, 11], [234, -36]] as const) {
    const knot = shipPoint(x, depth);
    ctx.save(); ctx.translate(knot.x, knot.y); ctx.rotate(-.1974); ctx.globalAlpha = .43;
    ctx.strokeStyle = colors.woodDark; ctx.lineWidth = .75;
    for (const size of [1.7, 5, 9]) {
      ctx.beginPath(); ctx.ellipse(0, 0, size, size * .2, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  // A fine, warm inlaid margin keeps the planks inside a solid timber rim.
  ctx.globalAlpha = .55; ctx.strokeStyle = colors.woodDark; ctx.lineWidth = 11; deckPath(ctx); ctx.stroke();
  ctx.globalAlpha = .6; ctx.strokeStyle = colors.deckLight; ctx.lineWidth = 1; deckPath(ctx); ctx.stroke();
  ctx.restore();
}

function ribbon(ctx: CanvasRenderingContext2D, points: readonly DeckPoint[], lower: number, upper: number,
  depthOffset: number, fill: string | CanvasGradient, colors: ShipColors, lineWidth = 1.4) {
  ctx.save(); const vertices: ShipPoint[] = [];
  for (const [x, depth] of points) vertices.push(shipPoint(x, depth + depthOffset, lower));
  for (const [x, depth] of [...points].reverse()) vertices.push(shipPoint(x, depth + depthOffset, upper));
  ctx.beginPath(); ctx.moveTo(vertices[0].x, vertices[0].y);
  for (const point of vertices.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = colors.outline; ctx.lineWidth = lineWidth; ctx.stroke(); ctx.restore();
}

function farPost(ctx: CanvasRenderingContext2D, x: number, depth: number, colors: ShipColors, width = 8) {
  ctx.save();
  shipFace(ctx, [[x - width / 2, depth + 6, 1], [x + width / 2, depth + 6, 1],
    [x + width / 2, depth + 6, 39], [x - width / 2, depth + 6, 39]], colors.wood, colors.outline, 1.6);
  shipFace(ctx, [[x + width / 2, depth + 6, 1], [x + width / 2, depth - 5, 1],
    [x + width / 2, depth - 5, 39], [x + width / 2, depth + 6, 39]], colors.woodDark, colors.outline, 1.2);
  shipFace(ctx, [[x - width / 2, depth + 6, 39], [x + width / 2, depth + 6, 39],
    [x + width / 2, depth - 5, 39], [x - width / 2, depth - 5, 39]], colors.woodLight, colors.outline, 1.3);
  shipLine(ctx, [shipPoint(x - width / 2 + 1.5, depth + 6, 3), shipPoint(x - width / 2 + 1.5, depth + 6, 36)], colors.woodLight, .9);
  shipLine(ctx, [shipPoint(x + 1, depth + 6, 7), shipPoint(x + 1, depth + 6, 32)], colors.woodDark, .75);
  ctx.restore();
}

function farRail(ctx: CanvasRenderingContext2D, points: readonly DeckPoint[], colors: ShipColors) {
  ctx.save();
  const green = ctx.createLinearGradient(0, 219, 0, 277);
  green.addColorStop(0, colors.greenLight); green.addColorStop(1, colors.greenDark);
  ribbon(ctx, points, 1, 29, 4, green, colors);
  shipLine(ctx, points.map(([x, d]) => shipPoint(x, d + 4, 15)), colors.greenDark, 1.5);
  shipLine(ctx, points.map(([x, d]) => shipPoint(x, d + 4, 16.6)), colors.greenLight, .7);
  ribbon(ctx, points, 27, 35, 6, colors.wood, colors, 2);
  const top: ShipPoint[] = points.map(([x, d]) => shipPoint(x, d + 6, 35));
  const back = [...points].reverse().map(([x, d]) => shipPoint(x, d - 6, 35));
  ctx.beginPath(); ctx.moveTo(top[0].x, top[0].y);
  for (const point of [...top.slice(1), ...back]) ctx.lineTo(point.x, point.y);
  ctx.closePath(); ctx.fillStyle = colors.woodLight; ctx.fill();
  ctx.strokeStyle = colors.outline; ctx.lineWidth = 1.9; ctx.stroke();
  shipLine(ctx, points.map(([x, d]) => shipPoint(x, d + 3, 35.8)), colors.deckLight, 1.2);
  ctx.restore();
}

function railShadow(ctx: CanvasRenderingContext2D, points: readonly DeckPoint[], colors: ShipColors) {
  ctx.save(); deckPath(ctx); ctx.clip();
  const edge = points.map(([x, d]) => shipPoint(x, d + 4));
  const fall = [...points].reverse().map(([x, d]) => shipPoint(x + 5, d + 23));
  ctx.beginPath(); ctx.moveTo(edge[0].x, edge[0].y);
  for (const point of [...edge.slice(1), ...fall]) ctx.lineTo(point.x, point.y);
  ctx.closePath(); ctx.globalAlpha = .26; ctx.fillStyle = colors.outline; ctx.fill();
  ctx.restore();
}

/** Base painter: the deck is empty and the far-side gate is physically open. */
export function drawTradeShipHull(ctx: CanvasRenderingContext2D, options: ShipArtOptions): void {
  ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
  const colors = shipColors(options.night);
  drawHullBody(ctx, colors); drawDeck(ctx, colors);
  railShadow(ctx, FAR_STERN, colors); railShadow(ctx, FAR_BOW, colors);
  // These are separate pieces. Nothing above deck crosses length 20…95.
  farRail(ctx, FAR_STERN, colors); farRail(ctx, FAR_BOW, colors);
  for (const [x, depth] of [[-268, -66], [-187, -78], [-108, -77], [-28, -75],
    [164, -74], [234, -55], [285, -19]] as const) farPost(ctx, x, depth, colors, 5.5);
  farPost(ctx, 16, -73, colors); farPost(ctx, 99, -73, colors);
  ctx.restore();
}

/** Final pass: a continuous, solid gunwale conceals the feet of deck cargo. */
export function drawTradeShipFrontRail(ctx: CanvasRenderingContext2D, options: ShipArtOptions): void {
  ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
  const colors = shipColors(options.night);
  const near: readonly DeckPoint[] = [
    [-306, -16], [-307, 5], [-300, 29], [-284, 52], [-258, 71], [-222, 80],
    [-145, 81], [-65, 81], [15, 81], [95, 81], [150, 80], [191, 74],
    [228, 60], [261, 42], [286, 21], [306, 2],
  ];
  // A low green bulwark, with a worn oak cap and visible front bevel.
  const green = ctx.createLinearGradient(0, 290, 0, 362);
  green.addColorStop(0, colors.greenLight); green.addColorStop(1, colors.greenDark);
  ribbon(ctx, near, 0, 23, 0, green, colors, 1.5);
  shipLine(ctx, near.map(([x, d]) => shipPoint(x, d, 9)), colors.greenDark, 1.3);
  const cap = ctx.createLinearGradient(0, 297, 0, 333);
  cap.addColorStop(0, colors.woodLight); cap.addColorStop(.5, colors.wood); cap.addColorStop(1, colors.woodDark);
  ribbon(ctx, near, 19, 27, 4, cap, colors, 1.4);
  const top = near.map(([x, d]) => shipPoint(x, d + 4, 27));
  const inner = [...near].reverse().map(([x, d]) => shipPoint(x, d - 7, 27));
  ctx.beginPath(); ctx.moveTo(top[0].x, top[0].y);
  for (const point of [...top.slice(1), ...inner]) ctx.lineTo(point.x, point.y);
  ctx.closePath(); ctx.fillStyle = colors.wood; ctx.fill();
  ctx.strokeStyle = colors.outline; ctx.lineWidth = 1.3; ctx.stroke();
  shipLine(ctx, near.map(([x, d]) => shipPoint(x, d + 1, 28)), colors.woodLight, .9);
  shipLine(ctx, near.map(([x, d]) => shipPoint(x, d - 4.5, 26.7)), colors.wood, .7);

  for (const [x, depth] of [[-283, 52], [-233, 79], [-174, 81], [-114, 81], [-54, 81],
    [6, 81], [66, 81], [126, 81], [184, 75], [237, 55], [281, 26]] as const) {
    const nail = shipPoint(x, depth + 5, 23);
    ctx.beginPath(); ctx.arc(nail.x, nail.y, 1.35, 0, Math.PI * 2); ctx.fillStyle = colors.woodDark; ctx.fill();
    ctx.beginPath(); ctx.arc(nail.x - .25, nail.y - .5, .7, 0, Math.PI * 2); ctx.fillStyle = colors.copperLight; ctx.fill();
  }
  for (const [x, depth] of [[-218, 80], [-43, 81], [132, 80], [262, 42]] as const) {
    shipLine(ctx, [shipPoint(x, depth - 6, 27), shipPoint(x + 1, depth + 4, 27), shipPoint(x + 1, depth + 4, 20)], colors.woodDark, 1.1);
  }
  ctx.restore();
}
