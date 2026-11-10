import type { FishingSceneFrame } from "./fishing-scene-types";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Water motion is presentation only. The dedicated meter owns the exact control/target positions. */
export function fishingBobberMotion(frame: FishingSceneFrame, elapsed: number, still: boolean) {
  const active = frame.stage === "reeling" || frame.stage === "paused";
  const strain = active && frame.reel ? clamp((frame.reel.fish - frame.reel.bar) / 5000, -1, 1) : 0;
  const surge = active && frame.resistancePhase === "surging" ? 1 : 0;
  const tension = active ? .12 + Math.abs(strain) * .18 + surge * .2 : 0;
  if (still) return { x: 0, y: 0, dip: active && frame.held ? 1.5 : 0, tilt: strain * .06, tension };
  const time = Number.isFinite(elapsed) ? elapsed : 0;
  return { x: Math.sin(time * 1.7) * 1.8 + strain * Math.sin(time * 6.4) * 2.2 + surge * Math.sin(time * 8.2) * 2,
    y: Math.sin(time * 2.3 + .4) * 1.2 + Math.sin(time * .83) * .8,
    dip: active ? (frame.held ? 1.6 : .3) + surge * (1 + Math.sin(time * 7.2)) * 1.4 : 0,
    tilt: Math.sin(time * 1.9) * .07 + strain * .12 + surge * Math.sin(time * 8.2) * .09, tension };
}

/** Draw in CSS-sized units about the float. Only the part above the surface breaks the water. */
export function paintFishingBobber(ctx: CanvasRenderingContext2D, waterline: number | null, tilt: number,
  biting: boolean, age: number, still: boolean) {
  ctx.save();
  if (waterline !== null) {
    ctx.beginPath(); ctx.rect(-20, -32, 40, Math.max(0, 33 + waterline)); ctx.clip();
  }
  ctx.rotate(tilt);
  // The outlined, striped antenna remains visible against both sky reflections and dark water.
  ctx.fillStyle = "#283b39"; ctx.fillRect(-2.5, -21, 5, 16);
  ctx.fillStyle = "#fff2c8"; ctx.fillRect(-1.5, -20, 3, 12);
  ctx.fillStyle = "#de7147"; ctx.fillRect(-1.5, -15, 3, 4);
  ctx.beginPath(); ctx.ellipse(0, -2, 5.6, 7.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#d97450"; ctx.fill(); ctx.lineWidth = 1.3; ctx.strokeStyle = "#283b39"; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-4.2, -4); ctx.quadraticCurveTo(0, -2.7, 4.2, -4);
  ctx.strokeStyle = "#fff2c8"; ctx.lineWidth = 2.3; ctx.stroke();
  ctx.restore();
  if (waterline === null) return;
  ctx.strokeStyle = biting ? "#d1e4d6" : "rgba(202,228,213,.64)"; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.ellipse(0, waterline, biting ? 6 : 8, 2, -.08, 0, Math.PI); ctx.stroke();
  if (!biting) return;
  // Two pressure waves start at the instant of the dive; the static alternative shows one clear ring.
  const phases = still ? [.48] : [age / .75, (age - .15) / .85];
  for (const phase of phases) {
    if (phase < 0 || phase >= 1) continue;
    ctx.strokeStyle = `rgba(224,243,223,${(1 - phase) * .82})`;
    ctx.lineWidth = 1.7 - phase * .6;
    ctx.beginPath(); ctx.ellipse(0, waterline + .8, 7 + phase * 23, 2.5 + phase * 7, -.08, .14, Math.PI * 1.89); ctx.stroke();
  }
}
