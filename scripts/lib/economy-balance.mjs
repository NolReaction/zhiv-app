import assert from "node:assert/strict";
import { createLiquidation, recipeBuildingLevel } from "./economy-math.mjs";

/** Timed production can create value; an unattended bundle must not create
 * extra raw materials or outperform its unlocked elementary station jobs. */
export function auditProductionBalance(catalog) {
  catalog = { ...catalog, recipes: catalog.recipes.filter(source => !source.retired), explorations: catalog.explorations.filter(source => !source.retired) };
  const value = createLiquidation(catalog);
  const net = recipe => value(recipe.rewards) - value(recipe.cost.items) - recipe.cost.coins;
  const rows = [];
  const mining = catalog.explorations.filter(route => route.activity === "mining" && route.requiredBuildings?.quarry && (catalog.version >= 13 || route.id.startsWith("quarry_")));
  const station = recipe => recipe.buildingId ?? (recipe.activity === "mining" ? "quarry" : null);
  const level = recipe => recipeBuildingLevel(recipe) ?? recipe.requiredBuildings?.quarry;
  const definitions = [...catalog.recipes, ...mining];
  for (const recipe of definitions) {
    const batchLimit = recipe.buildingId ? recipe.maxBatch : 1;
    const free = recipe.cost.coins === 0 && !Object.keys(recipe.cost.items).length;
    const long = recipe.seconds >= 14400;
    if (catalog.version >= 13) {
      assert(recipe.seconds <= 3600, `${recipe.id}: unit production cannot exceed one hour`);
      assert.equal(Object.values(recipe.rewards).reduce((sum, count) => sum + count, 0), 1, `${recipe.id}: a new job must yield exactly one item`);
    }
    assert(Number.isInteger(batchLimit) && batchLimit >= 1 && batchLimit <= catalog.maxBatch,
      `${recipe.id}: explicit production batch limit required`);
    if (free || long) assert.equal(batchLimit, 1, `${recipe.id}: free gathering and long orders cannot be bulk queued`);
    else assert(recipe.seconds * batchLimit <= Math.max(7200, recipe.seconds), `${recipe.id}: active queue exceeds two hours`);
    assert(net(recipe) > 0, `${recipe.id}: nonpositive processing margin`);
    let activeSeconds = recipe.seconds;
    if (long) {
      const short = definitions.filter(other => station(other) === station(recipe)
        && level(other) <= level(recipe) && other.requiredHomeLevel <= recipe.requiredHomeLevel
        && other.seconds < 14400 && Object.keys(other.rewards).length === 1);
      const primitive = new Map();
      for (const job of short) {
        const item = Object.keys(job.rewards)[0], previous = primitive.get(item);
        if (!previous || job.seconds / job.rewards[item] < previous.seconds / previous.rewards[item]) primitive.set(item, job);
      }
      const required = {}; let coins = 0; activeSeconds = 0;
      const expand = (item, quantity, path = []) => {
        const base = item in recipe.rewards ? primitive.get(item) : null;
        if (!base) { required[item] = (required[item] ?? 0) + quantity; return; }
        assert(!path.includes(item), `${recipe.id}: circular production`);
        const count = quantity / base.rewards[item];
        activeSeconds += count * base.seconds; coins += count * base.cost.coins;
        for (const [ingredient, amount] of Object.entries(base.cost.items)) expand(ingredient, amount * count, [...path, item]);
      };
      for (const [item, quantity] of Object.entries(recipe.rewards)) {
        assert(primitive.has(item), `${recipe.id}: output has no active alternative`);
        expand(item, quantity);
      }
      for (const [item, quantity] of Object.entries(required)) assert((recipe.cost.items[item] ?? 0) + 1e-8 >= quantity,
        `${recipe.id}: bulk order invents ${item}`);
      assert(recipe.cost.coins + 1e-8 >= coins, `${recipe.id}: bulk order discounts input coins`);
      const efficiency = [0, .4, .45, .6, .7, .85][level(recipe)];
      assert(activeSeconds <= recipe.seconds * efficiency + 1e-8,
        `${recipe.id}: unattended output exceeds ${efficiency * 100}% of active station work`);
      const fastestMargin = Math.max(...short.map(job => net(job) / job.seconds));
      assert(net(recipe) / recipe.seconds <= fastestMargin + 1e-8, `${recipe.id}: unattended sale income exceeds active jobs`);
      if (free && level(recipe) === 1 && recipe.requiredHomeLevel === 1) {
        const home = catalog.buildings.find(building => building.id === "home").levels.find(level => level.level === recipe.requiredHomeLevel);
        const storageLevel = Math.max(1, recipe.requiredBuildings?.warehouse ?? 1, home?.requiredBuildings?.warehouse ?? 1);
        const capacity = catalog.buildings.find(building => building.id === "warehouse").levels[storageLevel - 1].warehouseCapacity;
        assert(Object.values(recipe.rewards).reduce((sum, quantity) => sum + quantity, 0) <= capacity * .25,
          `${recipe.id}: starter overnight harvest occupies more than a quarter of storage`);
      }
    }
    rows.push({ id: recipe.id, hours: recipe.seconds / 3600, output: Object.values(recipe.rewards).reduce((a, b) => a + b, 0),
      revenue: value(recipe.rewards), inputValue: value(recipe.cost.items) + recipe.cost.coins,
      net: net(recipe), netPerHour: net(recipe) * 3600 / recipe.seconds, activeWorkHours: activeSeconds / 3600 });
  }
  for (const route of catalog.explorations.filter(route => !mining.includes(route))) {
    assert(net(route) > 0, `${route.id}: expedition consumes more sale value than it returns`);
    rows.push({ id: route.id, hours: route.seconds / 3600, output: Object.values(route.rewards).reduce((a, b) => a + b, 0),
      revenue: value(route.rewards), inputValue: value(route.cost.items) + route.cost.coins, net: net(route), netPerHour: net(route) * 3600 / route.seconds });
  }
  // Every recipe edge must move towards a later product. A new conversion back
  // to raw inputs requires an explicit new audit, rather than a silent cycle.
  const edges = new Map();
  for (const recipe of catalog.recipes) for (const input of Object.keys(recipe.cost.items)) {
    const next = edges.get(input) ?? new Set();
    for (const output of Object.keys(recipe.rewards)) next.add(output);
    edges.set(input, next);
  }
  const done = new Set();
  const visit = (item, path = new Set()) => {
    assert(!path.has(item), `Production conversion cycle at ${item}`);
    if (done.has(item)) return;
    for (const output of edges.get(item) ?? []) visit(output, new Set(path).add(item));
    done.add(item);
  };
  for (const item of edges.keys()) visit(item);
  return rows;
}

