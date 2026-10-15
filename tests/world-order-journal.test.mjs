import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = { appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-order-journal-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } };
const vite = await createServer(options);
const { WorldOrderJournal } = await vite.ssrLoadModule("/features/economy/ui/orders/world-order-journal.tsx");
const { ResidentOrderCard } = await vite.ssrLoadModule("/features/economy/ui/orders/world-resident-order-board.tsx");
const { orderJournalSummary, orderOfferReady } = await vite.ssrLoadModule("/features/economy/ui/orders/order-journal-summary.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ECONOMY_MAX_BALANCE } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const { residentOrderBoard, normalizedResidentOrders } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { newTutorialOrder, tutorialResidentOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const { stageResidentOrder } = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
after(() => vite.close());
const now = Date.parse("2026-10-15T16:00:00Z");
function controller(patch = {}, flags = {}) {
  return { snapshot: { ownerPublicId: "journal-owner", revision: 1, serverTime: new Date(now).toISOString(),
    wallet: { coins: 1000, pearls: 20 }, inventory: {}, buildings: { home: 5, dryer: 5, warehouse: 5, workshop: 5, garden: 5, woodlot: 5, quarry: 5, kiln: 5 }, jobs: [],
    food: { heroMeal: null, builderMeal: null }, catalog: structuredClone(economyCatalog),
    storage: { capacity: 1000, used: 0, reserved: 0, available: 1000, overflow: 0 }, ...patch },
    now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "", act() { assert.fail("journal inspection must never send an economy command"); }, retry() {}, ...flags };
}
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
function elements(tree) {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
}
function fill(economy, offers) {
  economy.snapshot.inventory = {};
  for (const offer of offers) for (const [id, amount] of Object.entries(offer.items)) economy.snapshot.inventory[id] = Math.max(economy.snapshot.inventory[id] ?? 0, amount);
}

test("journal readiness counts only actual activated offers and customer filters include the permanent chapter", () => {
  const economy = controller(), state = economy.snapshot;
  assert.deepEqual(orderJournalSummary(state, now), { total: 3, ready: 0 });
  state.tutorialOrder = newTutorialOrder(state.catalog);
  const tutorial = tutorialResidentOrder(state);
  state.inventory = { ...tutorial.items };
  const normal = residentOrderBoard(state, now).offers;
  const expected = [tutorial, ...normal];
  assert.deepEqual(orderJournalSummary(state, now), { total: 4, ready: expected.filter(offer => orderOfferReady(state, offer, now)).length });
  for (const residentId of ["plesk", "builder"]) {
    const matching = expected.filter(offer => offer.residentId === residentId);
    assert.deepEqual(orderJournalSummary(state, now, residentId), { total: matching.length, ready: matching.filter(offer => orderOfferReady(state, offer, now)).length });
  }
  const html = render(WorldOrderJournal, { economy });
  assert.match(html, /data-order-journal/); assert.match(html, /Все просьбы/);
  assert.ok(html.indexOf('aria-label="Заказчик"') < html.indexOf('data-order-chapter="progression"'));
  assert.ok(html.indexOf('data-order-chapter="progression"') < html.indexOf('data-order-chapter="repeatable"'));
  assert.doesNotMatch(html, /role="dialog"|Угощения во вкладке|data-world-food-tab|Маленькие просьбы/);
  const plesk = render(WorldOrderJournal, { economy, residentId: "plesk" });
  assert.match(plesk, /Просьбы Плёски/); assert.doesNotMatch(plesk, /data-tutorial-order|data-resident="builder"/);
});

test("ready marks and shared dock summary agree with real current quantities and full-wallet limits", () => {
  const economy = controller(), state = economy.snapshot;
  state.residentOrders = normalizedResidentOrders(state, now);
  const offers = residentOrderBoard(state, now).offers;
  fill(economy, offers);
  let summary = orderJournalSummary(state, now), html = render(WorldOrderJournal, { economy });
  assert.equal(summary.ready, offers.length);
  assert.equal((html.match(/data-order-ready="true"/g) ?? []).length, summary.ready);
  assert.match(html, new RegExp(`Можно сдать: ${summary.ready}\\. Всего заказов: ${summary.total}\\.`));
  state.wallet.coins = ECONOMY_MAX_BALANCE;
  summary = orderJournalSummary(state, now); html = render(WorldOrderJournal, { economy });
  assert.equal(summary.ready, 0); assert.doesNotMatch(html, /data-order-ready/);
  for (const offer of offers) {
    const controls = elements(ResidentOrderCard({ economy, offer })).filter(entry => entry.props["data-guide-order-submit"] !== undefined || entry.type?.name === "FishOrderAction");
    assert.equal(controls[0].props.disabled, true);
  }
  state.wallet.coins = 0; state.inventory = {};
  assert.equal(orderJournalSummary(state, now).ready, 0);
});

test("permanent readiness requires the saved deadline, restored building and claimed expedition", () => {
  const economy = controller({ buildings: { home: 4, warehouse: 1, bridge: 1, lighthouse: 0 },
    progression: { routes: {}, recipes: {}, collections: { finds: [], travelSeconds: 0, quarrySeconds: 0 } } });
  const state = economy.snapshot, course = state.catalog.stageOrders.find(entry => entry.homeLevel === 4), terms = structuredClone(course.orders.at(-1));
  state.stageOrders = { version: 1, stages: { 4: { step: course.orders.length - 1, completed: false, terms,
    availableAt: new Date(now + 1000).toISOString(), intervalSeconds: course.intervalSeconds, completionRewards: course.completionRewards } } };
  state.inventory = { ...terms.items };
  const offer = () => stageResidentOrder(state);
  assert.equal(orderOfferReady(state, offer(), now), false);
  state.buildings.lighthouse = 1; state.progression.routes.ancient_ruins = 1;
  assert.equal(orderOfferReady(state, offer(), now), false, "goods and prerequisites cannot bypass the saved deadline");
  assert.equal(orderOfferReady(state, offer(), now + 1000), true);
  state.buildings.lighthouse = 0;
  assert.equal(orderOfferReady(state, offer(), now + 1000), false);
  state.buildings.lighthouse = 1; state.progression.routes.ancient_ruins = 0;
  assert.equal(orderOfferReady(state, offer(), now + 1000), false);
});

test("reward room includes consumed stock while reserved space still blocks readiness", () => {
  const economy = controller({ buildings: { home: 3, warehouse: 1 } }), state = economy.snapshot;
  const course = state.catalog.stageOrders.find(entry => entry.homeLevel === 3), terms = course.orders.at(-1);
  state.stageOrders = { version: 1, stages: { 3: { step: course.orders.length - 1, completed: false, terms,
    availableAt: new Date(now).toISOString(), intervalSeconds: course.intervalSeconds, completionRewards: course.completionRewards } } };
  state.inventory = { ...terms.items };
  const consumed = Object.values(terms.items).reduce((sum, amount) => sum + amount, 0);
  state.storage = { capacity: 50, used: 50, reserved: 0, available: 0, overflow: 0 };
  const before = structuredClone(state), offer = stageResidentOrder(state);
  assert.equal(orderOfferReady(state, offer, now), true);
  const readyBefore = orderJournalSummary(state, now).ready;
  assert.deepEqual(state, before, "readiness never awards the previewed relic");
  state.storage.reserved = consumed;
  assert.equal(orderOfferReady(state, offer, now), false);
  const summary = orderJournalSummary(state, now);
  assert.equal(summary.ready, readyBefore - 1, "only the permanent delivery loses readiness; ordinary orders are unaffected");
});

test("journal loading, missing configuration and recovery never invent or pay orders", () => {
  const economy = controller({}, { snapshot: null });
  assert.match(render(WorldOrderJournal, { economy }), /Открываем журнал/);
  economy.error = "Не удалось загрузить заказы";
  assert.match(render(WorldOrderJournal, { economy }), /role="alert"/);
  assert.doesNotMatch(render(WorldOrderJournal, { economy }), /data-order-id=|Можно сдать:/);
  const unavailable = controller(); delete unavailable.snapshot.catalog.food;
  assert.deepEqual(orderJournalSummary(unavailable.snapshot, now), { total: 0, ready: 0 });
  assert.match(render(WorldOrderJournal, { economy: unavailable }), /Журнал пока недоступен/);
  assert.doesNotMatch(render(WorldOrderJournal, { economy: unavailable }), /data-order-filter/);
});

test("transport uncertainty keeps the readiness proof visible while disabling the actual handover", () => {
  const economy = controller(), offers = residentOrderBoard(economy.snapshot, now).offers;
  fill(economy, offers);
  economy.uncertain = true;
  assert.equal(orderJournalSummary(economy.snapshot, now).ready, offers.length);
  const html = render(WorldOrderJournal, { economy });
  assert.match(html, /Проверяем последнее действие/);
  for (const offer of offers) {
    const control = elements(ResidentOrderCard({ economy, offer })).find(entry => entry.props["data-guide-order-submit"] !== undefined || entry.type?.name === "FishOrderAction");
    assert.equal(control.props.disabled, true);
  }
});

test("changing the customer keeps the contextual heading and readiness in sync without a command", async () => {
  const id = "virtual:journal-hooks";
  const runtime = await createServer({ ...options, cacheDir: `/tmp/zhiv-order-journal-hooks-${process.pid}`, plugins: [{ name: "journal-hooks", enforce: "pre",
    resolveId(value) { if (value === id) return `\0${id}`; },
    load(value) { if (value === `\0${id}`) return `
      const frames = new Map(); let current, cursor = 0;
      export function frame(name) { current = frames.get(name) ?? []; frames.set(name, current); cursor = 0; }
      export function useRef(value) { const i = cursor++; return current[i] ??= { current: value }; }
      export function useState(value) { const slot = useRef(typeof value === 'function' ? value() : value); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useId() { return useRef('journal-board').current; }
      export function useEffect() {}
      export function useLayoutEffect(effect) { effect(); }
    `; },
    transform(source, path) { if (["/ui/orders/world-order-journal.tsx", "/ui/orders/world-resident-order-board.tsx"].some(suffix => path.endsWith(suffix))) return source.replace('from "react";', `from "${id}";`); },
  }] });
  try {
    const hooks = await runtime.ssrLoadModule(id), { WorldOrderJournal: Journal } = await runtime.ssrLoadModule("/features/economy/ui/orders/world-order-journal.tsx");
    const { ResidentOrderBoard: Board } = await runtime.ssrLoadModule("/features/economy/ui/orders/world-resident-order-board.tsx");
    const economy = controller(); economy.snapshot.tutorialOrder = newTutorialOrder(economy.snapshot.catalog);
    economy.snapshot.inventory = { ...tutorialResidentOrder(economy.snapshot).items };
    const journal = () => { hooks.frame("journal"); return Journal({ economy }); };
    const board = tree => { hooks.frame("board"); return Board(elements(tree).find(entry => entry.type === Board).props); };
    let tree = journal();
    let boardTree = board(tree);
    const filter = value => elements(boardTree).find(entry => entry.props["data-order-filter"] === value).props.onClick();
    filter("plesk"); tree = journal(); boardTree = board(tree);
    assert.ok(elements(tree).some(entry => entry.type === "h2" && entry.props.children === "Просьбы Плёски"));
    const summary = orderJournalSummary(economy.snapshot, now, "plesk");
    assert.equal(elements(tree).find(entry => entry.props["data-order-journal-summary"] !== undefined).props["aria-label"], `Можно сдать: ${summary.ready}. Всего заказов: ${summary.total}.`);
    assert.ok(!elements(boardTree).some(entry => entry.props["data-order-chapter"] === "progression"));
    filter("all"); tree = journal(); boardTree = board(tree);
    assert.ok(elements(boardTree).some(entry => entry.props["data-order-chapter"] === "progression"));
    assert.ok(elements(tree).some(entry => entry.type === "h2" && entry.props.children === "Все просьбы"));
  } finally { await runtime.close(); }
});
