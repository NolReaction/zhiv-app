import { economyCatalog, type EconomyView } from "@/features/economy/domain/model";
import { FISH_SPECIES_IDS, type FishSpeciesId } from "@/features/world/activities/fishing/fish-species";

type IllustrationState = Pick<EconomyView, "fishing"> & Partial<Pick<EconomyView, "catalog">>;

/** A personally discovered species illustrates a class, never its stock composition. */
export function fishClassIllustration(state: IllustrationState | null | undefined, itemId: string): FishSpeciesId | undefined {
  const catalog = state?.catalog?.fishing ?? economyCatalog.fishing;
  const group = catalog?.classes.find(entry => entry.itemId === itemId);
  if (!group || !state) return undefined;
  let selected: FishSpeciesId | undefined, mostCaught = 0;
  for (const fish of catalog!.fish) {
    const count = state.fishing?.catches[fish.itemId] ?? 0;
    if (fish.rarity !== group.rarity || !Number.isSafeInteger(count) || count <= mostCaught
      || !(FISH_SPECIES_IDS as readonly string[]).includes(fish.itemId)) continue;
    selected = fish.itemId as FishSpeciesId;
    mostCaught = count;
  }
  return selected;
}
