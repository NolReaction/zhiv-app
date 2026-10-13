import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { worldHelpAdvice } = await vite.ssrLoadModule("/features/world/ui/help/world-help-advice.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { economyStorage } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const { newTutorialOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const now = Date.parse("2026-10-07T12:00:00Z");
const snapshot = (patch = {}) => {
  const value = { ownerPublicId: "0000-0000-0001", revision: 0, serverTime: new Date(now).toISOString(), catalog: economyCatalog,
    wallet: { coins: 5000, pearls: 0 }, buildings: { home: 1, warehouse: 1, garden: 1, woodlot: 1, workshop: 1, dryer: 1 }, inventory: { wood: 10 }, jobs: [],
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, ...patch };
  return economyViewSchema.parse({ ...value, storage: patch.storage ?? economyStorage(value) });
};
const controller = (patch = {}) => ({ snapshot: snapshot(), now, busy: false, uncertain: false, retryAt: 0, error: null,
  act() { assert.fail("help must not send commands"); }, retry() { assert.fail("help must not retry"); }, refresh() { assert.fail("help must not refresh"); }, ...patch });
const advice = (patch = {}, rest = {}) => worldHelpAdvice({ economy: controller({ snapshot: snapshot(patch) }), ...rest });
const context = { intent: "production", stationId: "workshop", recipeId: "make_planks" };
const job = (patch = {}) => ({ id: crypto.randomUUID(), kind: "production", targetId: "workshop", recipeId: "make_planks", targetLevel: null,
  startedAt: new Date(now - 900_000).toISOString(), finishesAt: new Date(now + 1000).toISOString(), cost: { coins: 0, items: { wood: 2 } }, rewards: { planks: 1 }, catalogVersion: 3, ...patch });
const deepFreeze = value => { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; };

test("unknown, loading, busy or invalid-clock snapshots do not invent missing supplies", () => {
  assert.deepEqual(worldHelpAdvice({}), []);
  assert.deepEqual(worldHelpAdvice({ economy: controller({ snapshot: null }) }), []);
  assert.deepEqual(worldHelpAdvice({ economy: controller({ busy: true, snapshot: snapshot({ inventory: {} }) }) }), []);
  assert.deepEqual(worldHelpAdvice({ economy: controller({ now: NaN }) }), []);
  assert.deepEqual(advice(), [], "an established player without blockers receives no arbitrary warnings");
});

test("offline, another device and uncertain receipts suppress resource and ready-job advice", () => {
  const economy = controller({ snapshot: snapshot({ inventory: {}, jobs: [job({ finishesAt: new Date(now).toISOString() })] }) });
  const offline = worldHelpAdvice({ economy, isOnline: false });
  assert.deepEqual(offline.map(entry => entry.id), ["connection:offline"]); assert.equal(offline[0].action, undefined);
  const frozen = worldHelpAdvice({ economy, observation: { memory: { sync: { mode: "other-device", canTakeOver: true } } } });
  assert.deepEqual(frozen.map(entry => entry.id), ["connection:other-device"]);
  assert.deepEqual(frozen[0].action.target, { kind: "profile", tab: "mood" });
  const cannotTakeOver = worldHelpAdvice({ economy, observation: { memory: { sync: { mode: "other-device", canTakeOver: false } } } });
  assert.doesNotMatch(cannotTakeOver[0].message, /Продолжить здесь/);
  for (const kind of ["economy", "world"]) {
    const pending = worldHelpAdvice({ economy, [kind]: { ...economy, uncertain: true } });
    assert.equal(pending.length, 1); assert.match(pending[0].id, /uncertain/);
    assert.equal(pending[0].action.target.kind, `retry-${kind}`);
    assert.equal(worldHelpAdvice({ economy, [kind]: { ...economy, uncertain: true, busy: true } })[0].action, undefined);
  }
});

test("failed reads and cooldowns do not claim stale money or expose an early retry", () => {
  const economy = controller({ snapshot: snapshot({ inventory: {} }), error: "Нет связи" });
  assert.deepEqual(worldHelpAdvice({ economy }).map(entry => entry.id), ["connection:economy:error"]);
  assert.equal(worldHelpAdvice({ economy: { ...economy, retryAt: now + 1 } })[0].action, undefined);
  assert.equal(worldHelpAdvice({ economy: { ...economy, retryAt: now, uncertain: true } })[0].action.target.kind, "retry-economy");
  assert.equal(worldHelpAdvice({ economy: { ...economy, retryAt: now + 1, uncertain: true } })[0].action, undefined);
});

test("single-item recipe advice uses exact ingredients without substituting rarer fish stock", () => {
  const missing = advice({ inventory: { wood: 0 } }, { context: { ...context, quantity: 1 } });
  assert.equal(missing[0].id, "missing:wood"); assert.match(missing[0].message, /Есть 0, нужно 1/);
  assert.deepEqual(missing[0].action.target, { kind: "station", stationId: "woodlot", recipeId: "gather_wood" });
  const foodContext = { intent: "production", stationId: "dryer", recipeId: "cook_grilled_fish", quantity: 1 };
  assert.deepEqual(advice({ inventory: { fish_common: 1 } }, { context: foodContext }), []);
  const selected = advice({ inventory: {} }, { context: foodContext });
  assert.equal(selected[0].id, "missing:fish_common"); assert.match(selected[0].message, /Есть 0, нужно 1/);
  assert.deepEqual(selected[0].action.target, { kind: "expeditions", sector: "coast" });
  const rarerStock = advice({ inventory: { fish_uncommon: 2, wood: 2 } }, { context: foodContext });
  assert.equal(rarerStock[0].id, "missing:fish_common");
  assert.deepEqual(rarerStock[0].action.target, { kind: "expeditions", sector: "coast" });
  for (const bad of [{ recipeId: "unknown" }, { quantity: 0 }, { quantity: 1.1 }, { stationId: "kiln" }, { fishItemId: "fish_shark" }])
    assert.deepEqual(advice({}, { context: { ...context, ...bad } }), []);
});

test("missing prerequisites point to the next relevant building, not impossible crafting", () => {
  const locked = advice({}, { context: { ...context, recipeId: "make_metal_parts" } });
  assert.equal(locked[0].action.target.kind, "upgrade");
  const target = locked[0].action.target.stationId;
  assert.ok(["home", "kiln", "workshop"].includes(target));
  const work = job({ kind: "construction", targetId: target, targetLevel: 2, rewards: {}, recipeId: null });
  const inProgress = advice({ jobs: [work] }, { context: { ...context, recipeId: "make_metal_parts" } });
  assert.equal(inProgress[0].id, `job:${work.id}`); assert.equal(inProgress[0].title, "Строитель занят");
});

test("batch limits send the player back to quantity before recommending a bigger warehouse", () => {
  const result = advice({}, { context: { ...context, quantity: 9 } });
  assert.equal(result[0].id, "recipe:storage-capacity"); assert.equal(result[0].action.target.kind, "station");
  assert.match(result[0].message, /не больше 1/);
});

test("strawberry advice opens the compote recipe until its result has been collected", () => {
  const context = { intent: "production", stationId: "garden", recipeId: "grow_strawberries", quantity: 1 };
  const result = advice({}, { context });
  assert.equal(result[0].id, "recipe:unlock:cook_compote");
  assert.match(result[0].message, /0 \/ 1/);
  assert.deepEqual(result[0].action.target, { kind: "station", stationId: "dryer", recipeId: "cook_compote" });
  const running = job({ targetId: "dryer", recipeId: "cook_compote", rewards: { berry_compote: 1 } });
  assert.equal(advice({ jobs: [running] }, { context })[0].id, "recipe:unlock:cook_compote", "a started job does not unlock strawberries");
  assert.deepEqual(advice({ progression: { recipes: { cook_compote: 1 } } }, { context }), []);
});

test("house two advice opens the four-step tutorial before suggesting money or sale sources", () => {
  const patch = { inventory: { wood: 3, stone: 2, planks: 2 }, wallet: { coins: 250, pearls: 0 }, tutorialOrder: newTutorialOrder() };
  const context = { intent: "construction", stationId: "home" };
  let result = advice(patch, { context });
  assert.equal(result[0].id, "construction:tutorial");
  assert.match(result[0].message, /0 из 4/);
  assert.deepEqual(result[0].action.target, { kind: "food", tab: "orders" });
  patch.tutorialOrder.step = 3;
  assert.match(advice(patch, { context })[0].message, /3 из 4/);
  patch.tutorialOrder.step = 4; patch.tutorialOrder.completed = true;
  result = advice(patch, { context });
  assert.deepEqual(result, []);
});

test("house-three advice prioritizes the five stage requests and keeps the original warehouse sufficient", () => {
  const target = economyCatalog.buildings.find(entry => entry.id === "home").levels.find(entry => entry.level === 3);
  const patch = { buildings: { home: 2, warehouse: 1, workshop: 1, quarry: 2, kiln: 1, garden: 1, dryer: 1, woodlot: 1 },
    inventory: { ...target.cost.items }, wallet: { coins: target.cost.coins, pearls: 0 },
    tutorialOrder: { ...newTutorialOrder(), step: 4, completed: true },
    stageOrders: { version: 1, stages: { 2: { step: 0, completed: false, terms: null } } } };
  const context = { intent: "construction", stationId: "home" };
  let result = advice(patch, { context });
  assert.equal(result[0].id, "construction:stage-orders");
  assert.match(result[0].message, /0 из 5/);
  assert.deepEqual(result[0].action.target, { kind: "food", tab: "orders" });
  patch.stageOrders.stages[2].step = 4;
  assert.match(advice(patch, { context })[0].message, /4 из 5/);
  patch.stageOrders.stages[2] = { step: 5, completed: true, terms: null };
  result = advice(patch, { context });
  assert.deepEqual(result, []);
});

test("material advice directs stage-two stone and clay to the mine and first-stage recovery to the forest", () => {
  const target = economyCatalog.buildings.find(entry => entry.id === "home").levels.find(entry => entry.level === 3);
  const inventory = { ...target.cost.items, stone: 0 };
  const patch = { buildings: { home: 2, warehouse: 1, workshop: 1, quarry: 2, kiln: 1 }, inventory,
    wallet: { coins: target.cost.coins, pearls: 0 } };
  const stone = advice(patch, { context: { intent: "construction", stationId: "home" } }).find(entry => entry.id === "missing:stone");
  assert.deepEqual(stone.action.target, { kind: "station", stationId: "quarry" });
  const clay = advice({ ...patch, inventory: { clay: 0, charcoal: 1 } },
    { context: { intent: "production", stationId: "kiln", recipeId: "fire_bricks", quantity: 1 } }).find(entry => entry.id === "missing:clay");
  assert.deepEqual(clay.action.target, { kind: "station", stationId: "quarry" });
  const first = advice({ inventory: { wood: 3, stone: 0, planks: 2 }, wallet: { coins: 250, pearls: 0 } },
    { context: { intent: "construction", stationId: "home" } }).find(entry => entry.id === "missing:stone");
  assert.deepEqual(first.action.target, { kind: "expeditions", sector: "forest" });
});

test("independent miner guidance stays at the mine and never occupies Mochlik or suggests food", () => {
  const mining = job({ kind: "exploration", actorId: "miner", targetId: "quarry_stone", recipeId: null,
    rewards: { stone: 1 }, cost: { coins: 0, items: {} } });
  const patch = { buildings: { home: 2, warehouse: 1, quarry: 2 }, inventory: { wood: 3 }, jobs: [mining] };
  assert.deepEqual(advice(patch, { context: { intent: "expedition", routeId: "forest" } }), []);
  let result = advice(patch, { context: { intent: "expedition", routeId: "quarry_clay" } });
  assert.equal(result[0].id, `job:${mining.id}`);
  assert.match(result[0].title, /Шахтёр/);
  assert.deepEqual(result[0].action.target, { kind: "station", stationId: "quarry" });
  mining.finishesAt = new Date(now).toISOString();
  result = advice(patch);
  assert.equal(result[0].id, `job:${mining.id}`);
  assert.match(result[0].title, /Добыча ждёт получения/);
  assert.deepEqual(result[0].action.target, { kind: "station", stationId: "quarry" });
  assert.doesNotMatch(JSON.stringify(result), /Мохлик ещё в пути|food|Сыт/);
});

test("ready jobs use the supplied server clock and never claim their result", () => {
  const current = job();
  assert.deepEqual(advice({ jobs: [current] }), []);
  const done = worldHelpAdvice({ economy: controller({ snapshot: snapshot({ jobs: [current] }), now: now + 1000 }) });
  assert.equal(done[0].id, `job:${current.id}`); assert.equal(done[0].title, "Производство готово");
  assert.deepEqual(done[0].action.target, { kind: "station", stationId: "workshop" });
  const pending = advice({ jobs: [current] }, { context });
  assert.equal(pending[0].title, "Место производства занято");
});

test("storage shortfalls, including reserved goods, come before collection suggestions", () => {
  const capacity = snapshot().storage.capacity;
  const current = job({ finishesAt: new Date(now).toISOString(), rewards: { planks: 8 } });
  const result = advice({ jobs: [current], storage: { capacity, used: capacity - 30, reserved: 25, available: 5, overflow: 0 } }, { context });
  assert.equal(result[0].id, "storage:space"); assert.match(result[0].message, /ещё 3 мест/);
  assert.equal(result.filter(entry => entry.id === "storage:space").length, 1);
  assert.ok(!result.some(entry => entry.id === `job:${current.id}`));
  const build = job({ kind: "construction", targetId: "home", targetLevel: 2, recipeId: null, rewards: {}, finishesAt: new Date(now).toISOString() });
  const full = advice({ jobs: [build], inventory: { wood: capacity } });
  assert.equal(full[0].id, "storage:space"); assert.equal(full[1].title, "Стройка готова", "construction needs no item storage");
});

test("construction blockers point to the occupied building rather than the requested one", () => {
  const current = job({ kind: "construction", targetId: "warehouse", targetLevel: 2, recipeId: null, rewards: {} });
  const result = advice({ jobs: [current] }, { context: { intent: "construction", stationId: "home" } });
  assert.equal(result[0].title, "Строитель занят");
  assert.deepEqual(result[0].action.target, { kind: "upgrade", stationId: "warehouse" });
  const depleted = advice({ inventory: {} }, { context: { intent: "construction", stationId: "home" } });
  assert.ok(depleted.some(entry => entry.id.startsWith("missing:")));
});

test("coin shortfall uses the same integer amount shown by construction and orders", () => {
  const home = economyCatalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 2);
  assert.ok(home.cost.coins > 47);
  const result = advice({ wallet: { coins: home.cost.coins - 47, pearls: 0 } }, { context: { intent: "construction", stationId: "home" } });
  assert.equal(result[0].id, "missing:coins");
  assert.match(result[0].message, /Нужно ещё 47\./);
  assert.doesNotMatch(result[0].message, /4,7/);
  assert.deepEqual(result[0].action.target, { kind: "food", tab: "orders" });
});

