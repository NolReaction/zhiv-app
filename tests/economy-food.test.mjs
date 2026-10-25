import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const food = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const rules = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { economyCommandUsesActor } = await vite.ssrLoadModule("/features/economy/domain/actor-availability.ts");
const now = Date.parse("2026-10-07T12:00:00.000Z");
const catalog = model.economyCatalog;
const fresh = () => rules.newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshopLevel: 0 });
const command = (action, targetId, quantity = 1) => ({ requestId: crypto.randomUUID(), ownerPublicId: "0123-4567-89AB", expectedRevision: 0, action, targetId, quantity, totalPrice: 0 });
const apply = (state, action, targetId, at = now, quantity = 1) => rules.applyEconomyCommand(state, command(action, targetId, quantity), at, () => crypto.randomUUID(), {}, () => 0);
const failWithoutChanges = (state, action, targetId, code, at = now, quantity = 1) => {
  const previous = structuredClone(state);
  assert.throws(() => apply(state, action, targetId, at, quantity), { code });
  assert.deepEqual(state, previous, "a rejected transition cannot alter inventory, meals, orders, jobs or wallet");
};
const player = () => identities.createDevIdentity("Лесная кухня", crypto.randomUUID());
const read = (p, at = now) => api.getDevEconomy(p.token, at);
const request = (p, action, targetId, at = now) => ({ ...command(action, targetId), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision });
const send = (p, action, targetId, at = now) => api.commandDevEconomy(p.token, request(p, action, targetId, at), at);
const row = p => { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); };
beforeEach(() => identities.resetDevStoreForTests());
after(() => vite.close());

test("older snapshots and saved states gain empty food/order defaults without changing their inventory", () => {
  const p = player(), current = read(p), old = structuredClone(current);
  delete old.food; delete old.residentOrders;
  const parsed = model.economyViewSchema.parse(old);
  assert.deepEqual(parsed.food, { heroMeal: null, builderMeal: null });
  assert.deepEqual(parsed.residentOrders, { version: 1, cycle: -1, slots: [], completed: 0, earnedCoins: 0, recentTemplateIds: [], replacementCycle: -1, freeReplacementsUsed: 0 });
  assert.deepEqual(food.foodState({}), parsed.food);
  assert.deepEqual(parsed.inventory, old.inventory);
  const saved = row(p); delete saved.state.food; delete saved.state.residentOrders;
  assert.deepEqual(read(p).food, parsed.food);
  assert.equal(read(p).revision, current.revision);
});

test("class recipes combine species stock and save one exact class cost", () => {
  const state = fresh(); state.buildings.dryer = 1;
  state.inventory = { fish: 1, fish_silverfin: 1, wood: 3 };
  state.fishing.catches.fish_silverfin = 5;
  failWithoutChanges(state, "start_production", "cook_grilled_fish", "INVALID_ECONOMY_COMMAND", now, 2);
  apply(state, "start_production", "cook_grilled_fish");
  assert.deepEqual(state.inventory, { fish_common: 1, wood: 3 });
  const first = structuredClone(state.jobs[0]);
  assert.equal(first.recipeId, "cook_grilled_fish");
  assert.deepEqual(first.cost, { coins: 0, items: { fish_common: 1 } });
  assert.deepEqual(first.rewards, { grilled_fish: 1 });
  const ready = Date.parse(first.finishesAt);
  apply(state, "claim_job", first.id, ready);
  apply(state, "start_production", "cook_grilled_fish", ready);
  assert.deepEqual(state.inventory, { wood: 3, grilled_fish: 1 });
  assert.deepEqual(state.jobs[0].cost, first.cost); assert.deepEqual(state.jobs[0].rewards, first.rewards);
  apply(state, "claim_job", state.jobs[0].id, Date.parse(state.jobs[0].finishesAt));
  assert.deepEqual(state.inventory, { wood: 3, grilled_fish: 2 });
  assert.equal(state.jobs.length, 0); assert.equal(state.fishing.catches.fish_silverfin, 5);
});

