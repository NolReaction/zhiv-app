import type { PleskResidentFrame } from "./plesk-resident";
import type { WorldBounds, WorldPoint } from "./tiled/types";

export const PLESK_ARTWORK = "/world/residents/plesk-atlas.png?v=8ac2eb841906";

type AtlasFrame = { x: number; y: number; width: number; height: number; footX: number; footY: number };

// Original 1448 × 1086 atlas: four 362 px columns, three direction rows.
// Each source rectangle and opaque paw baseline is measured independently:
// generated cells are not aligned closely enough to use their centres as feet.
const atlas: readonly (readonly AtlasFrame[])[] = [
  [
    { x: 39, y: 76, width: 280, height: 281, footX: 216, footY: 352 },
    { x: 416, y: 67, width: 264, height: 290, footX: 577, footY: 350 },
    { x: 771, y: 68, width: 281, height: 290, footX: 940, footY: 352 },
    { x: 1122, y: 108, width: 264, height: 249, footX: 1316, footY: 352 },
  ],
  [
    { x: 37, y: 402, width: 302, height: 289, footX: 229, footY: 686 },
    { x: 396, y: 410, width: 302, height: 281, footX: 584, footY: 686 },
    { x: 773, y: 404, width: 300, height: 285, footX: 955, footY: 684 },
    { x: 1127, y: 452, width: 290, height: 236, footX: 1334, footY: 683 },
  ],
  [
    { x: 49, y: 744, width: 277, height: 275, footX: 225, footY: 1014 },
    { x: 394, y: 738, width: 299, height: 282, footX: 579, footY: 1016 },
    { x: 777, y: 736, width: 282, height: 284, footX: 948, footY: 1016 },
    { x: 1138, y: 786, width: 266, height: 234, footX: 1322, footY: 1016 },
  ],
];
const walkColumns = [0, 1, 0, 2] as const;
const tau = Math.PI * 2;
const boundedPhase = (frame: PleskResidentFrame) => Math.max(0, Math.min(1, Number.isFinite(frame.phase) ? frame.phase : 0));
const waterAction = (frame: PleskResidentFrame) => ["cast", "fish", "bite", "reel"].includes(frame.action)
  && frame.waterTarget && Number.isFinite(frame.waterTarget.x) && Number.isFinite(frame.waterTarget.y);
const between = (a: WorldPoint, b: WorldPoint, part: number): WorldPoint => ({ x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part });

/** Body-only bounds keep taps on a long fishing line from opening the trader. */
export function pleskHitBounds(frame: PleskResidentFrame): WorldBounds {
  return { x: frame.x - frame.size * .4, y: frame.y - frame.size * 1.04,
    width: frame.size * .8, height: frame.size * 1.08 };
}

