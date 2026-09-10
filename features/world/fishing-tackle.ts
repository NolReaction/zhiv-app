import type { fishingFrame } from "./fishing-journey";
type Frame = ReturnType<typeof fishingFrame>;
type Point = { x: number; y: number };
const between = (a: Point, b: Point, part: number): Point => ({ x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part });

/** Grip follows the leading paw. Even while carrying, the shaft stays beside
 * the face; only the flexible upper third bends under line tension. */
export function fishingTackle(state: Frame) {
  const fishing = state.phase === "fishing", side = state.direction === "left" ? -1 : 1;
  const step = state.walking && state.frame % 2 ? -1 : 0;
  const grip = { x: state.x + side * 12, y: state.y - 17 + step };
  const lift = Math.sin(state.catchProgress * Math.PI);
  const cast = state.casting ? state.fishingElapsed / 1800 : 1;
  const reach = fishing ? 15 + 21 * cast - lift * 5 : 15;
  const tip = { x: grip.x + side * reach, y: grip.y - (fishing ? 42 - 17 * cast + lift * 12 : 42) };
  const lower = between(grip, tip, .4), upper = between(grip, tip, .7);
  const bend = between(upper, tip, .55);
  bend.x += side * lift * 2; bend.y += lift * 3;
  const length = Math.hypot(tip.x - grip.x, tip.y - grip.y);
  const along = { x: (tip.x - grip.x) / length, y: (tip.y - grip.y) / length };
  const normal = { x: -along.y, y: along.x };
  return { grip, lower, upper, bend, tip, along, normal, side };
}

export function drawFishingRod(ctx: CanvasRenderingContext2D, rod: ReturnType<typeof fishingTackle>) {
  const { grip, lower, upper, tip, bend, along, normal, side } = rod;
  ctx.save(); ctx.lineCap = "round";
  const stroke = (from: Point, to: Point, width: number, color: string) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  };
  stroke(grip, lower, 2.2, "#8b663b"); stroke(grip, lower, .7, "#d0af70");
  stroke(lower, upper, 1.6, "#a68b55");
  ctx.strokeStyle = "#bda777"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(upper.x, upper.y); ctx.quadraticCurveTo(bend.x, bend.y, tip.x, tip.y); ctx.stroke();
  const butt = { x: grip.x - along.x * 4, y: grip.y - along.y * 4 };
  const handleEnd = { x: grip.x + along.x * 4, y: grip.y + along.y * 4 };
  stroke(butt, handleEnd, 3.5, "#58462c");
  for (const offset of [-3, 0, 3]) {
    const at = { x: grip.x + along.x * offset, y: grip.y + along.y * offset };
    stroke({ x: at.x - normal.x, y: at.y - normal.y }, { x: at.x + normal.x, y: at.y + normal.y }, .8, "#ad9160");
  }
  const reel = { x: grip.x - side * 3, y: grip.y + 3 };
  ctx.fillStyle = "#424b3b"; ctx.beginPath(); ctx.arc(reel.x, reel.y, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#a2a58b"; ctx.lineWidth = .8; ctx.stroke();
  ctx.fillStyle = "#bba77b"; ctx.fillRect(Math.round(reel.x), Math.round(reel.y), 1, 1);
  stroke(reel, { x: reel.x - side * 3, y: reel.y + 1 }, .8, "#a2a58b");
  for (const guide of [lower, upper, tip]) {
    ctx.strokeStyle = "#657562"; ctx.lineWidth = .7;
    ctx.beginPath(); ctx.arc(guide.x + normal.x, guide.y + normal.y, .9, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}
