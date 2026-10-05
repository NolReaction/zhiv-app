import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

// Read-only player policy: every state change uses the shipped TS domain rules.
// No market, pearls, legacy grant, admin command, backdating or tap income.
const root = fileURLToPath(new URL("..", import.meta.url));
const epoch = Date.parse("2026-10-05T00:00:00Z"), day = 86400, hour = 3600;
const firstVisit = 7 * hour;
export const journeyOrder = ["woodlot:1", "workshop:1", "home:2", "quarry:1", "kiln:1", "garden:2", "warehouse:2", "woodlot:2", "quarry:2", "kiln:2", "dryer:1", "dryer:2", "workshop:2", "home:3", "garden:3", "warehouse:3", "woodlot:3", "quarry:3", "kiln:3", "workshop:3", "dryer:3", "home:4", "woodlot:4", "quarry:4", "kiln:4", "workshop:4", "warehouse:4", "garden:4", "dryer:4", "home:5", "garden:5", "warehouse:5", "woodlot:5", "quarry:5", "kiln:5", "workshop:5", "dryer:5"];

export async function loadJourneyRules() {
  const vite = await createServer({ appType: "custom", configFile: false, root, logLevel: "silent",
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
  const rules = await vite.ssrLoadModule("/features/economy/rules.ts");
  const model = await vite.ssrLoadModule("/features/economy/model.ts");
  return { rules, catalog: model.economyCatalog, close: () => vite.close() };
}

export function simulateJourney({ rules, catalog }, mode, maxDays = 1600, policy = {}) {
  const { prepareNextConstruction = false, preserveFutureCraftedStock = false } = policy;
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  let clock = firstVisit, sequence = 0, targetIndex = 0, commands = 0, revenue = 0, storageRecovery = 0, lastFailure = null;
  const milestones = {}, events = [], failures = {}, actions = {}, items = new Map(catalog.items.map(item => [item.id, item]));
  const isActive = mode === "active16h", visits = mode === "visits2" ? [7, 19] : [7, 15, 23];
  const gap = isActive ? 1 : mode === "visits2" ? 12 * hour : 8 * hour;
  const uuid = () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
  const eligible = d => (state.buildings.home ?? 1) >= d.requiredHomeLevel && Object.entries(d.requiredBuildings ?? {}).every(([id, level]) => (state.buildings[id] ?? 0) >= level)
    && (!d.buildingId || state.buildings[d.buildingId] >= d.buildingLevel);
  const command = (action, targetId, quantity = 1) => {
    if (action === "start_exploration" && catalog.fishing.routeIds.includes(targetId)) action = "start_fishing";
    const next = structuredClone(state);
    try {
      rules.applyEconomyCommand(next, { requestId: uuid(), ownerPublicId: "0000-0000-0001", expectedRevision: commands,
        action, targetId, quantity, totalPrice: 0 }, epoch + clock * 1000, uuid);
      if (action === "sell" || action === "sell_fish") revenue += next.wallet.coins - state.wallet.coins;
      Object.assign(state, next); commands++; actions[action] = (actions[action] ?? 0) + 1; lastFailure = null; return true;
    } catch (error) { lastFailure = error.code ?? error.message; failures[lastFailure] = (failures[lastFailure] ?? 0) + 1; return false; }
  };
  const cash = rewards => Object.entries(rewards).reduce((sum, [id, amount]) => sum + (catalog.fishing.fish.some(f => f.itemId === id)
    ? items.get(id).baseSellPrice * amount : rules.economyLocalSellPrice(items.get(id).baseSellPrice, amount, catalog.localBuyer)), 0);
  const projectedEligible = d => {
    if (!prepareNextConstruction) return eligible(d);
    // Forecast only for ingredient planning. Commands still use current levels.
    const predicted = { ...state.buildings };
    for (const j of state.jobs.filter(j => j.kind === "construction")) predicted[j.targetId] = j.targetLevel;
    return (predicted.home ?? 1) >= d.requiredHomeLevel && Object.entries(d.requiredBuildings ?? {}).every(([id, level]) => (predicted[id] ?? 0) >= level)
      && (!d.buildingId || predicted[d.buildingId] >= d.buildingLevel);
  };
  const sources = itemId => [...catalog.recipes, ...catalog.explorations.filter(route => !Object.keys(route.cost.items).length && !route.cost.coins)]
    .filter(d => projectedEligible(d) && d.rewards[itemId] > 0)
    .sort((a, b) => {
      const rate = d => {
        const batch = d.buildingId ? d.maxBatch : 1;
        return isActive ? d.rewards[itemId] / d.seconds : d.rewards[itemId] * batch / Math.max(1, Math.ceil(d.seconds * batch / gap));
      };
      return rate(b) - rate(a) || Number(!b.buildingId) - Number(!a.buildingId);
    });
  function goal() {
    while (targetIndex < journeyOrder.length) {
      const [id, levelText] = journeyOrder[targetIndex].split(":");
      if (state.buildings[id] >= Number(levelText)) { targetIndex++; continue; }
      return { id, key: journeyOrder[targetIndex], ...catalog.buildings.find(b => b.id === id).levels.find(l => l.level === Number(levelText)) };
    }
  }
  function demand(target) {
    const needed = {}, planned = { ...state.inventory }, recipeWants = new Map();
    // The paid current upgrade must never manufacture its cost twice.
    if (state.jobs.some(j => j.kind === "construction" && j.targetId === target.id)) {
      if (!prepareNextConstruction) return { needed, recipeWants };
      const key = journeyOrder[targetIndex + 1];
      if (!key) return { needed, recipeWants };
      const [id, level] = key.split(":");
      target = { id, key, ...catalog.buildings.find(b => b.id === id).levels.find(l => l.level === Number(level)) };
    }
    for (const job of state.jobs) for (const [id, quantity] of Object.entries(job.rewards)) planned[id] = (planned[id] ?? 0) + quantity;
    const expand = (id, amount, path = []) => {
      needed[id] = (needed[id] ?? 0) + amount;
      const owned = Math.min(planned[id] ?? 0, amount); planned[id] = (planned[id] ?? 0) - owned;
      if (owned >= amount) return;
      assert(!path.includes(id), `Policy cycle: ${path.join(" -> ")} -> ${id}`);
      const source = sources(id)[0];
      if (!source && prepareNextConstruction) return;
      assert(source, `No source for ${id} at ${target.key}`);
      const batches = Math.ceil((amount - owned) / source.rewards[id]);
      recipeWants.set(source.id, (recipeWants.get(source.id) ?? 0) + batches);
      for (const [input, quantity] of Object.entries(source.cost.items)) expand(input, quantity * batches, [...path, id]);
    };
    for (const [id, amount] of Object.entries(target.cost.items)) expand(id, amount);
    return { needed, recipeWants };
  }
  const sellExcess = needed => {
    let sold = false;
    for (const [id, amount] of Object.entries(state.inventory)) {
      const futureUses = preserveFutureCraftedStock && journeyOrder.slice(targetIndex).some(key => {
        const [building, level] = key.split(":");
        return catalog.buildings.find(b => b.id === building).levels.find(l => l.level === Number(level)).cost.items[id] > 0;
      });
      const manufactured = futureUses && catalog.recipes.some(r => r.rewards[id] > 0 && Object.keys(r.cost.items).length > 0);
      const quantity = amount - (manufactured ? amount : (needed[id] ?? 0));
      if (quantity > 0 && cash({ [id]: quantity }) > 0) sold = command(catalog.fishing.fish.some(f => f.itemId === id) ? "sell_fish" : "sell", id, quantity) || sold;
    }
    return sold;
  };
  function act() {
    let target = goal(); if (!target) return;
    let plan = demand(target);
    sellExcess(plan.needed);
    // Receive an expedition before beginning the required berry collection.
    for (const job of [...state.jobs].sort((a, b) => Number(a.targetId === "garden") - Number(b.targetId === "garden"))) {
      if (clock * 1000 + epoch < Date.parse(job.finishesAt)) continue;
      if (job.collection && !job.collection.startedAt) {
        if (!state.jobs.some(j => j.kind === "exploration" && Date.parse(j.finishesAt) > epoch + clock * 1000)) command("start_collection", job.id);
        continue;
      }
      if (job.collection && clock * 1000 + epoch < Date.parse(job.collection.finishesAt)) continue;
      if (!command("claim_job", job.id) && lastFailure === "ECONOMY_STORAGE_FULL") {
        // A real player can recover a crowded warehouse by selling raw stock.
        const expendable = Object.entries(state.inventory).filter(([id, amount]) => amount > 0 && cash({ [id]: amount }) > 0)
          .sort((a, b) => Number(!!sources(b[0])[0]?.cost.items && Object.keys(sources(b[0])[0].cost.items).length === 0)
            - Number(!!sources(a[0])[0]?.cost.items && Object.keys(sources(a[0])[0].cost.items).length === 0) || b[1] - a[1])[0];
        if (expendable) { command(catalog.fishing.fish.some(f => f.itemId === expendable[0]) ? "sell_fish" : "sell", ...expendable); storageRecovery++; command("claim_job", job.id); }
      }
      if (job.kind === "construction" && state.buildings[job.targetId] === job.targetLevel) {
        const key = `${job.targetId}:${job.targetLevel}`; milestones[key] = (clock - firstVisit) / day;
        events.push({ day: Number(((clock - firstVisit) / day).toFixed(4)), building: key, coins: state.wallet.coins });
      }
    }
    target = goal(); if (!target) return;
    plan = demand(target); sellExcess(plan.needed);
    if (eligible(target) && rules.canAffordEconomy(state, target.cost) && !state.jobs.some(j => j.kind === "construction" || j.kind === "production" && j.targetId === target.id)) command("start_construction", target.id);
    target = goal(); if (!target) return;
    plan = demand(target);
    const busy = new Set(state.jobs.filter(j => ["production", "construction"].includes(j.kind)).map(j => j.targetId));
    const freeDefinitions = [...catalog.recipes, ...catalog.explorations].filter(d => eligible(d) && !Object.keys(d.cost.items).length && !d.cost.coins);
    const candidates = [...catalog.recipes, ...catalog.explorations].filter(d => eligible(d)).sort((a, b) => (plan.recipeWants.get(b.id) ?? 0) - (plan.recipeWants.get(a.id) ?? 0));
    for (const d of candidates) {
      if (!plan.recipeWants.has(d.id)) continue;
      if (d.buildingId ? busy.has(d.buildingId) : state.jobs.some(j => j.kind === "exploration" || j.collection?.startedAt)) continue;
      const wanted = Math.min(d.maxBatch ?? 1, plan.recipeWants.get(d.id));
      const affordable = Array.from({ length: wanted }, (_, i) => wanted - i).find(q => rules.canAffordEconomy(state, d.cost, q));
      if (!affordable) continue;
      if (command(d.buildingId ? "start_production" : "start_exploration", d.id, affordable)) { if (d.buildingId) busy.add(d.buildingId); }
    }
    // Idle free gathering slots earn sale money; costly processing is reserved
    // for the next upgrade. This is a simple reproducible policy, not an optimum.
    const income = d => cash(d.rewards) / (isActive ? d.seconds : Math.max(1, Math.ceil(d.seconds / gap)));
    for (const id of ["garden", "woodlot", "quarry", null]) {
      if (id ? busy.has(id) : state.jobs.some(j => j.kind === "exploration" || j.collection?.startedAt)) continue;
      const d = freeDefinitions.filter(d => id ? d.buildingId === id : !d.buildingId).sort((a, b) => income(b) - income(a))[0];
      if (d && command(d.buildingId ? "start_production" : "start_exploration", d.id)) { if (id) busy.add(id); }
    }
  }
  const nextVisit = at => {
    const base = Math.floor(at / day) * day;
    for (const h of visits) if (base + h * hour > at + .001) return base + h * hour;
    return base + day + visits[0] * hour;
  };
  while (clock < maxDays * day && goal()) {
    const sessionEnd = isActive ? Math.floor(clock / day) * day + 23 * hour : clock + 600;
    let operations = 0;
    while (clock <= sessionEnd && goal()) {
      const before = commands; act(); operations++;
      const future = state.jobs.flatMap(j => [Date.parse(j.finishesAt), j.collection?.finishesAt ? Date.parse(j.collection.finishesAt) : null])
        .filter(t => t && t > epoch + clock * 1000).map(t => (t - epoch) / 1000);
      const next = Math.min(...future);
      if (next <= sessionEnd) clock = next;
      else if (commands !== before && operations < 5) continue;
      else break;
      assert(operations < 100000, "Policy stalled in one session");
    }
    if (!goal()) break;
    if (isActive) clock = Math.floor(clock / day) * day + day + 7 * hour;
    else clock = nextVisit(sessionEnd);
  }
  const report = { mode, complete: !goal(), elapsedDays: Number(((clock - firstVisit) / day).toFixed(3)),
    homeDays: Object.fromEntries([2, 3, 4, 5].map(l => [l, milestones[`home:${l}`] == null ? null : Number(milestones[`home:${l}`].toFixed(3))])),
    commands, saleRevenue: revenue, storageRecovery, failures, actions, stoppedAt: goal()?.key ?? null, milestones: events };
  assert.equal(state.wallet.pearls, 0); assert(state.wallet.coins >= 0);
  assert(Object.values(state.inventory).every(q => Number.isSafeInteger(q) && q >= 0));
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const loaded = await loadJourneyRules();
  try { console.log(JSON.stringify(["active16h", "visits2", "visits3"].map(mode => simulateJourney(loaded, mode)), null, 2)); }
  finally { await loaded.close(); }
}
