import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const actual = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const context = { exports: {}, require: id => {
    if (id === "@/features/economy/domain/model") return { economyCatalog: actual, recipeBuildingLevel: recipe => recipe.baseCampfire ? 0 : recipe.buildingLevel };
    if (id === "@/features/economy/domain/local-sale") return { economyLocalSellPrice: (price, count, config, itemId) => count * (config?.unitPrices?.[itemId] ?? Math.floor(price * (config?.payoutBps ?? 10000) / 10000)) };
    if (id.startsWith("./")) return load(id.slice(2));
    throw new Error(`Unexpected dependency: ${id}`);
  } };
  const source = readFileSync(new URL(`../features/progression/${name}.ts`, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  modules.set(name, context.exports); return context.exports;
}
const { planEconomyProduction, buildingsAtHomeLevel } = load("economy-plan");
const { buildEconomyAnalysis } = load("economy-analysis");
const plain = value => JSON.parse(JSON.stringify(value));
const recipe = (id, buildingId, seconds, items, rewards, extra = {}) => ({ id, name: id, buildingId, buildingLevel: 1,
  requiredHomeLevel: 1, requiredBuildings: {}, requiredRecipes: {}, seconds, cost: { coins: 0, items }, rewards, ...extra });
function fixture() {
  const catalog = { version: 13, items: ["a", "b", "c", "d", "fish", "clay"].map(id => ({ id, name: id, category: "material", tradable: true, baseSellPrice: 10 })),
    buildings: ["home", "garden", "woodlot", "workshop", "kiln", "dryer", "quarry"].map(id => ({ id, name: id,
      levels: Array.from({ length: 5 }, (_, index) => ({ level: index + 1, requiredHomeLevel: index + 1, requiredBuildings: {}, seconds: 0, cost: { coins: 0, items: {} } })) })),
    recipes: [recipe("grow_a", "garden", 60, {}, { a: 1 }), recipe("make_b", "workshop", 120, { a: 2 }, { b: 1 }),
      recipe("make_c", "kiln", 60, { a: 1 }, { c: 1 }), recipe("make_d", "dryer", 60, { b: 1, c: 1 }, { d: 1 })],
    explorations: [{ id: "mine_clay", name: "mine_clay", activity: "mining", requiredHomeLevel: 1, requiredBuildings: { quarry: 1 },
      seconds: 180, cost: { coins: 0, items: {} }, rewards: { clay: 1 } }], localBuyer: { payoutBps: 10000 },
    food: { orders: { templates: [] }, meals: [] }, tradeRelations: { weekly: { templates: [] } },
    timeEconomy: { coinsPerMinute: 10, orderBonusBps: 2500, baselineRecipes: {}, baselineExplorations: {}, externalPrices: { fish: 50 } },
  };
  return catalog;
}

test("multiple targets consume shared initial stock once and preserve unused inventory", () => {
  const plan = planEconomyProduction({ targets: { b: 1, c: 1 }, inventory: { a: 1, clay: 4 } }, fixture());
  assert.equal(plan.complete, true);
  assert.deepEqual(plain(plan.inventoryUsed), { a: 1 });
  assert.equal(plan.operations.filter(operation => operation.sourceId === "recipe:grow_a").length, 2);
  assert.deepEqual(plain(plan.leftovers), { clay: 4 });
  assert.equal(plan.launches, 4);
  assert.equal(plan.workSeconds, 300);
  assert.equal(plan.elapsedSeconds, 180);
});

test("whole batches share surplus between goals and count each launch exactly once", () => {
  const catalog = fixture(); catalog.recipes[0].rewards.a = 3;
  const plan = planEconomyProduction({ targets: { b: 1, c: 1 } }, catalog);
  assert.equal(plan.operations.filter(operation => operation.sourceId === "recipe:grow_a").length, 1);
  assert.equal(plan.launches, 3);
  assert.deepEqual(plain(plan.leftovers), {});
  const leftover = planEconomyProduction({ targets: { b: 1 } }, catalog);
  assert.deepEqual(plain(leftover.leftovers), { a: 1 });
});

test("all item quantities are conserved across shared goals, stock, whole batches and leftovers", () => {
  const catalog = fixture(); catalog.recipes[0].rewards.a = 3;
  const targets = { a: 2, b: 2, c: 1, d: 1 }, inventory = { a: 3, b: 1, clay: 4 };
  const before = JSON.stringify({ targets, inventory, catalog });
  for (const slotCount of [1, 2, 3]) {
    const plan = planEconomyProduction({ targets, inventory, slots: { garden: slotCount, workshop: slotCount } }, catalog);
    assert.equal(plan.complete, true);
    const balance = { ...inventory };
    for (const operation of plan.operations) {
      for (const [id, count] of Object.entries(operation.inputs)) balance[id] = (balance[id] ?? 0) - count;
      for (const [id, count] of Object.entries(operation.outputs)) balance[id] = (balance[id] ?? 0) + count;
    }
    for (const [id, count] of Object.entries(targets)) balance[id] -= count;
    assert.deepEqual(Object.fromEntries(Object.entries(balance).filter(([, count]) => count !== 0)), plain(plan.leftovers));
    assert.ok(Object.values(balance).every(count => count >= 0));
    for (const [id, count] of Object.entries(plan.inventoryUsed)) assert.ok(count <= inventory[id]);
  }
  assert.equal(JSON.stringify({ targets, inventory, catalog }), before);
});

test("a selected circular alternative cannot promise a completion time", () => {
  const catalog = fixture(); catalog.recipes.push(recipe("cycle_a", "woodlot", 30, { b: 1 }, { a: 1 }));
  const plan = planEconomyProduction({ targets: { b: 1 }, sourceByItem: { a: "recipe:cycle_a" } }, catalog);
  assert.equal(plan.complete, false); assert.equal(plan.elapsedSeconds, null);
  assert.match(plan.warnings.join(" "), /Цикл производства/);
  assert.ok(plan.operations.every(operation => operation.blocked && operation.startSeconds === null));
  const supplied = planEconomyProduction({ targets: { b: 1 }, inventory: { a: 2 }, sourceByItem: { a: "recipe:cycle_a" } }, catalog);
  assert.equal(supplied.complete, true); assert.equal(supplied.launches, 1);
});

test("a joint expedition's side output is available only after that expedition", () => {
  const catalog = fixture(); catalog.recipes = [];
  catalog.explorations.push({ id: "joint", name: "joint", requiredHomeLevel: 1, requiredBuildings: {}, seconds: 120,
    cost: { coins: 0, items: {} }, rewards: { a: 2, b: 1 } });
  const plan = planEconomyProduction({ targets: { a: 1, b: 1 } }, catalog);
  assert.equal(plan.launches, 1); assert.equal(plan.elapsedSeconds, 120);
  assert.deepEqual(plain(plan.leftovers), { a: 1 });
  const row = buildEconomyAnalysis(catalog).items.find(item => item.id === "a");
  assert.equal(row.ownSeconds, null);
  assert.match(row.warnings.join(" "), /несколько товаров/);
});

test("parallel slots change feasible elapsed time, not total production work or amount", () => {
  const catalog = fixture();
  const one = planEconomyProduction({ targets: { d: 1 } }, catalog);
  const two = planEconomyProduction({ targets: { d: 1 }, slots: { garden: 2 } }, catalog);
  assert.equal(one.workSeconds, 420); assert.equal(two.workSeconds, 420);
  assert.equal(one.elapsedSeconds, 300); assert.equal(two.elapsedSeconds, 240);
  assert.equal(one.launches, two.launches);
  for (const operation of two.operations) for (const dependency of operation.dependencies)
    assert.ok(operation.startSeconds >= two.operations.find(value => value.id === dependency).endSeconds);
});

test("single miner cannot gain parallel capacity from a generic three-slot setting", () => {
  const plan = planEconomyProduction({ targets: { clay: 3 }, slots: { quarry: 3, hero: 3 } }, fixture());
  assert.equal(plan.elapsedSeconds, 540);
  assert.equal(plan.queues.find(queue => queue.stationId === "quarry").slots, 1);
});

test("same-station ingredient and result obey dependency and slot occupancy", () => {
  const catalog = fixture(); catalog.recipes[1].buildingId = "garden";
  const plan = planEconomyProduction({ targets: { b: 2 } }, catalog);
  assert.equal(plan.elapsedSeconds, 480);
  const intervals = plan.operations.map(operation => [operation.startSeconds, operation.endSeconds]).sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < intervals.length; index++) assert.ok(intervals[index][0] >= intervals[index - 1][1]);
});

