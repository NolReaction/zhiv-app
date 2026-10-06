import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { economicMath } from "./lib/economy-math.mjs";

const catalogPath = new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url);
const rounded = value => Number(value.toFixed(3));

/** Static pressure envelopes, not a multi-agent market or player simulation. */
export function reviewMarketPressure(catalog) {
  const math = economicMath(catalog), items = new Map(catalog.items.map(item => [item.id, item]));
  const baseValue = quantities => Object.entries(quantities).reduce((sum, [id, quantity]) => sum + items.get(id).baseSellPrice * quantity, 0);
  const profiles = Object.fromEntries(catalog.items.filter(item => item.tradable).map(item => [item.id, math.profile(item.id)]));
  const stations = [...new Set(catalog.recipes.map(recipe => recipe.buildingId))];
  const production = [1, 2, 3, 4, 5].map(homeLevel => {
    const maximumSlots = Math.max(1, ...catalog.productionSlots.upgrades.filter(upgrade => upgrade.requiredHomeLevel <= homeLevel).map(upgrade => upgrade.slots));
    return { homeLevel, maximumSlots, stations: stations.map(station => {
      const available = catalog.recipes.filter(recipe => recipe.buildingId === station && math.batch(recipe).directHome <= homeLevel);
      const row = recipe => ({ recipeId: recipe.id, output: recipe.rewards, inputs: recipe.cost.items,
        minutes: recipe.seconds / 60, grossBaseValue: baseValue(recipe.rewards),
        netBaseValue: math.batch(recipe).baseMarketMargin,
        grossBaseValuePerSlotHour: rounded(baseValue(recipe.rewards) * 3600 / recipe.seconds),
        netBaseValuePerSlotHour: rounded(math.batch(recipe).baseMarketMarginPerStationHour),
        npcNetCoinsPerSlotHour: rounded(math.batch(recipe).incrementalMargin * 60 / math.batch(recipe).stationMinutes) });
      const best = values => values.sort((left, right) => right.netBaseValuePerSlotHour - left.netBaseValuePerSlotHour)[0] ?? null;
      return { station, shortActive: best(available.filter(recipe => recipe.seconds < 14_400).map(row)),
        convenientLong: best(available.filter(recipe => recipe.seconds >= 14_400).map(row)) };
    }) };
  });
  const dailyCaps = Object.fromEntries(catalog.market.dailyTradeValueByHome.map((value, index) => [index + 1, value]).filter(([home]) => home >= 2));
  const tradeBudget = Object.entries(dailyCaps).map(([home, baseValueBudget]) => ({ homeLevel: Number(home), baseValueBudget,
    woodReferenceSlotHours: baseValueBudget / 600,
    maximumCoinsTransferredToSeller: baseValueBudget * catalog.market.maxPriceMultiplier
      - Math.ceil(baseValueBudget * catalog.market.maxPriceMultiplier * catalog.market.feeBps / 10_000),
    replacedProductionExamples: ["wood", "planks", "rope", "cut_stone", "iron_ingot", "tools", "reinforced_parts"].flatMap(id => {
      const profile = profiles[id]; if (profile.sourceHome > Number(home)) return [];
      const quantity = Math.floor(baseValueBudget / items.get(id).baseSellPrice);
      return [{ itemId: id, quantity, baseValue: quantity * items.get(id).baseSellPrice,
        occupiedMinutesByResource: Object.fromEntries(Object.entries(profile.slotMinutes).map(([resource, minutes]) => [resource, rounded(minutes * quantity)])) }];
    }) }));
  const food = ["dried_berries", "smoked_fish"].map(id => ({ itemId: id,
    consumedBy: catalog.explorations.filter(route => route.cost.items[id] > 0).map(route => ({ routeId: route.id, required: route.cost.items[id], hours: route.seconds / 3600 })),
    recipeInputs: catalog.recipes.filter(recipe => recipe.cost.items[id] > 0).map(recipe => recipe.id),
    constructionUses: catalog.buildings.flatMap(building => building.levels.filter(level => level.cost.items[id] > 0).map(level => `${building.id}:${level.level}`)) }));
  const fish = catalog.fishing.fish.map(spec => {
    const merchantPrice = spec.rarity === "common" ? Math.ceil(spec.buyPrice * catalog.fishing.shop.fishPriceBps / 10_000) : null;
    const marketMaximum = items.get(spec.itemId).baseSellPrice * catalog.market.maxPriceMultiplier;
    return { itemId: spec.itemId, rarity: spec.rarity, npcSalePrice: items.get(spec.itemId).baseSellPrice,
      merchantBuyPrice: merchantPrice, immediateNpcResaleProfit: merchantPrice === null ? null : items.get(spec.itemId).baseSellPrice - merchantPrice,
      conditionalPlayerResaleProfit: merchantPrice === null ? null : marketMaximum - Math.ceil(marketMaximum * catalog.market.feeBps / 10_000) - merchantPrice,
      consumedByRecipes: catalog.recipes.filter(recipe => recipe.cost.items[spec.itemId] > 0).map(recipe => recipe.id),
      consumedByExplorations: catalog.explorations.filter(route => route.cost.items[spec.itemId] > 0).map(route => route.id) };
  });
  assert(fish.filter(item => item.merchantBuyPrice !== null).every(item => item.immediateNpcResaleProfit <= 0));
  return { reviewDate: "2026-10-06", catalogVersion: catalog.version,
    method: { units: "Coins and catalog item quantities; pearl amounts only where explicitly labeled. All queue time is occupied resource time, not elapsed completion time.",
      production: "Each home tier assumes all required buildings completed and uninterrupted input supply. One slot is the reference; simultaneous identical slots multiply supply up to the house gate. Individual station maxima cannot be added as self-sufficient total output.",
      marketBudget: `Chosen release limits are catalog baseSellPrice × quantity per participant and direction per UTC day; price cap ${catalog.market.maxPriceMultiplier}× and fee${catalog.market.feeBps / 100}%. Four wood slot-hours per2400 is only a calibration, not a universal production-minute limit.`,
      limitations: ["No user telemetry, demand curve, bots, collusive account network or market-clearing price simulation.",
        "Quarry and Mochlik minutes overlap when mining; never add them as elapsed labour. Recipe reference profiles can use later unlocked efficient sources; their referenceHome is exposed separately by economicMath.",
        "No premium transactions exist. Gift income is evaluated by the separate daily-gift progression report.",
        "Market groups and quotas bound flow but do not prove complete resistance to account farms or all inflation."] },
    production, tradeBudget, fish, food,
    totalRemainingBuildingCoinCostFromStarter: catalog.buildings.reduce((sum, building) => sum + building.levels
      .filter(level => !(level.level === 1 && ["home", "garden", "warehouse"].includes(building.id)))
      .reduce((total, level) => total + level.cost.coins, 0), 0),
    rareMaterialDemand: catalog.rareDrops.itemIds.map(id => ({ itemId: id,
      totalAcrossAllCurrentBuildingLevels: catalog.buildings.reduce((sum, building) => sum + building.levels
        .reduce((total, level) => total + (level.cost.items[id] ?? 0), 0), 0),
      expectedExplorationHoursPerSpecificDrop: (catalog.rareDrops.minSeconds + catalog.rareDrops.maxSeconds) / 2 / 3600 * catalog.rareDrops.itemIds.length })),
    preparedExpeditions: catalog.explorations.filter(route => Object.keys(route.cost.items).length).map(route => ({ routeId: route.id,
      routeMinutes: route.seconds / 60, consumes: route.cost.items, gives: route.rewards,
      inputProductionMinutesByResource: Object.fromEntries(Object.entries(math.batch(route).slotMinutes).map(([resource, minutes]) =>
        [resource, rounded(minutes - (resource === "mochlik" || resource === "quarry" && route.requiredBuildings.quarry ? route.seconds / 60 : 0))])),
      sameOutputElementaryMinutesByResource: math.batch(route).elementaryOutputMinutes,
      npcRevenueLessIngredientOpportunity: math.batch(route).incrementalMargin })),
    observations: [
      "At home5 three garden slots can yield720 berries+144 fiber across three8h jobs/day versus96 berries from home1 one slot. At home5 three woodlot slots yield324wood+144hardwood+90resin/day versus72wood+72fiber at home2 one slot's three6h jobs. These are separate stationary envelopes without construction interruptions.",
      "A low-level player cannot compete on volume against such unlocked capacity. Small showcase size does not limit turnover once a seller relists sold goods.",
      "Common merchant fish cannot be immediately sold profitably to the NPC. Reselling at the market ceiling can have a small positive margin but requires another player, uses fixed merchant stock and consumes both market participants' daily quotas; it is not coin minting.",
      "deep_cave yields exactly four cave trips but charges one dried_berries+one smoked_fish: its current premium is fewer visits, not better yield. coastal_deposits takes600 route minutes plus food inputs for output requiring562.5 focused quarry/actor minutes without food.",
      "Food is currently consumed only by five expedition definitions; no building or recipe consumes either cooked item. Valuable collection fish have no recipe sink. Future ponds and limited personal collection commissions can create use without an unlimited coin faucet.",
      "Current buildings consume only two units of each relic in total. A guaranteed ancient_core every seventh daily gift meets its entire construction demand after14claims and creates an enduring excess; its weekly schedule predates this update. The other types still depend on shared expedition time or barter.",
      "Price caps, group boundaries and per-account limits bound damage. They do not prove resistance to organised account farms, price inflation or the indirect release of ordinary coins when premium currency pays construction." ],
    sourceHashes: Object.fromEntries(["../apps/api/src/main/resources/world/economy-catalog.json", "./lib/economy-math.mjs", "./review-market-pressure.mjs"]
      .map(path => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")])) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  console.log(JSON.stringify(reviewMarketPressure(JSON.parse(readFileSync(catalogPath, "utf8"))), null, 2));
