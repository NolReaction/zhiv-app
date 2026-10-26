import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-mining-continuous-journey-vite",
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const actors = await vite.ssrLoadModule("/features/economy/domain/actor-availability.ts");
const tutorial = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
after(() => vite.close());
const epoch = Date.parse("2026-10-14T09:00:00Z"), hour = 3600000;
// These optional branches are earned at their advertised house, before the next
// house is bought. The warehouse and paid slots are never prerequisites.
const chapters = {
  1: [["woodlot", 1], ["dryer", 1], ["workshop", 1], ["home", 2]],
  2: [["quarry", 1], ["quarry", 2], ["kiln", 1], ["garden", 2], ["bridge", 1], ["home", 3]],
  3: [["woodlot", 2], ["kiln", 2], ["workshop", 2], ["garden", 3], ["dryer", 2], ["woodlot", 3], ["workshop", 3],
    ["quarry", 3], ["kiln", 3], ["dryer", 3], ["lighthouse", 1], ["home", 4]],
  4: [["garden", 4], ["woodlot", 4], ["quarry", 4], ["kiln", 4], ["workshop", 4], ["home", 5]],
  5: [["dryer", 4], ["garden", 5]],
};
const newRecipes = {
  1: ["grow_strawberries", "cook_strawberry_compote"],
  2: ["grow_blueberries", "cook_blueberry_compote"],
  3: ["grow_currants", "cook_currant_jelly"],
  4: ["grow_blackberries", "cook_blackberry_preserve"],
  5: ["grow_cranberries", "cook_cranberry_glaze"],
};
const constructionSequence = Object.values(chapters).flat();

/** The only fixture is a newly created account. Each later chapter carries the
 * actual money, stock, recipes, restored landmarks and unfinished work forward. */
