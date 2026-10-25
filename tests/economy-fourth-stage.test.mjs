import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-fourth-stage-mining-planner-vite",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog: catalog, economyJobSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const actors = await vite.ssrLoadModule("/features/economy/domain/actor-availability.ts");
after(() => vite.close());
const epoch = Date.parse("2026-10-14T09:00:00Z"), hour = 3600000;
const constructionSequence = [["dryer", 2], ["woodlot", 4], ["kiln", 3], ["bridge", 1],
  ["lighthouse", 1], ["quarry", 4], ["kiln", 4], ["workshop", 4], ["dryer", 3], ["home", 5]];

/** Every action goes through the actual domain transition. Only the initial
 * completed house-three chapter is a fixture; money, inputs and work are earned. */
function fourthStageJourney(activeMinutes = 30, miningIncome = false) {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  Object.assign(state.buildings, { home: 4, garden: 1, warehouse: 1, woodlot: 3, workshop: 3, quarry: 3, kiln: 2, dryer: 1 });
  state.wallet = { coins: 3510, pearls: 0 }; state.inventory = {};
  state.tutorialOrder = { version: 2, step: 4, completed: true, ingredientsClaimed: true, terms: null };
  state.stageOrders = { version: 1, stages: { 2: { step: 7, completed: true, terms: null }, 3: { step: 8, completed: true, terms: null } } };
  let clock = epoch, sequence = 0, revision = 0, peak = 0, constructionCoins = 0, courseCoins = 0, repeatCoins = 0, saleCoins = 0, visitCount = 0;
  let constructionSeconds = 0, activeStart = epoch, activeEnd = epoch, activeSeconds = 0;
  const courses = [], builds = [], actions = {}, flow = {}, production = {}, catches = {}, repeatOrders = [], miningDeliveries = [];
  const incomeJobs = new Set();
  const requiredIncome = constructionSequence.reduce((sum, [id, level]) => sum + catalog.buildings.find(building => building.id === id)
    .levels.find(entry => entry.level === level).cost.coins, 0)
    - catalog.stageOrders.find(course => course.homeLevel === 4).orders.reduce((sum, order) => sum + order.coins, 0) - state.wallet.coins;
  const miningIncomeGoal = requiredIncome + 210;
  const uuid = () => `00000000-0000-4000-9000-${(++sequence).toString(16).padStart(12, "0")}`;
  const record = id => flow[id] ??= { received: 0, consumed: 0, sold: 0 };
  const currentCourse = () => stages.stageResidentOrder(state);
  const held = items => Object.entries(items).every(([id, count]) => (state.inventory[id] ?? 0) >= count);
  const buildingOpen = requirements => Object.entries(requirements ?? {}).every(([id, level]) => (state.buildings[id] ?? 0) >= level);
  const sourceOpen = source => !source.retired && state.buildings.home >= source.requiredHomeLevel && buildingOpen(source.requiredBuildings)
    && (!source.buildingId || (state.buildings[source.buildingId] ?? 0) >= source.buildingLevel);
  // Maximum interval and living resin are fixed trusted server entropy. Neither
  // core nor crystal can be supplied by this sampler, so the chapter must supply both.
  const rareRandom = maximum => maximum - 1;
  function apply(action, targetId, quantity = 1) {
    assert(clock >= activeStart && clock <= activeEnd, "manual actions only happen during a scheduled visit");
    const before = structuredClone(state), offer = action === "complete_resident_order" ? currentCourse() : null;
    rules.applyEconomyCommand(state, { requestId: uuid(), ownerPublicId: "0000-0000-0001", expectedRevision: revision,
      action, targetId, quantity, totalPrice: 0 }, clock, uuid, {}, rareRandom);
    revision++; actions[action] = (actions[action] ?? 0) + 1;
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
    const receivedMine = action === "claim_job" && before.jobs.find(job => job.id === targetId && job.actorId === "miner");
    if (receivedMine) {
      for (const [id, count] of Object.entries(receivedMine.rewards))
        assert.equal((state.inventory[id] ?? 0) - (before.inventory[id] ?? 0), count, `${receivedMine.targetId}: the complete saved batch is credited`);
      miningDeliveries.push({ route: receivedMine.targetId, rewards: receivedMine.rewards,
        seconds: (Date.parse(receivedMine.finishesAt) - Date.parse(receivedMine.startedAt)) / 1000 });
    }
    for (const id of new Set([...Object.keys(before.inventory), ...Object.keys(state.inventory)])) {
      const delta = (state.inventory[id] ?? 0) - (before.inventory[id] ?? 0);
      if (delta > 0) record(id).received += delta;
      else if (delta < 0) record(id)[["sell", "sell_fish"].includes(action) ? "sold" : "consumed"] -= delta;
      if (action === "claim_job" && delta > 0 && catalog.fishing.classes.some(group => group.itemId === id))
        catches[id] = (catches[id] ?? 0) + delta;
    }
    const storage = rules.economyStorage(state); peak = Math.max(peak, storage.used);
    assert.equal(storage.capacity, 50); assert(storage.used <= 50, `${action}:${targetId} exceeds the original warehouse`);
    assert.equal(state.wallet.pearls, 0); assert.deepEqual(state.productionSlots ?? {}, {}); assert.equal(state.marketSlots, 5);
    assert(state.jobs.filter(job => job.kind === "construction").length <= 1);
    for (const id of ["garden", "woodlot", "workshop", "dryer", "kiln"])
      assert(state.jobs.filter(job => job.kind === "production" && job.targetId === id).length <= 1);
    for (const actor of ["miner", "mochlik"])
      assert(state.jobs.filter(job => job.kind === "exploration" && job.actorId === actor).length <= 1);
    assert(state.jobs.every(job => !job.meal));
  }
  function sell(id, count) {
    while (count > 0) {
      const quantity = Math.min(catalog.maxBatch, count);
      apply(catalog.fishing.classes.some(group => group.itemId === id) ? "sell_fish" : "sell", id, quantity);
      count -= quantity;
    }
  }
  function makeRoom(quantity) {
    const needed = Math.max(0, rules.economyStorage(state).used + quantity - 50);
    if (!needed) return;
    let left = needed;
    // NPC sales are actual commands, counted in the budget and item ledger.
    // Guaranteed project relics are kept for the house; random resin is optional.
    const goods = Object.keys(state.inventory).filter(id => !catalog.rareDrops.itemIds.includes(id))
      .sort((a, b) => catalog.items.find(item => item.id === a).baseSellPrice - catalog.items.find(item => item.id === b).baseSellPrice);
    const reserve = ingredientReserve();
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
        // Keep a small working stock and ingredients for the current project;
        // sell surplus through real NPC commands after receiving the full batch.
        const reserve = { stone: 3, ore: 3, clay: 1, sand: 1 };
        for (const [id, count] of Object.entries(ingredientReserve())) reserve[id] = Math.max(reserve[id] ?? 0, count);
        for (const id of Object.keys(job.rewards).filter(id => !catalog.rareDrops.itemIds.includes(id))) {
          const surplus = Math.max(0, (state.inventory[id] ?? 0) - (reserve[id] ?? 0));
          if (surplus) sell(id, surplus);
        }
      }
    }
    return changed;
  }
  const sourceBusy = source => source.buildingId
    ? state.jobs.some(job => job.targetId === source.buildingId && ["construction", "production"].includes(job.kind))
    : source.activity === "mining"
      ? Boolean(actors.economyMinerConflict(state.jobs, clock)) || state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry")
      : Boolean(actors.economyActorConflict(state.jobs, "departure", clock));
  const pending = id => state.jobs.reduce((sum, job) => sum + (job.rewards[id] ?? 0), 0);
  const sources = id => [...catalog.recipes, ...catalog.explorations.filter(route => !catalog.fishing.routeIds.includes(route.id))]
    .filter(source => source.rewards[id] > 0 && sourceOpen(source))
    .sort((a, b) => Number(Object.keys(a.cost.items).length > 0) - Number(Object.keys(b.cost.items).length > 0)
      || a.seconds / a.rewards[id] - b.seconds / b.rewards[id]);
  function ingredientReserve() {
    const reserve = {};
    const protect = items => { for (const [id, count] of Object.entries(items ?? {})) reserve[id] = Math.max(reserve[id] ?? 0, count); };
    protect(currentCourse()?.items); protect(buildDefinition(nextConstruction())?.cost.items);
    for (const recipe of catalog.recipes.filter(sourceOpen)) protect(recipe.cost.items);
    return reserve;
  }
  function acquisitionSource(id) {
    // One fixed single-item extraction, including the last launch of a visit.
    return sources(id)[0];
  }
  function run(source, ancestors = []) {
    if (ancestors.includes(source.id)) throw new Error(`Acquisition cycle: ${ancestors.join(" -> ")} -> ${source.id}`);
    const path = [...ancestors, source.id];
    for (const [id, count] of Object.entries(source.requiredRecipes ?? {})) {
      if ((state.progression.recipes[id] ?? 0) < count) {
        const recipe = catalog.recipes.find(recipe => recipe.id === id);
        if (!state.jobs.some(job => job.recipeId === id) && run(recipe, path)) return true;
        return false;
      }
    }
    for (const [id, count] of Object.entries(source.cost.items)) if ((state.inventory[id] ?? 0) < count && need(id, count, path)) return true;
    if (!held(source.cost.items) || sourceBusy(source)) return false;
    apply(source.buildingId ? "start_production" : "start_exploration", source.id);
    production[source.id] = (production[source.id] ?? 0) + 1;
    return true;
  }
  function need(id, count, ancestors = []) {
    if ((state.inventory[id] ?? 0) + pending(id) >= count) return false;
    if (id.startsWith("fish_")) {
      const source = catalog.explorations.find(route => route.id === "shore");
      if (sourceBusy(source)) return false;
      apply("start_fishing", "shore"); production.shore = (production.shore ?? 0) + 1; return true;
    }
    if (catalog.rareDrops.itemIds.includes(id)) return false;
    const source = acquisitionSource(id, count);
    return source ? run(source, ancestors) : false;
  }
  function bundle(items) {
    for (const [id, count] of Object.entries(items)) if (need(id, count)) return true;
    return false;
  }
  const nextConstruction = () => constructionSequence.find(([id, level]) => (state.buildings[id] ?? 0) < level
    && !state.jobs.some(job => job.kind === "construction" && job.targetId === id && job.targetLevel >= level));
  const buildDefinition = entry => entry && catalog.buildings.find(building => building.id === entry[0]).levels.find(level => level.level === entry[1]);
  function estimatedEffort(id, path = []) {
    if (path.includes(id)) return Infinity;
    if (id.startsWith("fish_")) return id === "fish_common" ? 100 : 1500;
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
  function act() {
    if (claimReady()) return true;
    const course = currentCourse();
    if (course && Date.parse(course.availableAt) <= clock && buildingOpen(course.requiredBuildings)
      && Object.entries(course.requiredExplorations ?? {}).every(([id, count]) => (state.progression.routes[id] ?? 0) >= count) && held(course.items)) {
      apply("complete_resident_order", course.id); return true;
    }
    const next = nextConstruction(), definition = buildDefinition(next);
    const homeReady = next?.[0] !== "home" || !course;
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
    if (next && bundle(definition.cost.items)) return true;
    if (miningIncome) {
      // Earn before assembling final stock: an income delivery should not force
      // the player to sell and recreate a prepared building bundle.
      if (repeatCoins + saleCoins >= miningIncomeGoal) {
        for (const future of constructionSequence) {
          if ((state.buildings[future[0]] ?? 0) >= future[1]
            || state.jobs.some(job => job.kind === "construction" && job.targetId === future[0] && job.targetLevel >= future[1])) continue;
          if (bundle(buildDefinition(future).cost.items)) return true;
        }
      } else {
        const saleValue = route => Object.entries(route.rewards).reduce((sum, [id, count]) => sum + count * catalog.localBuyer.unitPrices[id], 0);
        const shift = catalog.explorations.filter(route => route.activity === "mining" && sourceOpen(route)
          && !route.cost.coins && !Object.keys(route.cost.items).length)
          .sort((a, b) => saleValue(b) - saleValue(a))[0];
        if (shift && !sourceBusy(shift) && run(shift)) {
          incomeJobs.add(state.jobs.find(job => job.actorId === "miner").id); return true;
        }
      }
      return false;
    }
    if (next && ordinaryIncome(definition.cost.coins)) return true;
    return false;
  }
  for (let visit = 0; visit < 150 && state.buildings.home < 5; visit++) {
    const begin = epoch + visit * 8 * hour, end = begin + activeMinutes * 60000;
    clock = begin; visitCount++; activeStart = begin; activeEnd = end;
    let commands = 0;
    while (clock <= end && state.buildings.home < 5) {
      if (act()) { assert(++commands < 500, "a short visit has bounded actual commands"); continue; }
      const due = state.jobs.map(job => job.collection?.startedAt ? Date.parse(job.collection.finishesAt) : Date.parse(job.finishesAt))
        .filter(at => at > clock && at <= end);
      const course = currentCourse(), availableAt = course && Date.parse(course.availableAt);
      if (availableAt > clock && availableAt <= end) due.push(availableAt);
      if (!due.length) break;
      clock = Math.min(...due);
    }
    activeSeconds += (clock - begin) / 1000;
  }
  return { state, clock, revision, peak, constructionCoins, courseCoins, repeatCoins, saleCoins, courses, builds,
    actions, flow, production, catches, repeatOrders, miningDeliveries, visitCount, activeMinutes, activeSeconds, constructionSeconds };
}

