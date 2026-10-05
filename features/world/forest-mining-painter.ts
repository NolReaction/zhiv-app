import type { ForestMiningFrame } from "./forest-mining";
import { drawGroundedHero } from "./grounding";
import { heroSourceAnchor } from "./hero-anchors";

/** A tapered, curved metal head and a wooden haft. The origin is the grip,
 * so walking changes the paw position without making the tool slide in it. */
function pickaxe(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle: number) {
  ctx.save(); ctx.translate(x,y); ctx.rotate(angle); ctx.scale(size/20,size/20);
  ctx.fillStyle = "#49382b"; ctx.fillRect(-1.5,-8,3,17);
  ctx.fillStyle = "#bf9255"; ctx.fillRect(-.5,-7,1,15);
  ctx.fillStyle = "#725036"; ctx.fillRect(-1.5,2,3,1); ctx.fillRect(-1.5,5,3,1);
  ctx.fillStyle = "#293d42"; ctx.beginPath();
  ctx.moveTo(-10,-4); ctx.lineTo(-7,-8); ctx.lineTo(-3,-10); ctx.lineTo(2,-10);
  ctx.lineTo(6,-8); ctx.lineTo(9,-4); ctx.lineTo(5,-6); ctx.lineTo(2,-7);
  ctx.lineTo(1,-5); ctx.lineTo(-2,-5); ctx.lineTo(-3,-7); ctx.lineTo(-6,-6); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#a5bdc0"; ctx.beginPath();
  ctx.moveTo(-9,-5); ctx.lineTo(-6,-8); ctx.lineTo(-2,-9); ctx.lineTo(2,-9);
  ctx.lineTo(6,-7); ctx.lineTo(8,-5); ctx.lineTo(4,-7); ctx.lineTo(1,-7);
  ctx.lineTo(-2,-7); ctx.lineTo(-5,-7); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#e4ebd8"; ctx.fillRect(-2,-9,4,1);
  ctx.fillStyle = "#697f83"; ctx.fillRect(-1,-8,2,3);
  ctx.restore();
}

export function drawForestMiningHero(ctx: CanvasRenderingContext2D, frame: ForestMiningFrame,
  appearance?: { palette: string; head: string | null; neck: string | null }, shadow?: boolean) {
  if (frame.opacity <= 0 || ![frame.x,frame.y,frame.size,frame.scale].every(Number.isFinite)) return;
  const actor = { ...frame, size: frame.size*frame.scale };
  ctx.save(); ctx.globalAlpha *= frame.opacity;
  drawGroundedHero(ctx, { ...actor, appearance: { palette: appearance?.palette ?? "moss", neck: appearance?.neck ?? null, head: "mining_helmet" }, shadow });
  // The shaft runs through the existing small paw; no new arm spans the torso.
  const left = frame.direction === "left", step = frame.pose === "walk" ? [0,-1,0,1][Math.abs(frame.frame)%4] : 0;
  const bob = frame.pose === "walk" && Math.abs(frame.frame)%2 === 1 ? -1 : 0;
  const hand = heroSourceAnchor(actor, { x: left ? 12 : 36, y: 32+bob+(left ? -step : step) }, frame);
  pickaxe(ctx, hand.x, hand.y, actor.size*.36, left ? -.5 : .5);
  ctx.restore();
}

export type ForestMiningWorkFrame = Pick<ForestMiningFrame, "working" | "workCue" | "size" | "elapsed">;

/** A persistent, contrasted work sign; only the two tools and one tiny impact
 * animate. Paint after weather so night never erases the station's status. */
export function drawForestMiningWork(ctx: CanvasRenderingContext2D, frame: ForestMiningWorkFrame, still: boolean) {
  if (!frame.working || ![frame.workCue.x,frame.workCue.y,frame.size,frame.elapsed].every(Number.isFinite) || frame.size <= 0) return;
  const size = Math.max(26,Math.min(32,frame.size*.6)), {x,y} = frame.workCue;
  const beat = still ? 0 : Math.sin(frame.elapsed*3.4);
  ctx.save();
  ctx.fillStyle = "#263d35"; ctx.beginPath(); ctx.ellipse(x,y,size*.59,size*.49,0,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle = "#d6c190"; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = "#263d35"; ctx.beginPath(); ctx.moveTo(x-3,y+size*.43); ctx.lineTo(x,y+size*.62); ctx.lineTo(x+3,y+size*.43); ctx.fill();
  for (let index=0; index<2; index++) {
    const side = index ? 1 : -1;
    pickaxe(ctx, x+side*size*.10, y+size*.1,size*.60,side*(.75+beat*.13));
  }
  if (!still && beat > .72) {
    ctx.fillStyle="#ffe4a1";
    ctx.fillRect(x-.6,y-size*.34,1.2,3); ctx.fillRect(x-2,y-size*.28,4,1);
  }
  ctx.restore();
}
