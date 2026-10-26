import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { recipeBuildingLevel } from "./helpers/recipe-level.mjs";

const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
// The real model schema supplies this default before graph construction.
for (const recipe of catalog.recipes) recipe.requiredRecipes ??= {};
const activeRecipes = catalog.recipes.filter(recipe => !recipe.retired);
const activeExplorations = catalog.explorations.filter(route => !route.retired);
const progressionRewards = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/progression-rewards-catalog.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../features/progression/graph.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const moneyContext = { exports: {}, structuredClone };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../features/economy/domain/money.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, moneyContext);
const timeContext = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../features/economy/domain/time-price.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, timeContext);
const prerequisiteContext = { exports: {} };
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../features/economy/domain/recipe-prerequisites.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, prerequisiteContext);
const context = { exports: {}, require: specifier => {
  if (specifier === "@/features/economy/domain/recipe-prerequisites") return prerequisiteContext.exports;
  if (specifier === "@/features/economy/domain/money") return moneyContext.exports;
  if (specifier === "@/features/economy/domain/rules") return { constructionTimePearlPrice: (seconds, config) => timeContext.exports.durationPearlPrice(seconds * 1000,
    config.secondsPerPearl, moneyContext.exports.ECONOMY_PEARL_SCALE, config.priceStepPearls, config.pricingPoints) };
  if (specifier === "@/apps/api/src/main/resources/world/progression-rewards-catalog.json") return { default: JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/progression-rewards-catalog.json", import.meta.url), "utf8")) };
  assert.equal(specifier, "@/features/economy/domain/model");
  return { economyCatalog: catalog, recipeBuildingLevel };
} };
vm.runInNewContext(code, context);
const { progressionGraph: graph, buildProgressionGraph, getPrerequisiteIds, getProgressionResourceSource, buildingLabels, progressionLocations } = context.exports;
const layoutSource = readFileSync(new URL("../features/progression/layout.ts", import.meta.url), "utf8");
const layoutCode = ts.transpileModule(layoutSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const layoutContext = { exports: {}, require: specifier => {
  assert.equal(specifier, "./graph");
  return context.exports;
} };
vm.runInNewContext(layoutCode, layoutContext);
const { buildProgressionLayout, NODE_WIDTH, NODE_HEIGHT } = layoutContext.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const node = id => graph.nodes.find(value => value.id === id);
const hasEdge = (source, target, kind) => graph.edges.some(edge => edge.source === source && edge.target === target && edge.kind === kind);

test("the base campfire exposes fish from level zero without requiring its paid improvement", () => {
  const base = node("b:dryer:0"), fish = node("r:cook_grilled_fish");
  assert.ok(base);
  assert.equal(base.cost.coins, 0);
  assert.equal(base.seconds, 0);
  assert.equal(fish.level, 0);
  assert.equal(fish.requirements.dryer, 0);
  assert.ok(hasEdge(base.id, fish.id, "unlock"));
  assert.equal(hasEdge("b:dryer:1", fish.id, "unlock"), false);
  assert.equal(node("r:cook_compote").level, 1);
});

test("recipe prerequisites name their claimed products without repeating action verbs", () => {
  const strawberry = node("r:grow_strawberries");
  assert.match(strawberry.description, /Для открытия произведите и заберите: Малиновый компот × 1/);
  assert.doesNotMatch(strawberry.description, /приготовьте[^.]*Приготовить/i);
  const parts = node("r:make_precision_parts");
  const reinforced = catalog.items.find(item => item.id === "reinforced_parts");
  assert.ok(parts.description.includes(`${reinforced.name} × 10`));
});

function reachableIds(currentGraph, accepts) {
  const outgoing = new Map();
  for (const edge of currentGraph.edges.filter(accepts)) {
    const destinations = outgoing.get(edge.source) || [];
    destinations.push(edge.target);
    outgoing.set(edge.source, destinations);
  }
  const seen = new Set(["start"]), pending = ["start"];
  while (pending.length) {
    for (const next of outgoing.get(pending.pop()) || []) {
      if (!seen.has(next)) { seen.add(next); pending.push(next); }
    }
  }
  return seen;
}

test("progression contains every catalog level and active source plus the existing base fire exactly once", () => {
  assert.equal(graph.nodes.filter(value => value.kind === "building").length, catalog.buildings.reduce((sum, building) => sum + building.levels.length, 0) + 1);
  assert.equal(graph.nodes.filter(value => value.kind === "recipe").length, activeRecipes.length);
  assert.equal(graph.nodes.filter(value => value.kind === "exploration").length, activeExplorations.length);
  for (const building of catalog.buildings) for (const level of building.levels) {
    const value = node(`b:${building.id}:${level.level}`);
    assert(value, `${building.id} ${level.level}`);
    assert.equal(value.title, `${buildingLabels[building.id] || building.name} · уровень ${level.level}`);
    assert.deepEqual(plain(value.cost), level.cost);
    assert.equal(value.seconds, level.seconds);
    if (level.warehouseCapacity) assert.equal(value.warehouseCapacity, level.warehouseCapacity);
    assert.deepEqual(Array.from(value.children).sort(), [
      ...activeRecipes.filter(recipe => recipe.buildingId === building.id && recipeBuildingLevel(recipe) === level.level).map(recipe => `r:${recipe.id}`),
      ...(building.id === "quarry" ? activeExplorations.filter(route => route.requiredBuildings.quarry === level.level).map(route => `e:${route.id}`) : []),
    ].sort());
  }
  for (const recipe of activeRecipes) {
    const value = node(`r:${recipe.id}`);
    assert.equal(value.title, recipe.name);
    assert.deepEqual(plain(value.cost), recipe.cost);
    assert.deepEqual(plain(value.rewards), recipe.rewards);
    assert.equal(value.seconds, recipe.seconds);
    assert(hasEdge(`b:${recipe.buildingId}:${recipeBuildingLevel(recipe)}`, value.id, "unlock"));
  }
  for (const exploration of activeExplorations) {
    const value = node(`e:${exploration.id}`);
    assert.equal(value.title, exploration.name);
    assert.deepEqual(plain(value.cost), exploration.cost);
    assert.deepEqual(plain(value.rewards), exploration.rewards);
    assert.equal(value.seconds, exploration.seconds);
    assert.deepEqual(plain(value.requirements), { home: exploration.requiredHomeLevel, ...exploration.requiredBuildings });
  }
});

test("node and edge ids are unique and actual world remains connected without proposed or cost edges", () => {
  const ids = new Set(graph.nodes.map(value => value.id));
  assert.equal(ids.size, graph.nodes.length);
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, graph.edges.length);
  for (const edge of graph.edges) {
    assert(ids.has(edge.source), `Unknown source ${edge.source}`);
    assert(ids.has(edge.target), `Unknown target ${edge.target}`);
    assert.notEqual(edge.source, edge.target);
  }
  const all = reachableIds(graph, () => true);
  assert.equal(all.size, ids.size);
  const actual = reachableIds(graph, edge => edge.kind !== "plan" && edge.kind !== "cost");
  for (const value of graph.nodes.filter(value => value.status === "active")) assert(actual.has(value.id), `Disconnected active node ${value.id}`);
  assert.equal(node("pearls").status, "active");
  assert.ok(!graph.edges.some(edge => edge.source === "pearls" && ["requirement", "unlock"].includes(edge.kind)), "optional acceleration never gates progression");
  assert.equal(graph.nodes.filter(value => value.status === "plan").length, 12);
});

test("fish ingredients resolve to a real chance source without inventing guaranteed species rewards", () => {
  const source = node("fishing_species");
  assert.equal(source.kind, "acquisition");
  assert.equal(source.status, "active");
  assert.equal(source.rewards, undefined);
  assert.equal(source.seconds, undefined);
  assert.equal(source.cost, undefined);
  assert.deepEqual(plain(source.fishingSource.itemIds), [...catalog.fishing.classes.map(group => group.itemId), ...catalog.fishing.fish.map(fish => fish.itemId)]);
  assert.deepEqual(plain(source.fishingSource.routeIds), catalog.fishing.routeIds);
  assert.match(source.description, /Ни класс, ни вид не гарантированы/);
  assert.match(source.description, /легендарная удочка/);
  assert(hasEdge("b:home:1", source.id, "requirement"));
  for (const route of catalog.fishing.routeIds) assert(hasEdge(`e:${route}`, source.id, "any"));
  const classIds = new Set(catalog.fishing.classes.map(group => group.itemId));
  for (const recipe of activeRecipes.filter(recipe => Object.keys(recipe.cost.items).some(id => classIds.has(id)))) {
    for (const id of Object.keys(recipe.cost.items).filter(id => classIds.has(id))) {
      assert(getProgressionResourceSource(graph, id), `${recipe.id}: no ingredient source for ${id}`);
      assert(node(`r:${recipe.id}`).description.includes(catalog.items.find(item => item.id === id).name));
      assert.equal(getProgressionResourceSource(graph, id).id, source.id);
    }
  }
  for (const recipe of ["cook_berry_fish", "cook_hearty_fish"]) assert(hasEdge(source.id, `r:${recipe}`, "cost"));
  assert(!graph.nodes.some(value => value.rewards?.fish_reedperch || value.rewards?.fish_mooncarp));
  const prerequisites = getPrerequisiteIds(graph, source.id, false);
  assert(!graph.nodes.some(value => value.kind === "exploration" && prerequisites.has(value.id)), "alternative fishing trips never all become mandatory");
});

test("food and resident orders are active optional uses rather than future progression gates", () => {
  assert.equal(node("orders").status, "active");
  assert.equal(node("meals").status, "active");
  assert.match(node("orders").description, /Обычные заказы дают монеты/);
  assert.match(node("orders").description, /сытость отдельно/);
  assert.match(node("orders").description, /3 бесплатные замены/);
  assert.match(node("meals").description, /\+8–100%/);
  assert.ok(node("meals").description.includes(`строитель +${Math.min(...catalog.food.meals.map(meal => meal.builderSpeedBps / 100))}–${Math.max(...catalog.food.meals.map(meal => meal.builderSpeedBps / 100))}%`));
  assert(hasEdge("start", "orders", "available"));
  assert(hasEdge("orders", "coins", "flow"));
  assert(hasEdge("r:cook_grilled_fish", "meals", "flow"));
  assert(!getPrerequisiteIds(graph, "b:home:5").has("orders"));
  assert(!getPrerequisiteIds(graph, "b:home:5").has("meals"));
});

test("orders reference explains all five relationships and the separate reviewed weekly choice", () => {
  const description = node("orders").description;
  assert.ok(description.includes(`До ${catalog.food.orders.slots} обычных просьб, по одной у доступного жителя`));
  for (const name of ["Плёске", "Шишколапу", "Лопоуху", "Камнешмыгу", "Листохвосту"]) assert.ok(description.includes(name), name);
  assert.match(description, /Маленькие портреты.*вкладка «Все»/);
  assert.ok(description.includes(`до ${catalog.tradeRelations.dailyOrderXpCap} очков у каждого жителя в сутки UTC`));
  assert.match(description, /Заработанный ранг не падает, учебные и проектные поставки его не повышают/);
  assert.ok(description.includes(`Максимальная выгода ${catalog.tradeRelations.maxBonusBps / 100}%`));
  assert.match(description, /Рыба, обычные материалы и припасы, жемчуг и обновление лавки без скидки/);
  assert.ok(description.includes(`одно большое поручение на аккаунт на ${catalog.tradeRelations.weekly.durationSeconds / 86400} дней с принятия`));
  assert.match(description, /все три этапа видны до подтверждения и оплачиваются по очереди/);
  assert.match(description, /уже полученные награды сохраняются/);
  assert.match(description, /базовую добычу и переработку с нуля; работы могут идти параллельно, случайный улов не гарантирует срок/);
});

test("older catalogs retain their board description without invented reputation or weekly contracts", () => {
  const legacy = structuredClone(catalog);
  delete legacy.tradeRelations;
  legacy.food.orders.slots = 3;
  const description = buildProgressionGraph(legacy).nodes.find(value => value.id === "orders").description;
  assert.match(description, /До 3 обычных просьб с именами заказчиков: Плёске нужен улов и блюда, Шишколапу материалы/);
  assert.doesNotMatch(description, /репутаци|Репутаци|большое поручение|Маленькие портреты|Лопоуху|Камнешмыгу|Листохвосту/);
});

test("daily and earned achievements explain current pearl sources while the optional relic merchant cannot gate upgrades", () => {
  assert.equal(node("daily_rewards").status, "active");
  const dailyPearls = moneyContext.exports.formatPearls(progressionRewards.daily.reduce((sum, reward) => sum + reward.pearls, 0));
  const achievementPearls = moneyContext.exports.formatPearls(Object.values(progressionRewards.achievementPearls).flat().reduce((sum, reward) => sum + reward, 0));
  assert.match(node("daily_rewards").description, /7 получений/); assert.ok(node("daily_rewards").description.includes(`${dailyPearls} жемчужин`));
  assert.match(node("daily_rewards").description, /20 часов/); assert.match(node("daily_rewards").description, /Пропуск не сбрасывает/);
  assert.ok(node("pearls").description.includes(`до ${achievementPearls}`)); assert.ok(node("achievements").description.includes(`до ${achievementPearls}`));
  assert(hasEdge("daily_rewards", "pearls", "flow")); assert(hasEdge("achievements", "pearls", "flow"));
  assert.equal(node("pearl_trader").status, "active");
  assert.match(node("pearl_trader").description, /личной лавке Листохвоста/);
  assert(graph.edges.filter(edge => edge.source === "pearl_trader" || edge.target === "pearl_trader").every(edge => edge.kind !== "plan"));
  assert(!getPrerequisiteIds(graph, "b:home:5").has("pearl_trader"));
  assert.match(node("market").description, /обмен реликвиями 1:1/);
});

test("rare materials share a real post-home-three exploration source without a fake recipe or coin purchase", () => {
  const source = node("rare_materials");
  assert.equal(source.kind, "acquisition"); assert.equal(source.status, "active"); assert.equal(source.phase, 3);
  assert.deepEqual(plain(source.requirements), { home: 3 });
  assert.deepEqual(plain(source.rareDrops), catalog.rareDrops);
  assert.equal(source.rewards, undefined); assert.equal(source.seconds, undefined); assert.equal(source.cost, undefined);
  assert.match(source.description, /два отдельных счётчика — по одному на персонажа/);
  assert.match(source.description, /перерасход переносится в очередь того же персонажа/);
  assert.match(source.description, /48 до 144/);
  assert.match(source.description, /равновероятных/); assert.match(source.description, /Конкретный тип не гарантирован/);
  assert.match(source.description, /завершение проекта дома 3 гарантирует Живая смола × 1/);
  assert.match(source.description, /путь к дому 4 не зависит от случайной находки/);
  assert.match(source.description, /Седьмой ежедневный подарок даёт древнее ядро/);
  assert.match(source.description, /купить или продать за монеты нельзя/);
  assert(hasEdge("b:home:3", source.id, "requirement"));
  for (const route of activeExplorations) assert(hasEdge(`e:${route.id}`, source.id, "any"));
  for (const item of catalog.rareDrops.itemIds) {
    assert.equal(getProgressionResourceSource(graph, item).id, source.id, "Cost buttons resolve the earned source");
    assert(!graph.nodes.some(value => value.rewards?.[item]), "Chance-source metadata must not turn the separate project or gift guarantee into a guaranteed route or recipe reward");
  }
  assert(hasEdge(source.id, "b:home:4", "cost")); assert(hasEdge(source.id, "b:home:5", "cost"));
  assert(!hasEdge(source.id, "b:home:3", "cost"));
  const prerequisites = getPrerequisiteIds(graph, source.id, false);
  assert(prerequisites.has("b:home:3"));
  assert(!graph.nodes.some(value => value.kind === "exploration" && prerequisites.has(value.id)), "Alternative trips are not all mandatory");
  assert(!getPrerequisiteIds(graph, "b:home:4", false).has(source.id));
  assert(getPrerequisiteIds(graph, "b:home:4").has(source.id));
  const changed = structuredClone(catalog); changed.rareDrops.minSeconds = 60 * 3600; changed.rareDrops.maxSeconds = 180 * 3600;
  const before = JSON.stringify(changed), custom = buildProgressionGraph(changed);
  const customSource = custom.nodes.find(value => value.id === source.id);
  assert.match(customSource.description, /60 до 180/); assert.match(customSource.description, /120 часов/);
  customSource.rareDrops.itemIds.reverse();
  assert.equal(JSON.stringify(changed), before, "Graph keeps its own copy of drop metadata");
});

test("fishing and glade visits are current while Pleska's home remains an optional proposal", () => {
  assert.equal(node("pleska").status, "active");
  assert.equal(node("fishing_catches").status, "active");
  assert(hasEdge("start", "pleska", "available"));
  assert.equal(node("public_profiles").status, "active");
  assert(hasEdge("start", "public_profiles", "available"));
  assert.equal(node("friend_glade").status, "active");
  assert(hasEdge("public_profiles", "friend_glade", "flow"));
  for (const id of ["pleska_home"]) {
    assert.equal(node(id).status, "plan");
    assert.equal(node(id).cost, undefined);
    assert.equal(node(id).seconds, undefined);
    assert(!getPrerequisiteIds(graph, "b:home:5").has(id));
  }
  assert.equal(node("player_level").status, "active");
  assert.equal(node("achievements").status, "active");
  assert.match(node("willow_rod").description, /отдельная вещь/);
  assert.match(node("trader").description, /все продаваемые товары NPC выкупает по полной базовой цене за каждую единицу/);
  assert.doesNotMatch(node("trader").description, /с уценкой/);
  assert.match(node("trader").description, /Сырую рыбу Плёска покупает по той же полной цене её класса/);
  assert.match(node("b:warehouse:1").description, /объявлениях рынка/);
  for (const recipe of activeRecipes) {
    assert.equal(recipe.maxBatch, 1, recipe.id);
    assert.equal(Object.values(recipe.rewards).reduce((sum, count) => sum + count, 0), 1, recipe.id);
    assert.match(node(`r:${recipe.id}`).description, /Каждый запуск выпускает один предмет/);
  }
});

test("graph labels use current unit-production timers and actual mining durations", () => {
  assert.equal(node("r:grow_berries").label, "Малина · 1 мин");
  assert.equal(node("r:hardwood_shift").label, "Крепкое бревно · 8 мин");
  assert.equal(node("r:smelt_iron").label, "Железный слиток · 15 мин");
  assert.equal(node("r:make_beams").label, "Балка · 20 мин");
  assert.equal(node("e:quarry_ore").label, "Руда · 10 мин");
  assert.equal(node("e:quarry_sand").label, "Песок · 5 мин");
  for (const recipe of catalog.recipes.filter(recipe => recipe.retired)) assert.equal(node(`r:${recipe.id}`), undefined);
  for (const route of catalog.explorations.filter(route => route.retired)) assert.equal(node(`e:${route.id}`), undefined);
  assert.equal(node("e:shore_camp").label, "Стоянка на берегу · 15 мин");
  const changed = structuredClone(catalog);
  changed.recipes.find(recipe => recipe.id === "hardwood_shift").seconds = 420;
  changed.explorations.find(route => route.id === "quarry_ore").seconds = 660;
  const custom = buildProgressionGraph(changed);
  assert.equal(custom.nodes.find(value => value.id === "r:hardwood_shift").label, "Крепкое бревно · 7 мин");
  assert.equal(custom.nodes.find(value => value.id === "e:quarry_ore").label, "Руда · 11 мин");
});

test("buyer description keeps discount rules only when the provided catalog actually uses them", () => {
  const changed = structuredClone(catalog);
  changed.localBuyer.unitPrices = Object.fromEntries(changed.items.filter(item => item.tradable).map(item => [item.id, item.baseSellPrice]));
  const fullPriceTrader = buildProgressionGraph(changed).nodes.find(value => value.id === "trader");
  assert.match(fullPriceTrader.description, /все продаваемые товары NPC выкупает по полной базовой цене за каждую единицу/);
  assert.doesNotMatch(fullPriceTrader.description, /с уценкой/);
  delete changed.localBuyer.unitPrices.berries;
  const trader = buildProgressionGraph(changed).nodes.find(value => value.id === "trader");
  assert.match(trader.description, /с уценкой 40%/);
  assert.doesNotMatch(trader.description, /все продаваемые товары NPC выкупает по полной/);
});

test("production and construction retain every house, previous-level and additional building gate", () => {
  for (const building of catalog.buildings) for (const level of building.levels) {
    const id = `b:${building.id}:${level.level}`;
    if (id !== "b:home:1") assert(hasEdge(`b:home:${level.requiredHomeLevel}`, id, "requirement"), `${id}: home gate`);
    if (level.level > 1) assert(hasEdge(`b:${building.id}:${level.level - 1}`, id, "requirement"), `${id}: previous level`);
    for (const [other, minimum] of Object.entries(level.requiredBuildings)) assert(hasEdge(`b:${other}:${minimum}`, id, "requirement"), `${id}: ${other}`);
  }
  for (const recipe of activeRecipes) {
    const id = `r:${recipe.id}`;
    assert(hasEdge(`b:home:${recipe.requiredHomeLevel}`, id, "requirement"));
    for (const [other, minimum] of Object.entries(recipe.requiredBuildings)) assert(hasEdge(`b:${other}:${minimum}`, id, "requirement"));
  }
  for (const exploration of activeExplorations) {
    const id = `e:${exploration.id}`;
    assert(hasEdge(`b:home:${exploration.requiredHomeLevel}`, id, "requirement"));
    for (const [other, minimum] of Object.entries(exploration.requiredBuildings)) assert(hasEdge(`b:${other}:${minimum}`, id, "requirement"));
  }
  const finalHouse = getPrerequisiteIds(graph, "b:home:5", false);
  for (const id of ["b:workshop:4", "b:quarry:4", "b:kiln:4", "b:dryer:3"]) assert(finalHouse.has(id), id);
  assert(!graph.nodes.some(value => value.buildingId === "warehouse" && finalHouse.has(value.id)), "storage remains optional for the final house");
  assert.equal(node("r:make_reinforced_parts").requirements.woodlot, 4);
  assert.equal(node("r:make_beams").requirements.woodlot, 3);
});

test("market requires home two and a claimed bridge restoration without forcing an exploration", () => {
  assert.deepEqual(plain(node("market").requirements), { home: 2, bridge: 1 });
  const incoming = graph.edges.filter(edge => edge.target === "market" && edge.kind === "requirement").map(edge => edge.source);
  assert.deepEqual(Array.from(incoming).sort(), ["b:bridge:1", "b:home:2"]);
  const unlocked = state => Object.entries(node("market").requirements).every(([counter, required]) => state[counter] >= required);
  assert.equal(unlocked({ home: 1, bridge: 0 }), false);
  assert.equal(unlocked({ home: 2, bridge: 0 }), false);
  assert.equal(unlocked({ home: 1, bridge: 1 }), false);
  assert.equal(unlocked({ home: 2, bridge: 1, completedExplorations: 0 }), true);
  for (const exploration of activeExplorations) assert.equal(hasEdge(`e:${exploration.id}`, "claimed", "any"), exploration.activity !== "mining");
  const prerequisites = getPrerequisiteIds(graph, "market", false);
  assert(!prerequisites.has("claimed"));
  assert(prerequisites.has("b:bridge:1"));
  assert(prerequisites.has("b:home:2"));
  assert(!graph.nodes.some(value => value.kind === "exploration" && prerequisites.has(value.id)), "Any exploration must not become all ten mandatory routes");
  assert.deepEqual(Array.from(getPrerequisiteIds(graph, "claimed", false)), ["claimed"]);
});

test("restored landmarks gate real routes while future proposals cannot gate active progression", () => {
  const proposed = new Set(graph.nodes.filter(value => value.status === "plan").map(value => value.id));
  assert.equal(node("bridge_ruin").status, "active");
  assert.equal(node("lighthouse_ruin").status, "active");
  assert.equal(node("bridge").status, "active");
  assert.equal(node("lighthouse").status, "active");
  assert.equal(node("mine_interior").status, "plan");
  for (const edge of graph.edges.filter(edge => proposed.has(edge.source) || proposed.has(edge.target))) assert.equal(edge.kind, "plan", edge.id);
  for (const value of graph.nodes.filter(value => value.status === "active")) {
    for (const prerequisite of getPrerequisiteIds(graph, value.id)) assert(!proposed.has(prerequisite), `${prerequisite} gates ${value.id}`);
  }
  const bridge = getPrerequisiteIds(graph, "b:bridge:1", false);
  for (const id of ["b:home:2", "b:workshop:1", "b:kiln:1", "b:woodlot:1"]) assert(bridge.has(id));
  assert.equal(node("b:bridge:1").phase, 2);
  assert.equal(node("b:lighthouse:1").phase, 3);
  assert.match(node("bridge").description, /с дома 2.*рынок игроков/);
  assert.match(node("lighthouse").description, /с дома 3.*пароход с большими заказами/);
  assert.equal(node("ships").status, "plan");
  assert(hasEdge("b:lighthouse:1", "ships", "plan"));
  assert(!hasEdge("port", "ships", "plan"));
  assert(hasEdge("bridge", "b:bridge:1", "contains"));
  assert(hasEdge("lighthouse", "b:lighthouse:1", "contains"));
  assert(hasEdge("b:bridge:1", "e:far_bank_path", "requirement"));
  assert(hasEdge("b:bridge:1", "e:far_bank_grove", "requirement"));
  assert(hasEdge("b:lighthouse:1", "e:ancient_ruins", "requirement"));
  assert.deepEqual(plain(node("e:ancient_ruins").requirements), { home: 4, bridge: 1, lighthouse: 1, workshop: 4, quarry: 4, kiln: 3, dryer: 2 });
  const finalHouse = getPrerequisiteIds(graph, "b:home:5", false);
  assert(finalHouse.has("b:bridge:1"));
  assert(finalHouse.has("b:lighthouse:1"));
  assert(!getPrerequisiteIds(graph, "album").has("new_finds"));
  assert(!getPrerequisiteIds(graph, "leaderboard").has("taps"), "Rating flow is not an unlock gate");
});

test("existing places contain improvements without becoming construction or recipe gates", () => {
  const expected = {
    "place:home": ["home", "warehouse"], "place:workshop": ["workshop", "kiln"],
    bush: ["garden"], campfire: ["dryer"], "place:woodlot": ["woodlot"], "place:quarry": ["quarry"], bridge: ["bridge"], lighthouse: ["lighthouse"],
  };
  assert.equal(graph.nodes.filter(value => value.kind === "location").length, Object.keys(expected).length);
  for (const [locationId, buildingIds] of Object.entries(expected)) {
    const place = node(locationId);
    assert.equal(place.kind, "location");
    assert.deepEqual(plain(place.requirements), {});
    assert.equal(place.cost, undefined, "A map object is not a second economic construction");
    assert.deepEqual(Array.from(place.children).sort(), buildingIds.map(id => `b:${id}:1`).sort());
    for (const buildingId of buildingIds) {
      assert(hasEdge(locationId, `b:${buildingId}:1`, "contains"));
      for (const value of graph.nodes.filter(value => value.buildingId === buildingId)) {
        assert.equal(value.locationId, locationId);
        assert(!getPrerequisiteIds(graph, value.id, false).has(locationId), `${locationId} is placement, not a gate for ${value.id}`);
      }
    }
  }
  assert.equal(node("b:warehouse:1").label, "Кладовая 1");
  assert.equal(node("b:workshop:1").label, "Верстак 1");
  assert.equal(node("b:kiln:1").label, "Печь 1");
  assert.match(node("start").description, /кладовая 1/);
  assert.doesNotMatch(node("b:woodlot:1").description, /Есть на старте/);
});

test("new quarry and kiln construction follow home 2 while advanced resources retain later requirements", () => {
  assert.equal(node("b:quarry:1").requirements.home, 2);
  assert.equal(node("b:kiln:1").requirements.home, 2);
  assert.equal(node("b:kiln:1").requirements.workshop, 1);
  assert.equal(node("b:kiln:1").requirements.quarry, 2);
  assert(!("quarry" in node("b:home:2").requirements));
  assert(!getPrerequisiteIds(graph, "b:home:2", false).has("b:quarry:1"));
  for (const id of ["b:quarry:1", "b:kiln:1", "e:quarry_stone", "e:quarry_clay", "r:make_charcoal"]) assert.equal(node(id).phase, 2, id);
  assert.equal(node("e:quarry_ore").phase, 3);
  for (const [prefix, recipe] of [["e", catalog.explorations.find(value => value.id === "quarry_stone")], ["r", catalog.recipes.find(value => value.id === "make_charcoal")]]) {
    assert.equal(node(`${prefix}:${recipe.id}`).requirements.home, recipe.requiredHomeLevel, "Display phase must not invent a stronger server requirement");
  }
});

test("display phases follow transitive catalog gates without moving unrelated places or inventing new requirements", () => {
  const changed = structuredClone(catalog);
  changed.buildings.find(value => value.id === "garden").levels[0].requiredHomeLevel = 2;
  changed.buildings.find(value => value.id === "dryer").levels[0].requiredBuildings = { garden: 1 };
  assert.throws(() => buildProgressionGraph(changed), /Cyclic progression requirements/,
    "home 2 requires the first campfire, so moving its prerequisite behind home 2 creates a real cycle");
  changed.buildings.find(value => value.id === "home").levels[1].requiredBuildings = {};
  const custom = buildProgressionGraph(changed);
  const find = id => custom.nodes.find(value => value.id === id);
  for (const id of ["b:garden:1", "b:dryer:1", "r:grow_berries"]) assert.equal(find(id).phase, 2, id);
  assert.equal(find("r:dry_berries").phase, 3, "an existing higher recipe gate remains authoritative");
  assert.equal(find("bush").phase, 0, "The existing object itself is not a late-game unlock");
  assert.equal(find("b:home:2").phase, 2);
  assert.equal(find("b:woodlot:1").phase, 1);
  assert.equal(find("r:dry_berries").requirements.home, catalog.recipes.find(value => value.id === "dry_berries").requiredHomeLevel);
});

test("ten storage levels stay visible in economic sections with their true sequential gates and relic sources", () => {
  const warehouse = catalog.buildings.find(value => value.id === "warehouse");
  assert.equal(warehouse.levels.length, 10);
  const layout = buildProgressionLayout(graph);
  for (const level of warehouse.levels) {
    const id = `b:warehouse:${level.level}`, storage = node(id), position = layout.positions.get(id);
    assert.equal(storage.status, "active");
    assert.equal(storage.locationId, "place:home");
    assert.equal(storage.phase, level.requiredHomeLevel, "house gates and ingredient sources place storage in its actual stage");
    assert.deepEqual(plain(storage.cost), level.cost);
    assert.equal(storage.warehouseCapacity, level.warehouseCapacity);
    assert(position, `storage ${level.level} must not disappear beyond the five home tiers`);
    const group = layout.groups.find(value => value.phase === storage.phase && value.locationId === "place:home");
    assert(position.x >= group.x && position.x + NODE_WIDTH <= group.x + group.width);
    assert(position.y >= group.y && position.y + NODE_HEIGHT <= group.y + group.height);
    assert.deepEqual(plain(storage.requirements), level.level === 1 ? { home: 1 }
      : { home: level.requiredHomeLevel, ...level.requiredBuildings, warehouse: level.level - 1 });
    const gates = getPrerequisiteIds(graph, id, false);
    assert.equal(gates.has("b:home:2"), level.level >= 2);
    assert.equal(gates.has("b:home:3"), level.level >= 3);
    assert.equal(gates.has("b:home:4"), level.requiredHomeLevel >= 4);
    assert.equal(gates.has("b:home:5"), level.requiredHomeLevel >= 5);
    assert.equal(storage.requirements.workshop, level.requiredBuildings.workshop);
    if (level.level >= 4) {
      for (const relic of Object.keys(level.cost.items).filter(id => catalog.rareDrops.itemIds.includes(id))) {
        assert.equal(getProgressionResourceSource(graph, relic).id, "rare_materials");
      }
      assert(hasEdge("rare_materials", id, "cost"));
      assert(getPrerequisiteIds(graph, id).has("b:home:3"), "home 3 opens the relic source, not the storage command");
    }
  }
});

test("workbench layout places every node once and groups equipment in one map location without overlapping nodes", () => {
  const layout = buildProgressionLayout(graph);
  assert.equal(layout.positions.size, graph.nodes.length);
  for (const value of graph.nodes) {
    const position = layout.positions.get(value.id);
    assert(position, value.id);
    const section = layout.sections.find(section => section.phase === value.phase);
    assert(Number.isFinite(position.x) && Number.isFinite(position.y), value.id);
    assert(position.x >= section.x && position.x + NODE_WIDTH <= section.x + section.width, value.id);
    assert(position.y >= section.y && position.y + NODE_HEIGHT <= section.y + section.height, value.id);
    const producer = value.kind === "recipe" ? node(`b:${value.buildingId}:${value.level}`) : value;
    if (value.kind === "building" || value.kind === "recipe" && producer.phase === value.phase) {
      const group = layout.groups.find(group => group.phase === value.phase && group.locationId === value.locationId);
      assert(group, `No map location group for ${value.id}`);
      assert(position.y >= group.y && position.y + NODE_HEIGHT <= group.y + group.height, value.id);
    } else if (value.kind === "recipe") {
      assert(producer.phase < value.phase, `${value.id} keeps its later gate in a separate section`);
    }
  }
  for (const section of layout.sections) for (const location of progressionLocations) {
    const hasBuildings = graph.nodes.some(value => value.kind === "building" && value.phase === section.phase && value.locationId === location.id);
    assert.equal(layout.groups.filter(group => group.phase === section.phase && group.locationId === location.id).length,
      hasBuildings ? 1 : 0, `${location.id} phase ${section.phase}`);
  }
  const placed = Array.from(layout.positions.entries());
  for (let index = 0; index < placed.length; index += 1) for (let other = index + 1; other < placed.length; other += 1) {
    const [id, first] = placed[index], [otherId, second] = placed[other];
    assert(first.x + NODE_WIDTH <= second.x || second.x + NODE_WIDTH <= first.x || first.y + NODE_HEIGHT <= second.y || second.y + NODE_HEIGHT <= first.y, `${id} overlaps ${otherId}`);
  }
  // Catalog additions with more than three recipes wrap inside the same workbench column.
  const expanded = structuredClone(catalog);
  const recipe = expanded.recipes.find(value => value.id === "make_planks");
  for (let index = 0; index < 5; index += 1) expanded.recipes.push({ ...structuredClone(recipe), id: `extra_planks_${index}` });
  const extraGraph = buildProgressionGraph(expanded), extraLayout = buildProgressionLayout(extraGraph);
  assert.equal(extraLayout.positions.size, extraGraph.nodes.length);
  for (const value of extraGraph.nodes.filter(value => value.kind === "recipe" && value.buildingId === "workshop" && value.level === 1)) {
    const point = extraLayout.positions.get(value.id);
    const section = extraLayout.sections.find(section => section.phase === value.phase);
    assert(point.x >= section.x && point.x + NODE_WIDTH <= section.x + section.width, value.id);
  }
});

test("cost chains are optional for prerequisite inspection and never rewrite the catalog", () => {
  const before = JSON.stringify(catalog);
  const constructed = buildProgressionGraph(catalog);
  assert.equal(JSON.stringify(catalog), before);
  const requiredOnly = getPrerequisiteIds(constructed, "r:dry_berries", false);
  const withCosts = getPrerequisiteIds(constructed, "r:dry_berries");
  assert(requiredOnly.has("b:dryer:1"));
  assert(!requiredOnly.has("r:grow_berries"));
  assert(withCosts.has("r:grow_berries"));
  assert(withCosts.has("b:garden:1"));
  assert(withCosts.size > requiredOnly.size);
  constructed.nodes.find(value => value.id === "r:dry_berries").cost.items.berries = 999;
  constructed.nodes.find(value => value.id === "r:dry_berries").rewards.dried_berries = 999;
  constructed.nodes.find(value => value.id === "r:dry_berries").requirements.home = 5;
  assert.equal(JSON.stringify(catalog), before);
});

test("graph derives new recipes and market counters from a supplied catalog", () => {
  const changed = structuredClone(catalog);
  const original = changed.recipes.find(value => value.id === "make_planks");
  changed.recipes.push({ ...structuredClone(original), id: "new_plank_batch", name: "Новая партия досок", buildingLevel: 5, requiredHomeLevel: 5, rewards: { planks: 7 }, seconds: 9000 });
  changed.market.requiredHomeLevel = 3;
  changed.market.requiredExplorations = 3;
  const custom = buildProgressionGraph(changed);
  const extra = custom.nodes.find(value => value.id === "r:new_plank_batch");
  assert(extra);
  assert.equal(extra.phase, 5);
  assert.equal(extra.rewards.planks, 7);
  assert(custom.nodes.find(value => value.id === "b:workshop:5").children.includes(extra.id));
  assert.deepEqual(plain(custom.nodes.find(value => value.id === "market").requirements), { home: 3, bridge: 1, completedExplorations: 3 });
  assert(custom.edges.some(edge => edge.source === "b:home:3" && edge.target === "market" && edge.kind === "requirement"));
  assert(!custom.edges.some(edge => edge.source === "b:home:2" && edge.target === "market"));
});

test("prerequisite traversal terminates on cycles, ignores stale ids and isolates accidental plan requirements", () => {
  const make = (id, status = "active") => ({ id, title: id, label: id, icon: "", kind: "world", status, phase: 0, requirements: {}, children: [] });
  const custom = {
    nodes: [make("a"), make("b"), make("future", "plan")],
    edges: [
      { id: "ab", source: "a", target: "b", kind: "requirement" },
      { id: "ba", source: "b", target: "a", kind: "requirement" },
      { id: "future-a", source: "future", target: "a", kind: "requirement" },
      { id: "stale-a", source: "stale", target: "a", kind: "requirement" },
    ],
  };
  assert.deepEqual(Array.from(getPrerequisiteIds(custom, "a")).sort(), ["a", "b"]);
  assert.equal(getPrerequisiteIds(custom, "missing").size, 0);
});


test("mine upgrades visibly unlock actor activities and never revive retired production", () => {
  for (const level of catalog.buildings.find(building => building.id === "quarry").levels) {
    const mine = node(`b:quarry:${level.level}`);
    assert.ok(mine.children.length > 0, `mine level ${level.level} has a purpose`);
    for (const id of mine.children) {
      const activity = node(id);
      assert.equal(activity.kind, "exploration");
      assert.equal(activity.locationId, "place:quarry");
      assert.equal(activity.requirements.quarry, level.level);
      assert(hasEdge(mine.id, id, "unlock"));
      assert(hasEdge(mine.id, id, "requirement"));
    }
  }
  assert.equal(graph.nodes.some(node => node.kind === "recipe" && node.buildingId === "quarry"), false);
});


test("player graph prices and rewards use visible pearls while costs keep internal units", () => {
  assert.ok(node("pleska").description.includes(`обновление стоит до ${moneyContext.exports.formatPearls(catalog.fishing.shop.refreshPricePearls)} жемчужин`));
  assert.match(node("pearls").description, /1 мин — 1 жемчужин; 1 ч — 12 жемчужин; 24 ч — 288 жемчужин; 48 ч — 576 жемчужин/);
  assert.doesNotMatch(node("pearls").description, /жемчужина за 10 минут/);
  const gifts = progressionRewards.daily.reduce((sum, reward) => sum + reward.pearls, 0);
  assert.ok(node("daily_rewards").description.includes(`${moneyContext.exports.formatPearls(gifts)} жемчужин`));
  assert.equal(catalog.pearlScale, 50);
  assert.equal(catalog.fishing.shop.refreshPricePearls, 100);
});

test("the orders graph describes material-led house-four projects and permanent market discovery", () => {
  const orders = node("orders").description;
  assert.match(orders, /один учебный заказ на малину, 3 просьбы к дому 2/);
  assert.match(orders, /7 просьб дома 2, включая улов и жареную рыбу/);
  assert.match(orders, /проект из 8 поставок: следующая открывается сразу после сдачи предыдущей/);
  assert.match(orders, /Искусственной паузы между поставками нет/);
  assert.match(orders, /Ожидание между всеми поставками: 0 с; строительство дома считается отдельно.*Живая смола × 1/);
  assert.match(node("market").description, /бесплатно доступны 5 мест/);
  assert.match(node("market").description, /покупаются по очереди до 10/);
  for (const [index, price] of [50, 80, 120, 180, 250].entries()) assert.ok(node("market").description.includes(`${index + 6}-е — ${price} жемчужин`));
  assert.match(node("market").description, /одного уровня дома недостаточно/);
  assert.match(node("market").description, /Открытие сохраняется после продажи запасов и недоступности источника/);
  const soup = catalog.food.meals.find(meal => meal.itemId === "fish_soup");
  assert.match(node("r:cook_fish_soup").description,
    new RegExp(`Рыбный суп даёт Мохлику \\+${soup.heroSpeedBps / 100}%.*строителю \\+${soup.builderSpeedBps / 100}%.*шахтёра не ускоряет`));
  for (const building of catalog.buildings.filter(entry => entry.id !== "warehouse")) for (const level of building.levels)
    assert(!("warehouse" in node(`b:${building.id}:${level.level}`).requirements), `${building.id}:${level.level}: storage is optional`);
  for (const recipe of activeRecipes) assert(!("warehouse" in node(`r:${recipe.id}`).requirements), recipe.id);
  for (const route of activeExplorations) assert(!("warehouse" in node(`e:${route.id}`).requirements), route.id);
});

test("the house-five graph distinguishes project funding and guaranteed relics from random exploration", () => {
  assert.match(node("orders").description, /Дом 5 требует 12 поставок без ожидания между ними/);
  assert.ok(node("orders").description.includes(`${catalog.stageOrders.find(course => course.homeLevel === 4).orders.reduce((sum, order) => sum + order.coins, 0)} монет за весь проект`));
  assert.match(node("orders").description, /Финал гарантирует Древнее ядро × 1, Лунный кристалл × 1/);
  assert.match(node("orders").description, /полученный результат исследования руин; запуск или отмена не засчитываются/);
  assert.match(node("rare_materials").description, /Проект дома 4 отдельно гарантирует Древнее ядро × 1, Лунный кристалл × 1/);
  assert.match(node("rare_materials").description, /переход к дому 5 не зависит от случайного вида реликвии/);
  assert.equal(node("e:ancient_ruins").rewards.ancient_core, undefined);
  assert.equal(node("e:ancient_ruins").rewards.moon_crystal, undefined);
  for (const relic of ["ancient_core", "moon_crystal"]) assert.equal(getProgressionResourceSource(graph, relic).id, "rare_materials");
});
