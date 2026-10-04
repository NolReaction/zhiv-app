import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const catalogPath = new URL("../apps/api/src/main/resources/world/economy-catalog.json", import.meta.url);
const startingBuildings = { home: 1, garden: 1, warehouse: 1 };
const day = 86_400;

/** Audits the actual catalog, including free-start reachability without player-market purchases.
 * Timing bounds deliberately assume unlimited money/materials and instant collection:
 * A fresh single profile cannot beat them while construction uses one non-accelerated
 * slot. Imported legacy progress and account merges deliberately retain earned levels
 * and are outside these bounds; the audit is not a prediction of actual play duration.
 */
export function auditEconomyProgression(catalog) {
  const unique = (entries, kind) => {
    const indexed = new Map(entries.map(entry => [entry.id, entry]));
    assert.equal(indexed.size, entries.length, `Duplicate ${kind} ID`);
    return indexed;
  };
  const items = unique(catalog.items, "item");
  const buildings = unique(catalog.buildings, "building");
  unique(catalog.recipes, "recipe");
  unique(catalog.explorations, "exploration");
  assert.equal(catalog.version, 2);
  const nodes = new Map();
  const itemUses = new Set();
  const requirements = definition => ({
    ...(definition.requiredBuildings ?? {}),
    home: Math.max(definition.requiredHomeLevel, definition.requiredBuildings?.home ?? 1),
  });
  const validateQuantities = (quantities, context, countUse = false) => {
    for (const [item, amount] of Object.entries(quantities)) {
      assert(items.has(item), `${context}: unknown item ${item}`);
      assert(Number.isSafeInteger(amount) && amount > 0, `${context}: invalid quantity ${item}`);
      if (countUse) itemUses.add(item);
    }
  };
  const validateRequirements = (definition, context) => {
    for (const [id, level] of Object.entries(requirements(definition))) {
      assert(buildings.get(id)?.levels.some(candidate => candidate.level === level), `${context}: unknown prerequisite ${id}:${level}`);
    }
  };
  for (const building of buildings.values()) {
    assert.deepEqual(building.levels.map(level => level.level), [1, 2, 3, 4, 5], `${building.id}: sequential tiers expected`);
    for (const level of building.levels) {
      const key = `${building.id}:${level.level}`;
      nodes.set(key, { buildingId: building.id, ...level });
      validateRequirements(level, key);
      validateQuantities(level.cost.items, key, true);
      assert(Number.isSafeInteger(level.seconds) && level.seconds >= 0, `${key}: invalid duration`);
      assert(Number.isSafeInteger(level.cost.coins) && level.cost.coins >= 0, `${key}: invalid price`);
      if (building.id === "warehouse") {
        assert(Number.isSafeInteger(level.warehouseCapacity) && level.warehouseCapacity > 0, `${key}: warehouse capacity missing`);
        if (level.level > 1) assert(level.warehouseCapacity > building.levels[level.level - 2].warehouseCapacity, `${key}: storage must grow`);
      } else if (building.id !== "home") {
        assert(catalog.recipes.some(recipe => recipe.buildingId === building.id && recipe.buildingLevel === level.level), `${key}: upgrade has no production benefit`);
      }
    }
  }
  const production = [...catalog.recipes, ...catalog.explorations];
  const npcValue = quantities => Object.entries(quantities).reduce((sum, [item, amount]) => sum + items.get(item).baseSellPrice * amount, 0);
  for (const definition of production) {
    validateRequirements(definition, definition.id);
    validateQuantities(definition.cost.items, definition.id, true);
    validateQuantities(definition.rewards, definition.id);
    assert(Object.keys(definition.rewards).length > 0, `${definition.id}: empty output`);
    assert(Number.isSafeInteger(definition.seconds) && definition.seconds > 0, `${definition.id}: invalid duration`);
    if (definition.buildingId) {
      assert(nodes.has(`${definition.buildingId}:${definition.buildingLevel}`), `${definition.id}: unknown producer`);
      const inputValue = npcValue(definition.cost.items) + definition.cost.coins;
      assert(npcValue(definition.rewards) > inputValue, `${definition.id}: crafting destroys NPC value`);
    }
  }
  const merchantItems = [];
  if (catalog.fishing) {
    const fishing = catalog.fishing;
    unique(fishing.rods, "rod");
    assert.equal(new Set(fishing.fish.map(fish => fish.itemId)).size, fishing.fish.length, "Duplicate fish ID");
    assert.equal(new Set(fishing.baits.map(bait => bait.itemId)).size, fishing.baits.length, "Duplicate bait ID");
    assert(fishing.routeIds.length > 0 && fishing.routeIds.every(id => catalog.explorations.some(route => route.id === id && route.rewards.fish > 0)), "Fishing needs a real fish route");
    assert(fishing.rods.some(rod => rod.id === "reed_rod" && rod.price === 0), "Starter rod must remain free");
    for (const rod of fishing.rods) assert(Number.isSafeInteger(rod.price) && rod.price >= 0 && Number.isSafeInteger(rod.rareBonus) && rod.rareBonus >= 0, "Invalid rod price or bonus");
    for (const fish of fishing.fish) {
      assert(items.has(fish.itemId), `Fishing: unknown item ${fish.itemId}`);
      assert(Number.isSafeInteger(fish.buyPrice) && fish.buyPrice > items.get(fish.itemId).baseSellPrice, "Fish buy-sell arbitrage");
      assert(Number.isSafeInteger(fish.weight) && fish.weight > 0 && Number.isSafeInteger(fish.affinity) && fish.affinity >= 0, "Invalid fishing weight");
      itemUses.add(fish.itemId); // Sold at Pleska's shop and recorded permanently in the catch collection.
      merchantItems.push(fish.itemId);
    }
    for (const bait of fishing.baits) {
      assert(items.has(bait.itemId), `Fishing: unknown bait ${bait.itemId}`);
      assert(Number.isSafeInteger(bait.price) && bait.price > items.get(bait.itemId).baseSellPrice, "Bait buy-sell arbitrage");
      itemUses.add(bait.itemId); // One stack unit is consumed by a special fishing departure.
      merchantItems.push(bait.itemId);
    }
    for (let index = 1; index < fishing.fish.length; index++) {
      const previous = fishing.fish[index - 1], fish = fishing.fish[index];
      assert(fish.affinity * previous.weight >= previous.affinity * fish.weight, "Stronger tackle must not improve cheaper fish over rarer fish");
    }
  }
  assert.deepEqual([...items.keys()].filter(item => !itemUses.has(item)), [], "Every item must serve crafting, construction, exploration or fishing");

  const closure = (target, visiting = new Set(), result = new Set()) => {
    assert(!visiting.has(target), `Construction dependency cycle at ${target}`);
    if (result.has(target)) return result;
    const node = nodes.get(target);
    assert(node, `Unknown construction ${target}`);
    if (node.level <= (startingBuildings[node.buildingId] ?? 0)) return result;
    const nextVisiting = new Set(visiting).add(target);
    if (node.level > 1) closure(`${node.buildingId}:${node.level - 1}`, nextVisiting, result);
    for (const [id, level] of Object.entries(requirements(node))) closure(`${id}:${level}`, nextVisiting, result);
    result.add(target);
    return result;
  };
  for (const key of nodes.keys()) {
    const prerequisites = closure(key);
    const node = nodes.get(key);
    const priorStorage = Math.max(1, ...[...prerequisites].filter(id => id !== key && id.startsWith("warehouse:")).map(id => nodes.get(id).level));
    const capacity = buildings.get("warehouse").levels[priorStorage - 1].warehouseCapacity;
    const inputCount = Object.values(node.cost.items).reduce((sum, amount) => sum + amount, 0);
    assert(inputCount <= capacity * 0.85, `${key}: upgrade inputs leave insufficient space (${inputCount}/${capacity})`);
  }
  for (const definition of production) {
    const prerequisites = new Set();
    for (const [id, level] of Object.entries(requirements(definition))) closure(`${id}:${level}`, new Set(), prerequisites);
    if (definition.buildingId) closure(`${definition.buildingId}:${definition.buildingLevel}`, new Set(), prerequisites);
    const storageLevel = Math.max(1, ...[...prerequisites].filter(id => id.startsWith("warehouse:")).map(id => nodes.get(id).level));
    const capacity = buildings.get("warehouse").levels[storageLevel - 1].warehouseCapacity;
    assert(Object.values(definition.cost.items).reduce((sum, amount) => sum + amount, 0) <= capacity, `${definition.id}: one batch input exceeds available storage`);
    assert(Object.values(definition.rewards).reduce((sum, amount) => sum + amount, 0) <= capacity, `${definition.id}: one batch output exceeds available storage`);
  }

  // Constructive unlock audit. An obtainable item can be generated repeatedly;
  // initial free berries can always be sold to meet every finite coin cost.
  const completed = { ...startingBuildings };
  const obtainable = new Set();
  const constructionOrder = [];
  const hasRequirements = definition => Object.entries(requirements(definition)).every(([id, level]) => (completed[id] ?? 0) >= level);
  const hasMaterials = cost => Object.keys(cost.items).every(item => obtainable.has(item));
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of production) {
      if (!hasRequirements(definition) || !hasMaterials(definition.cost)) continue;
      if (definition.buildingId && (completed[definition.buildingId] ?? 0) < definition.buildingLevel) continue;
      for (const item of Object.keys(definition.rewards)) {
        if (!obtainable.has(item)) { obtainable.add(item); changed = true; }
      }
    }
    // Repeatable free produce supplies coins, so fixed-price NPC stock is reachable.
    // This does not assume another player supplies a missing progression material.
    if ([...obtainable].some(id => items.get(id)?.tradable)) for (const item of merchantItems) {
      if (!obtainable.has(item)) { obtainable.add(item); changed = true; }
    }
    for (const building of buildings.values()) {
      const next = building.levels.find(level => level.level === (completed[building.id] ?? 0) + 1);
      if (!next || !hasRequirements(next) || !hasMaterials(next.cost)) continue;
      completed[building.id] = next.level;
      constructionOrder.push(`${building.id}:${next.level}`);
      changed = true;
    }
  }
  assert.deepEqual([...items.keys()].filter(item => !obtainable.has(item)), [], "Resources cannot be produced from a free start");
  assert.deepEqual(Object.fromEntries([...buildings.keys()].map(id => [id, completed[id] ?? 0])), Object.fromEntries([...buildings.keys()].map(id => [id, 5])), "A material/building dependency blocks progression without market purchases");
  assert(catalog.recipes.some(recipe => recipe.requiredHomeLevel === 1 && recipe.buildingId === "garden" && recipe.buildingLevel === 1 && recipe.seconds >= 8 * 3600 && recipe.cost.coins === 0 && !Object.keys(recipe.cost.items).length), "Starter needs a free overnight crop");
  assert(catalog.explorations.some(route => route.requiredHomeLevel === 1 && route.seconds >= 8 * 3600 && route.cost.coins === 0 && !Object.keys(route.cost.items).length), "Starter needs a free overnight exploration");
  const duration = targets => [...targets].reduce((sum, key) => sum + nodes.get(key).seconds, 0);
  const homeStages = buildings.get("home").levels.map(level => ({ level: level.level, minimumSeconds: duration(closure(`home:${level.level}`)) }));
  const allConstruction = new Set([...nodes.keys()].flatMap(key => [...closure(key)]));
  const fullBaseMinimumSeconds = duration(allConstruction);
  assert(homeStages[4].minimumSeconds >= 28 * day, "Home 5 must retain at least four weeks of mandatory construction");
  assert(fullBaseMinimumSeconds >= 49 * day, "Full base must retain at least seven weeks of mandatory construction");
  return {
    catalogVersion: catalog.version, itemCount: items.size, buildingCount: buildings.size,
    recipeCount: catalog.recipes.length, explorationCount: catalog.explorations.length,
    homeStages, fullBaseMinimumSeconds,
    totalConstructionCoins: [...allConstruction].reduce((sum, key) => sum + nodes.get(key).cost.coins, 0),
    constructionOrder,
  };
}

export function readEconomyCatalog() { return JSON.parse(readFileSync(catalogPath, "utf8")); }

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = auditEconomyProgression(readEconomyCatalog());
  console.log(JSON.stringify({ ...report, source: fileURLToPath(catalogPath),
    homeMinimumDays: report.homeStages.map(stage => ({ level: stage.level, days: Number((stage.minimumSeconds / day).toFixed(4)) })),
    fullBaseMinimumDays: Number((report.fullBaseMinimumSeconds / day).toFixed(4)),
  }, null, 2));
}
