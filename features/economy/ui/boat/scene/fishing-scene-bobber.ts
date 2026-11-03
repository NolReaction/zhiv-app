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
