import type { EconomyCatalog, EconomyView } from "./model";

/** Preview terms only. A future purchase must receive a fresh server-authoritative quote. */
export const PEARL_SHOP_PACKAGES = [
  { id: "handful", name: "Горсть жемчуга", pearls: 500 },
  { id: "pouch", name: "Мешочек жемчуга", pearls: 1500 },
  { id: "casket", name: "Шкатулка жемчуга", pearls: 4000 },
  { id: "chest", name: "Сундук жемчуга", pearls: 10000 },
] as const;

export const GOLD_SHOP_PACKAGES = [
  { id: "pouch", name: "Кошель золота", pearls: 100 },
  { id: "casket", name: "Шкатулка золота", pearls: 300 },
  { id: "chest", name: "Сундук золота", pearls: 750 },
] as const;

const HOME_BONUS_PERCENT = [0, 50, 150, 300, 600] as const;
const BASE_COINS_PER_PEARL = 100;
const MAX_BUILDING_BONUS_PERCENT = 100;
// Storage expansions beyond the original five tiers add capacity, not gold yield.
// Keep both sides of the development fraction stable for existing settlements.
const WAREHOUSE_QUOTE_LEVEL_CAP = 5;
type Development = Pick<EconomyView, "buildings" | "catalog">;

function maxCatalogLevel(building: EconomyCatalog["buildings"][number]) {
  return building.levels.reduce((max, entry) => building.id === "warehouse" && entry.level > WAREHOUSE_QUOTE_LEVEL_CAP
    ? max : Math.max(max, entry.level), 0);
}

/** Only completed, known catalog levels count; an unclaimed construction is not a level. */
function completedLevel(building: EconomyCatalog["buildings"][number], raw: number | undefined) {
  if (!Number.isSafeInteger(raw) || raw! < 1) return 0;
  const completed = building.id === "warehouse" ? Math.min(raw!, WAREHOUSE_QUOTE_LEVEL_CAP) : raw!;
  return building.levels.reduce((level, entry) => entry.level <= completed ? Math.max(level, entry.level) : level, 0);
}

export function currencyShopDevelopment({ buildings, catalog }: Development) {
  const home = catalog.buildings.find(building => building.id === "home");
  const homeLevel = Math.min(HOME_BONUS_PERCENT.length, Math.max(1, home ? completedLevel(home, buildings.home) : 1));
  const structures = catalog.buildings.filter(building => building.id !== "home" && maxCatalogLevel(building) > 0);
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
