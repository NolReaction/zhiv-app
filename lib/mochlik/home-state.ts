import { GAME_ITEMS, type GameItemId } from "../game-rewards";
import type { WorldState } from "@/features/world/model";

export function homeAppearance(state?: WorldState, gifts: readonly string[] = [], items: readonly GameItemId[] = []) {
  return {
    houseLevel: state?.houseLevel ?? 1,
    workshop: state?.workshop ?? false,
    equipment: state?.equipment ?? { palette: "moss", head: null, neck: null },
    away: Boolean(state?.journeys.length),
    items: GAME_ITEMS.filter(item => gifts.includes(item.id) || items.includes(item.id)).map(item => item.id),
  };
}
export function journeyLabel(state: WorldState | undefined, now: number) {
  if (!state?.journeys.length) return null;
  const remaining = Math.min(...state.journeys.map(journey => Date.parse(journey.finishesAt))) - now;
  return remaining <= 0 ? "Вернулся с находками" : `В пути · ещё ${remaining < 60000 ? `${Math.ceil(remaining / 1000)} с` : `${Math.ceil(remaining / 60000)} мин`}`;
}
