import assert from "node:assert/strict";

/** A reproducible, deliberately sequential player policy using real domain
 * commands. No invented money/items, market, gifts, paid slots or speedups.
 * Every timer is claimed immediately; this is a feasible active policy, NOT a
 * fastest route, a three-visits-per-day scenario or a player-duration forecast.
 */
export function runEconomyCommandScenario({ catalog, rules, stages, tutorial }, { targetHome = 3, warehouseLevel = 1, initialState } = {}) {
  const epoch = Date.parse("2026-10-26T06:00:00Z");
  const state = initialState ? structuredClone(initialState) : rules.newEconomyState({
    resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  const initialCoins = state.wallet.coins, initialInventory = { ...state.inventory };
  const active = [...catalog.recipes, ...catalog.explorations].filter(source => !source.retired);
  const actions = {}, flows = {}, starts = {}, builds = [], deliveries = [];
  let clock = epoch, sequence = 0, income = 0, expenses = 0, peak = rules.economyStorage(state).used;
  const uuid = () => `00000000-0000-4000-9000-${(++sequence).toString(16).padStart(12, "0")}`;
  const held = items => Object.entries(items).every(([id, count]) => (state.inventory[id] ?? 0) >= count);
  const effectiveLevel = source => source.baseCampfire ? 0 : source.buildingLevel;
  const currentOrder = () => tutorial.tutorialResidentOrder(state) ?? stages.stageResidentOrder(state);
  function apply(action, targetId, quantity = 1) {
    assert(sequence < 100_000, "Scenario must terminate within its command budget");
    const before = structuredClone(state);
    rules.applyEconomyCommand(state, { requestId: uuid(), ownerPublicId: "0000-0000-0001", expectedRevision: sequence,
      action, targetId, quantity, totalPrice: 0 }, clock, uuid, {}, maximum => maximum - 1);
    actions[action] = (actions[action] ?? 0) + 1;
    const money = state.wallet.coins - before.wallet.coins;
    if (money > 0) income += money; else expenses -= money;
    for (const id of new Set([...Object.keys(before.inventory), ...Object.keys(state.inventory)])) {
      const delta = (state.inventory[id] ?? 0) - (before.inventory[id] ?? 0);
      const flow = flows[id] ??= { received: 0, consumed: 0, sold: 0 };
      if (delta > 0) flow.received += delta;
      else if (delta < 0) flow[action === "sell" || action === "sell_fish" ? "sold" : "consumed"] -= delta;
    }
    const storage = rules.economyStorage(state); peak = Math.max(peak, storage.used);
    assert(storage.used <= storage.capacity && storage.used <= 50, `${action}:${targetId} must fit the starter warehouse`);
    assert.equal(state.wallet.pearls, 0, "No paid acceleration in this scenario");
    assert.deepEqual(state.productionSlots ?? {}, {}, "The scenario uses one ordinary slot");
    assert(state.jobs.filter(job => job.kind === "construction").length <= 1);
    for (const id of ["garden", "woodlot", "workshop", "dryer", "kiln"])
      assert(state.jobs.filter(job => job.kind === "production" && job.targetId === id).length <= 1);
    for (const actorId of ["miner", "mochlik"])
      assert(state.jobs.filter(job => job.actorId === actorId).length <= 1);
    assert(state.jobs.every(job => !job.meal), "No accelerated jobs in the scenario");
    if (action === "start_construction") builds.push({ buildingId: targetId, level: before.buildings[targetId] + 1,
      coins: -money, atSeconds: (clock - epoch) / 1000 });
    return state;
  }
  function finish(job) {
    assert(job, "A newly started job must exist");
    clock = Math.max(clock, Date.parse(job.finishesAt));
    if (job.collection) {
      apply("start_collection", job.id);
      clock = Math.max(clock, Date.parse(state.jobs.find(entry => entry.id === job.id).collection.finishesAt));
    }
    apply("claim_job", job.id);
  }
  function open(source) {
    return source.requiredHomeLevel <= state.buildings.home
      && Object.entries(source.requiredBuildings ?? {}).every(([id, level]) => (state.buildings[id] ?? 0) >= level)
      && (!source.buildingId || (state.buildings[source.buildingId] ?? 0) >= effectiveLevel(source));
  }
  function requirements(source, path) {
    assert(source.requiredHomeLevel <= state.buildings.home, `${source.id}: cannot borrow a future home's technology`);
    for (const [id, level] of Object.entries(source.requiredBuildings ?? {})) ensureBuilding(id, level, path);
    if (source.buildingId) ensureBuilding(source.buildingId, effectiveLevel(source), path);
    for (const [recipeId, count] of Object.entries(source.requiredRecipes ?? {})) {
      const prerequisite = active.find(entry => entry.id === recipeId);
      assert(prerequisite, `${source.id}: unavailable recipe prerequisite ${recipeId}`);
      while ((state.progression.recipes[recipeId] ?? 0) < count) run(prerequisite, path);
    }
  }
  function run(source, path = []) {
    requirements(source, path);
    ensureBundle(source.cost.items, path);
    earn(source.cost.coins);
    const fishing = catalog.fishing.routeIds.includes(source.id);
    apply(source.buildingId ? "start_production" : fishing ? "start_fishing" : "start_exploration", source.id);
    starts[source.id] = (starts[source.id] ?? 0) + 1;
    finish(state.jobs.find(job => job.recipeId === source.id || job.kind === "exploration" && job.targetId === source.id));
  }
  function ensureItem(itemId, quantity, path = []) {
    if ((state.inventory[itemId] ?? 0) >= quantity) return;
    assert(!path.includes(`item:${itemId}`), `Scenario acquisition cycle: ${[...path, itemId].join(" -> ")}`);
    const nextPath = [...path, `item:${itemId}`];
    let attempts = 0;
    while ((state.inventory[itemId] ?? 0) < quantity) {
      assert(++attempts <= 1000, `${itemId}: acquisition must be bounded`);
      if (catalog.fishing.classes.some(group => group.itemId === itemId)) {
        assert.equal(itemId, "fish_common", "Mandatory early scenario must not require a rare catch");
        const source = active.find(entry => entry.id === "shore");
        state.fishingCastSeed = uuid(); run(source, nextPath);
        // Deliveries need ordinary fish; sell only genuinely claimed non-common catches.
        for (const group of catalog.fishing.classes.filter(group => group.itemId !== "fish_common"))
          if (state.inventory[group.itemId]) apply("sell_fish", group.itemId, state.inventory[group.itemId]);
        continue;
      }
      const candidates = active.filter(source => source.rewards[itemId] > 0 && source.requiredHomeLevel <= state.buildings.home
        && !catalog.fishing.routeIds.includes(source.id));
      candidates.sort((a, b) => Number(open(b)) - Number(open(a)) ||
        Object.keys(a.cost.items).length - Object.keys(b.cost.items).length || a.seconds / a.rewards[itemId] - b.seconds / b.rewards[itemId]);
      assert(candidates.length, `${itemId}: no available repeatable source at home ${state.buildings.home}`);
      run(candidates[0], nextPath);
    }
  }
  function ensureBundle(items, path = []) {
    let passes = 0;
    do {
      assert(++passes <= 100, "Shared ingredients must converge without consuming another goal forever");
      for (const [id, quantity] of Object.entries(items)) ensureItem(id, quantity, path);
    } while (!held(items));
  }
  function earn(requiredCoins) {
    let attempts = 0;
    while (state.wallet.coins < requiredCoins) {
      assert(++attempts <= 10000, "Coin earning must finish within a bounded number of unit jobs");
      const source = active.filter(source => source.buildingId && open(source) && source.cost.coins === 0
        && !Object.keys(source.cost.items).length && !Object.keys(source.requiredRecipes ?? {}).length)
        .sort((a, b) => {
          const incomePerSecond = entry => Object.entries(entry.rewards).reduce((total, [id, count]) =>
            total + catalog.items.find(item => item.id === id).baseSellPrice * count, 0) / (entry.seconds + (entry.collection?.seconds ?? 0));
          return incomePerSecond(b) - incomePerSecond(a) || a.id.localeCompare(b.id);
        })[0];
      assert(source, "A zero-cash player needs a free earning source");
      run(source);
      for (const [id, quantity] of Object.entries(source.rewards)) apply("sell", id, quantity);
    }
  }
  function ensureBuilding(id, level, path = []) {
    if ((state.buildings[id] ?? 0) >= level) return;
    const key = `building:${id}:${level}`;
    assert(!path.includes(key), `Scenario construction cycle: ${[...path, key].join(" -> ")}`);
    const nextPath = [...path, key];
    while ((state.buildings[id] ?? 0) < level) {
      const target = catalog.buildings.find(building => building.id === id).levels.find(entry => entry.level === (state.buildings[id] ?? 0) + 1);
      assert(target.requiredHomeLevel <= state.buildings.home, `${key}: source requires a future house`);
      for (const [dependency, count] of Object.entries(target.requiredBuildings)) ensureBuilding(dependency, count, nextPath);
      // Money is earned before assembling the bundle, leaving room for its unit output.
      earn(target.cost.coins); ensureBundle(target.cost.items, nextPath);
      apply("start_construction", id); finish(state.jobs.find(job => job.kind === "construction"));
    }
  }
  while (state.buildings.home < targetHome) {
    let order = currentOrder();
    while (order) {
      for (const [id, level] of Object.entries(order.requiredBuildings ?? {})) ensureBuilding(id, level);
      for (const [id, count] of Object.entries(order.requiredExplorations ?? {}))
        while ((state.progression.routes[id] ?? 0) < count) run(active.find(source => source.id === id));
      ensureBundle(order.items);
      if (order.availableAt) clock = Math.max(clock, Date.parse(order.availableAt));
      const before = state.wallet.coins;
      apply("complete_resident_order", order.id);
      deliveries.push({ id: order.id, coins: state.wallet.coins - before, atSeconds: (clock - epoch) / 1000 });
      order = currentOrder();
    }
    ensureBuilding("home", state.buildings.home + 1);
  }
  ensureBuilding("warehouse", warehouseLevel);
  assert.equal(state.wallet.coins, initialCoins + income - expenses, "Every coin must come from or go to a real command");
  for (const id of new Set([...Object.keys(initialInventory), ...Object.keys(flows)])) {
    const flow = flows[id] ?? { received: 0, consumed: 0, sold: 0 };
    assert.equal(state.inventory[id] ?? 0, (initialInventory[id] ?? 0) + flow.received - flow.consumed - flow.sold,
      `${id}: item conservation across crafting, claims and sales`);
  }
  return { state, elapsedSeconds: (clock - epoch) / 1000, initialCoins, income, expenses,
    commandCount: sumActions(actions), actions, starts, builds, deliveries, peakStorage: peak, flows,
    timingBasis: "One sequential active player, immediate claims, no paid slots/gifts/speedups; feasible policy, not an optimal or calendar-visit forecast" };
}

const sumActions = actions => Object.values(actions).reduce((total, count) => total + count, 0);
