import type { ForestMiningFrame } from "./forest-mining";
import { drawGroundedHero } from "./grounding";
import { heroSourceAnchor } from "./hero-anchors";

/** Native pixel tool, shared by the carried pick and the quiet work cue. */
function pickaxe(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angle: number) {
  ctx.save(); ctx.translate(x,y); ctx.rotate(angle); ctx.scale(size/12,size/12);
  ctx.fillStyle = "#493f32"; ctx.fillRect(-1,-1,3,12);
  ctx.fillStyle = "#ad8150"; ctx.fillRect(0,0,1,10);
  ctx.fillStyle = "#3d5052"; ctx.fillRect(-6,-3,12,3); ctx.fillRect(-6,0,2,2); ctx.fillRect(4,-1,2,2);
  ctx.fillStyle = "#a9bbc0"; ctx.fillRect(-4,-3,8,1); ctx.fillRect(-5,-2,3,1); ctx.fillRect(3,-2,2,1);
  ctx.fillStyle = "#e1e0bc"; ctx.fillRect(-2,-3,3,1);
  ctx.restore();
}

export function drawForestMiningHero(ctx: CanvasRenderingContext2D, frame: ForestMiningFrame,
  appearance?: { palette: string; head: string | null; neck: string | null }, shadow?: boolean) {
  if (frame.opacity <= 0 || ![frame.x,frame.y,frame.size,frame.scale].every(Number.isFinite)) return;
  const actor = { ...frame, size: frame.size*frame.scale };
  ctx.save(); ctx.globalAlpha *= frame.opacity;
  drawGroundedHero(ctx, { ...actor, appearance: { palette: appearance?.palette ?? "moss", neck: appearance?.neck ?? null, head: "mining_helmet" }, shadow });
  // The shaft runs through the existing small paw; no new arm spans the torso.
  const hand = heroSourceAnchor(actor, { x: frame.direction === "left" ? 14 : 34, y: 32 }, frame);
  pickaxe(ctx, hand.x, hand.y-actor.size*.13, actor.size*.30, frame.direction === "left" ? -.18 : .18);
  ctx.restore();
}

/** Two bounded, font-independent marks above the mine; no particle queue or rewards. */
export function drawForestMiningWork(ctx: CanvasRenderingContext2D, frame: ForestMiningFrame, still: boolean) {
  if (!frame.working) return;
  ctx.save(); const alpha = ctx.globalAlpha;
  for (let index=0; index<2; index++) {
    const phase = still ? .3+index*.35 : (frame.elapsed*.3+index*.5)%1;
    ctx.globalAlpha = alpha*(still ? .7 : Math.sin(phase*Math.PI)*.85);
    pickaxe(ctx, frame.workCue.x+(index-.5)*frame.size*.23, frame.workCue.y-frame.size*phase*.28,
      frame.size*.18, -.35+index*.5);
  }
  ctx.restore();
}
