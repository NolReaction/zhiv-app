import type { FishingSceneFrame } from "./fishing-scene-types";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const smooth = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

/** Only public timing drives the visual nibble. Nothing here starts play or resolves a catch. */
export function fishingBiteMotion(stage: FishingSceneFrame["stage"], age: number, leadSeconds: number | undefined, still: boolean) {
  if (still) return { dip: stage === "bite" ? 15 : 0, tilt: 0, notice: 0, ripple: stage === "bite" ? 1.25 : .7 };
  if (stage === "soaking" && Number.isFinite(leadSeconds) && leadSeconds! > 0 && leadSeconds! < .85) {
    const p = 1 - leadSeconds! / .85;
    const nibble = Math.sin(p * Math.PI) ** 2;
    return { dip: nibble * 2.4, tilt: nibble * Math.sin(p * Math.PI * 2) * .14,
      notice: nibble * .22, ripple: .7 + nibble * .3 };
  }
  if (stage === "soaking" && leadSeconds !== undefined && leadSeconds > 1.75 && leadSeconds < 2.08) {
    const tap = Math.sin(Math.PI * (leadSeconds - 1.75) / .33) ** 2;
    return { dip: tap * 1.3, tilt: -tap * .12, notice: tap * .08, ripple: .7 + tap * .15 };
  }
  if (stage !== "bite") return { dip: 0, tilt: 0, notice: 0, ripple: .7 };
  const t = Math.max(0, age), first = t < .72 ? Math.sin(Math.PI * t / .72) : 0;
  const settle = smooth(t / .16), recover = smooth((t - .3) / .6);
  // Short tugs keep the float readable until the player sets the hook.
  const cycle = Math.max(0, t - 1.6) % .85;
  const reminder = t > 1.6 && cycle < .42 ? Math.sin(cycle / .42 * Math.PI) ** 2 : 0;
  return { dip: settle * (17 - recover * 4) + reminder * 3, tilt: -first * .24 + reminder * .18,
    notice: first, ripple: .85 + first * .65 + reminder * .4 };
}
