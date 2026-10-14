import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

// Read-only player policy: every state change uses the shipped TS domain rules.
// No market, achievement reward claims, legacy grant, admin command,
// backdating or tap income. The default has no pearls; an explicit research
// scenario may start with a declared budget, project only the pearl component,
// or claim full daily bundles using the real calendar, home tier and inventory
// transition rules. The full reward projection is not an HTTP/receipt integration test.
const root = fileURLToPath(new URL("..", import.meta.url));
const epoch = Date.parse("2026-10-05T00:00:00Z"), day = 86400, hour = 3600;
const firstVisit = 7 * hour;
export const journeyOrder = ["woodlot:1", "dryer:1", "workshop:1", "home:2", "quarry:1", "warehouse:2", "quarry:2", "kiln:1", "home:3", "garden:2", "woodlot:2", "kiln:2", "dryer:2", "workshop:2", "garden:3", "warehouse:3", "woodlot:3", "quarry:3", "kiln:3", "workshop:3", "dryer:3", "home:4", "bridge:1", "lighthouse:1", "woodlot:4", "quarry:4", "kiln:4", "workshop:4", "warehouse:4", "garden:4", "dryer:4", "home:5", "warehouse:5", "garden:5", "woodlot:5", "quarry:5", "kiln:5", "workshop:5", "dryer:5"];
export const DEFAULT_JOURNEY_RARE_SEED = 0x0672026;

/** Preserve the existing comparison policy; maximum storage is an explicit
 * additional goal, rather than a prerequisite for home five. */
export function journeyConstructionOrder(catalog, completionGoal = "base-tier-5") {
  assert(["home-5", "base-tier-5", "all-current-buildings"].includes(completionGoal), "Invalid research completion goal");
  const expansions = catalog.buildings.flatMap(building => building.levels
    .filter(level => level.level > 5).map(level => `${building.id}:${level.level}`));
  // The full-storage goal pays for optional capacity before accumulating the
  // final workshop chains. Every purchase still checks authored prerequisites
  // through the ordinary command and pays with earned relic inventory.
  const storageIndex = journeyOrder.indexOf("warehouse:5") + 1;
  const order = completionGoal === "home-5" ? journeyOrder.slice(0, journeyOrder.indexOf("home:5") + 1)
    : completionGoal === "all-current-buildings" ? [...journeyOrder.slice(0, storageIndex), ...expansions,
      ...journeyOrder.slice(storageIndex)] : [...journeyOrder];
  for (const key of order) {
    const [id, level] = key.split(":");
    assert(catalog.buildings.find(building => building.id === id)?.levels.some(entry => entry.level === Number(level)), `Unknown research goal ${key}`);
  }
  if (completionGoal === "all-current-buildings") for (const building of catalog.buildings) {
    assert(order.includes(`${building.id}:${building.levels.at(-1).level}`), `Missing current maximum tier for ${building.id}`);
  }
  return order;
}

/** Research-only reproducible entropy, independent of commands and fish seeds. */
export function createJourneyRareRandom(seed) {
  assert(Number.isSafeInteger(seed) && seed > 0 && seed <= 0xffffffff, "Invalid research relic seed");
  let value = seed, draws = 0;
  return {
    integer(exclusiveMaximum) {
      assert(Number.isSafeInteger(exclusiveMaximum) && exclusiveMaximum > 0 && exclusiveMaximum <= 0xffffffff, "Invalid relic draw bound");
      // Xorshift32 visits all nonzero uint32 values. Subtract one and reject
      // the incomplete tail before modulo; a full period has equal bin sizes.
      const limit = Math.floor(0xffffffff / exclusiveMaximum) * exclusiveMaximum;
      for (;;) {
        value ^= value << 13; value ^= value >>> 17; value ^= value << 5; value >>>= 0; draws++;
        const sample = value - 1;
        if (sample < limit) return sample % exclusiveMaximum;
      }
    },
    snapshot: () => ({ value, draws }),
    restore(snapshot) { value = snapshot.value; draws = snapshot.draws; },
    get draws() { return draws; },
  };
}

