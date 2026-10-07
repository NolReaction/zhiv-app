import type { EconomyCatalog } from "./model";

const rarityLabels = { common: "обычная", uncommon: "необычная", rare: "редкая", epic: "эпическая", legendary: "легендарная" } as const;

/** Say “any” only when every catalogue species in the advertised tiers qualifies. */
export function recipeFishGroupLabel(recipe: EconomyCatalog["recipes"][number], catalog: EconomyCatalog): string {
  const choices = new Set(recipe.fishInput?.itemIds ?? []);
  const fish = catalog.fishing?.fish ?? [];
  const rarities = (Object.keys(rarityLabels) as (keyof typeof rarityLabels)[])
    .filter(rarity => fish.some(entry => entry.rarity === rarity && choices.has(entry.itemId)));
  if (!rarities.length || fish.some(entry => rarities.includes(entry.rarity) && !choices.has(entry.itemId))) return "Рыба на выбор";
  return `Любая ${rarities.map(rarity => rarityLabels[rarity]).join(" или ")} рыба`;
}