test("a real three-visits-per-day house-four chapter builds both landmarks and house five with one slot and 50-place storage", t => {
  const result = fourthStageJourney(), { state, clock, courses, builds, flow, actions, production } = result;
  const report = { elapsedDays: (clock - epoch) / (24 * hour), visits: result.visitCount, activeMinutesPerVisit: result.activeMinutes,
    activeTimerHours: result.activeSeconds / 3600, builderHours: result.constructionSeconds / 3600,
    peak: result.peak, coins: state.wallet.coins, constructionCoins: result.constructionCoins, courseCoins: result.courseCoins,
    repeatCoins: result.repeatCoins, saleCoins: result.saleCoins, repeatOrders: result.repeatOrders.length, commands: result.revision,
    deliveryDays: courses.map(course => (course.at - epoch) / (24 * hour)), buildings: builds.map(build => `${build.target}:${build.level}`),
    remainingBuildings: state.buildings, nextCourse: stages.stageResidentOrder(state)?.id, production };
  t.diagnostic(JSON.stringify(report));
  assert.equal(state.buildings.home, 5, JSON.stringify(report));
  assert.equal(state.buildings.bridge, 1); assert.equal(state.buildings.lighthouse, 1); assert.equal(state.buildings.warehouse, 1);
  assert.equal(state.jobs.length, 0, "all completed work is manually claimed");
  assert.equal(courses.length, 12); assert.equal(result.courseCoins, catalog.stageOrders.find(stage => stage.homeLevel === 4).orders.reduce((sum, order) => sum + order.coins, 0)); assert.equal(result.constructionCoins, constructionSequence.reduce((sum, [id, level]) => sum + catalog.buildings.find(building => building.id === id).levels.find(spec => spec.level === level).cost.coins, 0));
  assert.equal(result.constructionSeconds, constructionSequence.reduce((sum, [id, level]) => sum + catalog.buildings.find(building => building.id === id).levels.find(spec => spec.level === level).seconds, 0), "all ten constructions use their actual catalog timers");
  assert.equal(state.stageOrders.stages["4"].completed, true); assert.equal(state.stageOrders.stages["4"].step, 12);
  assert.equal(state.progression.routes.ancient_ruins, 1); assert.equal(production.ancient_ruins, 1);
  assert(courses.at(-1).at - courses[0].at >= 11 * 23 * hour);
  for (let index = 1; index < courses.length; index++) assert(courses[index].at - courses[index - 1].at >= 23 * hour);
  assert(clock - courses.at(-1).at >= catalog.buildings.find(building => building.id === "home").levels.at(-1).seconds * 1000, "the final house uses its actual builder timer");
  assert(clock - epoch >= (11 * 23 + 24) * hour); assert(clock - epoch <= 21 * 24 * hour, JSON.stringify(report));
  assert.equal(result.flow.ancient_core.received, 1); assert.equal(result.flow.moon_crystal.received, 1);
  assert.equal(result.flow.ancient_core.consumed, 1); assert.equal(result.flow.moon_crystal.consumed, 1);
  assert.equal(state.wallet.coins, 3510 + result.courseCoins + result.repeatCoins + result.saleCoins - result.constructionCoins);
  for (const [id, counts] of Object.entries(flow)) assert.equal(counts.received - counts.consumed - counts.sold, state.inventory[id] ?? 0, `${id} is conserved`);
  for (const action of ["buy_market_slot", "buy_production_slot", "claim_tutorial_order", "claim_workshop_starter", "speedup_construction", "eat_food", "feed_builder"])
    assert.equal(actions[action], undefined);
  assert(result.repeatCoins + result.saleCoins >= Math.max(0, result.constructionCoins - result.courseCoins - 3510), "the unfunded part is actually earned");
  assert(actions.start_fishing > 0); assert(production.prepare_trail_ration >= 3); assert(production.assemble_field_kit >= 2);
  assert.deepEqual(builds.map(build => `${build.target}:${build.level}`), constructionSequence.map(([id, level]) => `${id}:${level}`));
});

