import type { ForestMiningFrame } from "./forest-mining";
import { drawGroundedHero } from "@/features/world/scene/grounding";
import { drawMiningPickaxe } from "@/features/mochlik/mining-pickaxe";

export function drawForestMiningHero(ctx: CanvasRenderingContext2D, frame: ForestMiningFrame,
  appearance?: { palette: string; head: string | null; neck: string | null }, shadow?: boolean) {
  if (frame.opacity <= 0 || ![frame.x,frame.y,frame.size,frame.scale,frame.opacity].every(Number.isFinite) || frame.size <= 0 || frame.scale <= 0) return;
  const actor = { ...frame, size: frame.size*frame.scale };
  ctx.save(); ctx.globalAlpha *= frame.opacity;
  // Body, gripping paw and tool share one cached image: the rear-facing body
  // occludes the tool even during the translucent doorway crossing.
  drawGroundedHero(ctx, { ...actor, appearance: { palette: appearance?.palette ?? "moss", neck: appearance?.neck ?? null, head: "mining_helmet" }, shadow, rig: { mining: true } });
  ctx.restore();
}

export type ForestMiningWorkFrame = Pick<ForestMiningFrame, "working" | "workCue" | "size" | "elapsed">;

/** A persistent, contrasted work sign; only the two tools
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
    drawMiningPickaxe(ctx, x+side*size*.10, y+size*.1,size*.60,side*(.75+beat*.13));
  }
  ctx.restore();
}
