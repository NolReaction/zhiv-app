import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

// Read-only player policy: every state change uses the shipped TS domain rules.
// No market, achievement reward claims, legacy grant, admin command,
// backdating or tap income. The default has no pearls; an explicit research
// scenario may start with a declared budget or project only the pearl component
// of daily gifts using their real claim calendar. Relics use actual exploration jobs.
const root = fileURLToPath(new URL("..", import.meta.url));
const epoch = Date.parse("2026-10-05T00:00:00Z"), day = 86400, hour = 3600;
const firstVisit = 7 * hour;
export const journeyOrder = ["woodlot:1", "workshop:1", "home:2", "quarry:1", "kiln:1", "garden:2", "warehouse:2", "woodlot:2", "quarry:2", "kiln:2", "dryer:1", "dryer:2", "workshop:2", "home:3", "garden:3", "warehouse:3", "woodlot:3", "quarry:3", "kiln:3", "workshop:3", "dryer:3", "home:4", "woodlot:4", "quarry:4", "kiln:4", "workshop:4", "warehouse:4", "garden:4", "dryer:4", "home:5", "garden:5", "warehouse:5", "woodlot:5", "quarry:5", "kiln:5", "workshop:5", "dryer:5"];
export const DEFAULT_JOURNEY_RARE_SEED = 0x0672026;

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
  const rules = await vite.ssrLoadModule("/features/economy/rules.ts");
  const model = await vite.ssrLoadModule("/features/economy/model.ts");
  const actorAvailability = await vite.ssrLoadModule("/features/economy/actor-availability.ts");
  const progressionRewards = await vite.ssrLoadModule("/features/game/progression-rewards.ts");
  return { rules, actorAvailability, progressionRewards, catalog: model.economyCatalog, close: () => vite.close() };
}

