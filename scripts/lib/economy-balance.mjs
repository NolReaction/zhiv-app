import assert from "node:assert/strict";

/** Timed production can create value; an unattended bundle must not create
 * extra raw materials or outperform its unlocked elementary station jobs. */
export function auditProductionBalance(catalog) {
  const items = new Map(catalog.items.map(item => [item.id, item]));
  const fish = new Set(catalog.fishing?.fish.map(item => item.itemId) ?? []);
  const moneyScale = catalog.currencyScale ?? 1;
  const value = quantities => Object.entries(quantities).reduce((sum, [id, quantity]) => sum
    + (fish.has(id) ? items.get(id).baseSellPrice * quantity
      : Math.floor(items.get(id).baseSellPrice / moneyScale * quantity * (catalog.localBuyer?.payoutBps ?? 10000) / 10000) * moneyScale), 0);
  const net = recipe => value(recipe.rewards) - value(recipe.cost.items) - recipe.cost.coins;
  const rows = [];
  const mining = catalog.explorations.filter(route => route.activity === "mining" && route.requiredBuildings?.quarry && route.id.startsWith("quarry_"));
  const station = recipe => recipe.buildingId ?? (recipe.activity === "mining" ? "quarry" : null);
  const level = recipe => recipe.buildingLevel ?? recipe.requiredBuildings?.quarry;
  const definitions = [...catalog.recipes, ...mining];
  for (const recipe of definitions) {
    const batchLimit = recipe.buildingId ? recipe.maxBatch : 1;
    const free = recipe.cost.coins === 0 && !Object.keys(recipe.cost.items).length;
    const long = recipe.seconds >= 14400;
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
      if (free && level(recipe) === 1) {
        const capacity = catalog.buildings.find(building => building.id === "warehouse").levels[0].warehouseCapacity;
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