test("class recipes never substitute rare fish for missing common fish", () => {
  const state = fresh(); state.buildings.dryer = 1;
  state.inventory = { fish_uncommon: 3, fish_legendary: 1, wood: 3 };
  failWithoutChanges(state, "start_production", "cook_grilled_fish", "ECONOMY_RESOURCES");
  state.inventory.fish_common = 1;
  apply(state, "start_production", "cook_grilled_fish");
  assert.equal(state.inventory.fish_uncommon, 3); assert.equal(state.inventory.fish_legendary, 1);
});

test("invalid fish substitutions and decorated non-fish recipes are rejected before spending", () => {
  const state = fresh(); state.buildings.dryer = 5; state.buildings.workshop = 5; state.buildings.home = 5;
  state.inventory = { fish: 9, wood: 9, fish_shark: 9, berries: 9 };
  for (const target of ["cook_grilled_fish@fish_shark", "cook_grilled_fish@wood", "cook_grilled_fish@", "cook_grilled_fish@fish@fish", "make_planks@fish"])
    failWithoutChanges(state, "start_production", target, "ECONOMY_RECIPE_FISH");
  assert.throws(() => food.recipeWithFish(catalog.recipes.find(recipe => recipe.id === "cook_grilled_fish"), "fish_shark"), RangeError);
});

test("feeding the hero reserves one meal indefinitely and applies it to exactly one successful trip", () => {
  const state = fresh(); state.inventory = { grilled_fish: 2 };
  apply(state, "eat_food", "grilled_fish");
  assert.equal(state.inventory.grilled_fish, 1); assert.equal(state.food.heroMeal, "grilled_fish");
  failWithoutChanges(state, "eat_food", "grilled_fish", "ECONOMY_ALREADY_FED");
  failWithoutChanges(state, "start_exploration", "missing", "ECONOMY_EXPLORATION");
  const later = now + 30 * 86400000, route = catalog.explorations.find(item => item.id === "forest");
  apply(state, "start_exploration", route.id, later);
  assert.equal(Date.parse(state.jobs[0].finishesAt) - later, food.mealDuration(route.seconds, 1000) * 1000);
  assert.deepEqual(state.jobs[0].meal, { itemId: "grilled_fish", consumer: "hero", speedBps: 1000 });
  assert.equal(state.food.heroMeal, null);
  apply(state, "cancel_exploration", state.jobs[0].id, later);
  apply(state, "start_exploration", route.id, later);
  assert.equal(Date.parse(state.jobs[0].finishesAt) - later, route.seconds * 1000);
  assert.equal(state.jobs[0].meal, undefined, "cancelled meals are not refundable or repeatable");
});

test("unused hero and builder portions return exactly once without touching the other meal or jobs", () => {
  const state = fresh(); state.inventory = { grilled_fish: 2, fish_soup: 1 };
  apply(state, "eat_food", "grilled_fish"); apply(state, "feed_builder", "fish_soup");
  const jobs = structuredClone(state.jobs), wallet = structuredClone(state.wallet);
  apply(state, "cancel_meal", "hero");
  assert.deepEqual(state.inventory, { grilled_fish: 2 });
  assert.deepEqual(state.food, { heroMeal: null, builderMeal: "fish_soup" });
  failWithoutChanges(state, "cancel_meal", "hero", "ECONOMY_MEAL_UNAVAILABLE");
  apply(state, "cancel_meal", "builder");
  assert.deepEqual(state.inventory, { grilled_fish: 2, fish_soup: 1 });
  assert.deepEqual(state.food, { heroMeal: null, builderMeal: null });
  assert.deepEqual(state.jobs, jobs); assert.deepEqual(state.wallet, wallet);
  failWithoutChanges(state, "cancel_meal", "builder", "ECONOMY_MEAL_UNAVAILABLE");
});