test("ripe berries are not treated as collected while the separate harvest timer runs", () => {
  const current = job({ targetId: "garden", recipeId: "grow_berries", rewards: { berries: 4 }, finishesAt: new Date(now - 1000).toISOString(),
    collection: { kind: "berry_harvest", seconds: 8, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 8000).toISOString() } });
  assert.deepEqual(advice({ jobs: [current] }), []);
  const waiting = advice({ jobs: [current] }, { context: { intent: "expedition", routeId: "forest" } });
  assert.equal(waiting[0].title, "Мохлик собирает урожай");
  const ripe = structuredClone(current); ripe.collection.startedAt = null; ripe.collection.finishesAt = null;
  assert.equal(advice({ jobs: [ripe] })[0].title, "Ягоды созрели");
  const away = job({ kind: "exploration", targetId: "forest", recipeId: null, rewards: { wood: 5 } });
  const blocked = advice({ jobs: [ripe, away] });
  assert.equal(blocked[0].id, `job:${away.id}`); assert.equal(blocked[0].title, "Мохлик ещё в пути");
  const collected = worldHelpAdvice({ economy: controller({ snapshot: snapshot({ jobs: [current] }), now: now + 8000 }) });
  assert.equal(collected[0].title, "Производство готово");
});

test("exact trip context handles missing bait, provisions and locked mine without random warnings", () => {
  const state = snapshot(); state.fishing.equippedBaitId = economyCatalog.fishing.baits[0].itemId;
  const economy = controller({ snapshot: state });
  assert.deepEqual(worldHelpAdvice({ economy }), [], "unselected fishing is not an error");
  const bait = worldHelpAdvice({ economy, context: { intent: "expedition", routeId: "shore" } });
  assert.equal(bait[0].id, "fishing:bait"); assert.match(bait[0].message, /Без наживки/);
  const mine = advice({}, { context: { intent: "expedition", routeId: "cave" } });
  assert.equal(mine[0].action.target.kind, "upgrade");
  const provisions = advice({ buildings: { home: 3, warehouse: 3, quarry: 1, dryer: 2 } }, { context: { intent: "expedition", routeId: "deep_cave" } });
  assert.equal(provisions[0].id, "missing:dried_berries"); assert.equal(provisions[0].action.target.recipeId, "dry_berries");
  const away = job({ kind: "exploration", targetId: "shore", recipeId: null, rewards: { fish: 4 }, finishesAt: new Date(now).toISOString() });
  const returned = advice({ jobs: [away] }, { context: { intent: "expedition", routeId: "forest" } });
  assert.equal(returned[0].title, "Находки ждут получения"); assert.equal(returned.filter(entry => entry.id === `job:${away.id}`).length, 1);
});

