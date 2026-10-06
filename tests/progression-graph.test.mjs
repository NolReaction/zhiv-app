import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../features/progression/graph.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {}, require: specifier => {
  if (specifier === "@/apps/api/src/main/resources/world/progression-rewards-catalog.json") return { default: JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/progression-rewards-catalog.json", import.meta.url), "utf8")) };
  assert.equal(specifier, "@/features/economy/model");
  return { economyCatalog: catalog };
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

test("progression contains every catalog building level, recipe and exploration exactly once", () => {
  assert.equal(graph.nodes.filter(value => value.kind === "building").length, 40);
  assert.equal(graph.nodes.filter(value => value.kind === "recipe").length, catalog.recipes.length);
  assert.equal(graph.nodes.filter(value => value.kind === "exploration").length, catalog.explorations.length);
  for (const building of catalog.buildings) for (const level of building.levels) {
    const value = node(`b:${building.id}:${level.level}`);
    assert(value, `${building.id} ${level.level}`);
    assert.equal(value.title, `${buildingLabels[building.id] || building.name} · уровень ${level.level}`);
    assert.deepEqual(plain(value.cost), level.cost);
    assert.equal(value.seconds, level.seconds);
    if (level.warehouseCapacity) assert.equal(value.warehouseCapacity, level.warehouseCapacity);
    assert.deepEqual(Array.from(value.children).sort(), [
      ...catalog.recipes.filter(recipe => recipe.buildingId === building.id && recipe.buildingLevel === level.level).map(recipe => `r:${recipe.id}`),
      ...(building.id === "quarry" ? catalog.explorations.filter(route => route.requiredBuildings.quarry === level.level).map(route => `e:${route.id}`) : []),
    ].sort());
  }
  for (const recipe of catalog.recipes) {
    const value = node(`r:${recipe.id}`);
    assert.equal(value.title, recipe.name);
    assert.deepEqual(plain(value.cost), recipe.cost);
    assert.deepEqual(plain(value.rewards), recipe.rewards);
    assert.equal(value.seconds, recipe.seconds);
    assert(hasEdge(`b:${recipe.buildingId}:${recipe.buildingLevel}`, value.id, "unlock"));
  }
  for (const exploration of catalog.explorations) {
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
  assert.equal(graph.nodes.length, 151);
  assert.equal(node("pearls").status, "active");
  assert.ok(!graph.edges.some(edge => edge.source === "pearls" && ["requirement", "unlock"].includes(edge.kind)), "optional acceleration never gates progression");
  assert.equal(graph.nodes.filter(value => value.status === "plan").length, 17);
});

test("daily and earned achievements explain current pearl sources while the future merchant cannot gate upgrades", () => {
  assert.equal(node("daily_rewards").status, "active");
  assert.match(node("daily_rewards").description, /7 получений/); assert.match(node("daily_rewards").description, /450 жемчужин/);
  assert.match(node("daily_rewards").description, /20 часов/); assert.match(node("daily_rewards").description, /Пропуск не сбрасывает/);
  assert.match(node("pearls").description, /до 2150/); assert.match(node("achievements").description, /до 2150/);
  assert(hasEdge("daily_rewards", "pearls", "flow")); assert(hasEdge("achievements", "pearls", "flow"));
  assert.equal(node("pearl_trader").status, "plan");
  assert(graph.edges.filter(edge => edge.source === "pearl_trader" || edge.target === "pearl_trader").every(edge => edge.kind === "plan"));
  assert(!getPrerequisiteIds(graph, "b:home:5").has("pearl_trader"));
  assert.match(node("market").description, /обмен реликвиями 1:1/);
});

test("rare materials share a real post-home-three exploration source without a fake recipe or coin purchase", () => {
  const source = node("rare_materials");
  assert.equal(source.kind, "acquisition"); assert.equal(source.status, "active"); assert.equal(source.phase, 3);
  assert.deepEqual(plain(source.requirements), { home: 3 });
  assert.deepEqual(plain(source.rareDrops), catalog.rareDrops);
  assert.equal(source.rewards, undefined); assert.equal(source.seconds, undefined); assert.equal(source.cost, undefined);
  assert.match(source.description, /один общий счётчик/); assert.match(source.description, /48 до 144/);
  assert.match(source.description, /равновероятных/); assert.match(source.description, /Конкретный тип не гарантирован/);
  assert.match(source.description, /купить или продать за монеты нельзя/);
  assert(hasEdge("b:home:3", source.id, "requirement"));
  for (const route of catalog.explorations) assert(hasEdge(`e:${route.id}`, source.id, "any"));
  for (const item of catalog.rareDrops.itemIds) {
    assert.equal(getProgressionResourceSource(graph, item).id, source.id, "Cost buttons resolve the earned source");
    assert(!graph.nodes.some(value => value.rewards?.[item]), "No guaranteed trip, recipe or merchant reward");
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

test("fishing and friend profiles are current while glade visits and Pleska's home remain optional proposals", () => {
  assert.equal(node("pleska").status, "active");
  assert.equal(node("fishing_catches").status, "active");
  assert(hasEdge("start", "pleska", "available"));
  assert.equal(node("public_profiles").status, "active");
  assert(hasEdge("start", "public_profiles", "available"));
  for (const id of ["friend_glade", "pleska_home"]) {
    assert.equal(node(id).status, "plan");
    assert.equal(node(id).cost, undefined);
    assert.equal(node(id).seconds, undefined);
    assert(!getPrerequisiteIds(graph, "b:home:5").has(id));
  }
  assert.equal(node("player_level").status, "active");
  assert.equal(node("achievements").status, "active");
  assert.match(node("willow_rod").description, /отдельная вещь/);
  assert.match(node("trader").description, /40%/);
  assert.match(node("b:warehouse:1").description, /объявлениях рынка/);
  assert.match(node("r:grow_berries").description, /Партия: до 1/);
});

test("production and construction retain every house, previous-level and additional building gate", () => {
  for (const building of catalog.buildings) for (const level of building.levels) {
    const id = `b:${building.id}:${level.level}`;
    if (id !== "b:home:1") assert(hasEdge(`b:home:${level.requiredHomeLevel}`, id, "requirement"), `${id}: home gate`);
    if (level.level > 1) assert(hasEdge(`b:${building.id}:${level.level - 1}`, id, "requirement"), `${id}: previous level`);
    for (const [other, minimum] of Object.entries(level.requiredBuildings)) assert(hasEdge(`b:${other}:${minimum}`, id, "requirement"), `${id}: ${other}`);
  }
  for (const recipe of catalog.recipes) {
    const id = `r:${recipe.id}`;
    assert(hasEdge(`b:home:${recipe.requiredHomeLevel}`, id, "requirement"));
    for (const [other, minimum] of Object.entries(recipe.requiredBuildings)) assert(hasEdge(`b:${other}:${minimum}`, id, "requirement"));
  }
  for (const exploration of catalog.explorations) {
    const id = `e:${exploration.id}`;
    assert(hasEdge(`b:home:${exploration.requiredHomeLevel}`, id, "requirement"));
    for (const [other, minimum] of Object.entries(exploration.requiredBuildings)) assert(hasEdge(`b:${other}:${minimum}`, id, "requirement"));
  }
  const finalHouse = getPrerequisiteIds(graph, "b:home:5", false);
  for (const id of ["b:workshop:4", "b:quarry:4", "b:warehouse:4", "b:kiln:4", "b:dryer:3", "b:woodlot:4"]) assert(finalHouse.has(id), id);
  assert.equal(node("r:make_reinforced_parts").requirements.woodlot, 4);
  assert.equal(node("r:make_beams").requirements.woodlot, 3);
});

test("market requires both home and completed exploration; any route suffices instead of all routes", () => {
  assert.deepEqual(plain(node("market").requirements), { home: 2, completedExplorations: 1 });
  const incoming = graph.edges.filter(edge => edge.target === "market" && edge.kind === "requirement").map(edge => edge.source);
  assert.deepEqual(Array.from(incoming).sort(), ["b:home:2", "claimed"]);
  const unlocked = state => Object.entries(node("market").requirements).every(([counter, required]) => state[counter] >= required);
  assert.equal(unlocked({ home: 1, completedExplorations: 0 }), false);
  assert.equal(unlocked({ home: 2, completedExplorations: 0 }), false);
  assert.equal(unlocked({ home: 1, completedExplorations: 1 }), false);
  assert.equal(unlocked({ home: 2, completedExplorations: 1 }), true);
  for (const exploration of catalog.explorations) assert.equal(hasEdge(`e:${exploration.id}`, "claimed", "any"), !exploration.id.startsWith("quarry_"));
  const prerequisites = getPrerequisiteIds(graph, "market", false);
  assert(prerequisites.has("claimed"));
  assert(prerequisites.has("b:home:2"));
  assert(!graph.nodes.some(value => value.kind === "exploration" && prerequisites.has(value.id)), "Any exploration must not become all ten mandatory routes");
  assert.deepEqual(Array.from(getPrerequisiteIds(graph, "claimed", false)), ["claimed"]);
});

test("future bridge and lighthouse proposals cannot gate actual production, collections or market", () => {
  const proposed = new Set(graph.nodes.filter(value => value.status === "plan").map(value => value.id));
  assert.equal(node("bridge_ruin").status, "active");
  assert.equal(node("lighthouse_ruin").status, "active");
  assert.equal(node("bridge").status, "plan");
  assert.equal(node("lighthouse").status, "plan");
  assert.equal(node("mine_interior").status, "plan");
  for (const edge of graph.edges.filter(edge => proposed.has(edge.source) || proposed.has(edge.target))) assert.equal(edge.kind, "plan", edge.id);
  for (const value of graph.nodes.filter(value => value.status === "active")) {
    for (const prerequisite of getPrerequisiteIds(graph, value.id)) assert(!proposed.has(prerequisite), `${prerequisite} gates ${value.id}`);
  }
  const bridge = getPrerequisiteIds(graph, "bridge", false);
  for (const id of ["bridge_ruin", "r:make_planks", "r:make_rope", "r:make_tools"]) assert(bridge.has(id));
  assert(!getPrerequisiteIds(graph, "album").has("new_finds"));
  assert(!getPrerequisiteIds(graph, "leaderboard").has("taps"), "Rating flow is not an unlock gate");
});

test("existing places contain improvements without becoming construction or recipe gates", () => {
  const expected = {
    "place:home": ["home", "warehouse"], "place:workshop": ["workshop", "kiln"],
    bush: ["garden"], campfire: ["dryer"], "place:woodlot": ["woodlot"], "place:quarry": ["quarry"],
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

test("new quarry and kiln construction follow home 2 while grandfathered low-level recipes keep their catalog requirements", () => {
  assert.equal(node("b:quarry:1").requirements.home, 2);
  assert.equal(node("b:kiln:1").requirements.home, 2);
  assert.equal(node("b:kiln:1").requirements.workshop, 1);
  assert.equal(node("b:kiln:1").requirements.quarry, 1);
  assert(!("quarry" in node("b:home:2").requirements));
  assert(!getPrerequisiteIds(graph, "b:home:2", false).has("b:quarry:1"));
  for (const id of ["b:quarry:1", "b:kiln:1", "e:quarry_stone", "e:quarry_stone_overnight", "r:make_charcoal"]) assert.equal(node(id).phase, 2, id);
  for (const [prefix, recipe] of [["e", catalog.explorations.find(value => value.id === "quarry_stone")], ["r", catalog.recipes.find(value => value.id === "make_charcoal")]]) {
    assert.equal(node(`${prefix}:${recipe.id}`).requirements.home, recipe.requiredHomeLevel, "Display phase must not invent a stronger server requirement");
  }
});

test("display phases follow transitive catalog gates without moving unrelated places or inventing new requirements", () => {
  const changed = structuredClone(catalog);
  changed.buildings.find(value => value.id === "garden").levels[0].requiredHomeLevel = 2;
  changed.buildings.find(value => value.id === "dryer").levels[0].requiredBuildings = { garden: 1 };
  const custom = buildProgressionGraph(changed);
  const find = id => custom.nodes.find(value => value.id === id);
  for (const id of ["b:garden:1", "b:dryer:1", "r:grow_berries", "r:dry_berries"]) assert.equal(find(id).phase, 2, id);
  assert.equal(find("bush").phase, 0, "The existing object itself is not a late-game unlock");
  assert.equal(find("b:home:2").phase, 2);
  assert.equal(find("b:woodlot:1").phase, 1);
  assert.equal(find("r:dry_berries").requirements.home, catalog.recipes.find(value => value.id === "dry_berries").requiredHomeLevel);
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
    if (value.kind === "building" || value.kind === "recipe") {
      const group = layout.groups.find(group => group.phase === value.phase && group.locationId === value.locationId);
      assert(group, `No map location group for ${value.id}`);
      assert(position.y >= group.y && position.y + NODE_HEIGHT <= group.y + group.height, value.id);
    }
  }
  for (const location of progressionLocations) {
    assert.equal(layout.groups.filter(group => group.phase === 2 && group.locationId === location.id).length, 1, location.id);
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
  const section = extraLayout.sections.find(value => value.phase === 1);
  for (const value of extraGraph.nodes.filter(value => value.kind === "recipe" && value.buildingId === "workshop" && value.level === 1)) {
    const point = extraLayout.positions.get(value.id);
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
  assert.deepEqual(plain(custom.nodes.find(value => value.id === "market").requirements), { home: 3, completedExplorations: 3 });
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
