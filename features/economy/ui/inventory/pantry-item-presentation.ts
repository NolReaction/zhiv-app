import type { EconomyView } from "@/features/economy/domain/model";
import { fishClassForItem } from "@/features/economy/domain/fishing";

type Catalog = EconomyView["catalog"];
type Item = Pick<Catalog["items"][number], "id" | "category">;
export const pantryRarities = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type PantryRarity = typeof pantryRarities[number];
export const pantryRarityNames: Record<PantryRarity, string> = {
  common: "Обычная", uncommon: "Необычная", rare: "Редкая", epic: "Эпическая", legendary: "Легендарная",
};

/** Presentation metadata only. These tiers never set prices, drops or unlocks. */
export const pantryItemRarities: Readonly<Record<string, PantryRarity>> = {
  berries: "common", strawberries: "common", wood: "common", stone: "common", planks: "common", berry_compote: "common", strawberry_compote: "common",
  fiber: "uncommon", clay: "uncommon", rope: "uncommon", charcoal: "uncommon", bricks: "uncommon", blueberries: "uncommon", blueberry_compote: "uncommon",
  ore: "rare", sand: "rare", hardwood: "rare", metal_parts: "rare", iron_ingot: "rare", glass: "rare", cloth: "rare", beams: "rare", cut_stone: "rare",
  dried_berries: "rare", currants: "rare", currant_jelly: "rare",
  resin: "epic", tools: "epic", reinforced_parts: "epic", research_gear: "epic", trail_ration: "epic", blackberries: "epic", blackberry_preserve: "epic",
  cranberries: "legendary", cranberry_glaze: "legendary",
};

/** Alternatives use the lowest required raw fish class, independent of the chosen species. */
export function pantryRecipeFishRarity(itemId: string, catalog: Catalog): PantryRarity | null {
  const classes = catalog.recipes.filter(recipe => (recipe.rewards[itemId] ?? 0) > 0)
    .flatMap(recipe => Object.keys(recipe.cost.items).flatMap(id => {
      const fish = fishClassForItem(id, catalog.fishing);
      return fish ? [fish.rarity] : [];
    }));
  return pantryRarities.find(rarity => classes.includes(rarity)) ?? null;
}

export function pantryItemRarity(item: Item, catalog: Catalog): PantryRarity {
  const fish = fishClassForItem(item.id, catalog.fishing);
  if (fish) return fish.rarity;
  const bait = catalog.fishing?.baits.find(entry => entry.itemId === item.id);
  if (bait) return bait.rarity;
  if (item.category === "special") return "epic";
  return (item.category === "provisions" ? pantryRecipeFishRarity(item.id, catalog) : null)
    ?? (Object.hasOwn(pantryItemRarities, item.id) ? pantryItemRarities[item.id] : "common");
}

export const pantryGroupDefinitions = [
  { id: "materials", name: "Материалы" }, { id: "crafted", name: "Изделия" }, { id: "berries", name: "Ягоды" },
  { id: "bait", name: "Наживка" }, { id: "fish-dishes", name: "Рыбные блюда" }, { id: "drinks", name: "Напитки" },
  { id: "desserts", name: "Ягодные десерты" }, { id: "travel", name: "Для вылазок" }, { id: "harvest", name: "Урожай" },
  { id: "fish", name: "Рыба" }, { id: "relics", name: "Реликвии" }, { id: "other", name: "Другое" },
] as const;
export type PantryGroupId = typeof pantryGroupDefinitions[number]["id"];
const berries = new Set(["berries", "strawberries", "blueberries", "currants", "blackberries", "cranberries"]);
const desserts = new Set(["currant_jelly", "blackberry_preserve", "cranberry_glaze"]);
const travel = new Set(["dried_berries", "smoked_fish", "trail_ration"]);

export function pantryItemGroup(item: Item, catalog: Catalog): PantryGroupId {
  if (fishClassForItem(item.id, catalog.fishing)) return "fish";
  if (item.category === "special") return "relics";
  if (item.category === "material") return "materials";
  if (item.category === "crafted") return "crafted";
  if (item.category === "produce") return berries.has(item.id) ? "berries" : "harvest";
  if (item.category === "fishing") return "bait";
  if (item.category === "provisions" || catalog.food?.meals.some(meal => meal.itemId === item.id)) {
    if (travel.has(item.id)) return "travel";
    if (item.id.endsWith("_compote")) return "drinks";
    if (desserts.has(item.id)) return "desserts";
    if (pantryRecipeFishRarity(item.id, catalog)) return "fish-dishes";
    return "other";
  }
  return "other";
}

/** Fixed group and catalog order keep cards steady as stock quantities change. */
export function groupPantryItems<T extends Item>(items: readonly T[], catalog: Catalog): { id: PantryGroupId; name: string; items: T[] }[] {
  const order = new Map(catalog.items.map((item, index) => [item.id, index]));
  return pantryGroupDefinitions.flatMap(group => {
    const matching = items.filter(item => pantryItemGroup(item, catalog) === group.id).sort((a, b) =>
      (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.id.localeCompare(b.id));
    return matching.length ? [{ ...group, items: matching }] : [];
  });
}
