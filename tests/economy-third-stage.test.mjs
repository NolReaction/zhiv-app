import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const stages = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
after(() => vite.close());
const epoch = Date.parse("2026-10-14T09:00:00Z"), hour = 3600000;

test("a real one-slot 50-place house-three route funds new material chains and earns its project resin", () => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  Object.assign(state.buildings, { home: 3, garden: 1, warehouse: 1, woodlot: 1, workshop: 1, quarry: 2, kiln: 1, dryer: 1 });
  state.wallet = { coins: 230, pearls: 0 }; state.inventory = {};
  state.tutorialOrder = { version: 2, step: 4, completed: true, ingredientsClaimed: true, terms: null };
  state.stageOrders = { version: 1, stages: { 2: { step: 5, completed: true, terms: null } } };
  let clock = epoch, sequence = 0, revision = 0, peak = 0, constructionCoins = 0, courseCoins = 0, repeatCoins = 0, saleCoins = 0;
  const courses = [], builds = [], actions = {}, flow = {}, production = {}, catches = {}, acquisitionTargets = [];
  const uuid = () => `00000000-0000-4000-9000-${(++sequence).toString(16).padStart(12, "0")}`;
  const record = id => flow[id] ??= { received: 0, consumed: 0, sold: 0 };
  const currentCourse = () => stages.stageResidentOrder(state);
  const held = items => Object.entries(items).every(([id, count]) => (state.inventory[id] ?? 0) >= count);
  function apply(action, targetId, quantity = 1) {
    const before = structuredClone(state), offer = action === "complete_resident_order" ? currentCourse() : null;
    rules.applyEconomyCommand(state, { requestId: uuid(), ownerPublicId: "0000-0000-0001", expectedRevision: revision,
      action, targetId, quantity, totalPrice: 0 }, clock, uuid, {}, maximum => maximum - 1);
    revision++; actions[action] = (actions[action] ?? 0) + 1;
    if (action === "start_construction") {
      constructionCoins += before.wallet.coins - state.wallet.coins;
      builds.push({ target: targetId, level: state.jobs.find(job => job.kind === "construction").targetLevel, startedAt: clock });
    }
    if (action === "complete_resident_order") {
      const coins = state.wallet.coins - before.wallet.coins;
      if (offer?.id === targetId) { courseCoins += coins; courses.push({ id: targetId, at: clock, items: offer.items, coins }); }
      else repeatCoins += coins;
    }
    if (action === "sell" || action === "sell_fish") saleCoins += state.wallet.coins - before.wallet.coins;
    for (const id of new Set([...Object.keys(before.inventory), ...Object.keys(state.inventory)])) {
      const delta = (state.inventory[id] ?? 0) - (before.inventory[id] ?? 0);
      if (delta > 0) record(id).received += delta;
      else if (delta < 0) record(id)[action === "sell" || action === "sell_fish" ? "sold" : "consumed"] -= delta;
    }
    const storage = rules.economyStorage(state); peak = Math.max(peak, storage.used);
    assert.equal(storage.capacity, 50); assert(storage.used <= 50, `${action}:${targetId} exceeds the original warehouse`);
    assert.equal(state.wallet.pearls, 0); assert.deepEqual(state.productionSlots ?? {}, {}); assert.equal(state.marketSlots, 5);
    assert(state.jobs.filter(job => job.kind === "construction").length <= 1);
    for (const id of ["garden", "woodlot", "workshop", "dryer", "kiln"])
      assert(state.jobs.filter(job => job.kind === "production" && job.targetId === id).length <= 1);
    assert(state.jobs.filter(job => job.actorId === "miner").length <= 1);
    assert(state.jobs.every(job => !job.meal));
  }
  function readyCourse() {
    const offer = currentCourse();
    if (offer && held(offer.items) && Date.parse(offer.availableAt) <= clock) apply("complete_resident_order", offer.id);
  }
  function advance(at) {
    assert(at >= clock, "the route never rewinds time");
    const offer = currentCourse(), due = offer && Date.parse(offer.availableAt);
    if (offer && held(offer.items) && due > clock && due <= at) { clock = due; readyCourse(); }
    clock = at;
    for (const job of [...state.jobs]) if (job.kind === "construction" && Date.parse(job.finishesAt) <= clock) apply("claim_job", job.id);
    readyCourse();
  }
  function receive(action, targetId) {
    for (;;) {
      try { apply(action, targetId); break; }
      catch (error) {
        if (error.code !== "ECONOMY_STORAGE_FULL") throw error;
        const targets = [...acquisitionTargets, currentCourse()?.items ?? {}];
        const surplus = Object.entries(state.inventory).filter(([id]) => catalog.items.some(item => item.id === id && item.tradable))
          .map(([id, count]) => [id, count - Math.max(0, ...targets.map(items => items[id] ?? 0))])
          .filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])[0];
        assert(surplus, "a full warehouse must release real surplus, never inject capacity");
        apply(catalog.fishing.classes.some(group => group.itemId === surplus[0]) ? "sell_fish" : "sell", surplus[0], 1);
      }
    }
  }
  function finish(job) {
    advance(Date.parse(job.finishesAt));
    if (job.collection) {
      receive("start_collection", job.id);
      advance(Date.parse(state.jobs.find(current => current.id === job.id).collection.finishesAt));
    }
    const before = { ...state.inventory };
    receive("claim_job", job.id);
    if (job.fishing) for (const [id, count] of Object.entries(state.inventory)) {
      const gained = count - (before[id] ?? 0); if (gained > 0 && id.startsWith("fish_")) catches[id] = (catches[id] ?? 0) + gained;
    }
    readyCourse();
  }
  function waitBuilder() {
    const job = state.jobs.find(job => job.kind === "construction");
    assert(job, "a locked source must have an actual in-progress required upgrade"); advance(Date.parse(job.finishesAt));
  }
  const sourceOpen = source => !source.retired && state.buildings.home >= source.requiredHomeLevel
    && Object.entries(source.requiredBuildings ?? {}).every(([id, level]) => (state.buildings[id] ?? 0) >= level)
    && (!source.buildingId || (state.buildings[source.buildingId] ?? 0) >= source.buildingLevel);
  const recipeOpen = source => Object.entries(source.requiredRecipes ?? {}).every(([id, count]) => (state.progression.recipes[id] ?? 0) >= count);
  const sources = id => [...catalog.recipes, ...catalog.explorations.filter(route => !catalog.fishing.routeIds.includes(route.id))]
    .filter(source => source.rewards[id] > 0 && sourceOpen(source) && recipeOpen(source))
    .sort((a, b) => a.seconds / a.rewards[id] - b.seconds / b.rewards[id]);
  function sellExtraFish() {
    for (const id of Object.keys(state.inventory).filter(id => catalog.fishing.classes.some(group => group.itemId === id) && id !== "fish_common"))
      apply("sell_fish", id, state.inventory[id]);
  }
  function run(source) {
    if (source.buildingId && state.jobs.some(job => job.kind === "construction" && job.targetId === source.buildingId)
      || source.requiredBuildings?.quarry && state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry")) waitBuilder();
    acquisitionTargets.push(source.cost.items);
    try {
      do {
        for (const [id, count] of Object.entries(source.cost.items)) ensure(id, count);
      } while (!held(source.cost.items)); // A due project delivery may use previously prepared inputs.
    } finally { acquisitionTargets.pop(); }
    apply(source.buildingId ? "start_production" : "start_exploration", source.id);
    production[source.id] = (production[source.id] ?? 0) + 1;
    finish(state.jobs.find(job => job.recipeId === source.id || job.kind === "exploration" && job.targetId === source.id));
  }
  function ensure(id, count) {
    let attempts = 0;
    while ((state.inventory[id] ?? 0) < count) {
      assert(++attempts <= 200, `bounded material acquisition: ${id}`);
      if (id === "fish_common") {
        apply("start_fishing", "shore"); finish(state.jobs.find(job => job.targetId === "shore")); sellExtraFish(); continue;
      }
      let source = sources(id)[0];
      if (!source) {
        const locked = catalog.recipes.find(recipe => recipe.rewards[id] > 0 && sourceOpen(recipe));
        if (locked && Object.keys(locked.requiredRecipes ?? {}).length) {
          for (const [recipeId, required] of Object.entries(locked.requiredRecipes))
            while ((state.progression.recipes[recipeId] ?? 0) < required) run(catalog.recipes.find(recipe => recipe.id === recipeId));
          source = sources(id)[0];
        } else { waitBuilder(); continue; }
      }
      assert(source, `no available source for ${id}`); run(source);
    }
  }
  function bundle(items, deferRelics = false, courseId = null) {
    acquisitionTargets.push(items);
    try {
      for (const [id, count] of Object.entries(items)) {
        if (courseId && currentCourse()?.id !== courseId) return;
        if (deferRelics && catalog.rareDrops.itemIds.includes(id)) continue;
        ensure(id, count);
      }
    } finally { acquisitionTargets.pop(); }
  }
  function prepareCourse() {
    for (;;) {
      const offer = currentCourse(), reachable = food.obtainableResidentOrderItems(state);
      if (!offer || !Object.keys(offer.items).every(id => reachable.has(id))) return;
      bundle(offer.items, false, offer.id); readyCourse();
      if (currentCourse()?.id === offer.id) return;
    }
  }
  function earn(requiredCoins) {
    let attempts = 0;
    while (state.wallet.coins < requiredCoins) {
      assert(++attempts <= 100, "income is earned through a bounded number of repeatable resident orders");
      const offers = food.residentOrderBoard(state, clock).offers;
      const effort = offer => Object.entries(offer.items).reduce((sum, [id, count]) => sum + count
        * (id === "fish_common" ? catalog.explorations.find(route => route.id === "shore").seconds : sources(id)[0]?.seconds ?? 1e9), 0);
      const canMake = (id, path = []) => id === "fish_common" || !path.includes(id)
        && sources(id).some(source => Object.keys(source.cost.items).every(item => canMake(item, [...path, id])));
      const offer = offers.filter(entry => Object.keys(entry.items).every(id => canMake(id)))
        .sort((a, b) => b.coins / effort(b) - a.coins / effort(a))[0];
      if (!offer) {
        // A new species-specific order can be declined by this deliberately
        // basic-tackle route. Earn the coins through actual extraction and sale.
        const item = sources("ore").length ? "ore" : "wood", source = sources(item)[0];
        assert(source, "an unlocked commodity provides repeatable NPC income");
        run(source); apply("sell", item, Math.min(source.rewards[item], state.inventory[item])); continue;
      }
      bundle(offer.items);
      if (held(offer.items) && food.residentOrderBoard(state, clock).offers.some(current => current.id === offer.id))
        apply("complete_resident_order", offer.id);
    }
  }
  function construct(id, level) {
    const definition = catalog.buildings.find(building => building.id === id).levels.find(value => value.level === level);
    const stock = () => {
      const needed = { ...definition.cost.items }, offer = currentCourse(), reachable = food.obtainableResidentOrderItems(state);
      if (offer) for (const [item, count] of Object.entries(offer.items)) if (reachable.has(item)) needed[item] = (needed[item] ?? 0) + count;
      bundle(needed);
    };
    prepareCourse(); stock(); earn(definition.cost.coins); stock();
    if (state.jobs.some(job => job.kind === "construction")) waitBuilder();
    prepareCourse(); stock(); earn(definition.cost.coins); stock();
    apply("start_construction", id); prepareCourse();
  }

  prepareCourse(); assert.equal(courses.length, 1, "the first delivery is immediately available once its actual materials are ready");
  const upgrades = [["woodlot", 2], ["kiln", 2], ["workshop", 2], ["garden", 2], ["dryer", 2],
    ["woodlot", 3], ["workshop", 3], ["quarry", 3], ["kiln", 3], ["garden", 3], ["dryer", 3]];
  for (const [id, level] of upgrades) construct(id, level);
  const home = catalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 4);
  while (currentCourse()) {
    bundle(currentCourse().items); readyCourse();
    if (currentCourse()) {
      bundle(home.cost.items, true); earn(home.cost.coins);
      const offer = currentCourse(); bundle(offer.items); if (Date.parse(offer.availableAt) > clock) advance(Date.parse(offer.availableAt)); readyCourse();
    }
  }
  if (state.jobs.some(job => job.kind === "construction")) waitBuilder();
  bundle(home.cost.items); earn(home.cost.coins); bundle(home.cost.items); apply("start_construction", "home"); waitBuilder();

  assert.equal(state.buildings.home, 4); assert.equal(state.buildings.warehouse, 1); assert.equal(state.jobs.length, 0);
  assert.equal(courses.length, 8);
  assert.equal(courseCoins, catalog.stageOrders.find(stage => stage.homeLevel === 3).orders.reduce((sum, order) => sum + order.coins, 0));
  assert.equal(constructionCoins, builds.reduce((sum, build) => sum + catalog.buildings.find(entry => entry.id === build.target)
    .levels.find(level => level.level === build.level).cost.coins, 0));
  assert.equal(catalog.stageOrders.find(stage => stage.homeLevel === 3).intervalSeconds, 0);
  for (let index = 1; index < courses.length; index++) assert(courses[index].at >= courses[index - 1].at);
  assert(clock - courses.at(-1).at >= home.seconds * 1000, "the final house waits for its full current builder timer");
  assert(clock - epoch < 10 * 24 * hour, JSON.stringify({ elapsedHours: (clock - epoch) / hour,
    deliveryHours: courses.map(offer => (offer.at - epoch) / hour), builds: builds.map(build => ({ target: build.target, level: build.level, hours: (build.startedAt - epoch) / hour })), peak,
    message: "the concrete route fits ten days with one worker and original storage" }));
  assert(repeatCoins > 0); assert(actions.start_fishing > 0); assert(production.cook_fish_soup >= 5); assert(catches.fish_common >= 16);
  assert.equal(record("living_resin").received, 1); assert.equal(record("living_resin").consumed, 1);
  assert.equal(state.inventory.living_resin, undefined);
  assert.equal(state.wallet.coins, 230 + courseCoins + repeatCoins + saleCoins - constructionCoins);
  for (const [id, counts] of Object.entries(flow)) assert.equal(counts.received - counts.consumed - counts.sold, state.inventory[id] ?? 0, `${id} is conserved`);
  for (const action of ["buy_market_slot", "buy_production_slot", "claim_tutorial_order", "claim_workshop_starter", "speedup_construction", "feed_hero", "feed_builder"])
    assert.equal(actions[action], undefined);
  assert(peak <= 50); assert.deepEqual(builds.map(build => `${build.target}:${build.level}`),
    [...upgrades.map(([id, level]) => `${id}:${level}`), "home:4"]);
  console.log(JSON.stringify({ elapsedHours: (clock - epoch) / hour, firstDeliveryHours: (courses[0].at - epoch) / hour,
    deliveryHours: courses.map(offer => (offer.at - epoch) / hour), peak, coins: state.wallet.coins, repeatCoins, saleCoins, commands: revision }));
});

