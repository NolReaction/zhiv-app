import type { EconomyCatalog, EconomyView } from "./model";
import { ECONOMY_PEARL_SCALE } from "./money";
import { durationPearlPrice } from "./time-price";
import { storefrontCatalog } from "./storefront";

/** Preview terms only. A future purchase must receive a fresh server-authoritative quote. */
export const PEARL_SHOP_PACKAGES = storefrontCatalog.pearlPacks;

export const GOLD_SHOP_PACKAGES = [
  { id: "pouch", name: "Кошель золота", pearls: 40 },
  { id: "casket", name: "Шкатулка золота", pearls: 100 },
  { id: "chest", name: "Сундук золота", pearls: 200 },
] as const;

export const HOME_BONUS_PERCENT = [0, 50, 125, 200, 300] as const;
/** Coins per stored pearl unit; one visible pearl is two units. */
export const BASE_COINS_PER_PEARL = 10;
export const MAX_BUILDING_BONUS_PERCENT = 25;
// Storage and restored landmarks serve their own purposes and do not mint gold bonuses.
const GOLD_BONUS_BUILDINGS = new Set(["garden", "woodlot", "workshop", "quarry", "dryer", "kiln"]);
type Development = Pick<EconomyView, "buildings" | "catalog">;

function maxCatalogLevel(building: EconomyCatalog["buildings"][number]) {
  return building.levels.reduce((max, entry) => Math.max(max, entry.level), 0);
}

/** Only completed, known catalog levels count; an unclaimed construction is not a level. */
function completedLevel(building: EconomyCatalog["buildings"][number], raw: number | undefined) {
  if (!Number.isSafeInteger(raw) || raw! < 1) return 0;
  return building.levels.reduce((level, entry) => entry.level <= raw! ? Math.max(level, entry.level) : level, 0);
}

export function currencyShopDevelopment({ buildings, catalog }: Development) {
  const home = catalog.buildings.find(building => building.id === "home");
  const homeLevel = Math.min(HOME_BONUS_PERCENT.length, Math.max(1, home ? completedLevel(home, buildings.home) : 1));
  const structures = catalog.buildings.filter(building => GOLD_BONUS_BUILDINGS.has(building.id) && maxCatalogLevel(building) > 0);
  const completedLevels = structures.reduce((sum, building) => sum + completedLevel(building, buildings[building.id]), 0);
  const totalLevels = structures.reduce((sum, building) => sum + maxCatalogLevel(building), 0);
  const homeBonusPercent = HOME_BONUS_PERCENT[homeLevel - 1];
  const buildingBonusPercent = totalLevels > 0 ? Math.min(MAX_BUILDING_BONUS_PERCENT,
    Math.floor(MAX_BUILDING_BONUS_PERCENT * completedLevels / totalLevels)) : 0;
  return { homeLevel, completedLevels, totalLevels, homeBonusPercent, buildingBonusPercent,
    bonusPercent: homeBonusPercent + buildingBonusPercent };
}

export function currencyShopGoldOffers(state: Development) {
  const development = currencyShopDevelopment(state);
  return GOLD_SHOP_PACKAGES.map(pack => {
    const baseCoins = pack.pearls * BASE_COINS_PER_PEARL;
    const bonusCoins = Math.floor(baseCoins * development.bonusPercent / 100);
    return { ...pack, baseCoins, bonusCoins, coins: baseCoins + bonusCoins };
  });
}


/** Current spending examples, not grants or a quote for a future cash purchase. */
export function currencyShopPearlBenchmarks(catalog: EconomyCatalog) {
  const examples: { id: string; label: string; itemId: string; pearls: number }[] = [];
  const relic = catalog.leaftailShop?.pearlOffers?.[0];
  if (relic) examples.push({ id: "relic", label: "Одна реликвия", itemId: relic.itemId, pearls: relic.pricePearls });
  const slot = catalog.productionSlots?.upgrades.find(entry => entry.slots === 2);
  if (slot) examples.push({ id: "slot", label: "Второе место производства", itemId: "pearls", pearls: slot.pricePearls });
  const speed = catalog.constructionSpeedup;
  examples.push({ id: "construction", label: "Завершить остаток в 1 час", itemId: "pearls",
    pearls: durationPearlPrice(3_600_000, speed.secondsPerPearl, ECONOMY_PEARL_SCALE, speed.priceStepPearls, speed.pricingPoints) });
  return examples;
}
