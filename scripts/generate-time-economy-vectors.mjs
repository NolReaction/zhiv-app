import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { auditTradeRelations } from "./audit-trade-relations.mjs";
import { residentOrderPricing } from "./lib/resident-order-pricing.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureUrl = name => new URL(`../apps/api/src/test/resources/world/${name}.json`, import.meta.url);
const read = name => JSON.parse(readFileSync(fixtureUrl(name), "utf8"));
const write = (name, value) => writeFileSync(fixtureUrl(name), `${JSON.stringify(value, null, 2)}\n`);
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { economyCatalog: catalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
  const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
  const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
  const relations = await vite.ssrLoadModule("/features/economy/domain/trade-relations.ts");
  const fresh = row => {
    const state = rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
    state.buildings = { ...row.buildings };
    state.fishing.ownedRods = [...row.ownedRods]; state.fishing.ownedHooks = [...row.ownedHooks];
    state.progression.recipes = { ...(row.completedRecipes ?? row.recipes ?? {}) };
    return state;
  };
  const quote = residentOrderPricing(catalog);
  write("time-economy-order-vectors", { policy: "baseline-time-value-plus-order-bonus", catalogVersion: catalog.version,
    orderBonusBps: catalog.timeEconomy.orderBonusBps, roundingCoins: 1,
    orders: catalog.food.orders.templates.map(template => ({ templateId: template.id, home: template.requiredHomeLevel,
      items: template.items, ...quote(template) })) });
  const progression = read("orders-progression-vectors");
  for (const row of progression.scaling) {
    const template = catalog.food.orders.templates.find(template => template.id === row.templateId);
    const actual = food.progressedResidentOrderTemplate(template, row.home);
    row.items = actual.items; row.coins = actual.coins;
  }
  for (const row of progression.availability) {
    const reachable = food.obtainableResidentOrderItems(fresh(row));
    const tested = [...row.present, ...row.missing];
    row.present = tested.filter(id => reachable.has(id)); row.missing = tested.filter(id => !reachable.has(id));
  }
  write("orders-progression-vectors", progression);
  const variety = read("orders-variety-vectors");
  for (const row of variety) {
    const eligible = new Set(food.eligibleResidentOrderTemplates(fresh(row)).map(template => template.id));
    const tested = [...row.present, ...row.missing];
    row.present = tested.filter(id => eligible.has(id)); row.missing = tested.filter(id => !eligible.has(id));
  }
  write("orders-variety-vectors", variety);
  const vectors = read("trade-relations-vectors"), report = auditTradeRelations(catalog);
  const clean = row => Object.fromEntries(Object.entries(row).filter(([key]) => !["completeNpcPurchaseCoins", "immediateNpcProfitCoins"].includes(key)));
  vectors.orders = report.orders.map(clean);
  vectors.weekly = report.weekly.map(weekly => ({ ...weekly, stages: weekly.stages.map(clean) }));
  vectors.optimisticMinimumElapsedDays = report.pacing.optimisticEarliestElapsedDays;
  vectors.ranks = [...new Set([0, 1_000_000, ...catalog.tradeRelations.ranks.flatMap(rank => [Math.max(0, rank.requiredXp - 1), rank.requiredXp])])].sort((a, b) => a - b).map(xp => {
    const rankIndex = catalog.tradeRelations.ranks.findLastIndex(rank => rank.requiredXp <= xp);
    return { xp, rankIndex, bonusBps: catalog.tradeRelations.ranks[rankIndex].bonusBps };
  });
  const project = (source, keys) => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  const offerKeys = ["id", "slot", "templateId", "residentId", "name", "description", "items", "coins", "pearls", "reputationXp", "effortSeconds", "manufacturingSeconds", "fishingUncertain", "requiredBuildings"];
  const choiceKeys = ["id", "templateId", "residentId", "coins", "pearls", "reputationXp", "effortSeconds", "manufacturingSeconds", "fishingUncertain"];
  for (const row of vectors.idCases) {
    const state = fresh(row), now = Date.parse(row.now);
    row.ordinary = food.residentOrderBoard(state, now).offers.map(offer => project(offer, offerKeys));
    row.weeklyChoices = relations.weeklyOrderBoard(state, now).offers.map(choice => {
      const accepted = structuredClone(state); relations.acceptWeeklyOrder(accepted, choice, now);
      const saved = accepted.tradeRelations.weekly;
      const activeStages = saved.stages.map((_, stage) => {
        saved.stage = stage; return project(relations.weeklyOrderBoard(accepted, now).active, offerKeys);
      });
      return { ...project(choice, choiceKeys), savedWeeklyId: saved.id, acceptedAt: saved.acceptedAt,
        expiresAt: saved.expiresAt, stages: choice.stages, activeStages };
    });
  }
  write("trade-relations-vectors", vectors);
  console.log(`Generated v${catalog.version} current vectors for ${vectors.orders.length} requests and ${vectors.weekly.length} weeklies; historical v12 balance and v2 fingerprints retained.`);
} finally { await vite.close(); }