test("returning pending meals preserves full-pantry stock and never grants new overflow capacity", () => {
  const state = fresh(), cap = rules.economyStorage(state).capacity;
  state.inventory = { wood: cap - 1 }; state.food = { heroMeal: "grilled_fish", builderMeal: "fish_soup" };
  const reserved = { stone: 1 };
  for (const consumer of ["hero", "builder"]) {
    const before = structuredClone(state);
    rules.applyEconomyCommand(state, command("cancel_meal", consumer), now, crypto.randomUUID, reserved);
    rules.assertEconomyStorageTransition(before, state, reserved);
  }
  assert.equal(rules.economyStorage(state, reserved).overflow, 2);
  const next = structuredClone(state); next.inventory.wood++;
  assert.throws(() => rules.assertEconomyStorageTransition(state, next, reserved), { code: "ECONOMY_STORAGE_FULL" });
  for (let i = 0; i < 3; i++) {
    apply(state, "eat_food", "grilled_fish"); apply(state, "cancel_meal", "hero");
  }
  assert.equal(state.inventory.grilled_fish, 1); assert.equal(state.inventory.fish_soup, 1);
  assert.equal(rules.economyStorage(state, reserved).overflow, 2);
});

test("meal return validates target and one-item command fields and preserves pending food on item-cap failure", () => {
  const state = fresh(); state.food = { heroMeal: "grilled_fish", builderMeal: null };
  for (const patch of [{ targetId: "grilled_fish" }, { quantity: 2 }, { totalPrice: 1 }, { fishSelection: {} }]) {
    const before = structuredClone(state);
    assert.throws(() => rules.applyEconomyCommand(state, { ...command("cancel_meal", "hero"), ...patch }, now, crypto.randomUUID), { code: "INVALID_ECONOMY_COMMAND" });
    assert.deepEqual(state, before);
  }
  state.inventory = { grilled_fish: model.ECONOMY_MAX_ITEMS };
  failWithoutChanges(state, "cancel_meal", "hero", "ECONOMY_CAPACITY");
  state.inventory.grilled_fish--;
  const before = structuredClone(state);
  assert.throws(() => rules.applyEconomyCommand(state, command("cancel_meal", "hero"), now, crypto.randomUUID,
    { grilled_fish: 1 }), { code: "ECONOMY_CAPACITY" });
  assert.deepEqual(state, before);
});

test("missing food and an occupied hero cannot debit a dish or overwrite active jobs", () => {
  const state = fresh();
  failWithoutChanges(state, "eat_food", "grilled_fish", "ECONOMY_RESOURCES");
  failWithoutChanges(state, "eat_food", "fish", "ECONOMY_FOOD");
  state.inventory = { grilled_fish: 2 };
  apply(state, "start_exploration", "forest");
  failWithoutChanges(state, "eat_food", "grilled_fish", "ECONOMY_EXPLORER_BUSY");
  failWithoutChanges(state, "eat_food", "grilled_fish", "ECONOMY_EXPLORER_BUSY", Date.parse(state.jobs[0].finishesAt));
  assert.equal(economyCommandUsesActor(command("eat_food", "grilled_fish")), true, "legacy trips block eating at the adapter boundary too");
});

test("failed paid departure preserves the hero meal; fishing receives the same one-trip speed rule", () => {
  const state = fresh(); state.buildings.home = 3;
  state.inventory = { hearty_fish: 1 };
  apply(state, "eat_food", "hearty_fish");
  const route = catalog.explorations.find(route => catalog.fishing.routeIds.includes(route.id));
  Object.assign(state.buildings, route.requiredBuildings);
  state.wallet.coins = 0;
  const failed = catalog.explorations.find(item => !item.retired && (item.cost.coins > 0 || Object.keys(item.cost.items).length > 0));
  Object.assign(state.buildings, failed.requiredBuildings);
  failWithoutChanges(state, "start_exploration", failed.id, "ECONOMY_RESOURCES");
  state.wallet.coins = route.cost.coins; state.inventory = { ...route.cost.items };
  apply(state, "start_fishing", route.id);
  const job = state.jobs[0];
  assert.equal(Date.parse(job.finishesAt) - now, food.mealDuration(route.seconds, 6000) * 1000);
  assert.equal(job.meal.itemId, "hearty_fish"); assert.equal(state.food.heroMeal, null);
  if (job.rareDrop) assert.equal(job.rareDrop.seconds, food.mealDuration(route.seconds, 6000));
});

