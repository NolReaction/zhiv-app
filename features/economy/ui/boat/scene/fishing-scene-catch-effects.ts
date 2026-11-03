import { fishingSceneFishAppearance } from "./fishing-scene-fish";
import type { FishingSceneFrame, FishingScenePoint } from "./fishing-scene-types";

/** A short water/glow flourish is shown only for a server-confirmed catch. */
export function paintFishingCatchEffects(ctx: CanvasRenderingContext2D, fish: FishingScenePoint,
  frame: FishingSceneFrame, age: number, still: boolean) {
  if (still || frame.stage !== "landed" || !frame.fishId || age < 0 || age >= 1.35) return;
  const p = age / 1.35, alpha = Math.sin(Math.PI * p) * .58;
  const appearance = fishingSceneFishAppearance(frame);
  const radius = appearance.size * .82;
  const glow = ctx.createRadialGradient(fish.x, fish.y, 3, fish.x, fish.y, radius);
  glow.addColorStop(0, `${appearance.colors[0]}55`); glow.addColorStop(1, `${appearance.colors[0]}00`);
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = glow;
  ctx.beginPath(); ctx.ellipse(fish.x, fish.y, radius, radius * .7, -.15, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#d7ede1";
  for (let index = 0; index < 9; index++) {
    const direction = (index - 4) * .23, spread = (16 + index % 3 * 12) * p;
    const x = fish.x + Math.sin(direction) * spread * 2;
    const y = fish.y - 14 - Math.sin(p * Math.PI) * (30 + index % 4 * 8) + p * p * 37;
    ctx.beginPath(); ctx.ellipse(x, y, 1.8 - p * .7, 3 - p, direction, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
