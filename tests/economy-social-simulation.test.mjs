import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createSocialPolicy } from "../scripts/lib/economy-social-scenario.mjs";
import { epoch, loadProgressionRules } from "../scripts/simulate-economy-progression.mjs";

const loaded = await loadProgressionRules();
after(() => loaded.close());

function advancedState(activityBps = 10000) {
  const state = loaded.rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
  state.buildings = Object.fromEntries(loaded.catalog.buildings.map(building => [building.id, Math.max(...building.levels.map(level => level.level))]));
  state.progression.recipes = Object.fromEntries(loaded.catalog.recipes.filter(recipe => !recipe.retired).map(recipe => [recipe.id, 1]));
  state.tradeRelations.reputation = Object.fromEntries(loaded.relations.TRADE_RESIDENT_IDS.map(id => [id, loaded.catalog.tradeRelations.ranks.at(-1).requiredXp]));
  state.tradeRelations.activity = Object.fromEntries(loaded.relations.TRADE_RESIDENT_IDS.map(id => [id, { pointsBps: activityBps, updatedAt: new Date(epoch).toISOString() }]));
  return state;
}

function context(state, actions = []) {
  let sequence = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  return { now: epoch, estimatedEffort: () => 60, dailyActiveSeconds: 8 * 3600,
    held: items => Object.entries(items).every(([id, count]) => (state.inventory[id] ?? 0) >= count),
    bundle: () => false,
    apply(action, targetId, quantity = 1, totalPrice = 0) {
      loaded.rules.applyEconomyCommand(state, { requestId: uuid(), ownerPublicId: "0000-0000-0001", expectedRevision: 0,
        action, targetId, quantity, totalPrice }, epoch, uuid, {}, maximum => maximum - 1);
      actions.push(action);
    } };
}

test("capacity policy keeps earning real weekly rewards after permanent ranks are complete", () => {
  const state = advancedState(), actions = [];
  state.inventory = {};
  const options = { catalog: loaded.catalog, relations: loaded.relations, food: loaded.food, state, mode: "reputation" };
  assert.equal(createSocialPolicy(options).act(context(state)), false, "completed ranks alone do not invent a further goal");
  const policy = createSocialPolicy({ ...options, continueWeekly: () => true });
  assert.equal(policy.act(context(state, actions)), true);
  assert.deepEqual(actions, ["accept_weekly_order"]);
  assert(state.tradeRelations.weekly, "the real command creates the dated contract");
  assert.equal(policy.snapshot(epoch).acceptedWeeklies.length, 1);
  assert.equal(policy.snapshot(epoch).allMaximum, true);
});

test("a resident with a maximum permanent rank still receives real orders to restore the active bonus", () => {
  const state = advancedState(0), actions = [];
  const offer = loaded.food.residentOrderBoard(state, epoch).offers.find(row => Date.parse(row.availableAt) <= epoch);
  assert(offer, "test needs a reachable, currently available request");
  state.inventory = { ...offer.items };
  const before = loaded.relations.tradeRelationProgress(state, offer.residentId, loaded.catalog, epoch);
  assert.equal(before.activityBps, 0);
  const policy = createSocialPolicy({ catalog: loaded.catalog, relations: loaded.relations, food: loaded.food, state, mode: "reputation" });
  assert.equal(policy.act(context(state, actions)), true);
  assert.deepEqual(actions, ["complete_resident_order"]);
  assert.equal(policy.snapshot(epoch).deliveries.length, 1);
  for (const id of Object.keys(offer.items)) assert.equal(state.inventory[id] ?? 0, 0, "restoring activity really consumes goods");
  const after = loaded.relations.tradeRelationProgress(state, offer.residentId, loaded.catalog, epoch);
  assert(after.activityBps > 0 && after.bonusBps > 0);
  assert(after.xp >= before.xp, "activity restoration does not erase lifetime progress");
});
