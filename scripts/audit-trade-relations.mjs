import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { residentOrderPricing } from "./lib/resident-order-pricing.mjs";
import { reputationXpForEffort, tradeGuaranteedBuildings, tradeOrderEffort, tradeResidentIds, tradeSourceAvailability } from "./lib/trade-relations-effort.mjs";

const sum = values => values.reduce((total, value) => total + value, 0);
const signature = items => JSON.stringify(Object.entries(items).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const baseline = JSON.parse(readFileSync(new URL("../apps/api/src/test/resources/world/resident-order-balance-vectors.json", import.meta.url), "utf8"));

/** Catalog policy audit independent of command execution. Runtime parity tests
 * use the authored values; this audit proves their ingredient/time provenance. */
export function auditTradeRelations(catalog) {
  const config = catalog.tradeRelations;
  assert(config?.version === 1, "Trading relations catalog is required");
  assert.equal(config.maxBonusBps, 1000, "Reputation benefits must never exceed ten percent");
  assert.deepEqual(config.ranks.map(rank => rank.requiredXp), [0, 150, 600, 1800, 4200]);
  assert.deepEqual(config.ranks.map(rank => rank.bonusBps), [0, 200, 400, 700, 1000]);
  assert.equal(new Set(config.ranks.map(rank => rank.id)).size, 5);
  assert(config.ranks.every(rank => rank.name.length > 0));
  assert.equal(config.dailyOrderXpCap, 60);
  assert.equal(config.purchaseXp, 1);
  assert.equal(config.dailyPurchaseXpCap, 2);
  assert.equal(config.weekly.durationSeconds, 7 * 86400);
  assert.equal(catalog.food.orders.slots, 5);

  const templates = catalog.food.orders.templates, ids = new Set(templates.map(template => template.id));
  assert(templates.length >= 109, "Keep the established requests and add useful new production baskets");
  assert.equal(ids.size, templates.length, "Ordinary request ids must be unique");
  assert.equal(new Set(templates.map(template => signature(template.items))).size, templates.length,
    "Ordinary requests must use different baskets, including across customers");
  const lookup = new Map(templates.map(template => [template.id, template]));
  for (const expected of baseline.orders) {
    const actual = lookup.get(expected.templateId);
    assert(actual, `${expected.templateId}: historical request removed`);
    if (catalog.version < 13) {
      assert.deepEqual(actual.items, expected.items, `${actual.id}: historical quantities changed`);
      assert.equal(actual.coins, expected.coins, `${actual.id}: historical payout changed`);
    }
  }

  const itemMap = new Map(catalog.items.map(item => [item.id, item]));
  const quote = residentOrderPricing(catalog), effort = tradeOrderEffort(catalog);
  const npcPrices = new Map((catalog.leaftailShop?.supplyOffers ?? []).map(offer => [offer.itemId, offer.unitPriceCoins]));
  for (const group of catalog.fishing.classes.filter(group => group.rarity === "common"))
    npcPrices.set(group.itemId, Math.ceil(group.buyPrice * catalog.fishing.shop.fishPriceBps / 10000));
  function auditBasket(template, weekly = false) {
    assert(tradeResidentIds.includes(template.residentId), `${template.id}: unknown resident`);
    assert(/^[a-z0-9_]{1,40}$/.test(template.id), `${template.id}: invalid request id`);
    assert(template.name?.length > 0 && template.description?.length <= 280, `${template.id}: missing or excessive copy`);
    const kinds = Object.keys(template.items).length;
    assert(kinds >= 1 && kinds <= (weekly ? 3 : 4), `${template.id}: invalid number of ingredient kinds`);
    assert(sum(Object.values(template.items)) <= 50, `${template.id}: basket exceeds the initial storage budget`);
    const reachable = tradeSourceAvailability(catalog, tradeGuaranteedBuildings(template));
    for (const [itemId, quantity] of Object.entries(template.items)) {
      assert(itemMap.has(itemId) && reachable.items.has(itemId), `${template.id}: unavailable source chain for ${itemId}`);
      assert(Number.isSafeInteger(quantity) && quantity > 0, `${template.id}: invalid quantity`);
      assert(itemMap.get(itemId).category !== "special", `${template.id}: relics never belong to ordinary relations work`);
    }
    const intrinsic = effort(template), pricing = quote(template);
    for (const key of ["effortSeconds", "manufacturingSeconds", "fishingUncertain"])
      assert.equal(template[key], intrinsic[key], `${template.id}: incorrect ${key}`);
    if (!weekly) assert.equal(template.reputationXp, reputationXpForEffort(intrinsic.effortSeconds), `${template.id}: incorrect reputation reward`);
    else assert.equal(template.reputationXp, Math.min(100, Math.max(20, 10 + Math.ceil(intrinsic.effortSeconds / 600))),
      `${template.id}: weekly XP must follow occupied work within its cap`);
    assert.equal(template.coins, pricing.coins, `${template.id}: coin payout must preserve the manufacturing policy`);
    const npcPurchaseCoins = Object.keys(template.items).every(itemId => npcPrices.has(itemId))
      ? sum(Object.entries(template.items).map(([itemId, quantity]) => quantity * npcPrices.get(itemId))) : null;
    if (npcPurchaseCoins !== null) assert(template.coins < npcPurchaseCoins,
      `${template.id}: immediate NPC purchase-to-order arbitrage`);
    return { templateId: template.id, residentId: template.residentId, home: template.requiredHomeLevel,
      requiredBuildings: template.requiredBuildings, items: template.items, coins: template.coins,
      reputationXp: template.reputationXp, effortSeconds: template.effortSeconds,
      ...(weekly ? { pearls: template.pearls ?? 0 } : {}),
      manufacturingSeconds: template.manufacturingSeconds, fishingUncertain: template.fishingUncertain,
      completeNpcPurchaseCoins: npcPurchaseCoins, immediateNpcProfitCoins: npcPurchaseCoins === null ? null : template.coins - npcPurchaseCoins };
  }
  const orders = templates.map(template => auditBasket(template));
  for (const residentId of ["lopukh", "kamneshmyg", "leaftail"])
    assert(orders.filter(order => order.residentId === residentId).length >= 8, `${residentId}: needs early and late requests`);
  for (const template of templates.filter(template => template.residentId === "lopukh"))
    assert((template.requiredBuildings.woodlot ?? 0) >= 1, `${template.id}: a woodcutter request requires his workplace`);
  for (const template of templates.filter(template => template.residentId === "kamneshmyg"))
    assert((template.requiredBuildings.quarry ?? 0) >= 1 && template.requiredHomeLevel >= 2, `${template.id}: a miner request requires a quarry`);
  for (const template of templates.filter(template => template.residentId === "leaftail"))
    assert(template.requiredHomeLevel >= catalog.leaftailShop.requiredHomeLevel, `${template.id}: trader request predates his arrival stage`);

  assert(config.weekly.templates.length >= 10);
  assert.equal(new Set(config.weekly.templates.map(template => template.id)).size, config.weekly.templates.length);
  const weekly = config.weekly.templates.map(template => {
    assert(tradeResidentIds.includes(template.residentId), `${template.id}: unknown weekly customer`);
    assert.equal(template.stages.length, 3, `${template.id}: weekly work needs exactly three stages`);
    const stages = template.stages.map(stage => auditBasket({ ...template, ...stage }, true));
    const reputationXp = sum(stages.map(stage => stage.reputationXp));
    assert(reputationXp >= 60 && reputationXp <= 300, `${template.id}: weekly reputation out of bounds`);
    // Optional specialist weeklies may use named fish dishes, with expected
    // acquisition disclosed above. Legendary RNG remains outside deadlines.
    const forbidden = ["fish_legendary", "legendary_fish"];
    assert(stages.every(stage => Object.keys(stage.items).every(item => !forbidden.includes(item))),
      `${template.id}: a weekly deadline cannot require rare random catches`);
    return { templateId: template.id, residentId: template.residentId, home: template.requiredHomeLevel,
      requiredBuildings: template.requiredBuildings, stages, reputationXp,
      pearls: sum(stages.map(stage => stage.pearls)),
      coins: sum(stages.map(stage => stage.coins)), effortSeconds: sum(stages.map(stage => stage.effortSeconds)),
      manufacturingSeconds: sum(stages.map(stage => stage.manufacturingSeconds)), fishingUncertain: stages.some(stage => stage.fishingUncertain) };
  });
  for (const resident of tradeResidentIds) {
    const variants = weekly.filter(template => template.residentId === resident);
    assert(variants.length >= 2, `${resident}: early and late weekly variants required`);
    assert(variants[0].home < variants[1].home, `${resident}: weekly variants must expand with progression`);
  }

  // Loyalty discounts apply only to paid gear/bait/clothes. Ingredients and fish
  // retain their exact NPC prices, so the complete-basket checks above also hold
  // at maximum reputation. Bait can exist as inventory and needs its own floor.
  const merchantDiscounts = catalog.fishing.baits.map(bait => {
    const discountedPrice = Math.ceil(bait.price * (10000 - config.maxBonusBps) / 10000);
    const resalePrice = catalog.localBuyer.unitPrices?.[bait.itemId] ?? itemMap.get(bait.itemId)?.baseSellPrice ?? 0;
    assert(discountedPrice >= resalePrice, `${bait.itemId}: maximum loyalty discount creates immediate resale profit`);
    return { itemId: bait.itemId, merchant: bait.shop, basePrice: bait.price, discountedPrice, resalePrice };
  });
  const finalXp = config.ranks.at(-1).requiredXp, weeklyMax = Math.max(...weekly.map(template => template.reputationXp));
  // Strong optimistic lower bound: award the entire weekly on acceptance, allow
  // an immediate UTC midnight to grant a second daily allowance, and assume
  // every later daily/weekly allowance is earned in full without work delays.
  let optimisticEarliestElapsedDays = 0;
  const ceilingAtDay = day => (day + 2) * (config.dailyOrderXpCap + config.dailyPurchaseXpCap)
    + (Math.floor(day / 7) + 1) * weeklyMax;
  while (ceilingAtDay(optimisticEarliestElapsedDays) < finalXp) optimisticEarliestElapsedDays++;
  assert(optimisticEarliestElapsedDays >= 42, "Maximum reputation must require at least six weeks even at every cap");
  const pacing = tradeResidentIds.map(residentId => {
    const dailyMedianXp = median(orders.filter(order => order.residentId === residentId).map(order => order.reputationXp));
    const ownWeeklies = weekly.filter(template => template.residentId === residentId);
    const weeklyAverageXp = sum(ownWeeklies.map(template => template.reputationXp)) / ownWeeklies.length;
    const purchasesPerDay = ["plesk", "leaftail"].includes(residentId) ? 1 : 0;
    const scenarios = [3, 5].map(ordinaryPerDay => ({ ordinaryPerDay, ordinaryXp: dailyMedianXp,
      purchaseXpPerDay: purchasesPerDay,
      approximateWeeksToMaximum: Number((finalXp / (ordinaryPerDay * dailyMedianXp + purchasesPerDay + weeklyAverageXp / 7) / 7).toFixed(1)) }));
    return { residentId, medianOrdinaryXp: dailyMedianXp, weeklyAverageXp, scenarios };
  });
  return { version: 1, assumptions: [
    "Effort is occupied baseline acquisition plus upstream processing work from an empty pantry, not elapsed completion time.",
    "Different stations may overlap, existing stock may shorten preparation, and joint expedition byproducts can serve several requirements.",
    "Mining duration counts once, not once per occupied quarry and miner.",
    "Fish acquisition is an expectation with baseline eligible tackle; it is not a guaranteed deadline.",
    "Manufacturing premium and original 85 coin promises stay unchanged; reputation is a separate bounded reward.",
    "Typical rank estimates assume the shown median requests every day and both weekly variants are accessible; they are not a promise of player progress.",
    "Each rank scenario focuses the single weekly choice on that resident every week; five residents cannot all receive weekly progress simultaneously.",
    "The optimistic minimum grants full weekly XP immediately and two daily caps near the first UTC midnight; real work makes it slower.",
  ], baselineOrders: baseline.orders.length, orders, weekly, merchantDiscounts,
    pacing: { finalXp, maximumDailyOrdinaryXp: config.dailyOrderXpCap, maximumDailyPurchaseXp: config.dailyPurchaseXpCap,
      maximumWeeklyXp: weeklyMax, optimisticEarliestElapsedDays, residents: pacing } };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
  console.log(JSON.stringify(auditTradeRelations(catalog), null, 2));
}
