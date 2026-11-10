import assert from "node:assert/strict";

/** In v15 a building price buys a permanent upgrade. Its construction timer is
 * still short, but is no longer the entire price of that permanent capability.
 * The shared catalogue owns prices; this audit does not overwrite them.
 * Warehouse tiers 11+ are an explicit relic-only path, without coin payment. */
export function auditConstructionEconomy(catalog) {
  const buildings = catalog.buildings.map(building => {
    let previousCoins = 0;
    for (const level of building.levels) {
      const coins = level.cost.coins, key = `${building.id}:${level.level}`;
      assert(Number.isSafeInteger(coins) && coins >= 0, `${key}: invalid construction price`);
      if (building.id === "warehouse" && level.level >= 11) {
        const entries = Object.entries(level.cost.items);
        assert(coins === 0 && entries.length > 0 && entries.every(([id, amount]) => catalog.rareDrops?.itemIds.includes(id)
          && Number.isSafeInteger(amount) && amount > 0), `${key}: relic storage must use only relics without coins`);
        continue;
      }
      assert(coins >= previousCoins, `${key}: later construction must not cost less`);
      if (level.seconds > 0) assert(coins >= Math.ceil(level.seconds * catalog.timeEconomy.constructionCoinsPerMinute / 60),
        `${key}: permanent construction price must cover its builder time`);
      previousCoins = coins;
    }
    return { buildingId: building.id, coins: building.levels.reduce((sum, level) => sum + level.cost.coins, 0) };
  });
  return { buildings, coins: buildings.reduce((sum, building) => sum + building.coins, 0) };
}