/** Current project contracts retain their identity; v14 gates work by materials. */
export function auditProjectCourses(catalog) {
  const items = new Set(catalog.items.map(item => item.id));
  const buildings = new Map(catalog.buildings.map(building => [building.id, building]));
  const routes = new Map(catalog.explorations.map(route => [route.id, route]));
  const courses = new Map((catalog.stageOrders ?? []).map(stage => [stage.homeLevel, stage]));
  assert.equal(courses.size, catalog.stageOrders?.length, "Duplicate project home level");
  const ids = new Set();
  for (const stage of courses.values()) {
    assert(Number.isSafeInteger(stage.intervalSeconds ?? 0) && (stage.intervalSeconds ?? 0) >= 0, "Invalid project interval");
    for (const order of stage.orders) {
      assert(!ids.has(order.id), `Duplicate project order ${order.id}`); ids.add(order.id);
      assert(Number.isSafeInteger(order.coins) && order.coins > 0, `${order.id}: invalid project reward`);
      assert(Object.keys(order.items).length > 0 && Object.entries(order.items).every(([id, quantity]) =>
        items.has(id) && Number.isSafeInteger(quantity) && quantity > 0), `${order.id}: invalid project ingredients`);
      assert(Object.values(order.items).reduce((sum, count) => sum + count, 0) <= 50, `${order.id}: project delivery exceeds starter storage`);
      assert(!Object.hasOwn(order.requiredBuildings ?? {}, "warehouse"), `${order.id}: storage must remain optional for projects`);
      for (const [id, level] of Object.entries(order.requiredBuildings ?? {})) {
        assert(buildings.get(id)?.levels.some(spec => spec.level === level), `${order.id}: unknown project building ${id}:${level}`);
      }
      for (const [id, count] of Object.entries(order.requiredExplorations ?? {})) {
        assert(routes.has(id) && Number.isSafeInteger(count) && count > 0, `${order.id}: unknown or invalid claimed exploration ${id}`);
        assert(routes.get(id).requiredHomeLevel <= stage.homeLevel, `${order.id}: claimed exploration opens after its project`);
      }
    }
    assert(Object.entries(stage.completionRewards ?? {}).every(([id, quantity]) => items.has(id)
      && Number.isSafeInteger(quantity) && quantity > 0), "Invalid project completion reward");
  }
  const third = courses.get(3), fourth = courses.get(4);
  const interval = catalog.version >= 14 ? 0 : 23 * 3600;
  assert(third?.orders.length === 8 && third.intervalSeconds === interval,
    "Third stage must retain eight deliveries and its versioned interval");
  assert.deepEqual(third.completionRewards, { living_resin: 1 }, "Third stage must guarantee its home relic");
  assert(fourth?.orders.length === 12 && fourth.intervalSeconds === interval,
    "Fourth stage must retain twelve deliveries and its versioned interval");
  if (catalog.version < 13) assert.equal(fourth.orders.reduce((sum, order) => sum + order.coins, 0), 50000,
    "Fourth stage one-time project financing must total 50000 coins");
  else {
    const value = createLiquidation(catalog);
    for (const stage of courses.values()) for (const order of stage.orders)
      assert.equal(order.coins, Math.ceil(value(order.items) * 125 / 100), `${order.id}: project must pay item value plus 25 percent`);
  }
  assert.deepEqual(fourth.completionRewards, { ancient_core: 1, moon_crystal: 1 }, "Fourth stage must guarantee both home relics");
  assert(fourth.orders.slice(4).every(order => order.requiredBuildings?.bridge === 1), "Fourth stage deliveries from five onward require the bridge");
  const final = fourth.orders.at(-1);
  assert.equal(final.requiredBuildings?.lighthouse, 1, "Fourth stage final delivery requires the lighthouse");
  assert.equal(final.requiredExplorations?.ancient_ruins, 1, "Fourth stage final delivery requires a claimed ruins expedition");
  const rare = new Set(catalog.rareDrops?.itemIds ?? []);
  const rareFish = new Set([...(catalog.fishing?.classes ?? []), ...(catalog.fishing?.fish ?? [])]
    .filter(fish => ["rare", "epic", "legendary"].includes(fish.rarity)).map(fish => fish.itemId));
  const dependsOnRare = (id, path = new Set()) => {
    if (rare.has(id) || rareFish.has(id)) return true;
    if (path.has(id)) return false; // The general production audit reports cycles separately.
    const recipe = catalog.recipes.find(recipe => recipe.rewards[id] > 0);
    return Boolean(recipe && Object.keys(recipe.cost.items).some(input => dependsOnRare(input, new Set(path).add(id))));
  };
  assert(fourth.orders.every(order => Object.keys(order.items).every(id => !dependsOnRare(id))),
    "Fourth stage deliveries must not depend on a rare find or rare fish, including recipe ingredients");
  for (const stage of [third, fourth]) {
    const home = buildings.get("home").levels.find(level => level.level === stage.homeLevel + 1);
    assert(home, `Project ${stage.homeLevel}: next home is missing`);
    assert(Object.entries(home.cost.items).filter(([id]) => rare.has(id)).every(([id, quantity]) =>
      quantity <= (stage.completionRewards[id] ?? 0)), `Home ${home.level}: required relics must be covered by guaranteed project rewards`);
  }
  return [...courses.values()].map(stage => ({ homeLevel: stage.homeLevel, orderCount: stage.orders.length,
    intervalSeconds: stage.intervalSeconds ?? 0, minimumWaitSeconds: Math.max(0, stage.orders.length - 1) * (stage.intervalSeconds ?? 0),
    coins: stage.orders.reduce((sum, order) => sum + order.coins, 0), completionRewards: { ...stage.completionRewards },
    requiredClaimedExplorations: Object.assign({}, ...stage.orders.map(order => order.requiredExplorations ?? {})) }));
}