test("collection reserves the hero once and keeps the growing slot occupied until collection", () => {
  const catalog = fixture(); catalog.recipes[0].collection = { kind: "berry_harvest", seconds: 8 };
  const plan = planEconomyProduction({ targets: { a: 2 }, slots: { garden: 2 } }, catalog);
  assert.equal(plan.workSeconds, 136); assert.equal(plan.collectionSeconds, 16);
  assert.equal(plan.elapsedSeconds, 76);
  assert.equal(plan.queues.find(queue => queue.stationId === "hero").workSeconds, 16);
});

test("random or missing ingredients block elapsed promises; provided stock resolves them", () => {
  const catalog = fixture(); catalog.recipes[1].cost.items = { fish: 1 };
  const missing = planEconomyProduction({ targets: { b: 1 } }, catalog);
  assert.equal(missing.complete, false); assert.equal(missing.elapsedSeconds, null);
  assert.deepEqual(plain(missing.missingItems), { fish: 1 });
  assert.equal(missing.operations[0].startSeconds, null);
  const supplied = planEconomyProduction({ targets: { b: 1 }, inventory: { fish: 1 } }, catalog);
  assert.equal(supplied.complete, true); assert.equal(supplied.elapsedSeconds, 120);
  const fish = buildEconomyAnalysis(catalog).items.find(item => item.id === "fish");
  assert.equal(fish.fullWorkSeconds, null); assert.match(fish.warnings.join(" "), /Внешняя базовая оценка/);
});