test("pending builder food survives rejected construction and shortens one paid job by 1 / 1.1", () => {
  const state = fresh(); state.inventory = { grilled_fish: 2 };
  apply(state, "feed_builder", "grilled_fish");
  failWithoutChanges(state, "feed_builder", "grilled_fish", "ECONOMY_ALREADY_FED");
  failWithoutChanges(state, "start_construction", "workshop", "ECONOMY_RESOURCES");
  const level = catalog.buildings.find(item => item.id === "workshop").levels[0];
  state.wallet.coins = level.cost.coins; state.inventory = { ...level.cost.items };
  Object.assign(state.buildings, level.requiredBuildings);
  apply(state, "start_construction", "workshop");
  assert.equal(state.food.builderMeal, null);
  assert.equal(Date.parse(state.jobs[0].finishesAt) - now, Math.ceil(level.seconds / 1.1) * 1000);
  assert.equal(state.jobs[0].meal.consumer, "builder");
});

test("a one-hour workshop upgrade with 25 percent extra speed takes 48m and saves 12m", () => {
  const state = fresh(), level = catalog.buildings.find(item => item.id === "workshop").levels.find(item => item.level === 2);
  assert.equal(level.seconds, 3600);
  state.buildings.workshop = 1;
  state.buildings.home = level.requiredHomeLevel;
  Object.assign(state.buildings, level.requiredBuildings);
  state.wallet.coins = level.cost.coins; state.inventory = { ...level.cost.items, fish_soup: 1 };
  apply(state, "feed_builder", "fish_soup");
  apply(state, "start_construction", "workshop");
  const boostedSeconds = (Date.parse(state.jobs[0].finishesAt) - now) / 1000;
  assert.equal(boostedSeconds, 48 * 60);
  assert.equal(level.seconds - boostedSeconds, 12 * 60, "25% more work per second saves 20% of the time");
  assert.equal(food.mealDuration(6 * 3600, 2500), 4 * 3600 + 48 * 60, "historic six-hour jobs follow the same speed rule");
  assert.deepEqual(state.jobs[0].meal, { itemId: "fish_soup", consumer: "builder", speedBps: 2500 });
  assert.equal(state.inventory.fish_soup, undefined);
  assert.deepEqual(state.jobs[0].cost, level.cost);
});

test("feeding an active builder speeds up only remaining milliseconds once and preserves paid job fields", () => {
  const state = fresh(), level = catalog.buildings.find(item => item.id === "workshop").levels[0];
  state.wallet.coins = level.cost.coins; state.inventory = { ...level.cost.items, fish_soup: 2 };
  Object.assign(state.buildings, level.requiredBuildings);
  apply(state, "start_construction", "workshop");
  const before = structuredClone(state.jobs[0]), at = now + 123456;
  apply(state, "feed_builder", "fish_soup", at);
  const changed = state.jobs[0];
  const speed = catalog.food.meals.find(meal => meal.itemId === "fish_soup").builderSpeedBps;
  assert.equal(changed.finishesAt, new Date(at + Math.ceil((Date.parse(before.finishesAt) - at) * 10000 / (10000 + speed))).toISOString());
  assert.equal(changed.startedAt, before.startedAt); assert.deepEqual(changed.cost, before.cost);
  assert.deepEqual(changed.rewards, before.rewards); assert.equal(changed.id, before.id);
  assert.equal(state.inventory.fish_soup, 1); assert.equal(state.food.builderMeal, null);
  failWithoutChanges(state, "feed_builder", "fish_soup", "ECONOMY_ALREADY_FED", at);
  failWithoutChanges(state, "cancel_meal", "builder", "ECONOMY_MEAL_UNAVAILABLE", at);
  failWithoutChanges(state, "cancel_meal", "builder", "ECONOMY_MEAL_UNAVAILABLE", Date.parse(changed.finishesAt));
  state.food.builderMeal = "grilled_fish";
  const savedJob = structuredClone(state.jobs[0]);
  apply(state, "cancel_meal", "builder", at);
  assert.deepEqual(state.jobs[0], savedJob, "a distinct pending portion never refunds or changes the applied boost");
  assert.equal(state.inventory.grilled_fish, 1);
});

