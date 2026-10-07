import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { economicMath } from "./lib/economy-math.mjs";

const rarities = ["common", "uncommon", "rare", "epic", "legendary"];
const rounded = value => Number(value.toFixed(9));

/** Enumerates every legal catalog combination; no random sample or fabricated catch. */
export function auditFishingBalance(catalog) {
  const fishing = catalog.fishing, math = economicMath(catalog);
  const loadouts = fishing.rods.flatMap(rod => fishing.hooks.flatMap(hook => [null, ...fishing.baits.map(bait => bait.itemId)].map(baitId => {
    const portfolio = math.catchPortfolio(rod.id, baitId, "shore", hook.id);
    const shares = Object.fromEntries(rarities.map(rarity => [rarity,
      fishing.fish.filter(fish => fish.rarity === rarity).reduce((sum, fish) => sum + portfolio.probabilities[fish.itemId], 0)]));
    assert(Math.abs(Object.values(shares).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    if (rod.rarity !== "legendary" || hook.rarity !== "legendary") assert.equal(shares.legendary, 0);
    return { rodId: rod.id, hookId: hook.id, baitId, shares };
  })));
  const targets = rarities.map(rarity => {
    const best = loadouts.reduce((a, b) => a.shares[rarity] >= b.shares[rarity] ? a : b), p = best.shares[rarity];
    return { rarity, rodId: best.rodId, hookId: best.hookId, baitId: best.baitId,
      probabilityPerSpecialAttempt: rounded(p), probabilityAtLeastOneInSix: rounded(1 - (1 - p) ** 6),
      expectedAttemptsPerCatch: rounded(1 / p), expectedCatchesInSix: rounded(6 * p) };
  });
  const saleEconomics = [loadouts.find(row => row.rodId === "reed_rod" && row.hookId === "bare_hook" && row.baitId === null),
    ...targets.map(target => loadouts.find(row => row.rodId === target.rodId && row.hookId === target.hookId && row.baitId === target.baitId))]
    .map(loadout => ({ rodId: loadout.rodId, hookId: loadout.hookId, baitId: loadout.baitId,
      routes: fishing.routeIds.map(routeId => {
        const value = math.catchPortfolio(loadout.rodId, loadout.baitId, routeId, loadout.hookId);
        const plain = math.catchPortfolio(loadout.rodId, null, routeId, loadout.hookId);
        const route = catalog.explorations.find(route => route.id === routeId);
        const net = value.expectedFishRevenue - value.routeCoins - value.baitPurchaseCoins - math.liquidation(value.routeInputs);
        return { routeId, specialAttempts: value.speciesDrawsPerJob, fishCount: route.rewards.fish,
          expectedSaleCoins: rounded(value.expectedFishRevenue), baitCoins: value.baitPurchaseCoins,
          netSaleCoins: rounded(net), netSaleCoinsPerHour: rounded(net * 3600 / route.seconds),
          incrementalSaleProfitFromBait: rounded(value.expectedFishRevenue - plain.expectedFishRevenue - value.baitPurchaseCoins) };
      }) }));
  const baitMargins = fishing.baits.map(bait => {
    const rows = loadouts.filter(row => row.baitId === bait.itemId).flatMap(row => fishing.routeIds.map(routeId => {
      const withBait = math.catchPortfolio(row.rodId, bait.itemId, routeId, row.hookId);
      const plain = math.catchPortfolio(row.rodId, null, routeId, row.hookId);
      const route = catalog.explorations.find(route => route.id === routeId);
      const profit = withBait.expectedFishRevenue - plain.expectedFishRevenue - bait.price;
      return { rodId: row.rodId, hookId: row.hookId, routeId,
        incrementalSaleProfit: profit, incrementalSaleProfitPerHour: profit * 3600 / route.seconds };
    }));
    const maximum = rows.reduce((a, b) => a.incrementalSaleProfit >= b.incrementalSaleProfit ? a : b);
    assert(rows.every(row => row.incrementalSaleProfitPerHour <= 30), `${bait.itemId}: bait must not dominate fishing income`);
    return { baitId: bait.itemId, priceCoins: bait.price,
      maximum: { ...maximum, incrementalSaleProfit: rounded(maximum.incrementalSaleProfit),
        incrementalSaleProfitPerHour: rounded(maximum.incrementalSaleProfitPerHour) } };
  });
  const incomeRanges = fishing.routeIds.map(routeId => {
    const route = catalog.explorations.find(route => route.id === routeId);
    const rows = loadouts.map(row => {
      const value = math.catchPortfolio(row.rodId, row.baitId, routeId, row.hookId);
      return (value.expectedFishRevenue - value.routeCoins - value.baitPurchaseCoins - math.liquidation(value.routeInputs)) * 3600 / route.seconds;
    });
    const starter = math.catchPortfolio("reed_rod", null, routeId, "bare_hook").expectedFishRevenue * 3600 / route.seconds;
    assert(Math.min(...rows) > 0, `${routeId}: paid bait must leave a positive expected catch value`);
    assert(Math.max(...rows) <= starter * 2, `${routeId}: premium tackle must not double the starter's income`);
    return { routeId, minimumNetSaleCoinsPerHour: rounded(Math.min(...rows)), maximumNetSaleCoinsPerHour: rounded(Math.max(...rows)),
      starterNetSaleCoinsPerHour: rounded(starter) };
  });
  const shop = fishing.shop.gearRarityBpsByHome.map((row, index) => {
    assert.equal(Object.values(row).reduce((sum, value) => sum + value, 0), 10000);
    const p = row.legendary / 10000, daysPerStock = fishing.shop.refreshSeconds / 86400;
    return { homeLevel: index + 1, rarityProbabilities: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value / 10000])),
      expectedDaysPerLegendaryModel: p ? rounded(daysPerStock / p) : null,
      expectedDaysForBothLegendaryModels: p ? rounded(daysPerStock * (2 / p - 1 / (2 * p - p * p))) : null };
  });
  return { catalogVersion: catalog.version, combinations: loadouts.length, currency: "coins as displayed in the UI; currencyScale is a legacy denomination marker, not a display divisor",
    assumptions: ["Each special attempt is one draw; the six-attempt estimate is 1-(1-p)^6, not 6p",
      "Guaranteed river fish are included in sale revenue; legendary tackle and named hook gates still apply",
      "Sale revenue uses Pleska's full fish buyback price, excluding orders, meals and player-market demand",
      "Shop waits assume every six-hour supply is viewed and the offered model can be afforded; no finite guarantee",
      "Existing paid fishing jobs retain their saved rewards"], targets,
    starterRarityProbabilities: Object.fromEntries(Object.entries(loadouts[0].shares).map(([key, value]) => [key, rounded(value)])),
    saleEconomics, baitMargins, incomeRanges, shop };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(auditFishingBalance(catalog), null, 2));
}
