import type { EconomyView } from "@/features/economy/domain/model";
import { fishClassForItem } from "@/features/economy/domain/fishing";
import { campfireRecipeGroups } from "./campfire-recipe-groups";
import { worldRecipeGroups, type WorldRecipeGroup } from "@/features/economy/ui/stations/world-recipe-groups";
import type { WorldRecipe } from "@/features/economy/ui/shared/world-stations";

export const cookbookCategories = [
  { id: "fish", label: "Рыбные блюда" }, { id: "drinks", label: "Напитки" },
  { id: "desserts", label: "Десерты" }, { id: "provisions", label: "Припасы" },
] as const;
export type CookbookCategory = typeof cookbookCategories[number]["id"];
export const cookbookRarities = [
  { id: "common", label: "Обычная рыба" }, { id: "uncommon", label: "Необычная рыба" },
  { id: "rare", label: "Редкая рыба" }, { id: "epic", label: "Эпическая рыба" },
  { id: "legendary", label: "Легендарная рыба" },
] as const;

/** Group by ingredient rarity only. Named species and the actual debit contract stay intact. */
export function cookbookFishRarity(state: EconomyView, recipe: WorldRecipe): string | null {
  const rarities = Object.entries(recipe.cost.items).filter(([, amount]) => amount > 0)
    .map(([id]) => fishClassForItem(id, state.catalog.fishing)?.rarity).filter(Boolean);
  return [...cookbookRarities].reverse().find(entry => rarities.includes(entry.id))?.id ?? null;
}

export function cookbookProducts(state: EconomyView, recipes: readonly WorldRecipe[]): (WorldRecipeGroup & { category: CookbookCategory })[] {
  const products = worldRecipeGroups(state, recipes, { includeFuture: true });
  return campfireRecipeGroups(products, "all").flatMap(section => section.recipes.map(product => ({
    ...product, category: cookbookCategories.some(entry => entry.id === section.id) ? section.id as CookbookCategory : "provisions" as const,
  })));
}
