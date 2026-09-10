import type { WorldState } from "./model";

export type Journey = WorldState["journeys"][number];
export type JourneyPhase = "outbound" | "fishing" | "returning" | "home";
export const FISHING_LEG_MS = 45_000;
export const FISHING_PREPARE_MS = 15_000;
export const isFishingJourney = (journey: Pick<Journey, "routeId">) => /^fishing_(5|15|30|60)$/.test(journey.routeId);

/** Only saved server timestamps determine location. Animation clocks never
 * decide whether a reward is ready, including after reload or backgrounding. */
export function journeyTimeline(journey: Journey, now: number) {
  const start = Date.parse(journey.startedAt), end = Date.parse(journey.finishesAt);
  const duration = Math.max(1, end - start);
  const elapsed = Math.max(0, Math.min(duration, now - start));
  const progress = elapsed / duration;
  const fishing = isFishingJourney(journey);
  const leg = fishing ? Math.min(FISHING_LEG_MS, duration / 4) : duration / 2;
  const phase: JourneyPhase = elapsed >= duration ? "home" : elapsed < leg ? "outbound"
    : elapsed >= duration - leg ? "returning" : "fishing";
  const preparation = fishing ? Math.min(FISHING_PREPARE_MS, leg / 3) : 0;
  const position = phase === "home" ? 0 : phase === "outbound" ? Math.max(0, elapsed - preparation) / (leg - preparation)
    : phase === "returning" ? (duration - elapsed) / leg : 1;
  return { phase, progress, position, remaining: Math.max(0, end - now), elapsed,
    preparation, fishingElapsed: Math.max(0, elapsed - leg), fishingDuration: Math.max(0, duration - leg * 2), leg };
}

/** Merges may retain several rewards. Animate an unfinished trip first. */
export function sceneJourney(state: WorldState | undefined, now: number) {
  return state?.journeys.find(journey => now < Date.parse(journey.finishesAt)) ?? state?.journeys[0];
}

export function journeyPhaseLabel(journey: Journey, now: number) {
  const phase = journeyTimeline(journey, now).phase;
  if (phase === "home") return "Дома · ждёт подтверждения";
  if (phase === "returning") return "Возвращается домой";
  if (phase === "fishing") return "Рыбачит у берега";
  return isFishingJourney(journey) ? journeyTimeline(journey, now).elapsed < FISHING_PREPARE_MS ? "Собирается на рыбалку" : "Идёт на рыбалку" : journey.routeId === "brook_path" ? "Идёт к воде" : "Гуляет по лесной тропе";
}
