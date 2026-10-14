import type { EconomyView } from "@/features/economy/domain/model";
import { worldMissingRequirements, worldRecipeUnlockReason, worldRequirements, worldDuration, type WorldRecipe } from "@/features/economy/ui/shared/world-stations";

export type WorldRecipeGroup = { key: string; recipe: WorldRecipe; methods: WorldRecipe[] };

/** One product entry, with its existing production methods retained in preparation. */
export function worldRecipeGroups(state: EconomyView, recipes: readonly WorldRecipe[], { includeFuture = false }: { includeFuture?: boolean } = {}): WorldRecipeGroup[] {
  const groups = new Map<string, WorldRecipeGroup>();
  for (const recipe of recipes) {
    if (!includeFuture && worldMissingRequirements(state, worldRequirements(recipe, recipe)).length) continue;
    const key = JSON.stringify([recipe.buildingId, Object.keys(recipe.rewards).sort()]);
    const group = groups.get(key);
    if (group) group.methods.push(recipe);
    else groups.set(key, { key, recipe, methods: [recipe] });
  }
  for (const group of groups.values()) {
    const availability = (recipe: WorldRecipe) => worldMissingRequirements(state, worldRequirements(recipe, recipe)).length ? 2 : Number(Boolean(worldRecipeUnlockReason(state, recipe)));
    group.methods.sort((left, right) => availability(left) - availability(right)
      || left.seconds - right.seconds);
    group.recipe = group.methods[0];
  }
  return [...groups.values()];
}

export function worldRecipeDuration(seconds: number) {
  if (seconds > 0 && seconds < 3600) {
    const minutes = Math.floor(seconds / 60), rest = seconds % 60;
    return minutes ? `${minutes} мин${rest ? ` ${rest} с` : ""}` : `${rest} с`;
  }
  return worldDuration(seconds);
}
