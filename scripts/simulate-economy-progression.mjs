import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";
import { createRewardScenario } from "./lib/economy-reward-scenario.mjs";

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
    slots: "features/economy/domain/production-slots.ts", rewards: "features/game/progression-rewards.ts", achievements: "features/game/achievement-progress.ts",
    welcome: "features/mailbox/welcome.ts", money: "features/economy/domain/money.ts", fishStock: "features/economy/domain/fish-stock.ts" };
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
    claimRewards = true, useMeals = true, completionGoal = "home-5", manualSeconds = 2, externalSlotBudget = 0 } = options;
  const random = createRandom(seed);
  const rewardScenario = loaded.createRewards?.();
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  const startingCoins = state.wallet.coins, startingItems = { ...state.inventory };
  let clock = epoch, sequence = 0, revision = 0, peak = 0, constructionCoins = 0, courseCoins = 0, repeatCoins = 0, saleCoins = 0, visitCount = 0;
  let constructionSeconds = 0, activeStart = epoch, activeEnd = epoch, activeSeconds = 0;
  const courses = [], builds = [], actions = {}, flow = {}, production = {}, catches = {}, repeatOrders = [];
  const berryClaims = [], checkpoints = [], windows = [];
  const incomeJobs = new Set();
  for (const [id, count] of Object.entries(startingItems)) flow[id] = { received: count, consumed: 0, sold: 0 };
  const uuid = () => `${(seed >>> 0).toString(16).padStart(8, "0")}-0000-4000-9000-${(++sequence).toString(16).padStart(12, "0")}`;
  const rewardClaims = [], slotPurchases = [], mealUses = [], storagePressure = [], waits = [];
  const concurrencyPeaks = {}, claimedWorkSeconds = {}, readyIdleSeconds = {};
  const coinLedger = { initial: state.wallet.coins, credits: {}, debits: {} };
  const pearlLedger = { initial: state.wallet.pearls, credits: {}, debits: {} };
  assert([0, 3500].includes(externalSlotBudget), "Only explicit zero or all-slot sensitivity budget is supported");
  if (externalSlotBudget) { state.wallet.pearls += externalSlotBudget; pearlLedger.credits.externalSlotBudget = externalSlotBudget; }
  const visitEnded = Symbol("scheduled visit ended");
  const manualMilliseconds = manualSeconds * 1000;
  const recordCurrency = (ledger, before, after, source) => { const delta = after - before;
    if (delta) { const bucket = delta > 0 ? ledger.credits : ledger.debits; bucket[source] = (bucket[source] ?? 0) + Math.abs(delta); } };
  const slotCapacity = id => slots.productionSlotCount(state, id);
  const record = id => flow[id] ??= { received: 0, consumed: 0, sold: 0 };
  const currentCourse = () => tutorial.tutorialResidentOrder(state) ?? stages.stageResidentOrder(state);
  const held = items => Object.entries(items).every(([id, count]) => (state.inventory[id] ?? 0) >= count);
  const buildingOpen = requirements => Object.entries(requirements ?? {}).every(([id, level]) => (state.buildings[id] ?? 0) >= level);
  const sourceOpen = source => !source.retired && state.buildings.home >= source.requiredHomeLevel && buildingOpen(source.requiredBuildings)
    && (!source.buildingId || (state.buildings[source.buildingId] ?? 0) >= source.buildingLevel);
  // Maximum interval and living resin are fixed trusted server entropy. Neither
  // core nor crystal can be supplied by this sampler, so the chapter must supply both.
  const rareRandom = random;
  function apply(action, targetId, quantity = 1) {
    if (clock + manualMilliseconds > activeEnd) throw visitEnded;
    assert(clock >= activeStart && clock <= activeEnd, "manual actions only happen during a scheduled visit");
    const before = structuredClone(state), offer = action === "complete_resident_order" ? currentCourse() : null;
    rules.applyEconomyCommand(state, { requestId: uuid(), ownerPublicId: "0000-0000-0001", expectedRevision: revision,
      action, targetId, quantity, totalPrice: 0 }, clock, uuid, {}, rareRandom);
    recordCurrency(coinLedger, before.wallet.coins, state.wallet.coins, action);
    recordCurrency(pearlLedger, before.wallet.pearls, state.wallet.pearls, action);
    if (action === "buy_production_slot") slotPurchases.push({ day: (clock - epoch) / (24 * hour), station: targetId, slots: slotCapacity(targetId), paid: before.wallet.pearls - state.wallet.pearls, home: state.buildings.home });
    if (["eat_food", "feed_builder"].includes(action)) mealUses.push({ day: (clock - epoch) / (24 * hour), action, item: targetId });
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
      if (job?.kind === "construction" && ["home", "bridge", "lighthouse"].includes(job.targetId))
        checkpoints.push({ target: job.targetId, level: job.targetLevel, home: state.buildings.home, at: clock, coins: state.wallet.coins });
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
      else if (delta < 0) record(id)[["sell", "sell_fish"].includes(action) ? "sold" : "consumed"] -= delta;
      if (action === "claim_job" && delta > 0 && catalog.fishing.classes.some(group => group.itemId === id))
        catches[id] = (catches[id] ?? 0) + delta;
    }
    const storage = rules.economyStorage(state); peak = Math.max(peak, storage.used);
    assert(storage.used <= storage.capacity, `${action}:${targetId} exceeds the warehouse`);
    assert(state.jobs.filter(job => job.kind === "construction").length <= 1);
    for (const id of ["garden", "woodlot", "workshop", "dryer", "kiln"]) {
      const occupied = state.jobs.filter(job => job.kind === "production" && job.targetId === id).length;
      concurrencyPeaks[id] = Math.max(concurrencyPeaks[id] ?? 0, occupied);
      assert(occupied <= slotCapacity(id));
    }
    for (const actor of ["miner", "mochlik"])
      assert(state.jobs.filter(job => job.kind === "exploration" && job.actorId === actor).length <= 1);
    clock += manualMilliseconds;
  }
  function sell(id, count) {
    while (count > 0) {
      const quantity = Math.min(catalog.maxBatch, count);
      apply(catalog.fishing.classes.some(group => group.itemId === id) ? "sell_fish" : "sell", id, quantity);
      count -= quantity;
    }
  }
  function makeRoom(quantity) {
    const needed = Math.max(0, rules.economyStorage(state).used + quantity - rules.economyStorage(state).capacity);
    if (!needed) return;
    storagePressure.push({ day: (clock - epoch) / (24 * hour), needed, capacity: rules.economyStorage(state).capacity });
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
    protect(currentCourse()?.items); protect(buildDefinition(nextConstruction())?.cost.items);
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
      makeRoom(Object.values(job.rewards).reduce((sum, count) => sum + count, 0));
      apply("claim_job", job.id); changed = true;
      if (incomeJobs.delete(job.id)) {
        // Keep a small working reserve and sell the claimed single item
        // through an actual NPC command when it exceeds that reserve.
        const reserve = { stone: 3, ore: 3, clay: 1, sand: 1 };
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
  const pending = id => state.jobs.reduce((sum, job) => sum + (job.rewards[id] ?? 0), 0);
  const sources = id => [...catalog.recipes, ...catalog.explorations.filter(route => !catalog.fishing.routeIds.includes(route.id))]
    .filter(source => source.rewards[id] > 0 && sourceOpen(source))
    .sort((a, b) => Number(Object.keys(a.cost.items).length > 0) - Number(Object.keys(b.cost.items).length > 0)
      || a.seconds / a.rewards[id] - b.seconds / b.rewards[id]);
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
    for (const [id, count] of Object.entries(source.cost.items)) if ((state.inventory[id] ?? 0) < count * batches && need(id, count * batches, path)) return true;
    if (!held(source.cost.items) || sourceBusy(source)) return false;
    apply(source.buildingId ? "start_production" : "start_exploration", source.id);
    production[source.id] = (production[source.id] ?? 0) + 1;
    return true;
  }
  function need(id, count, ancestors = []) {
    if ((state.inventory[id] ?? 0) + pending(id) >= count) return false;
    if (catalog.fishing.classes.some(group => group.itemId === id)) {
      const source = catalog.explorations.find(route => route.id === "shore");
      if (sourceBusy(source)) return false;
      apply("start_fishing", "shore"); production.shore = (production.shore ?? 0) + 1; return true;
    }
    if (catalog.rareDrops.itemIds.includes(id)) return false;
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
    const next = chapters[state.buildings.home].find(([id, level]) => (state.buildings[id] ?? 0) < level
      && !state.jobs.some(job => job.kind === "construction" && job.targetId === id && job.targetLevel >= level));
    // Current visible order reveals its crafting prerequisites. Future chapter
    // orders, future random loot and unrevealed catches are never inspected.
    const prerequisite = visibleIngredientUpgrade(currentCourse()?.items);
    if ((!next || next[0] === "home") && prerequisite && !state.jobs.some(job => job.kind === "construction" && job.targetId === prerequisite[0])) return prerequisite;
    return next;
  }
  const buildDefinition = entry => entry && catalog.buildings.find(building => building.id === entry[0]).levels.find(level => level.level === entry[1]);

  function estimatedEffort(id, path = []) {
    if (path.includes(id)) return Infinity;
    if (catalog.fishing.classes.some(group => group.itemId === id)) return id === "fish_common" ? 100 : 1500;
    const source = sources(id)[0];
    if (!source) return Infinity;
    return (source.seconds + Object.entries(source.cost.items).reduce((sum, [item, count]) => sum + count * estimatedEffort(item, [...path, id]), 0)) / source.rewards[id];
  }
  function ordinaryIncome(requiredCoins) {
    if (state.wallet.coins >= requiredCoins) return false;
    const offers = food.residentOrderBoard(state, clock).offers;
    const effort = offer => Object.entries(offer.items).reduce((sum, [id, count]) => sum + count * estimatedEffort(id), 0);
    const offer = [...offers].sort((a, b) => b.coins / effort(b) - a.coins / effort(a))[0];
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
  function claimAvailableRewards() {
    if (!claimRewards || !rewardScenario) return false;
    return rewardScenario.claimEligible(state, clock, (reward, { id, kind }) => {
      if (clock + manualMilliseconds > activeEnd) return false;
      const before = structuredClone(state);
      makeRoom(Object.values(reward.items).reduce((sum, count) => sum + count, 0));
      if (clock + manualMilliseconds > activeEnd) return false;
      const base = structuredClone(state);
      state.wallet.coins += reward.coins; state.wallet.pearls += reward.pearls;
      rules.creditEconomyItems(state, reward.items); loaded.fishStock.creditFishStock(state, reward.items);
      rules.assertEconomyStorageTransition(base, state);
      for (const item of new Set([...Object.keys(base.inventory), ...Object.keys(state.inventory)])) {
        const delta = (state.inventory[item] ?? 0) - (base.inventory[item] ?? 0);
        if (delta > 0) record(item).received += delta; else if (delta < 0) record(item).consumed -= delta;
      }
      recordCurrency(coinLedger, base.wallet.coins, state.wallet.coins, kind);
      recordCurrency(pearlLedger, base.wallet.pearls, state.wallet.pearls, kind);
      rewardClaims.push({ id, kind, at: new Date(clock).toISOString(), day: (clock - epoch) / (24 * hour), home: before.buildings.home, ...reward });
      revision++; actions.claim_reward = (actions.claim_reward ?? 0) + 1;
      peak = Math.max(peak, rules.economyStorage(state).used);
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
      apply("buy_production_slot", id); return true;
    }
    return false;
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
    if (claimReady()) return true;
    if (claimAvailableRewards()) return true;
    if (buySlot()) return true;
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
    return false;
  }
  const chapterRecipesComplete = () => newRecipes[state.buildings.home].every(id => (state.progression.recipes[id] ?? 0) > 0);
  const completed = () => state.buildings.home === 5 && (completionGoal === "home-5" || !nextConstruction() && chapterRecipesComplete() && state.jobs.length === 0);
  for (let visit = 0; visit < maxDays * 3 && !completed(); visit++) {
    const activeMinutes = visit === 0 ? firstVisitMinutes : regularActiveMinutes;
    const begin = epoch + visit * 8 * hour, end = begin + activeMinutes * 60000;
    windows.push({ begin, end });
    clock = begin; visitCount++; activeStart = begin; activeEnd = end;
    let commands = 0;
    while (clock <= end && !completed()) {
      try { if (act()) { assert(++commands < 500, "a short visit has bounded actual commands"); continue; } } catch (error) { if (error === visitEnded) break; throw error; }
      const due = state.jobs.map(job => job.collection?.startedAt ? Date.parse(job.collection.finishesAt) : Date.parse(job.finishesAt))
        .filter(at => at > clock && at <= end);
      const course = currentCourse(), availableAt = course && Date.parse(course.availableAt);
      if (availableAt > clock && availableAt <= end) due.push(availableAt);
      if (!due.length) { waits.push({ day: (clock - epoch) / (24 * hour), reason: course && Date.parse(course.availableAt) > clock ? "project-cooldown" : state.jobs.length ? "jobs-outside-visit" : "no-action", home: state.buildings.home, course: course?.id ?? null }); break; }
      clock = Math.min(...due);
    }
    activeSeconds += (clock - begin) / 1000;
  }
  return { state, clock, revision, peak, constructionCoins, courseCoins, repeatCoins, saleCoins, courses, builds,
    actions, flow, production, catches, repeatOrders, visitCount, activeSeconds, constructionSeconds, berryClaims, checkpoints, windows, startingCoins, startingItems, regularActiveMinutes, completed: completed(), rewardClaims, slotPurchases, mealUses, storagePressure, waits, coinLedger, pearlLedger, seed, slotPolicy, firstVisitMinutes, manualSeconds, externalSlotBudget, concurrencyPeaks, claimedWorkSeconds, readyIdleSeconds };
}



export function summarizeProgression(result) {
  const sum = object => Object.values(object).reduce((a, b) => a + b, 0);
  for (const [name, ledger] of Object.entries({ coins: result.coinLedger, pearls: result.pearlLedger }))
    assert.equal(result.state.wallet[name], ledger.initial + sum(ledger.credits) - sum(ledger.debits), `${name} conservation`);
  for (const [id, counts] of Object.entries(result.flow))
    assert.equal(counts.received - counts.consumed - counts.sold, result.state.inventory[id] ?? 0, `${id} conservation`);
  return { completed: result.completed, seed: result.seed, regularMinutes: result.regularActiveMinutes, firstMinutes: result.firstVisitMinutes,
    slotPolicy: result.slotPolicy, concurrencyPeaks: result.concurrencyPeaks, claimedWorkSeconds: result.claimedWorkSeconds, readyIdleSeconds: result.readyIdleSeconds, manualSeconds: result.manualSeconds, externalSlotBudget: result.externalSlotBudget, home5Days: result.checkpoints.find(p => p.target === "home" && p.level === 5) ? (result.checkpoints.find(p => p.target === "home" && p.level === 5).at - epoch) / (24 * hour) : null,
    elapsedDays: (result.clock - epoch) / (24 * hour), activeHours: result.activeSeconds / 3600, manualHours: result.revision * result.manualSeconds / 3600, productionWaitWithinVisitsHours: Math.max(0, result.activeSeconds - result.revision * result.manualSeconds) / 3600, commandCount: result.revision,
    storagePeak: result.peak, storagePressureCount: result.storagePressure.length, coinLedger: result.coinLedger, pearlLedger: result.pearlLedger,
    slotPurchases: result.slotPurchases, rewardClaims: result.rewardClaims, mealUses: result.mealUses,
    checkpoints: result.checkpoints.map(p => ({ ...p, day: (p.at - epoch) / (24 * hour) })), actions: result.actions,
    production: result.production, builderHours: result.constructionSeconds / 3600,
    buildings: result.state.buildings, coins: result.state.wallet.coins, pearls: result.state.wallet.pearls,
    lastWaits: result.waits.slice(-5), nextCourse: result.state.stageOrders, inventory: result.state.inventory };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loaded = await loadProgressionRules(process.env.ECONOMY_SOURCE_ROOT);
  try { console.log(JSON.stringify(summarizeProgression(simulateProgression(loaded, { regularActiveMinutes: Number(process.env.ACTIVE_MINUTES ?? 20), seed: Number(process.env.SIM_SEED ?? 1), claimRewards: true })), null, 2)); }
  finally { await loaded.close(); }
}
