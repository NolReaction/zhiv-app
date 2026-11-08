import releaseFeatures from "@/apps/api/src/main/resources/world/release-features.json";
import type { EconomyView } from "@/features/economy/domain/model";

export function boatAccess(state?: EconomyView | null): "play" | "recover" | null {
  if (!state?.catalog.boat) return null;
  if (releaseFeatures.boatFishingEnabled) return "play";
  return state.boat?.voyage || state.boat?.work ? "recover" : null;
}
