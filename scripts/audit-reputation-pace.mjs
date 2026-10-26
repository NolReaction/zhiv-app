import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

/** Isolated reputation exercise, not a funded playthrough. Every basket is
 * explicitly supplied by the fixture; its full authored work is recorded.
 * Real order selection, completion, seven-day contracts and XP caps still run.
 */
export function simulateReputationPace({ rules, food, relations, catalog, residentId, ordinaryPerDay, days = 30 }) {
  const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1).level]));
  state.progression.recipes = Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, 100]));
  state.fishing.ownedRods = catalog.fishing.rods.map(rod => rod.id);
  state.fishing.ownedHooks = catalog.fishing.hooks.map(hook => hook.id);
  let ordinary = 0, weeklyStages = 0, effortSeconds = 0, manufacturingSeconds = 0, suppliedItemValue = 0;
  const prices = new Map(catalog.items.map(item => [item.id, item.baseSellPrice]));
  const startsAt = Date.parse("2026-10-26T12:00:00Z"), dayMs = 86400_000;
  const milestones = [];
  const run = (action, targetId, now) => rules.applyEconomyCommand(state, {
    action, targetId, requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0, quantity: 1, totalPrice: 0,
  }, now, () => crypto.randomUUID(), {}, () => 0);
  function deliver(offer, now) {
    assert.equal(offer.residentId, residentId);
    assert(Object.values(offer.items).reduce((sum, quantity) => sum + quantity, 0) <= 50);
    // Deliberate test setup: this fixture measures the relation rule, while the
    // full economy scenario must actually produce these supplied materials.
    state.inventory = structuredClone(offer.items);
    effortSeconds += offer.effortSeconds ?? 0;
    manufacturingSeconds += offer.manufacturingSeconds ?? 0;
    suppliedItemValue += Object.entries(offer.items).reduce((sum, [id, quantity]) => sum + prices.get(id) * quantity, 0);
    run("complete_resident_order", offer.id, now);
    if (offer.weekly) weeklyStages++; else ordinary++;
    assert.equal(Object.values(state.inventory).reduce((sum, quantity) => sum + quantity, 0), 0, "the exact supplied basket is consumed");
  }
  const initialCoins = state.wallet.coins, initialPearls = state.wallet.pearls;
  for (let day = 0; day < days; day++) {
    const now = startsAt + day * dayMs;
    for (let index = 0; index < ordinaryPerDay; index++) {
      const offer = food.residentOrderBoard(state, now).offers.find(offer => offer.residentId === residentId);
      assert(offer, `missing ordinary offer for ${residentId}`);
      deliver(offer, now);
    }
    let board = relations.weeklyOrderBoard(state, now);
    if (board.canChoose) {
      const choice = board.offers.find(offer => offer.residentId === residentId);
      assert(choice, `missing weekly choice for ${residentId}`);
      run("accept_weekly_order", choice.id, now);
      board = relations.weeklyOrderBoard(state, now);
    }
    while (board.active) { deliver(board.active, now); board = relations.weeklyOrderBoard(state, now); }
    const progress = relations.tradeRelationProgress(state, residentId, catalog, now);
    for (const rank of catalog.tradeRelations.ranks.slice(1)) if (progress.xp >= rank.requiredXp && !milestones.some(value => value.rank === rank.id))
      milestones.push({ rank: rank.id, day: day + 1, xp: progress.xp });
  }
  const progress = relations.tradeRelationProgress(state, residentId, catalog, startsAt + (days - 1) * dayMs);
  return { residentId, ordinaryPerDay, days, ordinary, weeklyStages, completedWeekly: state.tradeRelations.completedWeekly,
    xp: progress.xp, bonusPercent: progress.bonusBps / 100, milestones,
    suppliedItemValue, payoutCoins: state.wallet.coins - initialCoins,
    visibleWeeklyPearls: (state.wallet.pearls - initialPearls) / 2,
    baselineWorkHours: Math.round(effortSeconds / 36) / 100, manufacturingHours: Math.round(manufacturingSeconds / 36) / 100 };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const vite = await createServer({ appType: "custom", configFile: false, root,
    resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const [rules, food, relations, { economyCatalog: catalog }] = await Promise.all([
      "/features/economy/domain/rules.ts", "/features/economy/domain/food.ts", "/features/economy/domain/trade-relations.ts", "/features/economy/domain/model.ts",
    ].map(path => vite.ssrLoadModule(path)));
    const scenarios = relations.TRADE_RESIDENT_IDS.flatMap(residentId => [3, 5].map(ordinaryPerDay =>
      simulateReputationPace({ rules, food, relations, catalog, residentId, ordinaryPerDay })));
    console.log(JSON.stringify({ kind: "reputation-rule-fixture", assumptions: [
      "All buildings, recipes and tackle are available from the first day; every basket is explicitly supplied by the fixture.",
      "Baseline work is counted for every supplied ingredient; production, money sourcing and login feasibility are not simulated.",
      "Each independent scenario assigns the single weekly contract to one resident; their weekly rewards cannot be combined on one account.",
      "No purchase XP, social gifts, welcome gifts or achievement pearls are included. Weekly stages are supplied immediately.",
      "These results test reputation rules and work obligations; they are not a forecast of a new player's completion time.",
    ], scenarios }, null, 2));
  } finally { await vite.close(); }
}
