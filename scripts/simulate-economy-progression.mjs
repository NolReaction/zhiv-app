import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";
import { createSocialPolicy } from "./lib/economy-social-scenario.mjs";
import { createRewardScenario } from "./lib/economy-reward-scenario.mjs";
import { createNeighborScenario } from "./lib/economy-neighbor-scenario.mjs";

export const epoch = Date.parse("2026-10-14T09:00:00Z"), hour = 3_600_000;
const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
export function createRandom(seed) {
  let value = seed >>> 0 || 1;
  return maximum => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; value >>>= 0; return value % maximum; };
}
export async function loadProgressionRules(sourceRoot = defaultRoot) {
  const root = resolve(sourceRoot);
  const vite = await createServer({ appType: "custom", configFile: false, root, logLevel: "silent", cacheDir: `/tmp/zhiv-v14-progression-${root.includes("baseline") ? "baseline" : "working"}`,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  const paths = { rules: "features/economy/domain/rules.ts", model: "features/economy/domain/model.ts", stages: "features/economy/domain/stage-orders.ts",
    food: "features/economy/domain/food.ts", actors: "features/economy/domain/actor-availability.ts", tutorial: "features/economy/domain/tutorial-order.ts",
    slots: "features/economy/domain/production-slots.ts", market: "features/economy/domain/market-rules.ts", relations: "features/economy/domain/trade-relations.ts", fishing: "features/economy/domain/fishing.ts", fishingShop: "features/economy/domain/fishing-shop.ts", publicJobs: "features/economy/domain/public-jobs.ts", leaftail: "features/economy/domain/leaftail-shop.ts", rewards: "features/game/progression-rewards.ts", achievements: "features/game/achievement-progress.ts",
    welcome: "features/mailbox/welcome.ts", money: "features/economy/domain/money.ts", fishStock: "features/economy/domain/fish-stock.ts",
    identities: "lib/dev/api-store.ts", economyStore: "lib/dev/economy-store.ts", neighborStore: "lib/dev/neighbor-store.ts",
    neighborRules: "features/economy/domain/neighbor-rules.ts", neighborModel: "features/economy/domain/neighbor-model.ts" };
  const loaded = {};
  for (const [name, path] of Object.entries(paths)) loaded[name] = await vite.ssrLoadModule(`/${path}`);
  loaded.catalog = loaded.model.economyCatalog;
  loaded.createRewards = () => createRewardScenario({ rewards: loaded.rewards, achievementProgress: loaded.achievements, welcome: loaded.welcome });
  loaded.close = () => vite.close();
  return loaded;
}
const chapters = {
  1: [["woodlot", 1], ["dryer", 1], ["workshop", 1], ["home", 2]],
  2: [["warehouse", 2], ["quarry", 1], ["quarry", 2], ["kiln", 1], ["garden", 2], ["bridge", 1], ["home", 3]],
  3: [["woodlot", 2], ["kiln", 2], ["workshop", 2], ["garden", 3], ["dryer", 2], ["woodlot", 3], ["workshop", 3],
    ["quarry", 3], ["warehouse", 3], ["kiln", 3], ["lighthouse", 1], ["home", 4]],
  4: [["garden", 4], ["woodlot", 4], ["quarry", 4], ["kiln", 4], ["workshop", 4], ["dryer", 3], ["home", 5]],
  5: [["dryer", 4], ["garden", 5]],
};
const newRecipes = {
  1: ["grow_strawberries", "cook_strawberry_compote"],
  2: ["grow_blueberries", "cook_blueberry_compote"],
  3: ["grow_currants", "cook_currant_jelly"],
  4: ["grow_blackberries", "cook_blackberry_preserve"],
  5: ["grow_cranberries", "cook_cranberry_glaze"],
};


/** The only fixture is a newly created account. Each later chapter carries the
 * actual money, stock, recipes, restored landmarks and unfinished work forward. */
export function simulateProgression(loaded, options = {}) {
  const { rules, catalog, stages, food, actors, tutorial, slots } = loaded;
  const { regularActiveMinutes = 20, firstVisitMinutes = 60, seed = 1, slotPolicy = "earned", maxDays = 160,
    claimRewards = true, useMeals = true, completionGoal = "home-5", manualSeconds = 2, externalSlotBudget = 0,
    visitsPerDay = 3, opportunisticRoutes = true, speedupPolicy = "none", socialMode = "income", buySupplies = true, relicPolicy = "none", neighborPolicy = "none", ownerPublicId = "0000-0000-0001", onVisit, onCommand } = options;
  assert(["none", "auto"].includes(neighborPolicy), "Unknown neighbor policy");
  assert(["none", "earned"].includes(relicPolicy), "Unknown relic purchasing policy");
  assert(["home-5", "all-production", "all-buildings", "all-recipes", "full", "all-capacity", "reputation", "observation"].includes(completionGoal), "Unknown completion goal");
  assert(typeof ownerPublicId === "string" && /^\d{4}-\d{4}-\d{4}$/.test(ownerPublicId), "A synthetic public owner ID is required");
  assert(Number.isInteger(visitsPerDay) && visitsPerDay > 0 && visitsPerDay <= 24);
  assert(regularActiveMinutes > 0 && regularActiveMinutes <= 24 * 60 / visitsPerDay);
  assert(firstVisitMinutes > 0 && firstVisitMinutes <= 24 * 60 / visitsPerDay);
  assert(manualSeconds > 0 && Number.isFinite(manualSeconds));
  const random = createRandom(seed);
  const rewardScenario = loaded.createRewards?.();
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  const startingCoins = state.wallet.coins, startingItems = { ...state.inventory };
  const neighbor = neighborPolicy === "auto" ? createNeighborScenario({ ...loaded, state, now: epoch, ownerPublicId }) : null;
  try {
  const escrowItems = () => neighbor?.escrowItems() ?? {};
  const neighborSales = [];
  let neighborPlan = null;
  const social = createSocialPolicy({catalog,relations:loaded.relations,food,state,mode:socialMode,continueWeekly: () => completionGoal === "all-capacity" && !maximumCapacity() || relicPolicy === "earned" && !maximumSettlement()});
  let clock = epoch, sequence = 0, revision = 0, peak = 0, constructionCoins = 0, courseCoins = 0, repeatCoins = 0, saleCoins = 0, visitCount = 0;
  let cashReserve = 0;
  let constructionSeconds = 0, activeStart = epoch, activeEnd = epoch, activeSeconds = 0;
  const courses = [], builds = [], actions = {}, flow = {}, production = {}, catches = {}, repeatOrders = [];
  const berryClaims = [], checkpoints = [], windows = [];
  const incomeJobs = new Set();
  for (const [id, count] of Object.entries(startingItems)) flow[id] = { received: count, consumed: 0, sold: 0, escrow: 0 };
  const uuid = () => `${(seed >>> 0).toString(16).padStart(8, "0")}-0000-4000-9000-${(++sequence).toString(16).padStart(12, "0")}`;
  const rewardClaims = [], slotPurchases = [], mealUses = [], storagePressure = [], waits = [];
  const concurrencyPeaks = {}, claimedWorkSeconds = {}, readyIdleSeconds = {};
  const materialRouteStarts = [], speedups = [], relicPurchases = [], marketSlotPurchases = [], calendarSnapshots = [];
  const sourceCache = new Map(), effortCache = new Map();
  const milestones = {};
  const targetHome = Math.max(...catalog.buildings.find(row => row.id === "home").levels.map(row => row.level));
  const maximumBuildings = Object.fromEntries(catalog.buildings.map(row => [row.id, Math.max(...row.levels.map(level => level.level))]));
  const activeRecipes = catalog.recipes.filter(row => !row.retired);
  const maximumProduction = () => Object.entries(maximumBuildings).filter(([id]) => id !== "warehouse").every(([id,level]) => state.buildings[id] >= level);
  const maximumSettlement = () => Object.entries(maximumBuildings).every(([id,level]) => state.buildings[id] >= level);
  const recipesComplete = () => activeRecipes.every(row => (state.progression.recipes[row.id] ?? 0) > 0);
  const productionStations = [...new Set(activeRecipes.map(row => row.buildingId))];
  const maximumSlotCount = Math.max(...catalog.productionSlots.upgrades.map(row => row.slots));
  const maximumProductionSlots = () => productionStations.every(id => slots.productionSlotCount(state, id) >= maximumSlotCount);
  const maximumCapacity = () => maximumProductionSlots() && loaded.market.marketSlotCount(state, catalog) >= catalog.market.maxListings;
  const owned = id => catalog.fishing.fish.some(fish => fish.itemId === id) ? loaded.fishStock.normalizedFishStock(state)[id] ?? 0 : state.inventory[id] ?? 0;
  const coinLedger = { initial: state.wallet.coins, credits: {}, debits: {} };
  const pearlLedger = { initial: state.wallet.pearls, credits: {}, debits: {} };
  assert([0, 3500].includes(externalSlotBudget), "Only explicit zero or all-slot sensitivity budget is supported");
  if (externalSlotBudget) { state.wallet.pearls += externalSlotBudget; pearlLedger.credits.externalSlotBudget = externalSlotBudget; }
  function captureCalendarSnapshots() {
    for (const day of [1, 7, 14, 30]) {
      if (clock < epoch + day * 24 * hour || calendarSnapshots.some(row => row.day === day)) continue;
      calendarSnapshots.push({ day, coins: state.wallet.coins, pearls: state.wallet.pearls,
        buildings: { ...state.buildings }, productionSlots: { ...state.productionSlots },
        marketSlots: loaded.market.marketSlotCount(state, catalog),
        coinLedger: structuredClone(coinLedger), pearlLedger: structuredClone(pearlLedger),
        claimedRewards: rewardClaims.length, commandCount: revision });
    }
  }
  const visitEnded = Symbol("scheduled visit ended");
  const manualMilliseconds = manualSeconds * 1000;
  const recordCurrency = (ledger, before, after, source) => { const delta = after - before;
    if (delta) { const bucket = delta > 0 ? ledger.credits : ledger.debits; bucket[source] = (bucket[source] ?? 0) + Math.abs(delta); } };
  const slotCapacity = id => slots.productionSlotCount(state, id);
  const record = id => flow[id] ??= { received: 0, consumed: 0, sold: 0, escrow: 0 };
  const currentCourse = () => tutorial.tutorialResidentOrder(state) ?? stages.stageResidentOrder(state);
  const held = items => Object.entries(items).every(([id, count]) => owned(id) >= count);
  const buildingOpen = requirements => Object.entries(requirements ?? {}).every(([id, level]) => (state.buildings[id] ?? 0) >= level);
  const sourceOpen = source => !source.retired && state.buildings.home >= source.requiredHomeLevel && buildingOpen(source.requiredBuildings)
    && (!source.buildingId || (state.buildings[source.buildingId] ?? 0) >= source.buildingLevel);
  // Seeded server entropy is shared by real trusted draws, never inspected by
  // the policy. The guaranteed chapter rewards do not depend on random relics.
  const rareRandom = random;
  function tickNeighbor(now) {
    if (!neighbor) return;
    for (const sale of neighbor.tick(now).sales) {
      const item = record(sale.itemId);
      item.escrow -= sale.quantity; item.sold += sale.quantity;
      assert(item.escrow >= 0, "Berest cannot buy goods which were never escrowed");
      rewardScenario?.recordMarketSale?.();
      const ordinaryUnit = catalog.localBuyer.unitPrices[sale.itemId] ?? catalog.items.find(row => row.id === sale.itemId).baseSellPrice;
      neighborSales.push({ itemId: sale.itemId, quantity: sale.quantity, totalPrice: sale.totalPrice, proceedsCoins: sale.proceedsCoins, feeCoins: sale.feeCoins, createdAt: sale.createdAt, closedAt: sale.closedAt, day: (Date.parse(sale.closedAt) - epoch) / (24 * hour), directSaleAlternative: ordinaryUnit * sale.quantity });
    }
  }
  function advanceClock(to) {
    if (neighbor) {
      let due = neighbor.nextDue(clock);
      for (let guard = 0; due != null && due <= to; guard++) {
        assert(guard < 100, "Neighbor scheduling must make progress");
        clock = Math.max(clock, due); captureCalendarSnapshots(); tickNeighbor(clock);
        const next = neighbor.nextDue(clock);
        assert(next == null || next > due, "Next automatic transaction must advance time");
        due = next;
      }
    }
    clock = to; captureCalendarSnapshots();
  }
  function apply(action, targetId, quantity = 1, totalPrice = 0) {
    if (clock + manualMilliseconds > activeEnd) throw visitEnded;
    assert(clock >= activeStart && clock <= activeEnd, "manual actions only happen during a scheduled visit");
    captureCalendarSnapshots();
    const before = structuredClone(state), offer = action === "complete_resident_order" ? currentCourse() : null;
    if (["create_listing", "claim_sale"].includes(action)) neighbor.command(action, targetId, quantity, totalPrice, clock);
    else rules.applyEconomyCommand(state, { requestId: uuid(), ownerPublicId, expectedRevision: revision,
      action, targetId, quantity, totalPrice }, clock, uuid, escrowItems(), rareRandom);
    recordCurrency(coinLedger, before.wallet.coins, state.wallet.coins, action);
    recordCurrency(pearlLedger, before.wallet.pearls, state.wallet.pearls, action);
    if (action === "speedup_construction") { sourceCache.clear(); effortCache.clear(); }
    if (action === "speedup_construction") speedups.push({ day: (clock - epoch) / (24 * hour), paid: before.wallet.pearls - state.wallet.pearls, target: before.jobs.find(job => job.id === targetId)?.targetId });
    if (action === "buy_production_slot") slotPurchases.push({ day: (clock - epoch) / (24 * hour), station: targetId, slots: slotCapacity(targetId), paid: before.wallet.pearls - state.wallet.pearls, home: state.buildings.home });
    if (action === "buy_market_slot") marketSlotPurchases.push({ day: (clock - epoch) / (24 * hour), slots: loaded.market.marketSlotCount(state, catalog), paid: before.wallet.pearls - state.wallet.pearls });
    if (["eat_food", "feed_builder"].includes(action)) mealUses.push({ day: (clock - epoch) / (24 * hour), action, item: targetId });
    if (["buy_fishing_item","buy_leaftail_item","equip_fishing_rod","equip_fishing_hook"].includes(action)) effortCache.clear();
    revision++; actions[action] = (actions[action] ?? 0) + 1;
    if (action === "claim_job") {
      const job = before.jobs.find(job => job.id === targetId);
      if (job) {
        const actor = job.kind === "production" ? job.targetId : job.actorId ?? job.kind;
        claimedWorkSeconds[actor] = (claimedWorkSeconds[actor] ?? 0) + (Date.parse(job.finishesAt) - Date.parse(job.startedAt)) / 1000;
        readyIdleSeconds[actor] = (readyIdleSeconds[actor] ?? 0) + Math.max(0, clock - Date.parse(job.finishesAt)) / 1000;
      }
      if (job?.recipeId && Object.values(newRecipes).flat().includes(job.recipeId))
        berryClaims.push({ recipeId: job.recipeId, home: before.buildings.home, at: clock, rewards: { ...job.rewards } });
      if (job?.kind === "construction") { sourceCache.clear(); effortCache.clear(); }

    }
    if (action === "start_construction") {
      constructionCoins += before.wallet.coins - state.wallet.coins;
      const job = state.jobs.find(job => job.kind === "construction");
      constructionSeconds += (Date.parse(job.finishesAt) - clock) / 1000;
      builds.push({ target: targetId, level: job.targetLevel, startedAt: clock });
    }
    if (action === "complete_resident_order") {
      const coins = state.wallet.coins - before.wallet.coins;
      if (offer?.id === targetId) { courseCoins += coins; courses.push({ id: targetId, at: clock, items: offer.items, coins }); }
      else { repeatCoins += coins; repeatOrders.push({ id: targetId, coins, at: clock }); }
    }
    if (["sell", "sell_fish"].includes(action)) saleCoins += state.wallet.coins - before.wallet.coins;
    for (const id of new Set([...Object.keys(before.inventory), ...Object.keys(state.inventory)])) {
      const delta = (state.inventory[id] ?? 0) - (before.inventory[id] ?? 0);
      if (delta > 0) record(id).received += delta;
      else if (delta < 0) record(id)[action === "create_listing" ? "escrow" : ["sell", "sell_fish"].includes(action) ? "sold" : "consumed"] -= delta;
      if (action === "claim_job" && delta > 0 && catalog.fishing.classes.some(group => group.itemId === id))
        catches[id] = (catches[id] ?? 0) + delta;
    }
    const storage = rules.economyStorage(state, escrowItems()); peak = Math.max(peak, storage.used + storage.reserved);
    assert(storage.used + storage.reserved <= storage.capacity, `${action}:${targetId} exceeds the warehouse`);
    assert(state.jobs.filter(job => job.kind === "construction").length <= 1);
    for (const id of ["garden", "woodlot", "workshop", "dryer", "kiln"]) {
      const occupied = state.jobs.filter(job => job.kind === "production" && job.targetId === id).length;
      concurrencyPeaks[id] = Math.max(concurrencyPeaks[id] ?? 0, occupied);
      assert(occupied <= slotCapacity(id));
    }
    for (const actor of ["miner", "mochlik"])
      assert(state.jobs.filter(job => job.kind === "exploration" && job.actorId === actor).length <= 1);
    for (const target of ["home","bridge","lighthouse"]) if (state.buildings[target] > before.buildings[target])
      checkpoints.push({target,level:state.buildings[target],home:state.buildings.home,at:clock,coins:state.wallet.coins});
    if (state.buildings.home >= targetHome) milestones.home5At ??= clock;
    if (social.complete()) milestones.reputationMaxAt ??= clock;
    if (maximumProduction()) milestones.allProductionAt ??= clock;
    if (maximumSettlement()) milestones.allBuildingsAt ??= clock;
    if (recipesComplete()) milestones.allRecipesAt ??= clock;
    if (maximumProductionSlots()) milestones.allProductionSlotsAt ??= clock;
    if (maximumCapacity()) milestones.allCapacityAt ??= clock;
    clock += manualMilliseconds;
    onCommand?.({action,targetId,clock,state,revision});
  }
  function sell(id, count) {
    while (count > 0) {
      const quantity = Math.min(catalog.maxBatch, count);
      apply(catalog.fishing.classes.some(group => group.itemId === id) ? "sell_fish" : "sell", id, quantity);
      count -= quantity;
    }
  }
  function makeRoom(quantity) {
    const needed = Math.max(0, quantity - rules.economyStorage(state, escrowItems()).available);
    if (!needed) return;
    storagePressure.push({ day: (clock - epoch) / (24 * hour), needed, capacity: rules.economyStorage(state, escrowItems()).capacity });
    let left = needed;
    // NPC sales are actual commands, counted in the budget and item ledger.
    // Guaranteed project relics are kept for the house; random resin is optional.
    const goods = Object.keys(state.inventory).filter(id => !catalog.rareDrops.itemIds.includes(id))
      .sort((a, b) => catalog.items.find(item => item.id === a).baseSellPrice - catalog.items.find(item => item.id === b).baseSellPrice);
    // Sell surplus before an ingredient currently needed for crafting. Selling
    // the cheapest item unconditionally can repeatedly destroy the two fibres
    // needed for a rope while keeping eighteen unused pieces of hardwood.
    const reserve = {};
    const protect = items => { for (const [id, count] of Object.entries(items ?? {})) reserve[id] = Math.max(reserve[id] ?? 0, count); };
    protect(currentCourse()?.items); protect(buildDefinition(nextConstruction())?.cost.items); protect(social.demand(clock));
    if (neighborPlan) protect({ [neighborPlan.itemId]: neighborPlan.quantity });
    for (const recipe of catalog.recipes.filter(sourceOpen)) protect(recipe.cost.items);
    for (const id of goods) {
      const count = Math.min(left, Math.max(0, state.inventory[id] - (reserve[id] ?? 0)));
      if (count) { sell(id, count); left -= count; }
      if (!left) break;
    }
    for (const id of goods) {
      if (!left) break;
      const count = Math.min(left, state.inventory[id] ?? 0);
      if (count) { sell(id, count); left -= count; }
    }
    assert.equal(left, 0, "original storage has enough sellable goods to make room for the complete delivery");
  }
  function claimReady() {
    let changed = false;
    for (const job of [...state.jobs]) {
      if (Date.parse(job.finishesAt) > clock) continue;
      if (job.collection && !job.collection.startedAt) {
        if (actors.economyActorConflict(state.jobs, "collection", clock)) continue;
        makeRoom(Object.values(job.rewards).reduce((sum, count) => sum + count, 0));
        apply("start_collection", job.id); changed = true; continue;
      }
      if (job.collection && Date.parse(job.collection.finishesAt) > clock) continue;
      // Species are grouped into classes by the normal claim transition.
      const possibleFind = catalog.explorations.find(route => route.id === job.targetId)?.finds?.entries ?? [];
      // Reserve the public maximum bonus quantity without inspecting the saved
      // private find. The concrete item is revealed only by the successful claim.
      makeRoom(Object.values(job.rewards).reduce((sum, count) => sum + count, 0) + Math.max(0,...possibleFind.map(row => row.quantity)));
      apply("claim_job", job.id); changed = true;
      if (incomeJobs.delete(job.id)) {
        // Keep a small working reserve and sell the claimed single item
        // through an actual NPC command when it exceeds that reserve.
        const reserve = { stone: 3, ore: 3, clay: 1, sand: 1 };
        for (const basket of [currentCourse()?.items,buildDefinition(nextConstruction())?.cost.items,social.demand(clock)])
          for (const [id,count] of Object.entries(basket ?? {})) reserve[id] = Math.max(reserve[id] ?? 0,count);
        if (neighborPlan) reserve[neighborPlan.itemId] = Math.max(reserve[neighborPlan.itemId] ?? 0, neighborPlan.quantity);
        for (const id of Object.keys(job.rewards).filter(id => !catalog.rareDrops.itemIds.includes(id))) {
          const surplus = Math.max(0, (state.inventory[id] ?? 0) - (reserve[id] ?? 0));
          if (surplus) sell(id, surplus);
        }
      }
    }
    return changed;
  }
  const sourceBusy = source => source.buildingId
    ? state.jobs.some(job => job.targetId === source.buildingId && job.kind === "construction") || state.jobs.filter(job => job.targetId === source.buildingId && job.kind === "production").length >= slotCapacity(source.buildingId)
    : source.activity === "mining"
      ? Boolean(actors.economyMinerConflict(state.jobs, clock)) || state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry")
      : Boolean(actors.economyActorConflict(state.jobs, "departure", clock));
  const pending = id => state.jobs.reduce((sum, job) => sum + (loaded.publicJobs.publicEconomyJob(job,clock).rewards[id] ?? 0), 0);
  const sources = id => {
    if (!sourceCache.has(id)) sourceCache.set(id,[...catalog.recipes, ...catalog.explorations.filter(route => !catalog.fishing.routeIds.includes(route.id))]
      .filter(source => source.rewards[id] > 0 && sourceOpen(source))
      .sort((a, b) => Number(Object.keys(a.cost.items).length > 0) - Number(Object.keys(b.cost.items).length > 0)
        || a.seconds / a.rewards[id] - b.seconds / b.rewards[id]));
    return sourceCache.get(id);
  };
  function run(source, ancestors = [], requestedBatches = 1) {
    if (!sourceOpen(source)) return false;
    if (ancestors.includes(source.id)) throw new Error(`Acquisition cycle: ${ancestors.join(" -> ")} -> ${source.id}`);
    const path = [...ancestors, source.id];
    for (const [id, count] of Object.entries(source.requiredRecipes ?? {})) {
      if ((state.progression.recipes[id] ?? 0) < count) {
        const recipe = catalog.recipes.find(recipe => recipe.id === id);
        if (!state.jobs.some(job => job.recipeId === id) && run(recipe, path)) return true;
        return false;
      }
    }
    // The currently visible requirement may need several copies. Prepare a
    // bounded parallel batch of ingredients, never an unknown future order.
    const batches = Math.min(requestedBatches, source.buildingId ? slotCapacity(source.buildingId) : 1);
    for (const [id, count] of Object.entries(source.cost.items)) if (owned(id) < count * batches && need(id, count * batches, path)) return true;
    if (!held(source.cost.items) || state.wallet.coins < source.cost.coins || sourceBusy(source)) return false;
    apply(source.buildingId ? "start_production" : "start_exploration", source.id);
    production[source.id] = (production[source.id] ?? 0) + 1;
    return true;
  }
  function fishNeed(id) {
    const route = catalog.explorations.find(row => row.id === "shore");
    if (sourceBusy(route)) return false;
    const isSpecies = catalog.fishing.fish.some(fish => fish.itemId === id);
    const probability = rodId => (isSpecies ? loaded.fishing.fishingOdds : loaded.fishing.fishingClassOdds)(state,catalog.fishing,{rodId,baitId:null})
      .find(fish => fish.itemId === id)?.probability ?? 0;
    if (loaded.fishingShop.fishingShopExpired(state.fishingShop,clock)) {
      if (clock + manualMilliseconds > activeEnd) throw visitEnded;
      state.fishingShop = loaded.fishingShop.createFishingShop(state,clock,random,uuid());
      revision++; actions.open_fishing_shop = (actions.open_fishing_shop ?? 0) + 1; clock += manualMilliseconds;
      return true;
    }
    const bestOwned = [...state.fishing.ownedRods].sort((a,b) => probability(b)-probability(a))[0];
    const candidate = state.fishingShop.offers.filter(offer => offer.kind === "rod" && offer.remaining > 0 && !state.fishing.ownedRods.includes(offer.itemId)
      && probability(offer.itemId) > probability(bestOwned))
      .sort((a,b) => probability(b.itemId) - probability(a.itemId))[0];
    if (candidate && cashReserve === 0) {
      const price = loaded.fishingShop.fishingOfferUnitPrice(state,candidate,catalog,clock);
      const requiredCoins = price + (buildDefinition(nextConstruction())?.cost.coins ?? 0);
      if (state.wallet.coins >= requiredCoins) {
        apply("buy_fishing_item",candidate.id,1,price); return true;
      }
      if (ordinaryIncome(requiredCoins)) return true;
    }
    if (!probability(bestOwned)) {
      const minimumPrice = Math.min(...catalog.fishing.rods.filter(rod => rod.requiredHomeLevel <= state.buildings.home && probability(rod.id) > 0).map(rod => rod.price));
      return Number.isFinite(minimumPrice) && ordinaryIncome(minimumPrice);
    }
    // Keep this public acquisition objective until an actual cast starts: an
    // income request and a recipe must not spend a session swapping rods. Both
    // commands still pay their separate attention cost and obey the visit end.
    if (state.fishing.equippedRodId !== bestOwned) apply("equip_fishing_rod",bestOwned);
    apply("start_fishing",route.id); production.shore = (production.shore ?? 0) + 1; return true;
  }
  function buyUsefulSupply(id,count) {
    if (!buySupplies) return false;
    const shop = loaded.leaftail.leaftailShopView({...state,ownerPublicId},clock);
    const offer = shop?.offers.find(row => row.kind === "item" && row.currency === "coins" && row.itemId === id && row.remaining > 0);
    if (!offer) return false;
    // Spend only surplus above the next known building. Every supply is drawn
    // from the actual dated shop and deducted through the real purchase rule.
    const available = Math.max(0,state.wallet.coins - Math.max(cashReserve,buildDefinition(nextConstruction())?.cost.coins ?? 0));
    const quantity = Math.min(20,offer.remaining,Math.ceil((count-owned(id))/offer.quantity),Math.floor(available/offer.unitPrice));
    if (quantity <= 0) return false;
    makeRoom(quantity * offer.quantity);
    apply("buy_leaftail_item",offer.targetId,quantity,quantity*offer.unitPrice); return true;
  }
  function buyNeededRelic(id, count) {
    if (relicPolicy !== "earned" || state.buildings.home < targetHome) return false;
    const shop = loaded.leaftail.leaftailShopView({ ...state, ownerPublicId }, clock);
    const offer = shop?.offers.find(row => row.kind === "item" && row.currency === "pearls" && row.itemId === id && row.remaining > 0);
    if (!offer) return false;
    const quantity = Math.min(20, offer.remaining, Math.ceil((count - owned(id)) / offer.quantity), Math.floor(state.wallet.pearls / offer.unitPrice));
    if (quantity <= 0) return false;
    makeRoom(quantity * offer.quantity);
    apply("buy_leaftail_item", offer.targetId, quantity, quantity * offer.unitPrice);
    relicPurchases.push({ day: (clock - epoch) / (24 * hour), itemId: id, quantity: quantity * offer.quantity, paid: quantity * offer.unitPrice });
    return true;
  }
  function need(id, count, ancestors = []) {
    if (owned(id) + pending(id) >= count) return false;
    if (catalog.fishing.fish.some(fish => fish.itemId === id) || catalog.fishing.classes.some(group => group.itemId === id && id !== "fish_common")) return fishNeed(id);
    if (catalog.fishing.classes.some(group => group.itemId === id)) {
      const source = catalog.explorations.find(route => route.id === "shore");
      if (sourceBusy(source)) return false;
      apply("start_fishing", "shore"); production.shore = (production.shore ?? 0) + 1; return true;
    }
    if (catalog.rareDrops.itemIds.includes(id) && buyNeededRelic(id, count)) return true;
    if (catalog.rareDrops.itemIds.includes(id)) return state.buildings.home >= targetHome && completionGoal === "all-buildings" ? farmRelics() : false;
    if (buyUsefulSupply(id,count)) return true;
    // Every active extraction yields one item; a return after eight hours never
    // silently substitutes the removed overnight bundle.
    const source = sources(id)[0];
    return source ? run(source, ancestors, Math.ceil((count - (state.inventory[id] ?? 0) - pending(id)) / source.rewards[id])) : false;
  }
  function bundle(items) {
    for (const [id, count] of Object.entries(items)) if (need(id, count)) return true;
    return false;
  }
  function visibleIngredientUpgrade(items, visited = new Set()) {
    for (const id of Object.keys(items ?? {})) {
      if (visited.has(id)) continue;
      const path = new Set([...visited, id]);
      const candidates = [...catalog.recipes, ...catalog.explorations].filter(source => !source.retired && source.rewards[id] > 0
        && source.requiredHomeLevel <= state.buildings.home).sort((a, b) => Number(!sourceOpen(a)) - Number(!sourceOpen(b))
          || Number(Object.keys(a.cost.items).length > 0) - Number(Object.keys(b.cost.items).length > 0) || a.seconds - b.seconds);
      const source = candidates[0];
      if (!source) continue;
      const requirements = { ...source.requiredBuildings, ...(source.buildingId ? { [source.buildingId]: source.buildingLevel } : {}) };
      for (const [building, level] of Object.entries(requirements)) if ((state.buildings[building] ?? 0) < level) {
        const next = (state.buildings[building] ?? 0) + 1;
        const definition = catalog.buildings.find(row => row.id === building)?.levels.find(row => row.level === next);
        if (definition && definition.requiredHomeLevel <= state.buildings.home) return [building, next];
      }
      const child = visibleIngredientUpgrade(source.cost.items, path); if (child) return child;
    }
    return null;
  }
  function nextConstruction() {
    const plan = state.buildings.home < targetHome ? chapters[state.buildings.home] : catalog.buildings
      .filter(row => row.id !== "home" && row.id !== "warehouse").map(row => [row.id, (state.buildings[row.id] ?? 0) + 1])
      .filter(([id, level]) => level <= maximumBuildings[id] && buildingOpen(buildDefinition([id,level]).requiredBuildings));
    if (state.buildings.home >= targetHome && ["all-buildings","full","all-capacity"].includes(completionGoal) && state.buildings.warehouse < maximumBuildings.warehouse) plan.push(["warehouse",state.buildings.warehouse + 1]);
    const next = plan.find(([id, level]) => (state.buildings[id] ?? 0) < level
      && !state.jobs.some(job => job.kind === "construction" && job.targetId === id && job.targetLevel >= level));
    // Current visible order reveals its crafting prerequisites. Future chapter
    // orders, future random loot and unrevealed catches are never inspected.
    const prerequisite = visibleIngredientUpgrade(currentCourse()?.items);
    if ((!next || next[0] === "home") && prerequisite && !state.jobs.some(job => job.kind === "construction" && job.targetId === prerequisite[0])) return prerequisite;
    return next;
  }
  const buildDefinition = entry => entry && catalog.buildings.find(building => building.id === entry[0]).levels.find(level => level.level === entry[1]);

  function farmRelics() {
    // Both workers advance private clocks only through legitimately claimed work.
    // Choose longest free job when a specific random relic is still missing;
    // never inspect private remainingSeconds/itemId to time or reroll a drop.
    const routes = catalog.explorations.filter(route => sourceOpen(route) && route.cost.coins === 0 && !Object.keys(route.cost.items).length)
      .sort((a,b) => b.seconds - a.seconds);
    for (const route of routes) if (!sourceBusy(route) && run(route)) return true;
    return false;
  }
  function estimatedEffort(id, path = []) {
    if (effortCache.has(id)) return effortCache.get(id);
    if (path.includes(id)) return Infinity;
    if (catalog.fishing.fish.some(fish => fish.itemId === id) || catalog.fishing.classes.some(group => group.itemId === id)) {
      const species = catalog.fishing.fish.some(fish => fish.itemId === id);
      const odds = (species ? loaded.fishing.fishingOdds : loaded.fishing.fishingClassOdds)(state,catalog.fishing).find(fish => fish.itemId === id)?.probability ?? 0;
      return odds > 0 ? 90 / odds : Infinity;
    }
    const source = sources(id)[0];
    if (!source) return Infinity;
    const seconds = (source.seconds + Object.entries(source.cost.items).reduce((sum, [item, count]) => sum + count * estimatedEffort(item, [...path, id]), 0)) / source.rewards[id];
    effortCache.set(id,seconds);
    return seconds;
  }
  function ordinaryIncome(requiredCoins) {
    const previous = cashReserve; cashReserve = Math.max(cashReserve,requiredCoins);
    try { return earnOrdinaryIncome(requiredCoins); } finally { cashReserve = previous; }
  }
  function earnOrdinaryIncome(requiredCoins) {
    if (state.wallet.coins >= requiredCoins) return false;
    if (neighborIncome()) return true;
    const offers = food.residentOrderBoard(state, clock).offers;
    const effort = offer => Object.entries(offer.items).reduce((sum, [id, count]) => sum + count * estimatedEffort(id), 0);
    const offer = [...offers].filter(row => Number.isFinite(effort(row)) && effort(row) > 0).sort((a, b) => b.coins / effort(b) - a.coins / effort(a))[0];
    if (offer && held(offer.items)) { apply("complete_resident_order", offer.id); return true; }
    if (offer && bundle(offer.items)) return true;
    // Fishing is a sustainable NPC fallback even when a frozen board currently
    // has only slow requests. Preserve common fish still needed for the project.
    const course = currentCourse(), commonNeeded = course?.items.fish_common ?? 0;
    for (const id of Object.keys(state.inventory).filter(id => catalog.fishing.classes.some(group => group.itemId === id))) {
      const surplus = Math.max(0, state.inventory[id] - (id === "fish_common" ? commonNeeded : 0));
      if (surplus) { sell(id, surplus); return true; }
    }
    return need("fish_common", commonNeeded + 2);
  }
  function neighborIncome() {
    if (!neighbor || !loaded.market.economyMarketUnlocked(state, catalog)) return false;
    const usage = neighbor.usage(clock), pending = neighbor.listings().filter(row => row.status === "active");
    const remainingLots = neighbor.settings.maxLotsPerDay - usage.usedLots - pending.length;
    const budget = neighbor.settings.dailyBudgetCoins - usage.spentCoins - pending.reduce((sum, row) => sum + row.totalPrice, 0);
    if (remainingLots <= 0 || budget <= 0) { neighborPlan = null; return false; }
    if (!neighborPlan) {
      const maximumQuantity = Math.min(catalog.market.maxLotQuantity, Math.floor(rules.economyStorage(state, escrowItems()).capacity / 3));
      const candidates = neighbor.settings.allowedItemIds.filter(id => loaded.market.marketItemUnlocked(state, id) && Number.isFinite(estimatedEffort(id)))
        .map(itemId => {
          for (let quantity = maximumQuantity; quantity > 0; quantity--) {
            const price = neighbor.quote(itemId, quantity);
            if (price > 0 && price <= budget && loaded.market.marketMinimumPrice(itemId, quantity, catalog) <= usage.marketLimit - usage.marketSalesUsed
              && price <= neighbor.settings.maxLotCoins) {
              const proceeds = price - loaded.market.marketSaleFee(price, catalog.market.feeBps);
              return { itemId, quantity, price, rate: proceeds / (quantity * estimatedEffort(itemId)) };
            }
          }
          return null;
        }).filter(Boolean).sort((a, b) => b.rate - a.rate || b.price - a.price || a.itemId.localeCompare(b.itemId));
      neighborPlan = candidates[0] ?? null;
    }
    if (!neighborPlan) return false;
    const plan = neighborPlan;
    if (held({ [plan.itemId]: plan.quantity })) {
      // Preserve visible project/build inputs rather than liquidating a needed
      // delivery. All offered goods are real stock and remain in warehouse escrow.
      const reserve = Math.max(currentCourse()?.items[plan.itemId] ?? 0, buildDefinition(nextConstruction())?.cost.items[plan.itemId] ?? 0);
      if (owned(plan.itemId) < plan.quantity + reserve) return need(plan.itemId, plan.quantity + reserve);
      apply("create_listing", plan.itemId, plan.quantity, plan.price); neighborPlan = null;
      return true;
    }
    return need(plan.itemId, plan.quantity);
  }
  function usefulMaterialTrip() {
    if (!opportunisticRoutes || actors.economyActorConflict(state.jobs, "departure", clock)) return false;
    // A long trip must not strand a crop that will become collectible during
    // this visit. Overnight bundles remain manual single departures.
    if (state.jobs.some(job => job.collection && !job.collection.startedAt && Date.parse(job.finishesAt) <= activeEnd)) return false;
    const desired = {}, pool = { ...state.inventory };
    for (const job of state.jobs) for (const [id,count] of Object.entries(loaded.publicJobs.publicEconomyJob(job,clock).rewards)) pool[id] = (pool[id] ?? 0) + count;
    function expand(items, ancestors = []) {
      for (const [id, amount] of Object.entries(items ?? {})) {
        const covered = Math.min(amount, pool[id] ?? 0); pool[id] = (pool[id] ?? 0) - covered;
        const missing = Math.max(0, amount - covered);
        if (!missing || ancestors.includes(id)) continue;
        desired[id] = (desired[id] ?? 0) + missing;
        const source = sources(id)[0];
        if (source) expand(Object.fromEntries(Object.entries(source.cost.items).map(([item, count]) => [item, count * Math.ceil(missing / source.rewards[id])])), [...ancestors, id]);
      }
    }
    expand(currentCourse()?.items ?? buildDefinition(nextConstruction())?.cost.items ?? social.demand(clock));
    const value = id => catalog.items.find(item => item.id === id)?.baseSellPrice ?? 0;
    const candidates = catalog.explorations.filter(route => route.activity !== "mining" && !catalog.fishing.routeIds.includes(route.id)
      && sourceOpen(route) && Object.entries(route.requiredRecipes ?? {}).every(([id, count]) => (state.progression.recipes[id] ?? 0) >= count))
      .map(route => ({ route, useful: Object.entries(route.rewards).reduce((sum, [id, count]) => sum + Math.min(count, desired[id] ?? 0) * value(id), 0),
        cost: route.cost.coins + Object.entries(route.cost.items).reduce((sum, [id, count]) => sum + count * value(id), 0) }))
      .filter(row => row.useful > row.cost && Object.values(row.route.rewards).reduce((sum, count) => sum + count, 0) <= rules.economyStorage(state, escrowItems()).capacity)
      .sort((a, b) => (b.useful - b.cost) - (a.useful - a.cost));
    for (const { route, useful, cost } of candidates) {
      const previous = state.jobs.length;
      if (!run(route)) continue;
      if (state.jobs.length > previous && state.jobs.some(job => job.targetId === route.id && Date.parse(job.startedAt) >= clock - manualMilliseconds))
        materialRouteStarts.push({ route: route.id, day: (clock - epoch) / (24 * hour), usefulValue: useful, costValue: cost });
      return true;
    }
    return false;
  }

  function claimAvailableRewards() {
    if (!claimRewards || !rewardScenario) return false;
    captureCalendarSnapshots();
    return rewardScenario.claimEligible(state, clock, (reward, { id, kind }) => {
      if (clock + manualMilliseconds > activeEnd) return false;
      const before = structuredClone(state);
      makeRoom(Object.values(reward.items).reduce((sum, count) => sum + count, 0));
      if (clock + manualMilliseconds > activeEnd) return false;
      const base = structuredClone(state);
      for (const [currency, maximum] of [["coins", loaded.model.ECONOMY_MAX_BALANCE], ["pearls", loaded.model.ECONOMY_MAX_PEARLS]]) {
        const balance = state.wallet[currency] + reward[currency];
        assert(Number.isSafeInteger(balance) && balance >= 0 && balance <= maximum, `${kind}: reward exceeds ${currency} wallet capacity`);
      }
      state.wallet.coins += reward.coins; state.wallet.pearls += reward.pearls;
      rules.creditEconomyItems(state, reward.items); loaded.fishStock.creditFishStock(state, reward.items);
      rules.assertEconomyStorageTransition(base, state, escrowItems(), escrowItems());
      for (const item of new Set([...Object.keys(base.inventory), ...Object.keys(state.inventory)])) {
        const delta = (state.inventory[item] ?? 0) - (base.inventory[item] ?? 0);
        if (delta > 0) record(item).received += delta; else if (delta < 0) record(item).consumed -= delta;
      }
      recordCurrency(coinLedger, base.wallet.coins, state.wallet.coins, kind);
      recordCurrency(pearlLedger, base.wallet.pearls, state.wallet.pearls, kind);
      rewardClaims.push({ id, kind, at: new Date(clock).toISOString(), day: (clock - epoch) / (24 * hour), home: before.buildings.home, ...reward });
      revision++; actions.claim_reward = (actions.claim_reward ?? 0) + 1;
      peak = Math.max(peak, rules.economyStorage(state, escrowItems()).used + rules.economyStorage(state, escrowItems()).reserved);
      clock += manualMilliseconds;
    }).length > 0;
  }
  function buySlot() {
    if (slotPolicy === "none") return false;
    // Buy useful permanent capacity with actually claimed free pearls, in a
    // stable public policy. Never grant fictional starting currency or slots.
    const stations = ["workshop", "woodlot", "garden", "kiln", "dryer"];
    for (const targetSlots of slotPolicy === "second-only" ? [2] : [2, 3]) for (const id of stations) {
      if (!(state.buildings[id] > 0) || slotCapacity(id) >= targetSlots) continue;
      const offer = slots.productionSlotOffer(state, id);
      if (!offer || state.buildings.home < offer.requiredHomeLevel || state.wallet.pearls < offer.pricePearls
        || state.jobs.some(job => job.kind === "construction" && job.targetId === id)) continue;
      apply("buy_production_slot", id, 1, offer.pricePearls); return true;
    }
    return false;
  }
  function buyMarketCapacity() {
    if (completionGoal !== "all-capacity" || !maximumProductionSlots() || !loaded.market.economyMarketUnlocked(state, catalog)) return false;
    const offer = loaded.market.marketSlotOffer(state, catalog);
    if (!offer || state.wallet.pearls < offer.pricePearls) return false;
    apply("buy_market_slot", offer.targetId, 1, offer.pricePearls);
    return true;
  }
  function feedAvailable() {
    if (!useMeals) return false;
    const course = currentCourse();
    const meals = [...(catalog.food?.meals ?? [])].sort((a, b) => b.builderSpeedBps - a.builderSpeedBps);
    const building = state.jobs.find(job => job.kind === "construction" && !job.meal && Date.parse(job.finishesAt) > clock + 1800_000);
    for (const meal of meals) {
      const reserved = Math.max(course?.items[meal.itemId] ?? 0, buildDefinition(nextConstruction())?.cost.items[meal.itemId] ?? 0,
        ...[...catalog.recipes, ...catalog.explorations].filter(sourceOpen).map(source => source.cost.items[meal.itemId] ?? 0));
      if ((state.inventory[meal.itemId] ?? 0) <= reserved) continue;
      if (building) { apply("feed_builder", meal.itemId); return true; }
      // Optional dishes are consumed only if a hero departure fits in this visit.
      if (!food.foodState(state).heroMeal && !actors.economyActorConflict(state.jobs, "departure", clock)) {
        apply("eat_food", meal.itemId); return true;
      }
    }
    return false;
  }
  function act() {
    tickNeighbor(clock);
    const sale = neighbor?.listings().find(row => row.status === "sold" && row.sale && !row.sale.claimedAt);
    if (sale) { apply("claim_sale", sale.id); return true; }
    if (claimReady()) return true;
    if (claimAvailableRewards()) return true;
    if (buySlot()) return true;
    if (buyMarketCapacity()) return true;
    if (speedupPolicy === "earned") {
      const construction = state.jobs.find(job => job.kind === "construction" && Date.parse(job.finishesAt) > clock);
      const price = construction && rules.constructionSpeedupPrice(construction,clock);
      const reservedSlotBudget = externalSlotBudget ? ["garden","woodlot","workshop","dryer","kiln"].reduce((sum,id) =>
        sum + catalog.productionSlots.upgrades.filter(row => row.slots > slotCapacity(id)).reduce((total,row) => total + row.pricePearls,0),0) : 0;
      if (price > 0 && state.wallet.pearls - reservedSlotBudget >= price) { apply("speedup_construction",construction.id,1,price); return true; }
    }
    if (feedAvailable()) return true;
    const course = currentCourse();
    if (course && Date.parse(course.availableAt) <= clock && buildingOpen(course.requiredBuildings)
      && Object.entries(course.requiredExplorations ?? {}).every(([id, count]) => (state.progression.routes[id] ?? 0) >= count) && held(course.items)) {
      apply("complete_resident_order", course.id); return true;
    }
    const next = nextConstruction(), definition = buildDefinition(next);
    const homeReady = next?.[0] !== "home" || !course && chapterRecipesComplete();
    if (next && homeReady && held(definition.cost.items) && state.wallet.coins >= definition.cost.coins
      && buildingOpen(definition.requiredBuildings) && !state.jobs.some(job => job.kind === "construction")
      && !state.jobs.some(job => job.kind === "production" && job.targetId === next[0])
      && !(next[0] === "quarry" && state.jobs.some(job => job.actorId === "miner"))) {
      apply("start_construction", next[0]); return true;
    }
    // One ruins trip is genuinely completed and claimed before the last delivery.
    const ruins = catalog.explorations.find(route => route.id === "ancient_ruins");
    if ((state.progression.routes.ancient_ruins ?? 0) < 1 && sourceOpen(ruins)
      && !state.jobs.some(job => job.targetId === "ancient_ruins") && run(ruins)) return true;
    if (course && bundle(course.items)) return true;
    // Produce both the new harvest and its processed product at each house.
    for (const id of newRecipes[state.buildings.home]) {
      if ((state.progression.recipes[id] ?? 0) > 0 || state.jobs.some(job => job.recipeId === id)) continue;
      const source = catalog.recipes.find(recipe => recipe.id === id);
      assert(source, `the advertised house reward must be a real recipe: ${id}`);
      if (run(source)) return true;
    }
    if (next && state.wallet.coins < definition.cost.coins) {
      // Choose a valuable single extraction for spare miner time.
      // Finished income jobs are sold only after the real claim command.
      const saleValue = items => Object.entries(items).reduce((sum, [id, quantity]) => sum + quantity * catalog.localBuyer.unitPrices[id], 0);
      const shift = catalog.explorations.filter(route => route.activity === "mining" && sourceOpen(route)
        && route.cost.coins === 0 && !Object.keys(route.cost.items).length)
        .sort((a, b) => saleValue(b.rewards) - saleValue(a.rewards))[0];
      if (shift) {
        if (!sourceBusy(shift) && run(shift)) {
          incomeJobs.add(state.jobs.find(job => job.actorId === "miner").id);
          return true;
        }
      }
      if (ordinaryIncome(definition.cost.coins)) return true;
    }
    if (next && bundle(definition.cost.items)) return true;
    if (["all-recipes", "full", "all-capacity"].includes(completionGoal)) {
      for (const recipe of activeRecipes) if (sourceOpen(recipe) && !(state.progression.recipes[recipe.id] > 0)
        && !state.jobs.some(job => job.recipeId === recipe.id) && run(recipe)) return true;
    }
    if (social.act({now:clock,held,bundle,estimatedEffort,apply,dailyActiveSeconds:regularActiveMinutes*60*visitsPerDay})) return true;
    if (usefulMaterialTrip()) return true;
    if (["full", "all-capacity"].includes(completionGoal) && next?.[0] === "warehouse" && catalog.rareDrops.itemIds.some(id => owned(id) < (definition.cost.items[id] ?? 0)) && farmRelics()) return true;
    return false;
  }
  const chapterRecipesComplete = () => newRecipes[state.buildings.home].every(id => (state.progression.recipes[id] ?? 0) > 0);
  const completed = () => state.buildings.home >= targetHome && (completionGoal === "home-5" || completionGoal === "all-production" && maximumProduction()
    || completionGoal === "all-buildings" && maximumSettlement() || completionGoal === "all-recipes" && maximumProduction() && recipesComplete()
    || completionGoal === "full" && maximumSettlement() && recipesComplete() && social.complete()
    || completionGoal === "all-capacity" && maximumSettlement() && recipesComplete() && social.complete() && maximumCapacity()
    || completionGoal === "reputation" && social.complete());
  for (let visit = 0; visit < maxDays * visitsPerDay && !completed(); visit++) {
    const activeMinutes = visit === 0 ? firstVisitMinutes : regularActiveMinutes;
    const begin = epoch + visit * 24 / visitsPerDay * hour, end = begin + activeMinutes * 60000;
    windows.push({ begin, end });
    advanceClock(begin); visitCount++; activeStart = begin; activeEnd = end;
    let commands = 0;
    while (clock <= end && !completed()) {
      try { if (act()) { assert(++commands <= Math.ceil(activeMinutes * 60 / manualSeconds) + 1, "commands cannot exceed the declared visit attention budget"); continue; } } catch (error) { if (error === visitEnded) break; throw error; }
      const due = state.jobs.map(job => job.collection?.startedAt ? Date.parse(job.collection.finishesAt) : Date.parse(job.finishesAt))
        .filter(at => at > clock && at <= end);
      const neighborDue = neighbor?.nextDue(clock);
      if (neighborDue != null && neighborDue > clock && neighborDue <= end) due.push(neighborDue);
      const course = currentCourse(), availableAt = course && Date.parse(course.availableAt);
      if (availableAt > clock && availableAt <= end) due.push(availableAt);
      if (state.fishingShop && Date.parse(state.fishingShop.refreshAt) > clock && Date.parse(state.fishingShop.refreshAt) <= end) due.push(Date.parse(state.fishingShop.refreshAt));
      if (!due.length) { waits.push({ day: (clock - epoch) / (24 * hour), reason: course && Date.parse(course.availableAt) > clock ? "project-cooldown" : state.jobs.length ? "jobs-outside-visit" : "no-action", home: state.buildings.home, course: course?.id ?? null }); break; }
      advanceClock(Math.min(...due));
    }
    activeSeconds += (clock - begin) / 1000;
    onVisit?.({visit,clock,day:(clock-epoch)/(24*hour),state,revision,completed:completed()});
  }
  const neighborSnapshot = { enabled: Boolean(neighbor), sales: neighborSales, escrow: escrowItems(),
    pendingProceeds: neighbor?.listings().filter(row => row.status === "sold" && !row.sale?.claimedAt).reduce((sum, row) => sum + row.sale.proceedsCoins, 0) ?? 0,
    settings: neighbor ? { maxLotsPerDay: neighbor.settings.maxLotsPerDay, dailyBudgetCoins: neighbor.settings.dailyBudgetCoins,
      maxLotCoins: neighbor.settings.maxLotCoins, firstDelaySeconds: neighbor.settings.firstDelaySeconds, staleAfterSeconds: neighbor.settings.staleAfterSeconds } : null };
  return { state, neighborPolicy, neighbor: neighborSnapshot, productionStations, marketSlots: loaded.market.marketSlotCount(state, catalog), relicPolicy, ownerPublicId, relicPurchases, marketSlotPurchases, calendarSnapshots, activeRecipeIds: activeRecipes.map(row=>row.id), clock, revision, peak, constructionCoins, courseCoins, repeatCoins, saleCoins, courses, builds,
    actions, flow, production, catches, repeatOrders, visitCount, activeSeconds, constructionSeconds, berryClaims, checkpoints, windows, startingCoins, startingItems, regularActiveMinutes, completed: completed(), rewardClaims, slotPurchases, mealUses, storagePressure, waits, coinLedger, pearlLedger, seed, slotPolicy, firstVisitMinutes, manualSeconds, externalSlotBudget, visitsPerDay, completionGoal, maxDays, speedupPolicy, speedups, milestones, social: social.snapshot(clock), socialMode, buySupplies, useMeals, opportunisticRoutes, materialRouteStarts, concurrencyPeaks, claimedWorkSeconds, readyIdleSeconds };
  } finally { neighbor?.close(); }
}



export function summarizeProgression(result) {
  const sum = object => Object.values(object).reduce((a, b) => a + b, 0);
  for (const [name, ledger] of Object.entries({ coins: result.coinLedger, pearls: result.pearlLedger }))
    assert.equal(result.state.wallet[name], ledger.initial + sum(ledger.credits) - sum(ledger.debits), `${name} conservation`);
  for (const [id, counts] of Object.entries(result.flow)) {
    assert.equal(counts.received - counts.consumed - counts.sold - (counts.escrow ?? 0), result.state.inventory[id] ?? 0, `${id} conservation`);
    assert.equal(counts.escrow ?? 0, result.neighbor.escrow[id] ?? 0, `${id}: item ledger must equal actual market escrow`);
  }
  for (const [id, quantity] of Object.entries(result.neighbor.escrow))
    assert.equal(quantity, result.flow[id]?.escrow ?? 0, `${id}: every escrowed item was actually produced`);
  return { completed: result.completed, seed: result.seed, regularMinutes: result.regularActiveMinutes, firstMinutes: result.firstVisitMinutes,
    slotPolicy: result.slotPolicy, neighborPolicy: result.neighborPolicy, neighbor: result.neighbor, relicPolicy: result.relicPolicy, ownerPublicId: result.ownerPublicId, visitsPerDay: result.visitsPerDay, completionGoal: result.completionGoal, maxDays: result.maxDays, speedupPolicy: result.speedupPolicy, buySupplies: result.buySupplies, useMeals: result.useMeals, opportunisticRoutes: result.opportunisticRoutes, socialMode: result.socialMode, social: result.social, speedups: result.speedups,
    allProductionDays: result.milestones.allProductionAt == null ? null : (result.milestones.allProductionAt - epoch)/(24*hour),
    allBuildingsDays: result.milestones.allBuildingsAt == null ? null : (result.milestones.allBuildingsAt - epoch)/(24*hour),
    allRecipesDays: result.milestones.allRecipesAt == null ? null : (result.milestones.allRecipesAt - epoch)/(24*hour), materialRouteStarts: result.materialRouteStarts, concurrencyPeaks: result.concurrencyPeaks, claimedWorkSeconds: result.claimedWorkSeconds, readyIdleSeconds: result.readyIdleSeconds, manualSeconds: result.manualSeconds, externalSlotBudget: result.externalSlotBudget, home5Days: result.milestones.home5At == null ? null : (result.milestones.home5At - epoch)/(24*hour),
    reputationMaxDays: result.milestones.reputationMaxAt == null ? null : (result.milestones.reputationMaxAt - epoch)/(24*hour),
    elapsedDays: (result.clock - epoch) / (24 * hour), activeHours: result.activeSeconds / 3600, manualHours: result.revision * result.manualSeconds / 3600, productionWaitWithinVisitsHours: Math.max(0, result.activeSeconds - result.revision * result.manualSeconds) / 3600, commandCount: result.revision,
    storagePeak: result.peak, storagePressureCount: result.storagePressure.length, coinLedger: result.coinLedger, pearlLedger: result.pearlLedger,
    productionSlots: Object.fromEntries(result.productionStations.map(id => [id, result.state.productionSlots?.[id] ?? 1])),
    marketSlots: result.marketSlots, relicPurchases: result.relicPurchases, marketSlotPurchases: result.marketSlotPurchases,
    allProductionSlotsDays: result.milestones.allProductionSlotsAt == null ? null : (result.milestones.allProductionSlotsAt - epoch)/(24*hour),
    allCapacityDays: result.milestones.allCapacityAt == null ? null : (result.milestones.allCapacityAt - epoch)/(24*hour),
    calendarSnapshots: result.calendarSnapshots,
    slotPurchases: result.slotPurchases, rewardClaims: result.rewardClaims, mealUses: result.mealUses,
    checkpoints: result.checkpoints.map(p => ({ ...p, day: (p.at - epoch) / (24 * hour) })), actions: result.actions,
    production: result.production, builderHours: result.constructionSeconds / 3600,
    recipesCompleted: result.activeRecipeIds.filter(id => result.state.progression.recipes[id] > 0).length,
    missingRecipes: result.activeRecipeIds.filter(id => !(result.state.progression.recipes[id] > 0)),
    buildings: result.state.buildings, coins: result.state.wallet.coins, pearls: result.state.wallet.pearls,
    lastWaits: result.waits.slice(-5), nextCourse: result.state.stageOrders, inventory: result.state.inventory };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loaded = await loadProgressionRules(process.env.ECONOMY_SOURCE_ROOT);
  try { console.log(JSON.stringify(summarizeProgression(simulateProgression(loaded, { regularActiveMinutes: Number(process.env.ACTIVE_MINUTES ?? 20), seed: Number(process.env.SIM_SEED ?? 1), claimRewards: true })), null, 2)); }
  finally { await loaded.close(); }
}
