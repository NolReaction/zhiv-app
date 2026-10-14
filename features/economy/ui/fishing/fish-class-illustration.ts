import { economyCatalog, type EconomyView } from "@/features/economy/domain/model";
import { normalizedFishStock } from "@/features/economy/domain/fish-stock";
import { FISH_SPECIES_IDS, type FishSpeciesId } from "@/features/world/activities/fishing/fish-species";

type IllustrationState = Pick<EconomyView, "fishing"> & Partial<Pick<EconomyView, "catalog" | "inventory">>;

/** Current species stock illustrates a class. Older untracked stocks retain
 * collection artwork without claiming their unidentified composition. */
export function fishClassIllustration(state: IllustrationState | null | undefined, itemId: string): FishSpeciesId | undefined {
  const catalog = state?.catalog?.fishing ?? economyCatalog.fishing;
  const group = catalog?.classes.find(entry => entry.itemId === itemId);
  if (!catalog || !group || !state) return undefined;
  const counts = state.fishing?.stock == null ? state.fishing?.catches ?? {}
    : state.inventory ? normalizedFishStock({ ...state, inventory: state.inventory }) : {};
  let selected: FishSpeciesId | undefined, mostCaught = 0;
  for (const fish of catalog.fish) {
    const count = counts[fish.itemId] ?? 0;
    if (fish.rarity !== group.rarity || !Number.isSafeInteger(count) || count <= mostCaught
      || !(FISH_SPECIES_IDS as readonly string[]).includes(fish.itemId)) continue;
    selected = fish.itemId as FishSpeciesId;
    mostCaught = count;
  }
  return selected;
}
