export const EAT_DURATION = 6.4;
export const PICKUP_PROGRESS = .22;
export const CONSUMED_PROGRESS = .82;
const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** Shared timing keeps the grounded mushroom, held food, pose and final bite in sync. */
export function feedingFrame(progress: number) {
  const phase: "reach" | "lift" | "chew" | "swallow" = progress < PICKUP_PROGRESS ? "reach" : progress < .42 ? "lift" : progress < CONSUMED_PROGRESS ? "chew" : "swallow";
  const bites = [.54, .66, .78].filter(at => progress >= at).length;
  return {
    phase, lifted: progress >= PICKUP_PROGRESS,
    lift: ease((progress - PICKUP_PROGRESS) / .20),
    remaining: progress >= CONSUMED_PROGRESS ? 0 : [1, .72, .45, .22][bites],
    bites,
  };
}