// A player's accepted daily rhythm remains a saved promise after new chapters
// replace the daily waiting gate with material requirements.
test("an accepted v9 chapter keeps its 24-hour delivery interval while new v14 chapters have no waiting gate", () => {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings.home = 3; state.wallet = { coins: 0, pearls: 0 };
  state.tutorialOrder = { version: 2, step: 4, completed: true, ingredientsClaimed: true, terms: null };
  const course = catalog.stageOrders.find(course => course.homeLevel === 3);
  assert.equal(course.intervalSeconds, 0);
  state.stageOrders = { version: 1, stages: { 3: { step: 0, completed: false,
    terms: structuredClone(course.orders[0]), availableAt: new Date(epoch).toISOString(),
    intervalSeconds: 24 * 3600, completionRewards: { living_resin: 1 } } } };
  state.inventory = { ...course.orders[0].items, ...course.orders[1].items };
  const apply = (targetId, at) => rules.applyEconomyCommand(state, { requestId: crypto.randomUUID(),
    ownerPublicId: "0000-0000-0001", expectedRevision: 0, action: "complete_resident_order", targetId, quantity: 1, totalPrice: 0 }, at, crypto.randomUUID);
  apply(course.orders[0].id, epoch);
  const pinned = structuredClone(state);
  assert.equal(Date.parse(stages.stageResidentOrder(state).availableAt), epoch + 24 * hour);
  assert.equal(state.stageOrders.stages["3"].intervalSeconds, 24 * 3600);
  assert.throws(() => apply(course.orders[1].id, epoch + 23 * hour), { code: "ECONOMY_STAGE_WAIT" });
  assert.deepEqual(state.inventory, pinned.inventory); assert.deepEqual(state.wallet, pinned.wallet);
  assert.deepEqual(state.stageOrders, pinned.stageOrders);
  apply(course.orders[1].id, epoch + 24 * hour);
  assert.equal(state.stageOrders.stages["3"].step, 2);
  assert.equal(state.wallet.coins, course.orders[0].coins + course.orders[1].coins);
  assert.equal(Date.parse(stages.stageResidentOrder(state).availableAt), epoch + 48 * hour);
});