/** Unit work and construction accounting; this is not a calendar-playthrough simulation. */
export function auditFourthStageBudget(catalog, requiredConstruction) {
  const constructionCoins = requiredConstruction.reduce((sum, node) => sum + node.cost.coins, 0);
  const constructionSeconds = requiredConstruction.reduce((sum, node) => sum + node.seconds, 0);
  if (catalog.version < 13) {
    assert.equal(constructionCoins, 70500, "Fourth stage mandatory construction must total 70500 coins (starting with unrestored landmarks)");
    assert.equal(constructionSeconds, 96 * 3600, "Fourth stage mandatory construction must total 96 hours");
  } else for (const node of requiredConstruction) {
    assert.equal(node.cost.coins, Math.ceil(node.seconds * catalog.timeEconomy.constructionCoinsPerMinute / 60),
      `${node.buildingId}:${node.level}: construction price must follow builder time`);
  }
  const stage = catalog.stageOrders.find(stage => stage.homeLevel === 4);
  const ruins = catalog.explorations.find(route => route.id === "ancient_ruins");
  assert(ruins, "Fourth stage needs a real ruins expedition");
  const runs = new Map(), queueSeconds = {};
  const expand = (itemId, count, path = new Set()) => {
    assert(!path.has(itemId), `Fourth stage recipe cycle at ${itemId}`);
    const recipe = catalog.recipes.filter(recipe => !recipe.retired && (recipe.rewards[itemId] ?? 0) > 0).sort((a, b) =>
      a.requiredHomeLevel - b.requiredHomeLevel || recipeBuildingLevel(a) - recipeBuildingLevel(b)
      || Object.keys(a.requiredRecipes ?? {}).length - Object.keys(b.requiredRecipes ?? {}).length
      || a.id.localeCompare(b.id))[0];
    if (!recipe) return;
    const amount = count / recipe.rewards[itemId];
    runs.set(recipe.id, (runs.get(recipe.id) ?? 0) + amount);
    queueSeconds[recipe.buildingId] = (queueSeconds[recipe.buildingId] ?? 0) + amount * recipe.seconds;
    for (const [id, quantity] of Object.entries(recipe.cost.items)) expand(id, quantity * amount, new Set(path).add(itemId));
  };
  for (const quantities of [...requiredConstruction.map(node => node.cost.items), ...stage.orders.map(order => order.items), ruins.cost.items]) {
    for (const [id, quantity] of Object.entries(quantities)) expand(id, quantity);
  }
  const longWorkshopRuns = Object.fromEntries([...runs].filter(([id]) => {
    const recipe = catalog.recipes.find(recipe => recipe.id === id);
    return recipe.buildingId === "workshop" && recipe.seconds >= 1800;
  }));
  const longWorkshopJobs = Object.values(longWorkshopRuns).reduce((sum, count) => sum + count, 0);
  assert(longWorkshopJobs <= 40, "Fourth stage mandatory workshop workload must stay within forty long unit jobs");
  return { constructionCoins, constructionSeconds, constructionCount: requiredConstruction.length,
    projectCoins: stage.orders.reduce((sum, order) => sum + order.coins, 0), longWorkshopJobs, longWorkshopRuns,
    productionQueueSeconds: queueSeconds, timingBasis: "Occupied queues and delivery waits are separate; visits, coins, mining, fishing and wall-clock playthrough are not simulated" };
}