export function simulateJourney({ rules, actorAvailability, progressionRewards, catalog }, mode, maxDays = 1600, policy = {}) {
  const { prepareNextConstruction = false, preserveFutureCraftedStock = false, jointBatchPlanning = false,
    pearlBudget = 0, constructionSpeedups = true, buyProductionSlots = false,
    parallelProductionPlanning = buyProductionSlots, dailyPearlsOnly = false, rareSeed = DEFAULT_JOURNEY_RARE_SEED } = policy;
  assert(Number.isSafeInteger(pearlBudget) && pearlBudget >= 0 && pearlBudget <= 1_000_000_000 * (catalog.pearlScale ?? catalog.currencyScale ?? 1), "Invalid research pearl budget");
  assert(["active16h", "visits2", "visits3"].includes(mode), "Invalid visit policy");
  const rareRandom = createJourneyRareRandom(rareSeed);
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.wallet.pearls = pearlBudget; // Hypothetical confirmed initial balance; not an earning or payment API.
  let clock = firstVisit, sequence = 0, castSequence = 0, targetIndex = 0, commands = 0, revenue = 0, storageRecovery = 0, lastFailure = null, pearlsSpent = 0;
  const milestones = {}, events = [], failures = {}, actions = {}, productionRecipes = {}, explorationRoutes = {}, itemFlow = {}, items = new Map(catalog.items.map(item => [item.id, item]));
  const productionStations = [...new Set(catalog.recipes.map(recipe => recipe.buildingId))].filter(id => id !== "quarry");
  const slotPurchases = [], maximumProductionJobs = {};
  let dailyState = dailyPearlsOnly ? progressionRewards.initialDailyRewardState() : null, dailyClaims = 0, dailyPearls = 0;
  const slotCapacity = id => state.productionSlots?.[id] ?? 1;
  const productionAvailable = id => !state.jobs.some(job => job.kind === "construction" && job.targetId === id)
    && state.jobs.filter(job => job.kind === "production" && job.targetId === id).length < slotCapacity(id);
  const relicIds = catalog.items.filter(item => item.category === "special").map(item => item.id);
  const relicReceived = Object.fromEntries(relicIds.map(id => [id, 0]));
  const relicSpent = Object.fromEntries(relicIds.map(id => [id, 0]));
  const relicFinds = []; let eligibleExplorationSeconds = 0;
  const miningRoutes = new Set(catalog.explorations.filter(route => route.activity === "mining").map(route => route.id));
  const actorWorkSeconds = { quarry: 0, exploration: 0, collection: 0 };
  const isActive = mode === "active16h", visits = mode === "visits2" ? [7, 19] : [7, 15, 23];
  const gap = isActive ? 1 : mode === "visits2" ? 12 * hour : 8 * hour;
  const uuid = () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
  const eligible = d => (state.buildings.home ?? 1) >= d.requiredHomeLevel && Object.entries(d.requiredBuildings ?? {}).every(([id, level]) => (state.buildings[id] ?? 0) >= level)
    && (!d.buildingId || state.buildings[d.buildingId] >= d.buildingLevel);
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
        if (previousJob.kind === "exploration") actorWorkSeconds[miningRoutes.has(previousJob.targetId) ? "quarry" : "exploration"] += duration;
        if (actorAvailability.isQuarryProduction(previousJob)) actorWorkSeconds.quarry += duration;
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
        const flow = itemFlow[id] ??= { received: 0, sold: 0, productionInputs: 0, expeditionInputs: 0, constructionInputs: 0 };
        if (difference > 0) flow.received += difference;
        else if (action === "sell" || action === "sell_fish") flow.sold -= difference;
        else if (action === "start_production") flow.productionInputs -= difference;
        else if (action === "start_exploration" || action === "start_fishing") flow.expeditionInputs -= difference;
        else if (action === "start_construction") flow.constructionInputs -= difference;
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
  const cash = rewards => Object.entries(rewards).reduce((sum, [id, amount]) => sum + (catalog.fishing.fish.some(f => f.itemId === id)
    ? items.get(id).baseSellPrice * amount : rules.economyLocalSellPrice(items.get(id).baseSellPrice, amount, catalog.localBuyer)), 0);
  const projectedEligible = d => {
    if (!prepareNextConstruction) return eligible(d);
    // Forecast only for ingredient planning. Commands still use current levels.
    const predicted = { ...state.buildings };
    for (const j of state.jobs.filter(j => j.kind === "construction")) predicted[j.targetId] = j.targetLevel;
    return (predicted.home ?? 1) >= d.requiredHomeLevel && Object.entries(d.requiredBuildings ?? {}).every(([id, level]) => (predicted[id] ?? 0) >= level)
      && (!d.buildingId || predicted[d.buildingId] >= d.buildingLevel);
  };
  const sources = itemId => [...catalog.recipes, ...catalog.explorations.filter(route => !Object.keys(route.cost.items).length && !route.cost.coins)]
    .filter(d => projectedEligible(d) && d.rewards[itemId] > 0)
    .sort((a, b) => {
      const rate = d => {
        const batch = d.buildingId ? d.maxBatch : 1;
        return isActive ? d.rewards[itemId] / d.seconds : d.rewards[itemId] * batch / Math.max(1, Math.ceil(d.seconds * batch / gap));
      };
      return rate(b) - rate(a) || Number(!b.buildingId) - Number(!a.buildingId);
    });
  function goal() {
    while (targetIndex < journeyOrder.length) {
      const [id, levelText] = journeyOrder[targetIndex].split(":");
      if (state.buildings[id] >= Number(levelText)) { targetIndex++; continue; }
      return { id, key: journeyOrder[targetIndex], ...catalog.buildings.find(b => b.id === id).levels.find(l => l.level === Number(levelText)) };
    }
  }
  function demand(target) {
    const needed = {}, planned = { ...state.inventory }, recipeWants = new Map(); let needsRelic = false;
    // The paid current upgrade must never manufacture its cost twice.
    if (state.jobs.some(j => j.kind === "construction" && j.targetId === target.id)) {
      if (!prepareNextConstruction) return { needed, recipeWants, needsRelic };
      const key = journeyOrder[targetIndex + 1];
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
        for (const fish of catalog.fishing.fish) delete rewards[fish.itemId];
        const route = catalog.explorations.find(route => route.id === job.targetId);
        rewards.fish = route.rewards.fish - (catalog.fishing.collectionDrawsByRoute?.[route.id] ?? 1);
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
    return { needed, recipeWants, needsRelic };
  }
  const sellExcess = needed => {
    let sold = false;
    for (const [id, amount] of Object.entries(state.inventory)) {
      if (items.get(id)?.category === "special") continue;
      const futureUses = preserveFutureCraftedStock && journeyOrder.slice(targetIndex).some(key => {
        const [building, level] = key.split(":");
        return catalog.buildings.find(b => b.id === building).levels.find(l => l.level === Number(level)).cost.items[id] > 0;
      });
      const manufactured = futureUses && catalog.recipes.some(r => r.rewards[id] > 0 && Object.keys(r.cost.items).length > 0);
      const quantity = amount - (manufactured ? amount : (needed[id] ?? 0));
      if (quantity > 0 && cash({ [id]: quantity }) > 0) sold = command(catalog.fishing.fish.some(f => f.itemId === id) ? "sell_fish" : "sell", id, quantity) || sold;
    }
    return sold;
  };
  function act() {
    let target = goal(); if (!target) return;
    if (dailyPearlsOnly) {
      const gift = progressionRewards.dailyRewardView(dailyState, epoch + clock * 1000);
      if (gift.claimable) {
        // Isolate slot affordability: intentionally omit the gift's coins,
        // ordinary items and relic. This is a projection, not a reward API test.
        state.wallet.pearls += gift.reward.pearls;
        dailyPearls += gift.reward.pearls; dailyClaims++;
        dailyState = progressionRewards.afterDailyClaim(dailyState, epoch + clock * 1000);
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
        // A real player can recover a crowded warehouse by selling raw stock.
        const expendable = Object.entries(state.inventory).filter(([id, amount]) => amount > 0 && cash({ [id]: amount }) > 0)
          .sort((a, b) => Number(!!sources(b[0])[0]?.cost.items && Object.keys(sources(b[0])[0].cost.items).length === 0)
            - Number(!!sources(a[0])[0]?.cost.items && Object.keys(sources(a[0])[0].cost.items).length === 0) || b[1] - a[1])[0];
        if (expendable) { command(catalog.fishing.fish.some(f => f.itemId === expendable[0]) ? "sell_fish" : "sell", ...expendable); storageRecovery++; command("claim_job", job.id); }
      }
      if (job.kind === "construction" && state.buildings[job.targetId] === job.targetLevel) {
        const key = `${job.targetId}:${job.targetLevel}`; milestones[key] = (clock - firstVisit) / day;
        events.push({ day: Number(((clock - firstVisit) / day).toFixed(4)), building: key, coins: state.wallet.coins });
      }
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
    if (eligible(target) && rules.canAffordEconomy(state, target.cost) && !(target.id === "quarry" && mineReserved)
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
    const actorBusy = () => actorAvailability.economyActorConflict(state.jobs, "departure", epoch + clock * 1000);
    for (const d of candidates) {
      // Re-read guaranteed pending output after every additional slot. A stale
      // recipe demand would manufacture the same construction inputs twice.
      for (;;) {
        if (!plan.recipeWants.has(d.id)) break;
        if (d.buildingId && (parallelProductionPlanning ? !productionAvailable(d.buildingId) || d.buildingId === drainingStation : busy.has(d.buildingId))) break;
        if ((!d.buildingId || d.buildingId === "quarry") && actorBusy()) break;
        const wanted = Math.min(d.maxBatch ?? 1, plan.recipeWants.get(d.id));
        const affordable = Array.from({ length: wanted }, (_, i) => wanted - i).find(q => rules.canAffordEconomy(state, d.cost, q));
        if (!affordable) break;
        if (!command(d.buildingId ? "start_production" : "start_exploration", d.id, affordable)) break;
        if (d.buildingId) busy.add(d.buildingId);
        if (parallelProductionPlanning) plan = demand(target);
        if (!parallelProductionPlanning || !d.buildingId) break;
      }
    }
    // Idle gathering earns sale money; mining and other routes use one actor.
    // Every eligible completed route advances the same relic clock.
    // Costly processing is reserved for the next upgrade. This is not an optimum.
    const income = d => cash(d.rewards) / (isActive ? d.seconds : Math.max(1, Math.ceil(d.seconds / gap)));
    for (const id of ["garden", "woodlot", null]) {
      if (id ? (parallelProductionPlanning ? !productionAvailable(id) || id === drainingStation : busy.has(id)) : actorBusy()) continue;
      const needsRelic = !id && plan.needsRelic && (state.buildings.home ?? 1) >= (catalog.rareDrops?.requiredHomeLevel ?? Infinity);
      const d = freeDefinitions.filter(d => id ? d.buildingId === id
        : !d.buildingId || !needsRelic && d.buildingId === "quarry" && !busy.has("quarry")).sort((a, b) => {
        // When a visible upgrade lacks a relic, prefer free routes that bank
        // more authored travel time between visits. Never inspect the private
        // clock or pending type, never skip real costs or building requirements.
        if (needsRelic) {
          const travel = route => isActive ? 1 : route.seconds / Math.max(1, Math.ceil(route.seconds / gap));
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
  const report = { catalogVersion: catalog.version, currencyScale: catalog.currencyScale ?? 1, pearlScale: catalog.pearlScale ?? catalog.currencyScale ?? 1, mode, complete: !goal(), elapsedDays: Number(((clock - firstVisit) / day).toFixed(3)),
    homeDays: Object.fromEntries([2, 3, 4, 5].map(l => [l, milestones[`home:${l}`] == null ? null : Number(milestones[`home:${l}`].toFixed(3))])),
    commands, saleRevenue: revenue, storageRecovery, failures, actions, stoppedAt: goal()?.key ?? null, milestones: events,
    ...(pearlBudget > 0 || dailyPearlsOnly ? { pearlBudget, pearlsSpent, pearlsRemaining: state.wallet.pearls } : {}),
    ...(dailyPearlsOnly ? { dailyPearlProjection: { claims: dailyClaims, pearlsReceived: dailyPearls,
      omitted: ["daily_reward_coins", "daily_reward_items", "daily_reward_relics", "achievement_rewards"] } } : {}),
    ...(parallelProductionPlanning ? { productionSlots: { constructionSpeedups, purchases: slotPurchases,
      maximumProductionJobs, finalCapacity: Object.fromEntries(productionStations.map(id => [id, slotCapacity(id)])) } } : {}),
    ...(jointBatchPlanning ? { productionRecipes } : {}),
    explorationRoutes, itemFlow: Object.fromEntries(Object.entries(itemFlow).map(([id, flow]) => [id, { ...flow, remaining: state.inventory[id] ?? 0 }])),
    actorWorkHours: Object.fromEntries(Object.entries(actorWorkSeconds).map(([kind, seconds]) => [kind, Number((seconds / hour).toFixed(4))])),
    excludedIncome: [dailyPearlsOnly ? "daily_reward_coins_and_items" : "daily_rewards", "achievement_rewards", "taps", "player_market", "legacy_grants"],
    rareMaterials: { seed: rareSeed, generator: "xorshift32-rejection-v1", draws: rareRandom.draws,
      eligibleExplorationHours: Number((eligibleExplorationSeconds / hour).toFixed(4)), received: relicReceived,
      spentOnConstruction: relicSpent, inventory: Object.fromEntries(relicIds.map(id => [id, state.inventory[id] ?? 0])), finds: relicFinds } };
  assert.equal(state.wallet.pearls, pearlBudget + dailyPearls - pearlsSpent); assert(state.wallet.coins >= 0);
  assert(Object.values(state.inventory).every(q => Number.isSafeInteger(q) && q >= 0));
  for (const [id, flow] of Object.entries(itemFlow))
    assert.equal(flow.received - flow.sold - flow.productionInputs - flow.expeditionInputs - flow.constructionInputs, state.inventory[id] ?? 0, `${id}: inventory flow must conserve every earned item`);
  for (const id of relicIds) assert.equal(relicReceived[id] - relicSpent[id], state.inventory[id] ?? 0, "Relics must be conserved from actual claims through construction");
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loaded = await loadJourneyRules();
  try { console.log(JSON.stringify(["active16h", "visits2", "visits3"].map(mode => simulateJourney(loaded, mode)), null, 2)); }
  finally { await loaded.close(); }
}