test("no supplies offers genuinely free starting actions and never diagnoses hunger from mood", () => {
  const result = advice({ inventory: {}, wallet: { coins: 0, pearls: 0 } });
  assert.deepEqual(result.map(entry => entry.id), ["start:free-forest", "start:free-berries"]);
  const observation = { memory: { status: "saved" }, needs: { energy: 0, curiosity: 0, comfort: 0, attention: 0 }, mood: "Устал", sleeping: true, paused: false };
  assert.deepEqual(advice({}, { observation }), []);
  const current = job({ kind: "exploration", targetId: "forest", recipeId: null });
  const busy = advice({ inventory: {}, jobs: [current] });
  assert.ok(busy.some(entry => entry.id === `job:${current.id}`)); assert.ok(!busy.some(entry => entry.id === "start:free-forest"));
});

test("advice stays deterministic, bounded, mutation-free and only uses valid help topics", async () => {
  const { worldHelpTopics } = await vite.ssrLoadModule("/features/world/ui/help/world-help-content.ts");
  const economy = deepFreeze(controller({ snapshot: snapshot({ inventory: {}, jobs: [
    job({ finishesAt: new Date(now).toISOString() }),
    job({ targetId: "dryer", finishesAt: new Date(now).toISOString(), rewards: { grilled_fish: 1 } }),
    job({ targetId: "woodlot", finishesAt: new Date(now).toISOString(), rewards: { wood: 5 } }),
    job({ targetId: "kiln", finishesAt: new Date(now).toISOString(), rewards: { charcoal: 1 } }),
  ] }) }));
  const before = JSON.stringify(economy);
  const first = worldHelpAdvice({ economy, context });
  assert.equal(first.length, 3); assert.deepEqual(first, worldHelpAdvice({ economy, context }));
  assert.equal(JSON.stringify(economy), before);
  const ids = new Set(worldHelpTopics().map(topic => topic.id));
  assert.ok(first.every(entry => ids.has(entry.topicId)));
});


test("trip advice explains incompatible stocked bait before allowing a wasted departure", () => {
  const state = snapshot();
  state.fishing.equippedRodId = "reed_rod";
  state.fishing.equippedBaitId = "star_bait";
  state.inventory.star_bait = 2;
  const before = structuredClone(state);
  const advice = worldHelpAdvice({ economy: controller({ snapshot: state }), context: { intent: "expedition", routeId: "shore" } });
  assert.equal(advice[0].id, "fishing:bait-incompatible");
  assert.match(advice[0].message, /Без наживки/);
  assert.match(advice[0].message, /запас наживки сохранится/);
  assert.deepEqual(state, before);
});