function completeJourney(regularActiveMinutes, maximumDays) {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  const startingCoins = state.wallet.coins, startingItems = { ...state.inventory };
  let clock = epoch, sequence = 0, revision = 0, peak = 0, constructionCoins = 0, courseCoins = 0, repeatCoins = 0, saleCoins = 0, visitCount = 0;
  let constructionSeconds = 0, activeStart = epoch, activeEnd = epoch, activeSeconds = 0;
  const courses = [], builds = [], actions = {}, flow = {}, production = {}, catches = {}, repeatOrders = [];
  const berryClaims = [], checkpoints = [], windows = [];
  const incomeJobs = new Set();
  for (const [id, count] of Object.entries(startingItems)) flow[id] = { received: count, consumed: 0, sold: 0 };
  const uuid = () => `00000000-0000-4000-9000-${(++sequence).toString(16).padStart(12, "0")}`;
  const record = id => flow[id] ??= { received: 0, consumed: 0, sold: 0 };
  const currentCourse = () => tutorial.tutorialResidentOrder(state) ?? stages.stageResidentOrder(state);
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
    if (action === "claim_job") {
      const job = before.jobs.find(job => job.id === targetId);
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
      let room = Object.values(job.rewards).reduce((sum, count) => sum + count, 0);
      for (;;) {
        makeRoom(room);
        try { apply("claim_job", job.id); break; }
        catch (error) {
          if (error.code !== "ECONOMY_STORAGE_FULL") throw error;
          // Additional finds are revealed only at delivery. Respond to the
          // server's capacity error with a real sale, without reading the draw.
          assert(++room <= 50, "a complete delivery fits the original warehouse");
        }
      }
      changed = true;
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
    ? state.jobs.some(job => job.targetId === source.buildingId && ["construction", "production"].includes(job.kind))
    : source.activity === "mining"
      ? Boolean(actors.economyMinerConflict(state.jobs, clock)) || state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry")
      : Boolean(actors.economyActorConflict(state.jobs, "departure", clock));
  const pending = id => state.jobs.reduce((sum, job) => sum + (job.rewards[id] ?? 0), 0);
  const sources = id => [...catalog.recipes, ...catalog.explorations.filter(route => !catalog.fishing.routeIds.includes(route.id))]
    .filter(source => source.rewards[id] > 0 && sourceOpen(source))
    .sort((a, b) => Number(Object.keys(a.cost.items).length > 0) - Number(Object.keys(b.cost.items).length > 0)
      || a.seconds / a.rewards[id] - b.seconds / b.rewards[id]);
  function run(source, ancestors = []) {
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
    for (const [id, count] of Object.entries(source.cost.items)) if ((state.inventory[id] ?? 0) < count && need(id, count, path)) return true;
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
    return source ? run(source, ancestors) : false;
  }
  function bundle(items) {
    for (const [id, count] of Object.entries(items)) if (need(id, count)) return true;
    return false;
  }
  const nextConstruction = () => chapters[state.buildings.home].find(([id, level]) => (state.buildings[id] ?? 0) < level
    && !state.jobs.some(job => job.kind === "construction" && job.targetId === id && job.targetLevel >= level));
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
  function act() {
    if (claimReady()) return true;
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
  const completed = () => state.buildings.home === 5 && !nextConstruction() && chapterRecipesComplete() && state.jobs.length === 0;
  for (let visit = 0; visit < maximumDays * 3 && !completed(); visit++) {
    const activeMinutes = visit === 0 ? 60 : regularActiveMinutes;
    const begin = epoch + visit * 8 * hour, end = begin + activeMinutes * 60000;
    windows.push({ begin, end });
    clock = begin; visitCount++; activeStart = begin; activeEnd = end;
    let commands = 0;
    while (clock <= end && !completed()) {
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
    actions, flow, production, catches, repeatOrders, visitCount, activeSeconds, constructionSeconds, berryClaims, checkpoints, windows, startingCoins, startingItems, regularActiveMinutes, completed: completed() };
}


// This conservative reachability route uses one free slot and no food, purchases
// or pearls. It also makes every berry product at its advertised house. The
// monthly balance is measured separately by the unified gameplay simulator.
// Visits happen eight hours apart; missed recipe finishes wait until the next.
// v15 charges 129,850 coins for this optional recipe route. The unchanged policy
// completes in 64/105 days and 11,031/10,618 commands; keep a small regression
// margin rather than the v14 budget. This is reachability, not an optimal route.
for (const [minutes, maximumDays, maximumCommands] of [[30, 66, 11400], [15, 108, 11000]]) test(`a conservative free account with ${minutes}-minute visits earns every house and berry product without resetting its stock`, t => {
  const result = completeJourney(minutes, maximumDays), { state, clock, flow, courses, builds, berryClaims, checkpoints, actions } = result;
  t.diagnostic(JSON.stringify({ elapsedDays: (clock - epoch) / (24 * hour), visits: result.visitCount,
    firstVisitMinutes: 60, laterVisitMinutes: result.regularActiveMinutes, activeTimerHours: result.activeSeconds / 3600,
    builderHours: result.constructionSeconds / 3600, peak: result.peak, coins: state.wallet.coins,
    constructionCoins: result.constructionCoins, courseCoins: result.courseCoins,
    repeatCoins: result.repeatCoins, saleCoins: result.saleCoins, commands: result.revision,
    fishCasts: actions.start_fishing, production: result.production,
    checkpoints: checkpoints.map(point => ({ ...point, day: (point.at - epoch) / (24 * hour) })),
    nextCourse: currentOfferId(state), remainingBuildings: state.buildings, inventory: state.inventory, jobs: state.jobs.map(job => ({ recipeId: job.recipeId, targetId: job.targetId, rewards: job.rewards })) }));
  assert(result.completed, "the bounded real command route completes all goals");
  assert.equal(state.buildings.home, 5); assert.equal(state.buildings.bridge, 1); assert.equal(state.buildings.lighthouse, 1);
  assert.equal(state.buildings.garden, 5); assert.equal(state.buildings.warehouse, 1); assert.equal(state.jobs.length, 0);
  assert.equal(state.wallet.pearls, 0); assert.deepEqual(state.productionSlots ?? {}, {});
  assert.equal(state.wallet.coins, result.startingCoins + result.courseCoins + result.repeatCoins + result.saleCoins - result.constructionCoins);
  for (const [id, counts] of Object.entries(flow))
    assert.equal(counts.received - counts.consumed - counts.sold, state.inventory[id] ?? 0, `${id} remains conserved across all chapters`);
  for (const [home, recipes] of Object.entries(newRecipes)) for (const recipe of recipes) {
    const claims = berryClaims.filter(claim => claim.recipeId === recipe);
    assert(claims.length > 0, `${recipe} was really made and claimed`);
    assert.equal(claims[0].home, Number(home), `${recipe} is experienced before leaving its intended house`);
    assert.equal(Object.values(claims[0].rewards).reduce((sum, count) => sum + count, 0), 1);
  }
  assert.equal(checkpoints.find(point => point.target === "bridge").home, 2);
  assert.equal(checkpoints.find(point => point.target === "lighthouse").home, 3);
  assert.equal(state.progression.routes.ancient_ruins, 1);
  assert.equal(state.tutorialOrder.completed, true);
  const teaching = courses.filter(course => course.id === tutorial.TUTORIAL_ORDER_ID);
  assert.equal(teaching.length, 1, "only the first ripe raspberry is an instructional request");
  assert.deepEqual(teaching[0].items, { berries: 1 }); assert.equal(teaching[0].coins, 13);
  const firstProject = courses.filter(course => course.id.startsWith("stage1_"));
  assert.deepEqual(firstProject.map(course => [course.id, course.items, course.coins]),
    catalog.stageOrders.find(stage => stage.homeLevel === 1).orders.map(order => [order.id, order.items, order.coins]));
  assert.equal(courses.length, 1 + 3 + 7 + 8 + 12);
  assert.equal(result.courseCoins, teaching[0].coins + catalog.stageOrders.reduce((sum, stage) =>
    sum + stage.orders.reduce((total, order) => total + order.coins, 0), 0));
  for (const [home, count] of [[1, 3], [2, 7], [3, 8], [4, 12]]) {
    assert.equal(state.stageOrders.stages[String(home)].step, count); assert.equal(state.stageOrders.stages[String(home)].completed, true);
    const chapter = courses.filter(course => course.id.startsWith(`stage${home}_`));
    const interval = catalog.stageOrders.find(stage => stage.homeLevel === home).intervalSeconds * 1000;
    for (let index = 1; index < chapter.length; index++)
      assert(chapter[index].at - chapter[index - 1].at >= interval);
  }
  assert.deepEqual(builds.map(build => `${build.target}:${build.level}`), constructionSequence.map(([id, level]) => `${id}:${level}`));
  for (const action of ["buy_market_slot", "buy_production_slot", "claim_tutorial_order", "claim_workshop_starter", "speedup_construction", "eat_food", "feed_builder", "buy", "buy_fish"])
    assert.equal(actions[action], undefined, `${action} is not needed for free progress`);
  assert.equal(result.constructionCoins, constructionSequence.reduce((sum, [id, level]) =>
    sum + catalog.buildings.find(building => building.id === id).levels.find(spec => spec.level === level).cost.coins, 0));
  const mineJobs = Object.entries(result.production).filter(([id]) => catalog.explorations.find(route => route.id === id)?.activity === "mining");
  assert(mineJobs.length > 0, "the real route uses independent mining");
  for (const [id] of mineJobs) {
    const route = catalog.explorations.find(route => route.id === id);
    assert(!route.retired, `${id}: no retired overnight batches`);
    assert.equal(Object.values(route.rewards).reduce((sum, count) => sum + count, 0), 1, `${id}: one item per extraction`);
  }
  for (const id of ["ancient_core", "moon_crystal"]) {
    assert.equal(flow[id].received, 1); assert.equal(flow[id].consumed, 1); assert.equal(flow[id].sold, 0);
  }
  assert(result.revision <= maximumCommands, "v15 paid construction and all berry products stay within the measured command budget");
  assert(result.peak <= 50); assert(clock - epoch <= maximumDays * 24 * hour);
});
const currentOfferId = state => (tutorial.tutorialResidentOrder(state) ?? stages.stageResidentOrder(state))?.id;
