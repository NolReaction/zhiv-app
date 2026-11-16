import type { FishingSceneFrame } from "./scene/fishing-scene-types";
import type { boatReelFeedback } from "./boat-reel-feedback";

/** A phase explains actual fish motion; an immediate directional correction always wins. */
export function boatResistanceFeedback(phase: FishingSceneFrame["resistancePhase"], feedback: ReturnType<typeof boatReelFeedback>) {
  const label = phase === "preparing" ? "Готовится к рывку" : phase === "surging" ? "Рывок" : phase === "recovering" ? "Передышка" : null;
  if (!feedback.inZone || !label) return { ...feedback, phaseLabel: label };
  return { ...feedback, phaseLabel: label,
    title: phase === "preparing" ? "Сейчас будет рывок" : phase === "surging" ? "Удержите рывок" : "Рыба сбавила ход",
    instruction: phase === "preparing" ? "Следите за рыбой — скоро сменит темп" : phase === "surging"
      ? "Следуйте за рыбой короткими удержаниями" : "Спокойно верните рыбу в центр зоны" };
}
