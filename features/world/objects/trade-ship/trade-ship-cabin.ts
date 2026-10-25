import { shipColors, shipFace, shipGrain, shipLine, shipPoint, shipPolygon,
  type ShipArtOptions, type ShipColors, type ShipPoint } from "./trade-ship-art";

const WALL_NEAR = 49;
const ROOF_START = -256;
const ROOF_END = -79;
const ROOF_BEAM = 61;
const CHIMNEY_LENGTH = -105;
const CHIMNEY_DEPTH = -10;

/** A shallow barrel, rather than a pitched house roof. */
function roofHeight(depth: number) {
  return 114 + Math.cos(depth / ROOF_BEAM * Math.PI / 2) * 36;
}

function roofProfile(length: number, offset = 0, from = -ROOF_BEAM): ShipPoint[] {
  return Array.from({ length: 33 }, (_, index) => {
    const depth = from + index / 32 * (ROOF_BEAM - from);
    return shipPoint(length, depth, roofHeight(depth) + offset);
  });
}

/** The rear slope is hidden beyond the tangent of this orthographic view. */
function visibleRoofProfile(length: number, offset = 0): ShipPoint[] {
  return roofProfile(length, offset, -23);
}

function drawWindow(ctx: CanvasRenderingContext2D, length: number, colors: ShipColors, night: number) {
  ctx.save();
  const d = WALL_NEAR + .7;
  const frame = [[length, d, 28], [length + 45, d, 28],
    [length + 45, d, 88], [length, d, 88]] as const;
  const corner = shipPoint(length, d, 88);
  const timber = ctx.createLinearGradient(corner.x, corner.y, corner.x + 45, corner.y + 54);
  timber.addColorStop(0, colors.woodLight); timber.addColorStop(.37, colors.wood);
  timber.addColorStop(1, colors.woodDark);
  shipFace(ctx, frame, colors.woodDark, colors.outline, 2.4);
  shipFace(ctx, [[length + 3, d + .3, 32], [length + 42, d + .3, 32],
    [length + 42, d + .3, 84], [length + 3, d + .3, 84]], timber, colors.outline, 1);

  const glass = ctx.createLinearGradient(corner.x + 8, corner.y + 5, corner.x + 36, corner.y + 55);
  glass.addColorStop(0, colors.glass); glass.addColorStop(.55, colors.glassLight);
  glass.addColorStop(1, colors.glass);
  shipFace(ctx, [[length + 7, d + .6, 37], [length + 38, d + .6, 37],
    [length + 38, d + .6, 79], [length + 7, d + .6, 79]], glass, colors.outline, 2);
  if (night > 0) {
    ctx.save();
    ctx.globalAlpha *= Math.min(1, night) * .76;
    const warm = ctx.createLinearGradient(corner.x, corner.y, corner.x + 15, corner.y + 58);
    warm.addColorStop(0, "#b77632"); warm.addColorStop(.55, "#edb75a"); warm.addColorStop(1, "#d7923c");
    shipFace(ctx, [[length + 8, d + .7, 38], [length + 37, d + .7, 38],
      [length + 37, d + .7, 78], [length + 8, d + .7, 78]], warm, "", 0);
    ctx.restore();
  }
  // The dark top and left reveal set the panes behind the timber frame.
  shipLine(ctx, [shipPoint(length + 7, d + 1, 37), shipPoint(length + 7, d + 1, 79),
    shipPoint(length + 38, d + 1, 79)], colors.outline, 2.3);
  shipLine(ctx, [shipPoint(length + 10, d + 1, 76), shipPoint(length + 19, d + 1, 76),
    shipPoint(length + 10, d + 1, 54)], colors.glassLight, 1.3);
  shipLine(ctx, [shipPoint(length + 30, d + 1, 75), shipPoint(length + 25, d + 1, 63)], colors.glassLight, .8);
  shipFace(ctx, [[length + 21, d + 1.2, 35], [length + 24, d + 1.2, 35],
    [length + 24, d + 1.2, 81], [length + 21, d + 1.2, 81]], colors.woodLight, colors.woodDark, .8);
  shipFace(ctx, [[length + 5, d + 1.2, 56], [length + 40, d + 1.2, 56],
    [length + 40, d + 1.2, 59], [length + 5, d + 1.2, 59]], colors.woodLight, colors.woodDark, .8);
  // Separate sill and lintel catch the light, with a small overhang.
  for (const h of [27, 86]) {
    shipFace(ctx, [[length - 2, d + 1.5, h], [length + 47, d + 1.5, h],
      [length + 47, d + 1.5, h + 5], [length - 2, d + 1.5, h + 5]], timber, colors.outline, 1.5);
    shipLine(ctx, [shipPoint(length, d + 2, h + 4), shipPoint(length + 45, d + 2, h + 4)], colors.woodLight, 1);
    for (const x of [length + 2, length + 43]) {
      const nail = shipPoint(x, d + 2, h + 2.2);
      ctx.beginPath(); ctx.arc(nail.x, nail.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = colors.iron; ctx.fill();
    }
  }
  ctx.restore();
}

function drawDoor(ctx: CanvasRenderingContext2D, colors: ShipColors) {
  ctx.save();
  const x = -88.8;
  const frame = [[x, -32, 0], [x, 42, 0], [x, 42, 104], [x, -32, 104]] as const;
  const near = shipPoint(x, 42, 104), far = shipPoint(x, -32, 0);
  const timber = ctx.createLinearGradient(far.x, far.y, near.x, near.y);
  timber.addColorStop(0, colors.woodDark); timber.addColorStop(.5, colors.wood);
  timber.addColorStop(1, colors.woodLight);
  shipFace(ctx, frame, colors.woodDark, colors.outline, 2.4);
  shipFace(ctx, [[x + .3, -26, 5], [x + .3, 36, 5], [x + .3, 36, 97], [x + .3, -26, 97]], timber, colors.outline, 1.5);
  for (const d of [-11, 5, 21]) {
    shipLine(ctx, [shipPoint(x + .5, d, 7), shipPoint(x + .5, d, 96)], colors.woodDark, 1);
    shipLine(ctx, [shipPoint(x + .6, d + 1.5, 9), shipPoint(x + .6, d + 1.5, 94)], colors.woodLight, .65);
  }
  shipFace(ctx, [[x + .8, -33, 99], [x + .8, 43, 99], [x + .8, 43, 105], [x + .8, -33, 105]], colors.woodLight, colors.woodDark, 1);
  shipLine(ctx, [shipPoint(x + .7, 39, 1), shipPoint(x + .7, 39, 99)], colors.woodLight, 1.7);
  for (const h of [26, 77]) {
    shipFace(ctx, [[x + 1, -25, h], [x + 1, -5, h], [x + 1, -5, h + 7], [x + 1, -25, h + 7]], colors.iron, colors.outline, 1);
    shipLine(ctx, [shipPoint(x + 1.3, -23, h + 6), shipPoint(x + 1.3, -7, h + 6)], colors.ironLight, .8);
  }
  const knob = shipPoint(x + 1.5, 27, 47);
  ctx.beginPath(); ctx.ellipse(knob.x, knob.y, 3.1, 3.7, -.1, 0, Math.PI * 2);
  ctx.fillStyle = colors.copperDark; ctx.fill(); ctx.strokeStyle = colors.outline; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(knob.x - .8, knob.y - 1, 1.9, 2.3, -.1, 0, Math.PI * 2);
  ctx.fillStyle = colors.copperLight; ctx.fill();
  ctx.restore();
}

function drawCabinWalls(ctx: CanvasRenderingContext2D, colors: ShipColors, night: number) {
  ctx.save();
  const frontTop = shipPoint(-245, WALL_NEAR, 114);
  const frontBottom = shipPoint(-90, WALL_NEAR, 0);
  const endPaint = ctx.createLinearGradient(295, 150, 329, 320);
  endPaint.addColorStop(0, colors.wood); endPaint.addColorStop(.55, colors.woodDark);
  endPaint.addColorStop(1, colors.wood);
  const endWall = [shipPoint(-90, -48, 0), shipPoint(-90, WALL_NEAR, 0),
    ...roofProfile(-90, -8).filter((_, index) => index >= 4 && index <= 29).reverse()];
  shipPolygon(ctx, endWall, endPaint, colors.outline, 2.2);
  for (let d = -40; d < 49; d += 12) {
    shipLine(ctx, [shipPoint(-89.7, d, 2), shipPoint(-89.7, d, roofHeight(d) - 9)], colors.woodDark, 1.1);
    shipLine(ctx, [shipPoint(-89.5, d + 1.5, 5), shipPoint(-89.5, d + 1.5, roofHeight(d) - 12)], colors.woodLight, .65);
  }
  const wallPaint = ctx.createLinearGradient(frontTop.x, frontTop.y, frontBottom.x, frontBottom.y);
  wallPaint.addColorStop(0, colors.linen); wallPaint.addColorStop(.5, colors.deckLight);
  wallPaint.addColorStop(1, colors.linenDark);
  const nearWall = [shipPoint(-245, WALL_NEAR, 0), shipPoint(-90, WALL_NEAR, 0),
    shipPoint(-90, WALL_NEAR, 114), shipPoint(-245, WALL_NEAR, 114)];
  shipPolygon(ctx, nearWall, wallPaint, colors.outline, 2);
  for (let h = 12; h < 112; h += 16) {
    shipLine(ctx, [shipPoint(-243, WALL_NEAR + .2, h), shipPoint(-92, WALL_NEAR + .2, h)], colors.linenDark, 1.1);
    shipLine(ctx, [shipPoint(-243, WALL_NEAR + .3, h - 1.8), shipPoint(-92, WALL_NEAR + .3, h - 1.8)], colors.linen, .8);
  }
  shipGrain(ctx, nearWall, 419, .1);
  // A broad roof shadow makes the pale boards sit behind the projecting eave.
  shipFace(ctx, [[-245, 49.4, 99], [-90, 49.4, 99], [-90, 49.4, 114], [-245, 49.4, 114]], colors.woodDark, "", 0);
  for (const [left, right] of [[-246, -236], [-101, -90]]) {
    const post = ctx.createLinearGradient(shipPoint(left, 50).x, 0, shipPoint(right, 50).x, 0);
    post.addColorStop(0, colors.woodDark); post.addColorStop(.42, colors.woodLight); post.addColorStop(1, colors.wood);
    shipFace(ctx, [[left, 50, 0], [right, 50, 0], [right, 50, 115], [left, 50, 115]], post, colors.outline, 1.8);
    shipLine(ctx, [shipPoint(left + 2.1, 50.4, 7), shipPoint(left + 2.1, 50.4, 108)], colors.woodLight, .9);
  }
  shipFace(ctx, [[-245, 50.5, 0], [-90, 50.5, 0], [-90, 50.5, 8], [-245, 50.5, 8]], colors.woodDark, colors.outline, 1.4);
  shipLine(ctx, [shipPoint(-243, 51, 7), shipPoint(-92, 51, 7)], colors.woodLight, 1.3);
  drawWindow(ctx, -226, colors, night);
  drawWindow(ctx, -165, colors, night);
  drawDoor(ctx, colors);
  ctx.restore();
}

function drawChimney(ctx: CanvasRenderingContext2D, colors: ShipColors) {
  ctx.save();
  const baseHeight = roofHeight(CHIMNEY_DEPTH) + 1;
  const bottom = shipPoint(CHIMNEY_LENGTH, CHIMNEY_DEPTH, baseHeight);
  const top = shipPoint(CHIMNEY_LENGTH, CHIMNEY_DEPTH, 210);
  const metal = ctx.createLinearGradient(top.x - 18, 0, top.x + 18, 0);
  metal.addColorStop(0, colors.copperDark); metal.addColorStop(.22, colors.copper);
  metal.addColorStop(.46, colors.copperLight); metal.addColorStop(.7, colors.copper);
  metal.addColorStop(1, colors.copperDark);
  // A shallow, rolled flashing seats the pipe on the curved boards.
  ctx.beginPath(); ctx.ellipse(bottom.x, bottom.y + 3, 21, 8, 0, 0, Math.PI);
  ctx.lineTo(bottom.x - 21, bottom.y - 2);
  ctx.ellipse(bottom.x, bottom.y - 2, 21, 8, 0, Math.PI, 0, true);
  ctx.closePath(); ctx.fillStyle = metal; ctx.fill(); ctx.strokeStyle = colors.outline; ctx.lineWidth = 1.7; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(bottom.x, bottom.y - 2, 21, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = metal; ctx.fill(); ctx.strokeStyle = colors.copperDark; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bottom.x - 16, bottom.y); ctx.lineTo(top.x - 16, top.y);
  ctx.bezierCurveTo(top.x - 16, top.y - 7, top.x + 16, top.y - 7, top.x + 16, top.y);
  ctx.lineTo(bottom.x + 16, bottom.y);
  ctx.bezierCurveTo(bottom.x + 16, bottom.y + 8, bottom.x - 16, bottom.y + 8, bottom.x - 16, bottom.y);
  ctx.closePath(); ctx.fillStyle = metal; ctx.fill();
  ctx.strokeStyle = colors.outline; ctx.lineWidth = 2; ctx.stroke();
  for (const height of [167, 204]) {
    const band = shipPoint(CHIMNEY_LENGTH, CHIMNEY_DEPTH, height), radius = 17.5;
    ctx.beginPath(); ctx.ellipse(band.x, band.y + 2, radius, 6.3, 0, 0, Math.PI);
    ctx.lineTo(band.x - radius, band.y - 3);
    ctx.ellipse(band.x, band.y - 3, radius, 6.3, 0, Math.PI, 0, true);
    ctx.closePath(); ctx.fillStyle = metal; ctx.fill(); ctx.strokeStyle = colors.copperDark; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(band.x, band.y - 3, radius - .5, 6, 0, .1, Math.PI - .1);
    ctx.strokeStyle = colors.copperLight; ctx.lineWidth = 1.3; ctx.stroke();
  }
  shipLine(ctx, [{ x: top.x - 6, y: top.y + 11 }, { x: top.x - 6.6, y: top.y + 34 }], colors.copperLight, 1.4);
  shipLine(ctx, [{ x: top.x + 11.5, y: top.y + 11 }, { x: top.x + 11.5, y: bottom.y - 3 }], colors.copperDark, 1);
  // The heavy rolled lip has a true dark opening and an illuminated inner rim.
  ctx.beginPath(); ctx.ellipse(top.x, top.y, 18.8, 8.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = colors.copperLight; ctx.fill(); ctx.strokeStyle = colors.outline; ctx.lineWidth = 1.9; ctx.stroke();
  const hollow = ctx.createLinearGradient(0, top.y - 6, 0, top.y + 6);
  hollow.addColorStop(0, "#101d1d"); hollow.addColorStop(1, colors.iron);
  ctx.beginPath(); ctx.ellipse(top.x, top.y -.5, 14.2, 5.7, 0, 0, Math.PI * 2);
  ctx.fillStyle = hollow; ctx.fill(); ctx.strokeStyle = colors.copperDark; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(top.x, top.y, 17.4, 7.2, 0, .1, Math.PI - .1);
  ctx.strokeStyle = colors.copperLight; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

function drawCabinRoof(ctx: CanvasRenderingContext2D, colors: ShipColors) {
  ctx.save();
  const left = visibleRoofProfile(ROOF_START), right = visibleRoofProfile(ROOF_END);
  const roof = [...left, ...right.slice().reverse()];
  const shade = ctx.createLinearGradient(0, 115, 0, 226);
  shade.addColorStop(0, colors.greenLight); shade.addColorStop(.28, colors.greenLight);
  shade.addColorStop(.58, colors.green); shade.addColorStop(1, colors.greenDark);
  shipPolygon(ctx, roof, shade, colors.outline, 2.5);
  // Long curved boards are slightly varied but retain one continuous barrel.
  for (let x = ROOF_START + 5, index = 0; x < ROOF_END - 7; x += 18, index++) {
    const surface = [...visibleRoofProfile(x), ...visibleRoofProfile(Math.min(x + 17, ROOF_END - 5)).reverse()];
    ctx.save(); ctx.globalAlpha *= index % 3 === 0 ? .13 : .06;
    shipPolygon(ctx, surface, index % 2 ? colors.greenDark : colors.greenLight, "", 0);
    ctx.restore();
    shipLine(ctx, visibleRoofProfile(x), colors.greenDark, 1.6);
    shipLine(ctx, visibleRoofProfile(x + 1.8, .4), colors.greenLight, .8);
    // Short grain marks follow the local curve instead of striping the roof.
    for (const d of [-4, 23, 46]) {
      const trace = [d - 7, d - 2, d + 3, d + 8].map((v, n) => shipPoint(x + 7 + n * .35, v, roofHeight(v) + .2));
      shipLine(ctx, trace, index % 2 ? colors.green : colors.greenLight, .55);
    }
  }
  shipGrain(ctx, roof, 821, .055);
  // Two broad, steam-bent timber end ribs frame the green planks.
  for (const [start, end] of [[ROOF_START - 1, ROOF_START + 7], [ROOF_END - 8, ROOF_END + 1]]) {
    const rib = [...visibleRoofProfile(start, 2), ...visibleRoofProfile(end, 2).reverse()];
    const edgeShade = ctx.createLinearGradient(0, 126, 0, 218);
    edgeShade.addColorStop(0, colors.woodLight); edgeShade.addColorStop(.5, colors.wood);
    edgeShade.addColorStop(1, colors.woodDark);
    shipPolygon(ctx, rib, edgeShade, colors.outline, 1.6);
    shipLine(ctx, visibleRoofProfile(start + 1.6, 2.4), colors.woodLight, 1.2);
    for (const d of [-21, 12, 43, 58]) {
      const bolt = shipPoint((start + end) / 2, d, roofHeight(d) + 2.5);
      ctx.beginPath(); ctx.ellipse(bolt.x, bolt.y, 1.65, 1.9, -.25, 0, Math.PI * 2);
      ctx.fillStyle = colors.iron; ctx.fill(); ctx.strokeStyle = colors.woodLight; ctx.lineWidth = .7; ctx.stroke();
    }
  }
  // A thin transverse strap sits across the sunlit upper quarter.
  for (const d of [-7]) {
    shipFace(ctx, [[ROOF_START + 8, d, roofHeight(d) + .8], [ROOF_END - 9, d, roofHeight(d) + .8],
      [ROOF_END - 9, d + 3, roofHeight(d + 3) + .8], [ROOF_START + 8, d + 3, roofHeight(d + 3) + .8]], colors.ironLight, colors.greenDark, .7);
    for (let x = ROOF_START + 17; x < ROOF_END - 12; x += 35) {
      const bolt = shipPoint(x, d + 1.5, roofHeight(d + 1.5) + 1.1);
      ctx.beginPath(); ctx.arc(bolt.x, bolt.y, .9, 0, Math.PI * 2); ctx.fillStyle = colors.iron; ctx.fill();
    }
  }
  shipFace(ctx, [[ROOF_START, 62, 107], [ROOF_END, 62, 107],
    [ROOF_END, 62, 115], [ROOF_START, 62, 115]], colors.wood, colors.outline, 1.8);
  shipLine(ctx, [shipPoint(ROOF_START + 2, 62.3, 114), shipPoint(ROOF_END - 2, 62.3, 114)], colors.woodLight, 1.5);
  ctx.restore();
}

/** The cabin is fixed scenery; door and glass do not change simulation state. */
export function drawTradeShipCabin(ctx: CanvasRenderingContext2D, options: ShipArtOptions): void {
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  const colors = shipColors(options.night);
  drawCabinWalls(ctx, colors, options.night);
  drawCabinRoof(ctx, colors);
  drawChimney(ctx, colors);
  ctx.restore();
}