test("a finished construction cannot eat a meal, and builder food does not affect the hero", () => {
  const state = fresh(), level = catalog.buildings.find(item => item.id === "workshop").levels[0];
  state.wallet.coins = level.cost.coins; state.inventory = { ...level.cost.items, grilled_fish: 2 };
  Object.assign(state.buildings, level.requiredBuildings);
  apply(state, "start_construction", "workshop");
  failWithoutChanges(state, "feed_builder", "grilled_fish", "ECONOMY_JOB_READY", Date.parse(state.jobs[0].finishesAt));
  apply(state, "eat_food", "grilled_fish");
  assert.equal(state.food.heroMeal, "grilled_fish"); assert.equal(state.food.builderMeal, null);
});

test("order board is deterministic, replacement changes template, and locked kitchens cannot generate unreachable food orders", () => {
  const state = fresh(), frozen = structuredClone(state), first = food.residentOrderBoard(state, now);
  assert.equal(first.offers.length, 2, "only the two introduced starting residents have cards"); assert.deepEqual(food.residentOrderBoard(state, now + 1000), first);
  assert.ok(first.offers.every(offer => /^order2_[0-9]+_[0-2]_0_[0-9]+$/.test(offer.id)));
  assert.equal(first.offers[0].residentId, "plesk"); assert.equal(first.offers[1].residentId, "builder");
  assert.deepEqual(state, frozen, "deriving the board cannot mutate a save");
  for (const offer of first.offers) assert.ok(Object.keys(offer.items).every(itemId => !catalog.food.meals.some(meal => meal.itemId === itemId)));
  apply(state, "replace_resident_order", first.offers[0].id);
  const replacement = food.residentOrderBoard(state, now).offers[0];
  assert.notEqual(replacement.templateId, first.offers[0].templateId);
  assert.ok(Date.parse(replacement.availableAt) <= now);
  assert.deepEqual(food.residentOrderBoard(state, now).offers.slice(1), first.offers.slice(1), "replacing one card keeps its neighbours stable");
  failWithoutChanges(state, "replace_resident_order", first.offers[0].id, "ECONOMY_ORDER_CHANGED");
  state.inventory = { ...replacement.items };
  apply(state, "complete_resident_order", replacement.id, now);
  assert.equal(state.residentOrders.completed, 1, "a replacement is available immediately");
});

test("orders pay only coins and lifetime totals without activating or consuming satiety", () => {
  const state = fresh(), offer = food.residentOrderBoard(state, now).offers[0];
  state.inventory = { ...offer.items, grilled_fish: 1 };
  state.food = { heroMeal: "fish_soup", builderMeal: "grilled_fish" };
  const beforeFood = structuredClone(state.food), beforeFishing = structuredClone(state.fishing), beforeCoins = state.wallet.coins;
  apply(state, "complete_resident_order", offer.id);
  assert.equal(state.wallet.coins, beforeCoins + offer.coins); assert.equal(state.residentOrders.completed, 1);
  assert.equal(state.residentOrders.earnedCoins, offer.coins);
  assert.deepEqual(state.food, beforeFood); assert.deepEqual(state.fishing, beforeFishing);
  assert.equal(state.inventory.grilled_fish, 1);
  const next = food.residentOrderBoard(state, now).offers[0];
  assert.notEqual(next.id, offer.id);
  assert.ok(Date.parse(next.availableAt) <= now);
  assert.equal(food.residentOrderBoard(state, now).freeReplacementsRemaining, 3, "fulfilment does not consume replacement allowance");
  failWithoutChanges(state, "complete_resident_order", offer.id, "ECONOMY_ORDER_CHANGED");
});

