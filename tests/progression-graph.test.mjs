import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const catalog = JSON.parse(readFileSync(new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../features/progression/graph.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {}, require: specifier => {
  assert.equal(specifier, "@/features/economy/model");
  return { economyCatalog: catalog };
} };
vm.runInNewContext(code, context);
const { progressionGraph: graph, buildProgressionGraph, getPrerequisiteIds } = context.exports;
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
  assert.equal(graph.nodes.filter(value => value.kind === "recipe").length, 49);
  assert.equal(graph.nodes.filter(value => value.kind === "exploration").length, 10);
  for (const building of catalog.buildings) for (const level of building.levels) {
    const value = node(`b:${building.id}:${level.level}`);
    assert(value, `${building.id} ${level.level}`);
    assert.equal(value.title, `${building.name} · уровень ${level.level}`);
    assert.deepEqual(plain(value.cost), level.cost);
    assert.equal(value.seconds, level.seconds);
    if (level.warehouseCapacity) assert.equal(value.warehouseCapacity, level.warehouseCapacity);
    assert.deepEqual(Array.from(value.children).sort(), catalog.recipes.filter(recipe => recipe.buildingId === building.id && recipe.buildingLevel === level.level).map(recipe => `r:${recipe.id}`).sort());
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
  assert.equal(graph.nodes.length, 138);
  assert.equal(graph.nodes.filter(value => value.status === "plan").length, 13);
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
  for (const exploration of catalog.explorations) assert(hasEdge(`e:${exploration.id}`, "claimed", "any"));
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
  for (const edge of graph.edges.filter(edge => proposed.has(edge.source) || proposed.has(edge.target))) assert.equal(edge.kind, "plan", edge.id);
  for (const value of graph.nodes.filter(value => value.status === "active")) {
    for (const prerequisite of getPrerequisiteIds(graph, value.id)) assert(!proposed.has(prerequisite), `${prerequisite} gates ${value.id}`);
  }
  const bridge = getPrerequisiteIds(graph, "bridge", false);
  for (const id of ["bridge_ruin", "r:make_planks", "r:make_rope", "r:make_tools"]) assert(bridge.has(id));
  assert(!getPrerequisiteIds(graph, "album").has("new_finds"));
  assert(!getPrerequisiteIds(graph, "leaderboard").has("taps"), "Rating flow is not an unlock gate");
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
