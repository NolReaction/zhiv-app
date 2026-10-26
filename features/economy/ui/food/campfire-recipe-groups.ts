import type { WorldRecipeGroup } from "@/features/economy/ui/stations/world-recipe-groups";

export const campfireDurationFilters = [
  { id: "all", label: "Все" },
  { id: "short", label: "До 15 мин" },
  { id: "medium", label: "15 мин - 1 ч" },
  { id: "long", label: "Дольше 1 ч" },
] as const;
export type CampfireDurationFilter = typeof campfireDurationFilters[number]["id"];
export type CampfireRecipeSection = { id: string; label: string; recipes: WorldRecipeGroup[] };

const sections = [
  { id: "fish", label: "Рыбные блюда", items: ["grilled_fish", "fish_soup", "berry_fish", "hearty_fish", "epic_fish", "legendary_fish", "grilled_silverfin", "smoked_bream", "mooncarp_blueberries", "pike_berry_sauce", "eel_in_jar", "festive_sturgeon"] },
  { id: "drinks", label: "Напитки", items: ["berry_compote", "strawberry_compote", "blueberry_compote", "bottled_compote"] },
  { id: "desserts", label: "Ягодные десерты", items: ["currant_jelly", "blackberry_preserve", "cranberry_glaze", "berry_gift"] },
  { id: "provisions", label: "Походные припасы", items: ["dried_berries", "smoked_fish", "trail_ration", "packed_berries"] },
] as const;

export function campfireDurationMatches(seconds: number, filter: CampfireDurationFilter) {
  return filter === "all" || (filter === "short" && seconds <= 900)
    || (filter === "medium" && seconds > 900 && seconds <= 3600)
    || (filter === "long" && seconds > 3600);
}

/** Organize the selected product methods without changing recipes or duplicating mixed outputs. */
export function campfireRecipeGroups(products: readonly WorldRecipeGroup[], filter: CampfireDurationFilter): CampfireRecipeSection[] {
  const grouped = new Map<string, CampfireRecipeSection>();
  for (const product of products) {
    if (!campfireDurationMatches(product.recipe.seconds, filter)) continue;
    const outputs = Object.keys(product.recipe.rewards).filter(id => product.recipe.rewards[id] > 0);
    const section = outputs.length === 1 ? sections.find(entry => entry.items.some(id => id === outputs[0])) : undefined;
    const id = section?.id ?? "other";
    const group = grouped.get(id) ?? { id, label: section?.label ?? "Другие заготовки", recipes: [] };
    group.recipes.push(product);
    grouped.set(id, group);
  }
  const order: readonly string[] = [...sections.map(section => section.id), "other"];
  return [...grouped.values()].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
    .map(section => ({ ...section, recipes: section.recipes.sort((left, right) => left.recipe.seconds - right.recipe.seconds) }));
}