test("insufficient goods, full wallet and malformed command amounts cannot debit order resources", () => {
  const state = fresh(), offer = food.residentOrderBoard(state, now).offers[0];
  state.inventory = {};
  failWithoutChanges(state, "complete_resident_order", offer.id, "ECONOMY_RESOURCES");
  state.inventory = { ...offer.items }; state.wallet.coins = model.ECONOMY_MAX_BALANCE;
  failWithoutChanges(state, "complete_resident_order", offer.id, "ECONOMY_CAPACITY");
  for (const action of ["complete_resident_order", "replace_resident_order", "eat_food", "feed_builder"])
    failWithoutChanges(state, action, offer.id, "INVALID_ECONOMY_COMMAND", now, 2);
  assert.throws(() => rules.applyEconomyCommand(state, { ...command("complete_resident_order", offer.id), totalPrice: 1 }, now, () => crypto.randomUUID()), { code: "INVALID_ECONOMY_COMMAND" });
});

test("twelve-hour refresh invalidates earlier orders and preserves earned totals", () => {
  const state = fresh(), offer = food.residentOrderBoard(state, now).offers[0];
  state.inventory = { ...offer.items };
  apply(state, "complete_resident_order", offer.id);
  const nextCycle = Date.parse(food.residentOrderBoard(state, now).refreshAt), before = structuredClone(state);
  const board = food.residentOrderBoard(state, nextCycle);
  assert.equal(board.completed, 1); assert.equal(board.earnedCoins, offer.coins);
  assert.ok(board.offers.every(item => Date.parse(item.availableAt) === nextCycle));
  assert.deepEqual(state, before);
  failWithoutChanges(state, "complete_resident_order", offer.id, "ECONOMY_ORDER_CHANGED", nextCycle);
});

test("order counters cannot overflow safe integers or debit goods at their limit", () => {
  for (const field of ["completed", "earnedCoins"]) {
    const state = fresh(); state.residentOrders = food.normalizedResidentOrders(state, now);
    state.residentOrders[field] = Number.MAX_SAFE_INTEGER;
    const offer = food.residentOrderBoard(state, now).offers[0]; state.inventory = { ...offer.items };
    failWithoutChanges(state, "complete_resident_order", offer.id, "ECONOMY_CAPACITY");
  }
  const state = fresh(); state.residentOrders = food.normalizedResidentOrders(state, now);
  state.residentOrders.slots[0].sequence = Number.MAX_SAFE_INTEGER;
  const offer = food.residentOrderBoard(state, now).offers[0];
  failWithoutChanges(state, "replace_resident_order", offer.id, "ECONOMY_CAPACITY");
});