test("retired, inaccessible and unmastered sources cannot be selected", () => {
  const catalog = fixture();
  catalog.recipes.push(recipe("old_a", "garden", 1, {}, { a: 100 }, { retired: true }));
  const retired = planEconomyProduction({ targets: { a: 1 }, sourceByItem: { a: "recipe:old_a" } }, catalog);
  assert.equal(retired.complete, false);
  const inaccessible = planEconomyProduction({ targets: { b: 1 }, buildings: { home: 1, garden: 1 } }, catalog);
  assert.equal(inaccessible.complete, false);
  catalog.recipes[0].requiredRecipes = { starter: 3 };
  assert.equal(planEconomyProduction({ targets: { a: 1 }, buildings: { home: 1, garden: 1 } }, catalog).complete, false);
  assert.equal(planEconomyProduction({ targets: { a: 1 }, buildings: { home: 1, garden: 1 }, completedRecipes: { starter: 3 } }, catalog).complete, true);
  assert.ok(!buildEconomyAnalysis(catalog).sources.some(source => source.id === "recipe:old_a"));
});

test("source override and speed model preserve fixed shared item prices", () => {
  const catalog = fixture(); catalog.recipes.push(recipe("fast_a", "woodlot", 30, {}, { a: 1 }));
  catalog.timeEconomy.baselineRecipes.a = "grow_a";
  const plainPlan = planEconomyProduction({ targets: { a: 2 } }, catalog);
  const fast = planEconomyProduction({ targets: { a: 2 }, sourceByItem: { a: "recipe:fast_a" }, speedBps: { woodlot: 2500 } }, catalog);
  assert.equal(plainPlan.workSeconds, 120); assert.equal(fast.workSeconds, 48);
  assert.equal(buildEconomyAnalysis(catalog).items.find(item => item.id === "a").npcPrice, 10);
});

test("weekly stages count as recurring uses and graph connects quantities in both directions", () => {
  const catalog = fixture(); catalog.tradeRelations.weekly.templates.push({ id: "week", stages: [{ id: "first", items: { clay: 2 } }] });
  const analysis = buildEconomyAnalysis(catalog);
  assert.equal(analysis.items.find(item => item.id === "clay").recurringUses, 1);
  assert.ok(analysis.graph.edges.some(edge => edge.from === "item:a" && edge.to === "recipe:make_b" && edge.quantity === 2));
  assert.ok(analysis.graph.edges.some(edge => edge.from === "recipe:make_b" && edge.to === "item:b" && edge.quantity === 1));
  for (const edge of analysis.graph.edges) {
    assert.ok(analysis.graph.nodes.some(node => node.id === edge.from));
    assert.ok(analysis.graph.nodes.some(node => node.id === edge.to));
  }
});

test("home presets respect prerequisite closure and preserve input catalogue", () => {
  const catalog = fixture(); catalog.buildings.find(building => building.id === "kiln").levels[0].requiredBuildings = { workshop: 2 };
  const before = JSON.stringify(catalog);
  assert.equal(buildingsAtHomeLevel(1, catalog).kiln, undefined);
  assert.equal(buildingsAtHomeLevel(2, catalog).kiln, 2);
  planEconomyProduction({ targets: { d: 2 }, inventory: { a: 1 } }, catalog);
  assert.equal(JSON.stringify(catalog), before);
});

test("invalid quantities and a huge recursive request fail safely within a bounded workload", () => {
  const catalog = fixture();
  for (const count of [-1, 0.5, Infinity, 10000]) assert.throws(() => planEconomyProduction({ targets: { a: count } }, catalog), /invalid quantity/);
  assert.throws(() => planEconomyProduction({ targets: { a: 1 }, slots: { garden: 4 } }, catalog), /Slots/);
  assert.throws(() => planEconomyProduction({ targets: { unknown: 1 }, inventory: { unknown: 1 } }, catalog), /Unknown item/);
  const huge = planEconomyProduction({ targets: { d: 9999 } }, catalog);
  assert.equal(huge.complete, false); assert.ok(huge.operations.length <= 5000);
  assert.match(huge.warnings.join(" "), /5000 запусков/);
});

test("the actual catalogue graph and baseline plans remain finite and auditable", () => {
  const analysis = buildEconomyAnalysis(actual);
  assert.equal(analysis.items.length, actual.items.length);
  assert.ok(analysis.sources.every(source => !source.retired));
  assert.ok(analysis.items.some(item => item.recurringUses > 0));
  const raw = analysis.items.find(item => item.id === "berries");
  assert.equal(raw.npcPrice, 10); assert.equal(raw.launches, 1);
  const cooked = planEconomyProduction({ targets: { dried_berries: 1 } }, actual);
  assert.equal(cooked.complete, true);
  assert.ok(cooked.launches > 1);
});