test("three 15-minute visits per day can fund house five with independent mining instead of hundreds of fish casts", t => {
  const result = fourthStageJourney(15, true), { state, clock, courses, builds, flow, actions, production } = result;
  const minedItems = {};
  for (const delivery of result.miningDeliveries) for (const [id, count] of Object.entries(delivery.rewards))
    minedItems[id] = (minedItems[id] ?? 0) + count;
  t.diagnostic(JSON.stringify({ elapsedDays: (clock - epoch) / (24 * hour), visits: result.visitCount,
    activeMinutesPerVisit: result.activeMinutes, activeTimerHours: result.activeSeconds / 3600,
    builderHours: result.constructionSeconds / 3600, peak: result.peak, coins: state.wallet.coins,
    constructionCoins: result.constructionCoins, courseCoins: result.courseCoins,
    repeatCoins: result.repeatCoins, saleCoins: result.saleCoins, repeatOrders: result.repeatOrders.length,
    commands: result.revision, fishCasts: actions.start_fishing,
    miningShifts: (production.quarry_shift ?? 0) + (production.quarry_deep_face ?? 0),
    miningDeliveries: result.miningDeliveries.length, minedItems,
    focusedBatches: Object.fromEntries(Object.entries(production).filter(([id]) => id.endsWith("_hour") || id.endsWith("_overnight"))),
    deliveryDays: courses.map(course => (course.at - epoch) / (24 * hour)) }));
  assert.equal(state.buildings.home, 5); assert.equal(state.buildings.bridge, 1); assert.equal(state.buildings.lighthouse, 1);
  assert.equal(state.buildings.warehouse, 1); assert.equal(state.jobs.length, 0);
  assert.equal(result.constructionCoins, constructionSequence.reduce((sum, [id, level]) => sum + catalog.buildings.find(building => building.id === id).levels.find(spec => spec.level === level).cost.coins, 0)); assert.equal(result.courseCoins, catalog.stageOrders.find(stage => stage.homeLevel === 4).orders.reduce((sum, order) => sum + order.coins, 0));
  assert.equal(result.constructionSeconds, constructionSequence.reduce((sum, [id, level]) => sum + catalog.buildings.find(building => building.id === id).levels.find(spec => spec.level === level).seconds, 0)); assert.equal(courses.length, 12);
  assert.equal(state.stageOrders.stages["4"].completed, true); assert.equal(state.stageOrders.stages["4"].step, 12);
  assert.equal(state.progression.routes.ancient_ruins, 1); assert.equal(production.ancient_ruins, 1);
  assert(courses.at(-1).at - courses[0].at >= 11 * 23 * hour);
  for (let index = 1; index < courses.length; index++) assert(courses[index].at - courses[index - 1].at >= 23 * hour);
  assert(clock - courses.at(-1).at >= catalog.buildings.find(building => building.id === "home").levels.at(-1).seconds * 1000);
  // Single-item mining needs manual visits: the v12 23-day budget relied on removed overnight bundles.
  assert(clock - epoch >= (11 * 23 + 24) * hour); assert(clock - epoch <= 35 * 24 * hour);
  assert.equal(result.activeMinutes, 15); assert(result.activeSeconds <= 24 * 3600);
  assert(actions.start_fishing >= 8); assert(actions.start_fishing <= 20);
  assert(result.revision < 1800); assert(result.saleCoins >= Math.max(0, result.constructionCoins - result.courseCoins - 3510)); assert.equal(result.repeatCoins, 0);
  assert(result.miningDeliveries.length > 0, "independent mining really delivers the goods that fund the project");
  assert(result.miningDeliveries.every(delivery => Object.values(delivery.rewards).reduce((sum, count) => sum + count, 0) === 1),
    "every extraction delivers exactly one item, never a removed hourly batch");
  assert.equal(result.miningDeliveries.length, Object.entries(production).filter(([id]) => catalog.explorations
    .some(route => route.id === id && route.activity === "mining")).reduce((sum, [, count]) => sum + count, 0),
    "every started mining batch is received exactly once");
  for (const delivery of result.miningDeliveries) {
    const route = catalog.explorations.find(route => route.id === delivery.route);
    assert.equal(delivery.seconds, route.seconds, "mining keeps its actual catalog duration");
    for (const [id, count] of Object.entries(route.rewards)) assert.equal(delivery.rewards[id], count);
  }
  const requiredCommonFish = courses.reduce((sum, order) => sum + (order.items.fish_common ?? 0), 0)
    + catalog.recipes.reduce((sum, recipe) => sum + (production[recipe.id] ?? 0) * (recipe.cost.items.fish_common ?? 0), 0);
  assert(requiredCommonFish > 0);
  assert((result.catches.fish_common ?? 0) >= requiredCommonFish, "every fish used by the project and provisions was genuinely caught");
  assert.equal(production.prepare_trail_ration, 3); assert.equal(production.assemble_field_kit, 2);
  for (const id of ["ancient_core", "moon_crystal"]) {
    assert.equal(flow[id].received, 1); assert.equal(flow[id].consumed, 1); assert.equal(flow[id].sold, 0);
  }
  assert.equal(state.wallet.coins, 3510 + result.courseCoins + result.repeatCoins + result.saleCoins - result.constructionCoins);
  for (const [id, counts] of Object.entries(flow)) assert.equal(counts.received - counts.consumed - counts.sold, state.inventory[id] ?? 0, `${id} is conserved`);
  for (const action of ["buy_market_slot", "buy_production_slot", "claim_tutorial_order", "claim_workshop_starter", "speedup_construction", "eat_food", "feed_builder"])
    assert.equal(actions[action], undefined);
  assert.deepEqual(builds.map(build => `${build.target}:${build.level}`), constructionSequence.map(([id, level]) => `${id}:${level}`));
});