test("local API receipts make order and eating retries idempotent and reject altered requests", () => {
  const p = player(), saved = row(p), offer = food.residentOrderBoard(read(p), now).offers[0];
  saved.state.inventory = { ...offer.items, grilled_fish: 2 };
  const beforeCoins = saved.state.wallet.coins;
  const payload = request(p, "complete_resident_order", offer.id), first = api.commandDevEconomy(p.token, payload, now);
  const replay = api.commandDevEconomy(p.token, payload, now);
  assert.equal(first.state.wallet.coins, beforeCoins + offer.coins); assert.equal(replay.replayed, true);
  assert.equal(replay.state.residentOrders.completed, 1); assert.equal(replay.acceptedRevision, first.acceptedRevision);
  assert.throws(() => api.commandDevEconomy(p.token, { ...payload, action: "replace_resident_order" }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  const eating = request(p, "eat_food", "grilled_fish");
  api.commandDevEconomy(p.token, eating, now);
  assert.equal(api.commandDevEconomy(p.token, eating, now).state.inventory.grilled_fish, 1);
  assert.throws(() => send(p, "complete_resident_order", offer.id), { code: "ECONOMY_ORDER_CHANGED" });
});

test("local API validates owner and revision before food or order spending", () => {
  const p = player(), saved = row(p); saved.state.inventory = { grilled_fish: 2 };
  const payload = request(p, "eat_food", "grilled_fish"), before = read(p);
  assert.throws(() => api.commandDevEconomy(p.token, { ...payload, ownerPublicId: "0123-4567-89AB" }, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => api.commandDevEconomy(p.token, { ...payload, expectedRevision: payload.expectedRevision + 1 }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.deepEqual(read(p), before);
});

test("local API meal refunds keep receipts ownership and stale-revision protection even with a full pantry", () => {
  const p = player(), other = player(), saved = row(p);
  saved.state.inventory = { grilled_fish: 2 }; send(p, "eat_food", "grilled_fish");
  saved.state.inventory = { wood: rules.economyStorage(saved.state).capacity };
  const payload = request(p, "cancel_meal", "hero"), before = read(p);
  assert.equal(model.economyCommandSchema.safeParse(payload).success, true);
  assert.throws(() => api.commandDevEconomy(other.token, payload, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.throws(() => api.commandDevEconomy(p.token, { ...payload, expectedRevision: payload.expectedRevision + 1 }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.deepEqual(read(p), before);
  const refunded = api.commandDevEconomy(p.token, payload, now);
  assert.equal(refunded.state.inventory.grilled_fish, 1); assert.equal(refunded.state.storage.overflow, 1);
  const replay = api.commandDevEconomy(p.token, payload, now);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, refunded.acceptedRevision);
  assert.equal(replay.state.inventory.grilled_fish, 1);
  assert.throws(() => api.commandDevEconomy(p.token, { ...payload, targetId: "builder" }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.throws(() => api.commandDevEconomy(p.token, { ...payload, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.throws(() => send(p, "cancel_meal", "hero"), { code: "ECONOMY_MEAL_UNAVAILABLE" });
  send(p, "eat_food", "grilled_fish");
  assert.equal(api.commandDevEconomy(p.token, payload, now).replayed, true);
  assert.equal(read(p).food.heroMeal, "grilled_fish", "old refund receipt cannot cancel a newly selected portion");
  assert.equal(read(p).inventory.grilled_fish ?? 0, 0);
  send(p, "start_exploration", "forest");
  assert.throws(() => send(p, "cancel_meal", "hero"), { code: "ECONOMY_MEAL_UNAVAILABLE" });
  const trip = read(p).jobs.find(job => job.kind === "exploration");
  send(p, "cancel_exploration", trip.id);
  assert.throws(() => send(p, "cancel_meal", "hero"), { code: "ECONOMY_MEAL_UNAVAILABLE" });
  assert.equal(read(p).inventory.grilled_fish ?? 0, 0, "abandoning the boosted journey never refunds its consumed food");
});

test("reading a new board cycle is revision-neutral and does not persist normalized slots", () => {
  const p = player(), saved = row(p);
  saved.state.fishingShop.refreshAt = new Date(now + 48 * 3600000).toISOString();
  const before = read(p), later = now + catalog.food.orders.refreshSeconds * 1000, snapshot = read(p, later);
  assert.equal(snapshot.revision, before.revision);
  assert.deepEqual(snapshot.residentOrders, before.residentOrders);
  assert.notEqual(food.residentOrderBoard(snapshot, later).offers[0].id, food.residentOrderBoard(before, now).offers[0].id);
});

test("class recipes need no species selector and helpers preserve the source", () => {
  const recipe = catalog.recipes.find(item => item.id === "cook_grilled_fish"), copy = structuredClone(recipe);
  assert.equal(food.recipeWithFish(recipe), recipe); assert.deepEqual(recipe, copy);
  assert.equal(recipe.cost.items.fish_common, 1); assert.equal(recipe.fishInput, undefined);
  assert.deepEqual(food.recipeFishOptions({ inventory: { fish_common: 7 }, catalog }, recipe), []);
  assert.equal(food.pendingMeal({ food: { heroMeal: "hearty_fish", builderMeal: null }, catalog }, "hero").heroSpeedBps, 6000);
});

test("catalog and saved job schemas reject unknown ingredients and misplaced food bonuses", () => {
  for (const mutate of [
    value => { value.food.meals[0].itemId = "missing_item"; },
    value => { value.food.orders.templates[0].items = { missing_item: 1 }; },
    value => { value.food.orders.templates.push(value.food.orders.templates[0]); },
    value => { value.recipes.find(recipe => recipe.id === "cook_grilled_fish").fishInput = { itemIds: ["wood"] }; },
  ]) {
    const invalid = structuredClone(catalog); mutate(invalid);
    assert.equal(model.economyCatalogSchema.safeParse(invalid).success, false);
  }
  const state = fresh(); apply(state, "start_exploration", "forest");
  const original = state.jobs[0];
  assert.equal(model.economyJobSchema.safeParse(original).success, true, "jobs paid before meals remain valid");
  assert.equal(model.economyJobSchema.safeParse({ ...original, meal: { itemId: "grilled_fish", consumer: "builder", speedBps: 1000 } }).success, false);
  assert.equal(model.economyJobSchema.safeParse({ ...original, meal: { itemId: "grilled_fish", consumer: "hero", speedBps: 1000 } }).success, true);
});

test("Ktor's explicit null recipe extensions remain readable alongside old catalogs without food", () => {
  const wire = structuredClone(catalog);
  for (const recipe of wire.recipes) recipe.fishInput ??= null;
  assert.equal(model.economyCatalogSchema.safeParse(wire).success, true);
  wire.food = null;
  for (const recipe of wire.recipes) recipe.fishInput = null;
  assert.equal(model.economyCatalogSchema.safeParse(wire).success, true);
  const duration = Number.MAX_SAFE_INTEGER, bps = 2500;
  const expected = Number((BigInt(duration) * 10000n + BigInt(10000 + bps) - 1n) / BigInt(10000 + bps));
  assert.equal(food.mealDuration(duration, bps), expected, "large saved durations retain Kotlin integer-ceiling semantics");
});


test("saved ordinary orders retain their promise when the current product source is locked", () => {
  const state = fresh();
  state.residentOrders = food.normalizedResidentOrders(state, now);
  state.residentOrders.completed = 7;
  state.residentOrders.earnedCoins = 1234;
  state.residentOrders.freeReplacementsUsed = 2;
  const original = structuredClone(state.residentOrders);
  const locked = { id: "old_compote", residentId: "plesk", name: "Старый компот", items: { berry_compote: 2 }, coins: 900 };
  state.residentOrders.slots[0] = { ...state.residentOrders.slots[0], templateId: locked.id, terms: locked };
  const before = structuredClone(state), wallet = structuredClone(state.wallet);
  const normalized = food.normalizedResidentOrders(state, now);
  assert.equal(normalized.slots[0].templateId, locked.id);
  assert.deepEqual(normalized.slots[0].terms, locked);
  assert.deepEqual(normalized.slots.slice(1), original.slots.slice(1));
  assert.equal(normalized.freeReplacementsUsed, 2);
  assert.equal(normalized.completed, 7); assert.equal(normalized.earnedCoins, 1234);
  assert.deepEqual(state, before); assert.deepEqual(state.wallet, wallet);
  assert.ok(!normalized.recentTemplateIds.includes(locked.id));
  assert.equal(food.obtainableResidentOrderItems(state).has("berry_compote"), false);
  assert.ok(food.eligibleResidentOrderTemplates(state).every(template => Object.keys(template.items).every(id => food.obtainableResidentOrderItems(state).has(id))));
  const supplied = structuredClone(state); supplied.inventory = { ...locked.items };
  const offer = food.residentOrderBoard(supplied, now).offers.find(offer => offer.templateId === locked.id);
  apply(supplied, "complete_resident_order", offer.id);
  assert.equal(supplied.wallet.coins, state.wallet.coins + 900);
  assert.deepEqual(supplied.inventory, {});
  failWithoutChanges(supplied, "complete_resident_order", offer.id, "ECONOMY_ORDER_CHANGED");
  state.buildings.dryer = 1; state.buildings.garden = 1;
  const unlocked = food.normalizedResidentOrders(state, now);
  assert.deepEqual(unlocked.slots[0].terms, locked, "reachable accepted quantities and payout stay frozen even for retired templates");
});