/** The rod, casting arc and bobber can remain visible after the body is culled. */
export function pleskRenderBounds(frame: PleskResidentFrame): WorldBounds {
  const size = frame.size;
  let left = frame.x - size * 1.2, right = frame.x + size * 1.2;
  let top = frame.y - size * 2.4, bottom = frame.y + size * .25;
  if (waterAction(frame)) {
    left = Math.min(left, frame.waterTarget!.x - size * .3);
    right = Math.max(right, frame.waterTarget!.x + size * .3);
    top = Math.min(top, frame.waterTarget!.y - size * 1.1);
    bottom = Math.max(bottom, frame.waterTarget!.y + size * .3);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function drawFish(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = "#557d85"; ctx.strokeStyle = "#344f56"; ctx.lineWidth = size * .075;
  ctx.beginPath(); ctx.moveTo(-size * .32, 0); ctx.lineTo(-size * .75, -size * .28);
  ctx.lineTo(-size * .67, size * .3); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#a9c3bf";
  ctx.beginPath(); ctx.ellipse(0, 0, size * .5, size * .24, 0, 0, tau); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = "#d6e4cf"; ctx.lineWidth = size * .09;
  ctx.beginPath(); ctx.moveTo(-size * .22, -size * .05); ctx.lineTo(size * .2, -size * .08); ctx.stroke();
  ctx.fillStyle = "#223839"; ctx.beginPath(); ctx.arc(size * .28, -size * .04, size * .047, 0, tau); ctx.fill();
  ctx.restore();
}

function drawBasket(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, filled: boolean) {
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = "#715035"; ctx.lineWidth = size * .09; ctx.lineCap = "round";
  ctx.beginPath(); ctx.ellipse(0, -size * .38, size * .3, size * .34, 0, Math.PI, tau); ctx.stroke();
  ctx.fillStyle = "#705239"; ctx.beginPath(); ctx.ellipse(0, -size * .33, size * .5, size * .18, 0, 0, tau); ctx.fill();
  if (filled) drawFish(ctx, size * .05, -size * .38, size * .9, -.2);
  ctx.fillStyle = "#bd925c";
  ctx.beginPath(); ctx.moveTo(-size * .48, -size * .3); ctx.lineTo(size * .48, -size * .3);
  ctx.lineTo(size * .36, size * .29); ctx.quadraticCurveTo(0, size * .43, -size * .36, size * .29);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = "#86633c"; ctx.lineWidth = size * .055;
  for (const offset of [-.2, .04, .23]) {
    ctx.beginPath(); ctx.moveTo(-size * .39, size * offset); ctx.lineTo(size * .39, size * offset); ctx.stroke();
  }
  ctx.strokeStyle = "#dec088";
  for (const offset of [-.22, 0, .22]) {
    ctx.beginPath(); ctx.moveTo(size * offset, -size * .24); ctx.lineTo(size * offset * .8, size * .27); ctx.stroke();
  }
  ctx.restore();
}

function drawRod(ctx: CanvasRenderingContext2D, grip: WorldPoint, tip: WorldPoint, size: number, tension: number) {
  const middle = between(grip, tip, .62);
  ctx.lineCap = "round"; ctx.strokeStyle = "#62472d"; ctx.lineWidth = size * .045;
  ctx.beginPath(); ctx.moveTo(grip.x, grip.y); ctx.lineTo(middle.x, middle.y); ctx.stroke();
  ctx.strokeStyle = "#d1b27c"; ctx.lineWidth = size * .028;
  ctx.beginPath(); ctx.moveTo(grip.x, grip.y); ctx.lineTo(middle.x, middle.y);
  ctx.quadraticCurveTo(tip.x, tip.y - size * .09 * tension, tip.x, tip.y + size * .04 * tension); ctx.stroke();
  ctx.strokeStyle = "#765639"; ctx.lineWidth = size * .08;
  const handle = between(grip, tip, .12);
  ctx.beginPath(); ctx.moveTo(grip.x, grip.y + size * .025); ctx.lineTo(handle.x, handle.y); ctx.stroke();
  ctx.fillStyle = "#586861"; ctx.beginPath(); ctx.arc(grip.x, grip.y + size * .04, size * .045, 0, tau); ctx.fill();
  ctx.strokeStyle = "#d4bf8c"; ctx.lineWidth = size * .015; ctx.stroke();
}

function drawTackle(ctx: CanvasRenderingContext2D, frame: PleskResidentFrame, phase: number, still: boolean) {
  const size = frame.size, side = frame.direction === "left" ? -1 : 1;
  const grip = { x: frame.x + side * size * .22, y: frame.y - size * .39 };
  const active = waterAction(frame);
  if (!active) {
    if (frame.action === "rest" || frame.action === "trade" || frame.action === "pack") return;
    const tip = { x: grip.x + side * size * .22, y: grip.y - size * 1.02 };
    drawRod(ctx, grip, tip, size, 0);
    ctx.strokeStyle = "#d4d4bda0"; ctx.lineWidth = size * .016;
    ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(tip.x - side * size * .035, tip.y + size * .25); ctx.stroke();
    ctx.fillStyle = "#d87349"; ctx.beginPath(); ctx.ellipse(tip.x - side * size * .035, tip.y + size * .25,
      size * .025, size * .04, 0, 0, tau); ctx.fill();
    return;
  }
  const water = frame.waterTarget!, distance = Math.max(1, Math.hypot(water.x - grip.x, water.y - grip.y));
  const reach = Math.min(distance * .7, size * 1.03);
  const ready = { x: grip.x + (water.x - grip.x) / distance * reach,
    y: grip.y + (water.y - grip.y) / distance * reach - size * .48 };
  const cast = frame.action === "cast" ? phase : 1;
  const tip = between({ x: grip.x - (ready.x - grip.x) * .65, y: grip.y - size * 1.15 }, ready, cast);
  const tension = frame.action === "bite" ? 1 : frame.action === "reel" ? 1 - phase * .5 : 0;
  if (frame.action === "reel") tip.y -= phase * size * .24;
  drawRod(ctx, grip, tip, size, tension);
  let bobber = between(grip, water, cast);
  bobber.y -= Math.sin(cast * Math.PI) * size * .8;
  if (!still && frame.action === "fish") bobber.y += Math.sin(phase * tau * 6) * size * .009;
  if (!still && frame.action === "bite") bobber.y += (1 - Math.cos(phase * tau * 3)) * size * .035;
  if (frame.action === "reel") bobber = between(water, { x: grip.x + side * size * .36, y: grip.y - size * .25 }, phase);
  ctx.strokeStyle = "#e4e3c4c0"; ctx.lineWidth = size * .02;
  ctx.beginPath(); ctx.moveTo(tip.x, tip.y);
  ctx.quadraticCurveTo((tip.x + bobber.x) / 2, Math.max(tip.y, bobber.y) + size * .07 * (1 - tension), bobber.x, bobber.y); ctx.stroke();
  if (cast >= .99 && frame.action !== "reel") {
    const ring = still ? .35 : phase * (frame.action === "bite" ? 4 : 7) % 1;
    ctx.strokeStyle = `rgba(218,238,212,${(1 - ring) * .6})`; ctx.lineWidth = size * .022;
    ctx.beginPath(); ctx.ellipse(water.x, water.y + size * .025, size * (.055 + ring * .17),
      size * (.025 + ring * .065), 0, 0, tau); ctx.stroke();
  }
  ctx.fillStyle = "#f7e6b9"; ctx.beginPath(); ctx.ellipse(bobber.x, bobber.y, size * .035, size * .05, 0, 0, tau); ctx.fill();
  ctx.fillStyle = "#d76c42"; ctx.beginPath(); ctx.ellipse(bobber.x, bobber.y - size * .035, size * .032, size * .028, 0, 0, tau); ctx.fill();
  if (frame.action === "reel" && phase > .08) drawFish(ctx, bobber.x, bobber.y + size * .13, size * .22,
    -Math.PI / 2 + (still ? 0 : Math.sin(phase * tau * 3) * .22));
}

/** Direct atlas painting: no per-frame canvases, pixel readback or growing cache. */
export function drawPleskResident(ctx: CanvasRenderingContext2D, frame: PleskResidentFrame,
  image: HTMLImageElement | undefined, still: boolean) {
  if (!image || !(image.naturalWidth || image.width) || ![frame.x, frame.y, frame.size].every(Number.isFinite) || frame.size <= 0) return;
  const phase = still ? 0 : boundedPhase(frame), size = frame.size, side = frame.direction === "left" ? -1 : 1;
  const row = frame.direction === "back" ? 2 : frame.direction === "front" ? 0 : 1;
  const column = frame.action === "rest" ? 3 : frame.action === "walk" && !still
    ? walkColumns[Math.abs(Math.trunc(frame.frame || 0)) % walkColumns.length] : 0;
  const source = atlas[row][column], scale = size / 280;
  const breath = still ? 0 : Math.sin(phase * tau * (frame.action === "fish" ? 5 : 1)) * .004;
  const nod = !still && frame.action === "greet" ? Math.sin(phase * Math.PI) * .035 : 0;
  ctx.save();
  ctx.fillStyle = "rgba(28,43,35,.08)"; ctx.beginPath(); ctx.ellipse(frame.x, frame.y + size * .012, size * .28, size * .06, 0, 0, tau); ctx.fill();
  ctx.fillStyle = "rgba(28,43,35,.18)"; ctx.beginPath(); ctx.ellipse(frame.x, frame.y, size * .2, size * .032, 0, 0, tau); ctx.fill();
  ctx.save(); ctx.translate(frame.x, frame.y); ctx.scale(side, 1 + breath - nod);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, source.x, source.y, source.width, source.height,
    (source.x - source.footX) * scale, (source.y - source.footY) * scale, source.width * scale, source.height * scale);
  ctx.restore();
  drawTackle(ctx, frame, phase, still);
  const basketOnGround = frame.action === "trade" || frame.action === "pack" || frame.action === "rest"
    || frame.action === "catch" || !!waterAction(frame);
  const basket = { x: frame.x + side * size * (basketOnGround ? .4 : .23), y: frame.y - size * (basketOnGround ? .08 : .3) };
  if (frame.carryingFish || basketOnGround) drawBasket(ctx, basket.x, basket.y, size * .27,
    frame.carryingFish && (frame.action !== "pack" || phase > .65));
  if (frame.action === "catch" || frame.action === "pack" && frame.carryingFish && phase < .7) {
    const held = { x: frame.x + side * size * .24, y: frame.y - size * .45 };
    const at = frame.action === "pack" ? between(held, { x: basket.x, y: basket.y - size * .14 }, Math.min(1, phase / .7)) : held;
    drawFish(ctx, at.x, at.y, size * .28, side * (still ? -.15 : -.15 + Math.sin(phase * tau * 2) * .14));
  }
  ctx.restore();
}