for (const [targetId, seconds, oldCost] of [
  ["bridge", 4 * 3600, { coins: 4000, items: { beams: 1, planks: 2, rope: 2, metal_parts: 1 } }],
  ["lighthouse", 6 * 3600, { coins: 5000, items: { cut_stone: 2, bricks: 2, glass: 2, tools: 1 } }],
]) test(`a paid v9 ${targetId} restoration retains its saved terms after the early v10 unlock`, () => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  Object.assign(state.buildings, { home: 4, workshop: 3, kiln: 3, quarry: 3, bridge: targetId === "lighthouse" ? 1 : 0, lighthouse: 0 });
  state.wallet = { coins: 17, pearls: 0 }; state.inventory = { berries: 1 };
  const saved = economyJobSchema.parse({ id: "00000000-0000-4000-9000-999999999999", kind: "construction",
    targetId, targetLevel: 1, recipeId: null, startedAt: new Date(epoch).toISOString(),
    finishesAt: new Date(epoch + seconds * 1000).toISOString(), cost: oldCost, rewards: {}, catalogVersion: 9 });
  state.jobs = [saved];
  assert.notDeepEqual(saved.cost, catalog.buildings.find(building => building.id === targetId).levels[0].cost);
  assert.throws(() => rules.applyEconomyCommand(state, { requestId: crypto.randomUUID(), ownerPublicId: "0000-0000-0001",
    expectedRevision: 0, action: "claim_job", targetId: saved.id, quantity: 1, totalPrice: 0 }, epoch + seconds * 1000 - 1, crypto.randomUUID),
    { code: "ECONOMY_JOB_NOT_READY" });
  assert.deepEqual(state.jobs, [saved]); assert.deepEqual(state.wallet, { coins: 17, pearls: 0 });
  rules.applyEconomyCommand(state, { requestId: crypto.randomUUID(), ownerPublicId: "0000-0000-0001",
    expectedRevision: 0, action: "claim_job", targetId: saved.id, quantity: 1, totalPrice: 0 }, epoch + seconds * 1000, crypto.randomUUID);
  assert.equal(state.buildings[targetId], 1); assert.equal(state.jobs.length, 0);
  assert.deepEqual(state.wallet, { coins: 17, pearls: 0 }); assert.deepEqual(state.inventory, { berries: 1 });
});