export async function loadJourneyRules() {
  const vite = await createServer({ appType: "custom", configFile: false, root, logLevel: "silent",
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
  const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
  const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
  const actorAvailability = await vite.ssrLoadModule("/features/economy/domain/actor-availability.ts");
  const progressionRewards = await vite.ssrLoadModule("/features/game/progression-rewards.ts");
  const fishing = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
  const stageOrders = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
  return { rules, actorAvailability, progressionRewards, fishing, stageOrders, catalog: model.economyCatalog,
    walletLimits: { coins: model.ECONOMY_MAX_BALANCE, pearls: model.ECONOMY_MAX_PEARLS }, close: () => vite.close() };
}

export function simulateJourney({ rules, actorAvailability, progressionRewards, fishing, stageOrders, catalog, walletLimits }, mode, maxDays = 1600, policy = {}) {
  const { prepareNextConstruction = false, preserveFutureCraftedStock = false, jointBatchPlanning = false,
    pearlBudget = 0, constructionSpeedups = true, buyProductionSlots = false,
    parallelProductionPlanning = buyProductionSlots, dailyPearlsOnly = false, dailyRewards = false, rareSeed = DEFAULT_JOURNEY_RARE_SEED,
    completionGoal = "base-tier-5" } = policy;
  assert(Number.isSafeInteger(pearlBudget) && pearlBudget >= 0 && pearlBudget <= 1_000_000_000 * (catalog.pearlScale ?? catalog.currencyScale ?? 1), "Invalid research pearl budget");
  assert(["active16h", "visits2", "visits3"].includes(mode), "Invalid visit policy");
  assert(!(dailyRewards && dailyPearlsOnly), "Choose complete gifts or pearl-only projection, not both");
  const constructionOrder = journeyConstructionOrder(catalog, completionGoal);
  const rareRandom = createJourneyRareRandom(rareSeed);
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.wallet.pearls = pearlBudget; // Hypothetical confirmed initial balance; not an earning or payment API.
  const initialCoins = state.wallet.coins, coinSpending = {};
  let tutorialRevenue = 0;
  let clock = firstVisit, sequence = 0, castSequence = 0, targetIndex = 0, commands = 0, revenue = 0, storageRecovery = 0, lastFailure = null, pearlsSpent = 0;
  const milestones = {}, events = [], failures = {}, actions = {}, productionRecipes = {}, explorationRoutes = {}, items = new Map(catalog.items.map(item => [item.id, item]));
  const itemFlow = Object.fromEntries(Object.entries(state.inventory).map(([id, quantity]) => [id,
    { initial: quantity, received: 0, sold: 0, productionInputs: 0, expeditionInputs: 0, constructionInputs: 0, orderInputs: 0 }]));
  const productionStations = [...new Set(catalog.recipes.map(recipe => recipe.buildingId))].filter(id => id !== "quarry");
  const slotPurchases = [], maximumProductionJobs = {};
  let dailyState = dailyPearlsOnly || dailyRewards ? progressionRewards.initialDailyRewardState() : null, dailyClaims = 0, dailyPearls = 0;
  let dailyCoins = 0, dailyDeferredForStorage = 0;
  const dailyItems = {}, dailyClaimRows = [];
  const slotCapacity = id => state.productionSlots?.[id] ?? 1;
  const productionAvailable = id => !state.jobs.some(job => job.kind === "construction" && job.targetId === id)
    && state.jobs.filter(job => job.kind === "production" && job.targetId === id).length < slotCapacity(id);
  const relicIds = catalog.items.filter(item => item.category === "special").map(item => item.id);
  const relicReceived = Object.fromEntries(relicIds.map(id => [id, 0]));
  const relicSpent = Object.fromEntries(relicIds.map(id => [id, 0]));
  const stageRelics = Object.fromEntries(relicIds.map(id => [id, 0]));
  const relicFinds = []; let eligibleExplorationSeconds = 0;
  const actorWorkSeconds = { miner: 0, exploration: 0, collection: 0 };
  const isActive = mode === "active16h", visits = mode === "visits2" ? [7, 19] : [7, 15, 23];
  const gap = isActive ? 1 : mode === "visits2" ? 12 * hour : 8 * hour;
  const uuid = () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
  const eligible = d => (state.buildings.home ?? 1) >= d.requiredHomeLevel && Object.entries(d.requiredBuildings ?? {}).every(([id, level]) => (state.buildings[id] ?? 0) >= level)
    && (!d.buildingId || state.buildings[d.buildingId] >= d.buildingLevel)
    && Object.entries(d.requiredRecipes ?? {}).every(([id, count]) => (state.progression.recipes[id] ?? 0) >= count);
  const courseTerms = () => state.tutorialOrder?.ingredientsClaimed && !state.tutorialOrder.completed
    ? state.tutorialOrder.terms : stageOrders.stageResidentOrder(state, catalog);
  const command = (action, targetId, quantity = 1, totalPrice = 0) => {
    if (action === "start_exploration" && catalog.fishing.routeIds.includes(targetId)) action = "start_fishing";
    const next = structuredClone(state);
    const entropy = rareRandom.snapshot();
    const previousJob = action === "claim_job" ? state.jobs.find(job => job.id === targetId) : null;
    try {
      let generated = 0;
      // The nth cast gets the same server-generated seed in every scenario.
      // Extra speedup requests cannot shift the future catch sample path.
      const jobId = () => action === "start_fishing" && ++generated === 2
        ? `00000000-0000-4000-9000-${(castSequence + 1).toString(16).padStart(12, "0")}` : uuid();
      rules.applyEconomyCommand(next, { requestId: uuid(), ownerPublicId: "0000-0000-0001", expectedRevision: commands,
        action, targetId, quantity, totalPrice }, epoch + clock * 1000, jobId, {}, rareRandom.integer);
      if (action === "start_fishing" && generated >= 2) castSequence++;
      if (action === "sell" || action === "sell_fish") revenue += next.wallet.coins - state.wallet.coins;
      if (action === "complete_resident_order") {
        tutorialRevenue += next.wallet.coins - state.wallet.coins;
        for (const id of relicIds) stageRelics[id] += Math.max(0, (next.inventory[id] ?? 0) - (state.inventory[id] ?? 0));
      }
      if (next.wallet.coins < state.wallet.coins) coinSpending[action] = (coinSpending[action] ?? 0) + state.wallet.coins - next.wallet.coins;
      if (action === "speedup_construction") {
        const job = state.jobs.find(j => j.id === targetId);
        pearlsSpent += state.wallet.pearls - next.wallet.pearls;
        milestones[`${job.targetId}:${job.targetLevel}`] = (clock - firstVisit) / day;
        events.push({ day: Number(((clock - firstVisit) / day).toFixed(4)), building: `${job.targetId}:${job.targetLevel}`, coins: next.wallet.coins });
      }
      if (action === "buy_production_slot") {
        const paid = state.wallet.pearls - next.wallet.pearls;
        pearlsSpent += paid;
        slotPurchases.push({ day: Number(((clock - firstVisit) / day).toFixed(4)), building: targetId,
          houseLevel: state.buildings.home, slots: next.productionSlots[targetId], pricePearls: paid });
      }
      if (action === "claim_job" && previousJob?.rareDrop) {
        assert.equal(previousJob.kind, "exploration", "Only completed exploration jobs accrue relic time");
        eligibleExplorationSeconds += previousJob.rareDrop.seconds;
        for (const id of relicIds) if (previousJob.rewards[id]) {
          assert.equal(previousJob.rareDrop.itemId, id);
          assert.equal(next.inventory[id] - (state.inventory[id] ?? 0), previousJob.rewards[id]);
          relicReceived[id] += previousJob.rewards[id];
          relicFinds.push({ day: Number(((clock - firstVisit) / day).toFixed(4)), route: previousJob.targetId,
            itemId: id, eligibleExplorationHours: Number((eligibleExplorationSeconds / hour).toFixed(4)) });
        }
      }
      if (action === "claim_job" && previousJob) {
        const duration = (Date.parse(previousJob.finishesAt) - Date.parse(previousJob.startedAt)) / 1000;
        if (previousJob.kind === "exploration") actorWorkSeconds[previousJob.actorId === "miner" ? "miner" : "exploration"] += duration;
        if (actorAvailability.isQuarryProduction(previousJob)) actorWorkSeconds.exploration += duration;
        if (previousJob.collection?.startedAt) actorWorkSeconds.collection += previousJob.collection.seconds;
      }
      if (action === "start_construction") {
        const job = next.jobs.find(j => j.kind === "construction" && j.targetId === targetId);
        for (const id of relicIds) if (job.cost.items[id]) {
          assert.equal((state.inventory[id] ?? 0) - (next.inventory[id] ?? 0), job.cost.items[id]);
          relicSpent[id] += job.cost.items[id];
        }
      }
      for (const id of new Set([...Object.keys(state.inventory), ...Object.keys(next.inventory)])) {
        const difference = (next.inventory[id] ?? 0) - (state.inventory[id] ?? 0);
        if (!difference) continue;
        const flow = itemFlow[id] ??= { initial: 0, received: 0, sold: 0, productionInputs: 0, expeditionInputs: 0, constructionInputs: 0, orderInputs: 0 };
        if (difference > 0) flow.received += difference;
        else if (action === "sell" || action === "sell_fish") flow.sold -= difference;
        else if (action === "start_production") flow.productionInputs -= difference;
        else if (action === "start_exploration" || action === "start_fishing") flow.expeditionInputs -= difference;
        else if (action === "start_construction") flow.constructionInputs -= difference;
        else if (action === "complete_resident_order") flow.orderInputs -= difference;
        else assert.fail(`Unaccounted inventory debit: ${action} ${id}`);
      }
      Object.assign(state, next); commands++; actions[action] = (actions[action] ?? 0) + 1;
      if (parallelProductionPlanning) for (const id of productionStations) {
        const count = state.jobs.filter(job => job.kind === "production" && job.targetId === id).length;
        assert(count <= slotCapacity(id), "The planner must respect purchased capacity including unclaimed jobs");
        maximumProductionJobs[id] = Math.max(maximumProductionJobs[id] ?? 0, count);
      }
      if (action === "start_production") productionRecipes[targetId] = (productionRecipes[targetId] ?? 0) + quantity;
      if (action === "start_exploration" || action === "start_fishing") explorationRoutes[targetId] = (explorationRoutes[targetId] ?? 0) + 1;
      lastFailure = null; return true;
    } catch (error) {
      rareRandom.restore(entropy); // A rejected transition cannot shift the sample path.
      if (error instanceof assert.AssertionError) throw error;
      lastFailure = error.code ?? error.message; failures[lastFailure] = (failures[lastFailure] ?? 0) + 1; return false;
    }
  };
  const cash = rewards => Object.entries(rewards).reduce((sum, [id, amount]) => sum + (fishing.fishClassForItem(id, catalog.fishing)
    ? items.get(id).baseSellPrice * amount : rules.economyLocalSellPrice(items.get(id).baseSellPrice, amount, catalog.localBuyer, id)), 0);
  const projectedEligible = d => {
    if (!prepareNextConstruction) return eligible(d);
    // Forecast only for ingredient planning. Commands still use current levels.
    const predicted = { ...state.buildings };
    for (const j of state.jobs.filter(j => j.kind === "construction")) predicted[j.targetId] = j.targetLevel;
    return (predicted.home ?? 1) >= d.requiredHomeLevel && Object.entries(d.requiredBuildings ?? {}).every(([id, level]) => (predicted[id] ?? 0) >= level)
      && (!d.buildingId || predicted[d.buildingId] >= d.buildingLevel)
      && Object.entries(d.requiredRecipes ?? {}).every(([id, count]) => (state.progression.recipes[id] ?? 0) >= count);
  };
  const sources = itemId => [...catalog.recipes, ...catalog.explorations.filter(route => !Object.keys(route.cost.items).length && !route.cost.coins)
    .map(route => catalog.fishing.routeIds.includes(route.id) && fishing.fishClassForItem(itemId, catalog.fishing)
      && fishing.fishingClassOdds(state, catalog.fishing).some(group => group.itemId === itemId && group.probability > 0)
      // A desired class is only a possible catch. No pending draw is credited:
      // the demand is recomputed from actually claimed inventory after each trip.
      ? { ...route, rewards: { [itemId]: route.rewards.fish } } : route)]
    .filter(d => projectedEligible(d) && d.rewards[itemId] > 0)
    .sort((a, b) => {
      const rate = d => {
        const batch = d.buildingId ? d.maxBatch : 1;
        return isActive ? d.rewards[itemId] / d.seconds : d.rewards[itemId] * batch / Math.max(1, Math.ceil(d.seconds * batch / gap));
      };
      return rate(b) - rate(a) || Number(!b.buildingId) - Number(!a.buildingId);
    });
  function goal() {
    while (targetIndex < constructionOrder.length) {
      const [id, levelText] = constructionOrder[targetIndex].split(":");
      if (state.buildings[id] >= Number(levelText)) { targetIndex++; continue; }
      return { id, key: constructionOrder[targetIndex], ...catalog.buildings.find(b => b.id === id).levels.find(l => l.level === Number(levelText)) };
    }
  }
  function demand(target) {
    const needed = {}, planned = { ...state.inventory }, recipeWants = new Map(); let needsRelic = false;
    // The paid current upgrade must never manufacture its cost twice.
    if (state.jobs.some(j => j.kind === "construction" && j.targetId === target.id)) {
      if (!prepareNextConstruction) return { needed, recipeWants, needsRelic };
      const key = constructionOrder[targetIndex + 1];
      if (!key) return { needed, recipeWants, needsRelic };
      const [id, level] = key.split(":");
      target = { id, key, ...catalog.buildings.find(b => b.id === id).levels.find(l => l.level === Number(level)) };
    }
    for (const job of state.jobs) {
      // Newly started research jobs use this catalog. Plan only publicly known
      // guaranteed output: never inspect pending species or the private relic type.
      const rewards = { ...job.rewards };
      for (const id of relicIds) delete rewards[id];
      if (job.fishing) {
        // Every fish is random now. No class stock is guaranteed before claim.
        for (const id of Object.keys(rewards)) if (fishing.fishClassForItem(id, catalog.fishing)) delete rewards[id];
      }
      for (const [id, quantity] of Object.entries(rewards)) planned[id] = (planned[id] ?? 0) + quantity;
    }
    const jointSources = new Map();
    if (jointBatchPlanning && !isActive) {
      for (const r of [...catalog.recipes, ...catalog.explorations.filter(route => route.activity === "mining")].filter(r => projectedEligible(r) && Object.keys(r.rewards).length > 1 && r.seconds <= gap)) {
        const covered = Object.entries(r.rewards).filter(([id]) => (target.cost.items[id] ?? 0) > (planned[id] ?? 0));
        const separateClaims = covered.reduce((sum, [id, amount]) => {
          const basic = [...catalog.recipes, ...catalog.explorations.filter(route => route.activity === "mining")].find(b => projectedEligible(b) && Object.keys(b.rewards).length === 1 && b.rewards[id] > 0 && b.seconds < 14400);
          return sum + (basic ? Math.ceil(Math.min(amount, target.cost.items[id] - (planned[id] ?? 0)) / basic.rewards[id] / (basic.maxBatch ?? 1)) : 0);
        }, 0);
        // The unit is completed orders/visits, not a dimensionless rarity score.
        // Inputs and every output are still processed by the ordinary recursion.
        if (covered.length >= 2 && separateClaims > 1) for (const [id] of covered) jointSources.set(id, r);
      }
    }
    const expand = (id, amount, path = []) => {
      needed[id] = (needed[id] ?? 0) + amount;
      const owned = Math.min(planned[id] ?? 0, amount); planned[id] = (planned[id] ?? 0) - owned;
      if (owned >= amount) return;
      // A rare requirement has no recipe or guaranteed route reward. The
      // player must complete ordinary eligible explorations until it is found.
      if (items.get(id)?.category === "special") { needsRelic = true; return; }
      assert(!path.includes(id), `Policy cycle: ${path.join(" -> ")} -> ${id}`);
      const source = jointSources.get(id) ?? sources(id)[0];
      if (!source && prepareNextConstruction) return;
      assert(source, `No source for ${id} at ${target.key}`);
      const batches = Math.ceil((amount - owned) / source.rewards[id]);
      recipeWants.set(source.id, (recipeWants.get(source.id) ?? 0) + batches);
      if (jointBatchPlanning) for (const [output, quantity] of Object.entries(source.rewards))
        planned[output] = (planned[output] ?? 0) + quantity * batches - (output === id ? amount - owned : 0);
      for (const [input, quantity] of Object.entries(source.cost.items)) expand(input, quantity * batches, [...path, id]);
    };
    for (const [id, amount] of Object.entries(target.cost.items)) expand(id, amount);
    const tutorial = courseTerms();
    if (tutorial) for (const [id, amount] of Object.entries(tutorial.items)) {
      if ((planned[id] ?? 0) >= amount || sources(id).length) expand(id, amount);
      else needed[id] = (needed[id] ?? 0) + amount;
    }
    // A project's route gate is satisfied only by a real successful claim.
    // Schedule its paid departure once, reserve its inputs, and never credit a
    // pending job as a completed exploration or reveal its private rare reward.
    for (const [id, count] of Object.entries(tutorial?.requiredExplorations ?? {})) {
      if ((state.progression.routes[id] ?? 0) >= count || state.jobs.some(job => job.kind === "exploration" && job.targetId === id)) continue;
      const route = catalog.explorations.find(route => route.id === id);
      assert(route, `Unknown required research route ${id}`);
      if (!projectedEligible(route)) continue;
      recipeWants.set(id, 1);
      for (const [input, quantity] of Object.entries(route.cost.items)) expand(input, quantity);
    }
    return { needed, recipeWants, needsRelic };
  }
  const sellExcess = needed => {
    let sold = false;
    const storage = rules.economyStorage(state);
    const processingRoom = Math.max(Math.ceil(storage.capacity * .15), ...state.jobs.map(job => Object.values(job.rewards).reduce((sum, quantity) => sum + quantity, 0)));
    const preserveManufactured = preserveFutureCraftedStock && storage.available >= processingRoom;
    const starterReserve = {};
    if (state.buildings.home === 1) for (const key of ["woodlot:1", "dryer:1", "workshop:1", "home:2"]) {
      const [id, text] = key.split(":"), level = Number(text);
      if ((state.buildings[id] ?? 0) >= level || state.jobs.some(job => job.kind === "construction" && job.targetId === id && job.targetLevel === level)) continue;
      const cost = catalog.buildings.find(building => building.id === id).levels.find(spec => spec.level === level).cost;
      for (const [item, quantity] of Object.entries(cost.items)) starterReserve[item] = (starterReserve[item] ?? 0) + quantity;
    }
    for (const [id, amount] of Object.entries(state.inventory)) {
      if (items.get(id)?.category === "special") continue;
      const futureUses = preserveManufactured && constructionOrder.slice(targetIndex).some(key => {
        const [building, level] = key.split(":");
        return catalog.buildings.find(b => b.id === building).levels.find(l => l.level === Number(level)).cost.items[id] > 0;
      });
      const manufactured = futureUses && catalog.recipes.some(r => r.rewards[id] > 0 && Object.keys(r.cost.items).length > 0);
      const quantity = amount - (manufactured ? amount : Math.max(needed[id] ?? 0, starterReserve[id] ?? 0));
      if (quantity > 0 && cash({ [id]: quantity }) > 0) sold = command(fishing.fishClassForItem(id, catalog.fishing) ? "sell_fish" : "sell", id, quantity) || sold;
    }
    return sold;
  };
  const enoughGatheredInput = (definition, plan, target) => {
    if (state.buildings.home < 2 || definition.cost.coins || Object.keys(definition.cost.items).length
      || Object.keys(definition.rewards).length !== 1) return false;
    const id = Object.keys(definition.rewards)[0];
    if (relicIds.includes(id) || fishing.fishClassForItem(id, catalog.fishing)) return false;
    const ownedOrPending = (state.inventory[id] ?? 0) + state.jobs.reduce((sum, job) =>
      sum + (job.fishing || job.rareDrop?.itemId === id ? 0 : (job.rewards[id] ?? 0)), 0);
    if (ownedOrPending < (target.cost.items[id] ?? 0)) return false;
    const consumers = catalog.recipes.filter(recipe => eligible(recipe) && plan.recipeWants.has(recipe.id) && (recipe.cost.items[id] ?? 0) > 0);
    return consumers.length > 0 && ownedOrPending >= Math.max(...consumers.map(recipe => recipe.cost.items[id]));
  };
  function act() {
    let target = goal(); if (!target) return;
    if (dailyPearlsOnly || dailyRewards) {
      const gift = progressionRewards.dailyRewardView(dailyState, epoch + clock * 1000, state.buildings.home ?? 1);
      if (gift.claimable) {
        const next = structuredClone(state);
        let accepted = true;
        if (dailyRewards) {
          // Match creditDevProgressionReward's atomic wallet/item/storage checks.
          // No escrow exists in this no-market policy. Failed capacity keeps the
          // entire gift and calendar untouched for a later attempt.
          for (const currency of ["coins", "pearls"]) {
            assert(next.wallet[currency] + gift.reward[currency] <= walletLimits[currency], "Research wallet reached capacity");
            next.wallet[currency] += gift.reward[currency];
          }
          rules.creditEconomyItems(next, gift.reward.items);
          try { rules.assertEconomyStorageTransition(state, next); }
          catch (error) {
            if (error.code !== "ECONOMY_STORAGE_FULL" && error.code !== "ECONOMY_CAPACITY") throw error;
            accepted = false; dailyDeferredForStorage++;
          }
        } else next.wallet.pearls += gift.reward.pearls;
        if (accepted) {
          const creditedItems = Object.fromEntries(Object.entries(next.inventory).map(([id, quantity]) =>
            [id, quantity - (state.inventory[id] ?? 0)]).filter(([, quantity]) => quantity > 0));
          Object.assign(state, next);
          dailyPearls += gift.reward.pearls; dailyClaims++;
          if (dailyRewards) {
            dailyCoins += gift.reward.coins;
            for (const [id, quantity] of Object.entries(creditedItems)) {
              dailyItems[id] = (dailyItems[id] ?? 0) + quantity;
              (itemFlow[id] ??= { initial: 0, received: 0, sold: 0, productionInputs: 0, expeditionInputs: 0, constructionInputs: 0, orderInputs: 0 }).received += quantity;
            }
            dailyClaimRows.push({ day: Number(((clock - firstVisit) / day).toFixed(4)), at: new Date(epoch + clock * 1000).toISOString(),
              homeLevel: state.buildings.home ?? 1, step: gift.step, reward: structuredClone(gift.reward) });
          }
          dailyState = progressionRewards.afterDailyClaim(dailyState, epoch + clock * 1000);
        }
      }
    }
    let plan = demand(target);
    sellExcess(plan.needed);
    // Receive quarry/expedition results before beginning the required collection.
    for (const job of [...state.jobs].sort((a, b) => Number(a.targetId === "garden") - Number(b.targetId === "garden"))) {
      if (clock * 1000 + epoch < Date.parse(job.finishesAt)) continue;
      if (job.collection && !job.collection.startedAt) {
        if (!actorAvailability.economyActorConflict(state.jobs, "collection", epoch + clock * 1000)) command("start_collection", job.id);
        continue;
      }
      if (job.collection && clock * 1000 + epoch < Date.parse(job.collection.finishesAt)) continue;
      if (!command("claim_job", job.id) && lastFailure === "ECONOMY_STORAGE_FULL") {
        // Release unrelated surplus first, and only the amount required for this
        // delivery. Replacing an entire needed raw stack with the same incoming
        // stack can otherwise starve a recipe's minimum ingredient quantity.
        const headroom = Object.values(job.rewards).reduce((sum, quantity) => sum + quantity, 0) - rules.economyStorage(state).available;
        const expendable = Object.entries(state.inventory).filter(([id, amount]) => amount > 0 && cash({ [id]: amount }) > 0)
          .map(([id, amount]) => ({ id, amount, surplus: Math.max(0, amount - (plan.needed[id] ?? 0)) }))
          .sort((a, b) => Number(b.surplus > 0) - Number(a.surplus > 0) || b.surplus - a.surplus
            || Number((target.cost.items[a.id] ?? 0) > 0) - Number((target.cost.items[b.id] ?? 0) > 0) || b.amount - a.amount)[0];
        if (expendable) {
          const fish = fishing.fishClassForItem(expendable.id, catalog.fishing);
          const minimum = fish ? 1 : rules.economyLocalSaleMinimumQuantity(items.get(expendable.id).baseSellPrice, catalog.localBuyer, expendable.id);
          const quantity = Math.min(expendable.amount, Math.max(minimum, Math.min(headroom, expendable.surplus || expendable.amount)));
          if (command(fish ? "sell_fish" : "sell", expendable.id, quantity)) { storageRecovery++; command("claim_job", job.id); }
        }
      }
      if (job.kind === "construction" && state.buildings[job.targetId] === job.targetLevel) {
        const key = `${job.targetId}:${job.targetLevel}`; milestones[key] = (clock - firstVisit) / day;
        events.push({ day: Number(((clock - firstVisit) / day).toFixed(4)), building: key, coins: state.wallet.coins });
      }
    }
    for (;;) {
      const tutorial = courseTerms();
      if (!tutorial || Date.parse(tutorial.availableAt ?? "1970-01-01T00:00:00.000Z") > epoch + clock * 1000
        || Object.entries(tutorial.requiredBuildings ?? {}).some(([id, level]) => (state.buildings[id] ?? 0) < level)
        || Object.entries(tutorial.requiredExplorations ?? {}).some(([id, count]) => (state.progression.routes[id] ?? 0) < count)
        || !rules.canAffordEconomy(state, { coins: 0, items: tutorial.items })) break;
      assert(command("complete_resident_order", tutorial.id), `Earned tutorial request failed: ${lastFailure}`);
    }
    target = goal(); if (!target) return;
    if (buyProductionSlots) for (const id of productionStations) {
      if (!(state.buildings[id] > 0) || state.jobs.some(job => job.kind === "construction" && job.targetId === id)) continue;
      for (const upgrade of catalog.productionSlots.upgrades) {
        if (upgrade.slots !== slotCapacity(id) + 1 || state.buildings.home < upgrade.requiredHomeLevel || state.wallet.pearls < upgrade.pricePearls) continue;
        assert(command("buy_production_slot", id), `Eligible slot purchase failed: ${lastFailure}`);
      }
    }
    plan = demand(target); sellExcess(plan.needed);
    const mineReserved = state.jobs.some(job => job.kind === "exploration" && catalog.explorations.find(route => route.id === job.targetId)?.requiredBuildings.quarry);
    if (eligible(target) && rules.canAffordEconomy(state, target.cost) && !(target.id === "home" && courseTerms()) && !(target.id === "quarry" && mineReserved)
      && !state.jobs.some(j => j.kind === "construction" || j.kind === "production" && j.targetId === target.id)) command("start_construction", target.id);
    const construction = state.jobs.find(j => j.kind === "construction");
    if (constructionSpeedups && pearlBudget > 0 && construction) {
      const price = rules.constructionSpeedupPrice(construction, epoch + clock * 1000);
      if (price > 0 && price <= state.wallet.pearls) command("speedup_construction", construction.id, 1, price);
    }
    target = goal(); if (!target) return;
    plan = demand(target);
    // Staggered parallel jobs can otherwise refill forever and prevent an
    // already affordable station upgrade. Finish that station's existing jobs
    // without admitting fresh work until its construction can begin.
    const drainingStation = parallelProductionPlanning && eligible(target) && rules.canAffordEconomy(state, target.cost)
      && !state.jobs.some(job => job.kind === "construction") ? target.id : null;
    const busy = new Set(state.jobs.filter(j => ["production", "construction"].includes(j.kind)).map(j => j.targetId));
    const available = d => eligible(d) && !(d.requiredBuildings?.quarry && busy.has("quarry"));
    const freeDefinitions = [...catalog.recipes, ...catalog.explorations].filter(d => available(d) && !Object.keys(d.cost.items).length && !d.cost.coins);
    const candidates = [...catalog.recipes, ...catalog.explorations].filter(available).sort((a, b) => (plan.recipeWants.get(b.id) ?? 0) - (plan.recipeWants.get(a.id) ?? 0));
    const actorBusy = actorId => actorId === "miner"
      ? actorAvailability.economyMinerConflict(state.jobs, epoch + clock * 1000)
      : actorAvailability.economyActorConflict(state.jobs, "departure", epoch + clock * 1000);
    for (const d of candidates) {
      // Re-read guaranteed pending output after every additional slot. A stale
      // recipe demand would manufacture the same construction inputs twice.
      for (;;) {
        if (!plan.recipeWants.has(d.id)) break;
        // A shared station must gather the counterpart ingredient before
        // trying to stock every raw unit of the entire future craft chain.
        if (enoughGatheredInput(d, plan, target)) break;
        if (d.buildingId && (parallelProductionPlanning ? !productionAvailable(d.buildingId) || d.buildingId === drainingStation : busy.has(d.buildingId))) break;
        if ((!d.buildingId || d.buildingId === "quarry") && actorBusy(d.activity === "mining" ? "miner" : "mochlik")) break;
        const wanted = Math.min(d.maxBatch ?? 1, plan.recipeWants.get(d.id));
        const affordable = Array.from({ length: wanted }, (_, i) => wanted - i).find(q => rules.canAffordEconomy(state, d.cost, q));
        if (!affordable) break;
        if (!command(d.buildingId ? "start_production" : "start_exploration", d.id, affordable)) break;
        if (d.buildingId) busy.add(d.buildingId);
        if (parallelProductionPlanning) plan = demand(target);
        if (!parallelProductionPlanning || !d.buildingId) break;
      }
    }
    // Idle gathering earns sale money; the miner and Mochlik have independent queues.
    // Eligible completed routes advance their saved actor's relic clock.
    // Costly processing is reserved for the next upgrade. This is not an optimum.
    const income = d => {
      let expectedCash = cash(d.rewards);
      if (catalog.fishing.routeIds.includes(d.id)) {
        // Use visible class odds for route choice, never inspect a pending private draw.
        const perFish = fishing.fishingClassOdds(state, catalog.fishing).reduce((sum, group) =>
          sum + group.probability * items.get(group.itemId).baseSellPrice, 0);
        const { fish: count, ...otherRewards } = d.rewards;
        expectedCash = cash(otherRewards) + count * perFish;
      }
      return expectedCash / (isActive ? d.seconds : Math.max(1, Math.ceil(d.seconds / gap)));
    };
    for (const id of ["garden", "woodlot", "miner", "mochlik"]) {
      const station = id !== "miner" && id !== "mochlik";
      if (!station && id === "mochlik" && courseTerms()) continue; // Optional departures must not block the introductory berry collection.
      if (station ? (parallelProductionPlanning ? !productionAvailable(id) || id === drainingStation : busy.has(id)) : actorBusy(id)) continue;
      const needsRelic = !station && plan.needsRelic && (state.buildings.home ?? 1) >= (catalog.rareDrops?.requiredHomeLevel ?? Infinity);
      // The player gathers construction inputs above, and earns sale money only
      // until the next visible upgrade is funded. Relic work remains necessary
      // even when its wallet cost is already covered.
      if (!needsRelic && state.wallet.coins >= target.cost.coins) continue;
      const d = freeDefinitions.filter(d => station ? d.buildingId === id
        : !d.buildingId && (d.activity === "mining" ? "miner" : "mochlik") === id).sort((a, b) => {
        // When a visible upgrade lacks a relic, prefer free routes that bank
        // more authored travel time between visits. Never inspect the private
        // clock or pending type, never skip real costs or building requirements.
        if (needsRelic) {
          const travel = route => isActive ? route.seconds : route.seconds / Math.max(1, Math.ceil(route.seconds / gap));
          const difference = travel(b) - travel(a);
          if (difference) return difference;
        }
        return income(b) - income(a);
      })[0];
      if (!d) continue;
      do {
        if (!command(d.buildingId ? "start_production" : "start_exploration", d.id)) break;
        if (d.buildingId) busy.add(d.buildingId);
      } while (parallelProductionPlanning && d.buildingId && productionAvailable(d.buildingId));
    }
  }
  const nextVisit = at => {
    const base = Math.floor(at / day) * day;
    for (const h of visits) if (base + h * hour > at + .001) return base + h * hour;
    return base + day + visits[0] * hour;
  };
  while (clock < maxDays * day && goal()) {
    const sessionEnd = isActive ? Math.floor(clock / day) * day + 23 * hour : clock + 600;
    let operations = 0;
    while (clock <= sessionEnd && goal()) {
      const before = commands; act(); operations++;
      const future = state.jobs.flatMap(j => [Date.parse(j.finishesAt), j.collection?.finishesAt ? Date.parse(j.collection.finishesAt) : null])
        .filter(t => t && t > epoch + clock * 1000).map(t => (t - epoch) / 1000);
      const next = Math.min(...future);
      if (next <= sessionEnd) clock = next;
      else if (commands !== before && operations < 5) continue;
      else break;
      assert(operations < 100000, "Policy stalled in one session");
    }
    if (!goal()) break;
    if (isActive) clock = Math.floor(clock / day) * day + day + 7 * hour;
    else clock = nextVisit(sessionEnd);
  }
  const targetBuildingLevels = {};
  for (const key of constructionOrder) {
    const [id, level] = key.split(":"); targetBuildingLevels[id] = Number(level);
  }
  const report = { catalogVersion: catalog.version, currencyScale: catalog.currencyScale ?? 1, pearlScale: catalog.pearlScale ?? catalog.currencyScale ?? 1, mode,
    completionGoal, targetBuildingLevels, finalBuildingLevels: { ...state.buildings }, complete: !goal(), elapsedDays: Number(((clock - firstVisit) / day).toFixed(3)),
    homeDays: Object.fromEntries([2, 3, 4, 5].map(l => [l, milestones[`home:${l}`] == null ? null : Number(milestones[`home:${l}`].toFixed(3))])),
    commands, saleRevenue: revenue, coinFlow: { initial: initialCoins, sales: revenue, gifts: dailyCoins, orders: tutorialRevenue,
      spendingByAction: coinSpending, remaining: state.wallet.coins }, storageRecovery, failures, actions, stoppedAt: goal()?.key ?? null, milestones: events,
    ...(pearlBudget > 0 || dailyPearlsOnly || dailyRewards ? { pearlBudget, pearlsSpent, pearlsRemaining: state.wallet.pearls } : {}),
    ...(dailyPearlsOnly ? { dailyPearlProjection: { claims: dailyClaims, pearlsReceived: dailyPearls,
      omitted: ["daily_reward_coins", "daily_reward_items", "daily_reward_relics", "achievement_rewards"] } } : {}),
    ...(dailyRewards ? { dailyRewards: { claims: dailyClaims, coinsReceived: dailyCoins, pearlsReceived: dailyPearls,
      itemsReceived: dailyItems, storageDeferrals: dailyDeferredForStorage, claimRows: dailyClaimRows } } : {}),
    ...(parallelProductionPlanning ? { productionSlots: { constructionSpeedups, purchases: slotPurchases,
      maximumProductionJobs, finalCapacity: Object.fromEntries(productionStations.map(id => [id, slotCapacity(id)])) } } : {}),
    ...(jointBatchPlanning ? { productionRecipes } : {}),
    explorationRoutes, itemFlow: Object.fromEntries(Object.entries(itemFlow).map(([id, flow]) => [id, { ...flow, remaining: state.inventory[id] ?? 0 }])),
    actorWorkHours: Object.fromEntries(Object.entries(actorWorkSeconds).map(([kind, seconds]) => [kind, Number((seconds / hour).toFixed(4))])),
    excludedIncome: [...(dailyRewards ? [] : [dailyPearlsOnly ? "daily_reward_coins_and_items" : "daily_rewards"]), "achievement_rewards", "taps", "player_market", "legacy_grants"],
    rareMaterials: { seed: rareSeed, generator: "xorshift32-rejection-v1", draws: rareRandom.draws,
      eligibleExplorationHours: Number((eligibleExplorationSeconds / hour).toFixed(4)), received: relicReceived,
      stageRewards: stageRelics,
      spentOnConstruction: relicSpent, inventory: Object.fromEntries(relicIds.map(id => [id, state.inventory[id] ?? 0])), finds: relicFinds } };
  assert.equal(state.wallet.pearls, pearlBudget + dailyPearls - pearlsSpent); assert(state.wallet.coins >= 0);
  assert.equal(state.wallet.coins, initialCoins + revenue + dailyCoins + tutorialRevenue - Object.values(coinSpending).reduce((sum, value) => sum + value, 0), "Coins must reconcile across gifts, orders, sales and actual paid commands");
  assert(Object.values(state.inventory).every(q => Number.isSafeInteger(q) && q >= 0));
  for (const [id, flow] of Object.entries(itemFlow))
    assert.equal(flow.initial + flow.received - flow.sold - flow.productionInputs - flow.expeditionInputs - flow.constructionInputs - flow.orderInputs, state.inventory[id] ?? 0, `${id}: inventory flow must conserve starting and earned items`);
  for (const id of relicIds) assert.equal(relicReceived[id] + stageRelics[id] + (dailyItems[id] ?? 0) - relicSpent[id], state.inventory[id] ?? 0, "Exploration, project and gifted relics must be conserved through construction");
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const flags = process.argv.slice(2);
  assert(flags.every(flag => flag === "--all-current-buildings" || flag === "--home-5") && flags.length <= 1, "Use --all-current-buildings or --home-5");
  const completionGoal = flags[0] === "--all-current-buildings" ? "all-current-buildings" : flags[0] === "--home-5" ? "home-5" : "base-tier-5";
  const loaded = await loadJourneyRules();
  try { console.log(JSON.stringify(["active16h", "visits2", "visits3"].map(mode => simulateJourney(loaded, mode, 1600, { completionGoal })), null, 2)); }
  finally { await loaded.close(); }
}