/** Type reachability at each advertised home unlock, without later-home tools,
 * NPC purchases or player-market stock. This proves availability, not quantity,
 * affordability, random-fish deadlines or a feasible visit schedule. */
export function auditBuildingUnlocks(catalog) {
  const sources = [...catalog.recipes, ...catalog.explorations].filter(source => !source.retired);
  const rows = [];
  for (let home = 1; home <= 5; home++) {
    const levels = { home, garden: 1, warehouse: 1 }, items = new Set(), recipes = new Set();
    const permits = definition => home >= definition.requiredHomeLevel
      && Object.entries(definition.requiredBuildings ?? {}).every(([id, level]) => (levels[id] ?? 0) >= level);
    const materials = definition => Object.keys(definition.cost.items).every(id => items.has(id));
    let changed = true;
    while (changed) {
      changed = false;
      const obtain = id => { if (!items.has(id)) { items.add(id); changed = true; } };
      for (const source of sources) {
        if (!permits(source) || !materials(source)
          || source.buildingId && (levels[source.buildingId] ?? 0) < recipeBuildingLevel(source)
          || Object.keys(source.requiredRecipes ?? {}).some(id => !recipes.has(id))) continue;
        for (const id of Object.keys(source.rewards)) obtain(id);
        if (source.buildingId && !recipes.has(source.id)) { recipes.add(source.id); changed = true; }
        if (!source.buildingId && home >= catalog.rareDrops.requiredHomeLevel)
          for (const id of catalog.rareDrops.itemIds) obtain(id);
        if (catalog.fishing.routeIds.includes(source.id)) for (const fish of catalog.fishing.classes)
          if (catalog.fishing.rods.some(rod => rod.requiredHomeLevel <= home
            && rod.classOddsBps[fish.rarity] > 0 && (fish.rarity !== "legendary" || rod.rarity === "legendary"))) obtain(fish.itemId);
      }
      for (const building of catalog.buildings.filter(building => building.id !== "home")) {
        const next = building.levels.find(level => level.level === (levels[building.id] ?? 0) + 1);
        if (!next || !permits(next) || !materials(next)) continue;
        levels[building.id] = next.level; changed = true;
      }
    }
    for (const building of catalog.buildings) for (const level of building.levels) {
      if (building.id === "warehouse" && level.level >= 4) continue; // Optional relic levels deliberately have no home gate.
      const advertisedHome = building.id === "home" ? level.level - 1 : level.requiredHomeLevel;
      if (advertisedHome !== home) continue;
      const missing = Object.keys(level.cost.items).filter(id => !items.has(id));
      assert(missing.length === 0 && permits(level),
        `${building.id}:${level.level}: materials or prerequisites unavailable at advertised home ${home}: ${missing.join(", ")}`);
      if (building.id !== "home") assert((levels[building.id] ?? 0) >= level.level,
        `${building.id}:${level.level}: construction unavailable at advertised home ${home}`);
      rows.push({ buildingId: building.id, level: level.level, homeLevel: home });
    }
  }
  return rows;
}
