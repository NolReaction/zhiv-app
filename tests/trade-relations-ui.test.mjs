import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = { appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-trade-ui-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } };
const vite = await createServer(options);
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { WorldOrderJournal } = await vite.ssrLoadModule("/features/economy/ui/orders/world-order-journal.tsx");
const { ResidentOrderCard, residentOrderReplacementTerms, residentOrderQuoteReason } = await vite.ssrLoadModule("/features/economy/ui/orders/world-resident-order-board.tsx");
const { OrderResidentTabs } = await vite.ssrLoadModule("/features/economy/ui/orders/order-resident-tabs.tsx");
const { orderReputationPresentation } = await vite.ssrLoadModule("/features/economy/ui/orders/order-reputation-presentation.ts");
const { orderJournalSummary } = await vite.ssrLoadModule("/features/economy/ui/orders/order-journal-summary.ts");
const { residentOrderBoard, normalizedResidentOrders } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { tradeRelationsState, weeklyOrderBoard, acceptWeeklyOrder } = await vite.ssrLoadModule("/features/economy/domain/trade-relations.ts");
const { newTutorialOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
after(() => vite.close());
const now = Date.parse("2026-10-23T12:00:00Z");
const ids = ["builder", "lopukh", "kamneshmyg", "plesk", "leaftail"];
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
function controller(patch = {}, flags = {}) {
  return { snapshot: { ownerPublicId: "trade-ui-owner", revision: 7, serverTime: new Date(now).toISOString(),
    wallet: { coins: 1000, pearls: 40 }, inventory: {}, buildings: { home: 5, dryer: 5, warehouse: 5, workshop: 5, garden: 5, woodlot: 5, quarry: 5, kiln: 5 }, jobs: [],
    food: { heroMeal: null, builderMeal: null }, catalog: structuredClone(economyCatalog),
    storage: { capacity: 1000, used: 0, reserved: 0, available: 1000, overflow: 0 }, ...patch },
    now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "", act() { assert.fail("inspection cannot issue a command"); }, retry() {}, ...flags };
}
function elements(tree) {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
}

test("orders retain All and five compact character tabs without exposing residents before their introduction", () => {
  const economy = controller();
  let html = render(WorldOrderJournal, { economy, introducedResidents: ids });
  assert.equal((html.match(/role="tab"/g) ?? []).length, 6);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(html, /data-order-filter="all"/);
  for (const id of ids) assert.match(html, new RegExp(`data-order-filter="${id}"`));
  assert.match(html, /data-order-chapter="repeatable"/);
  assert.match(html, /data-order-chapter="weekly"/);
  html = render(WorldOrderJournal, { economy, introducedResidents: ["builder", "plesk"], residentId: "lopukh" });
  assert.match(html, /Все просьбы/);
  assert.doesNotMatch(html, /Лопоух|Камнешмыг|Листохвост|data-order-relations=/);
  assert.equal((html.match(/disabled=""/g) ?? []).length >= 3, true);
  const strip = render(OrderResidentTabs, { selected: "all", available: ["builder", "plesk"], counts: {}, panelId: "trade-panel", onSelect() {} });
  assert.equal((strip.match(/<canvas /g) ?? []).length, 2);
  assert.equal((strip.match(/tabindex="0"/g) ?? []).length, 1);
  assert.match(strip, /aria-controls="trade-panel"/);
});

test("character view shows the real long-term rank, benefit and remaining daily reputation", () => {
  const economy = controller();
  economy.snapshot.tradeRelations = { ...tradeRelationsState(economy.snapshot), reputation: { builder: 1800 },
    dailyCycle: Math.floor(now / 86400000), dailyOrderXp: { builder: 59 } };
  const html = render(WorldOrderJournal, { economy, residentId: "builder", introducedResidents: ids });
  assert.match(html, /data-order-relations="builder"/);
  assert.match(html, /Близкий друг/);
  assert.match(html, /Скорость стройки \+7%/);
  assert.match(html, /Следующий уровень: Скорость стройки \+10%/);
  assert.match(html, /data-order-daily-reputation/);
  assert.match(html, /<strong>1 \/ 60<\/strong>/);
  const offer = residentOrderBoard(economy.snapshot, now).offers.find(entry => entry.residentId === "builder");
  const card = render(ResidentOrderCard, { economy, offer });
  assert.match(card, /\+1 репутации/);
  assert.match(card, /дневной остаток/);
  assert.match(card, /data-order-preparation/);
  economy.snapshot.tradeRelations.reputation.builder = 100000;
  const top = orderReputationPresentation(economy.snapshot, "builder", now);
  assert.equal(top.nextRankAt, null);
  assert.equal(top.benefit, "Скорость стройки +10%");
});

test("All includes the saved weekly stage in readiness and weekly rewards do not consume the ordinary daily allowance", () => {
  const economy = controller(), state = economy.snapshot;
  const candidate = weeklyOrderBoard(state, now).offers.find(offer => offer.residentId === "builder");
  assert.ok(candidate);
  acceptWeeklyOrder(state, candidate, now, state.catalog);
  state.tradeRelations.dailyCycle = Math.floor(now / 86400000);
  state.tradeRelations.dailyOrderXp.builder = state.catalog.tradeRelations.dailyOrderXpCap;
  const active = weeklyOrderBoard(state, now).active;
  assert.ok(active);
  state.inventory = { ...active.items };
  const summary = orderJournalSummary(state, now);
  const html = render(WorldOrderJournal, { economy, introducedResidents: ids });
  assert.match(html, /data-weekly-order="true"/);
  assert.match(html, /этап 1 \/ 3/);
  assert.match(html, /data-weekly-deadline/);
  assert.match(html, new RegExp(`Можно сдать: ${summary.ready}\\. Всего заказов: ${summary.total}\\.`));
  const card = render(ResidentOrderCard, { economy, offer: active });
  assert.match(card, new RegExp(`\\+${active.reputationXp} репутации`));
  assert.doesNotMatch(card, /Заменить заказ:|дневной остаток|Репутация за обычные просьбы/);
  const ownSummary = orderJournalSummary(state, now, "builder");
  assert.ok(ownSummary.total >= 2);
  const future = { ...economy, now: Date.parse(state.tradeRelations.weekly.expiresAt) };
  assert.doesNotMatch(render(WorldOrderJournal, { economy: future }), /data-weekly-order=/);
});

test("the initial world lesson stays focused on its single pinned request", () => {
  const economy = controller();
  economy.snapshot.tutorialOrder = { ...newTutorialOrder(economy.snapshot.catalog), ingredientsClaimed: true };
  const html = render(WorldOrderJournal, { economy, tutorialOnly: true, introducedResidents: ids });
  assert.match(html, /data-tutorial-order="true"/);
  assert.doesNotMatch(html, /data-order-resident-tabs|data-order-relations|data-order-chapter="weekly"|data-order-reputation-reward/);
});

test("a retained duplicate request can be removed with no pearls after the normal replacement allowance is exhausted", () => {
  const calls = [], economy = controller({}, { act(...args) { calls.push(args); return true; } });
  const state = economy.snapshot, config = state.catalog.food.orders;
  const builders = config.templates.filter(entry => entry.residentId === "builder").slice(0, 2);
  const plesk = config.templates.find(entry => entry.residentId === "plesk");
  const original = normalizedResidentOrders(state, now);
  state.residentOrders = { ...original, version: 2, slots: [...builders, plesk].map(terms => ({
    sequence: 0, readyAt: new Date(now).toISOString(), templateId: terms.id, terms: structuredClone(terms),
  })), freeReplacementsUsed: config.freeReplacements, replacementCycle: Math.floor(now / (config.replacementWindowSeconds * 1000)) };
  state.wallet.pearls = 0;
  const board = residentOrderBoard(state, now), duplicate = board.offers.find(entry => entry.residentId === "builder");
  assert.ok(board.replacementPricePearls > 0);
  assert.deepEqual(residentOrderReplacementTerms(economy, duplicate, board), { price: 0, retiring: true });
  assert.equal(residentOrderQuoteReason(economy, { owner: state.ownerPublicId, revision: state.revision, offerId: duplicate.id, price: 0 }), null);
  const tree = ResidentOrderCard({ economy, offer: duplicate });
  const remove = elements(tree).find(entry => entry.type === "button" && entry.props["aria-label"]?.startsWith("Убрать прежнюю просьбу:"));
  assert.ok(remove); assert.equal(remove.props.disabled, false);
  remove.props.onClick();
  assert.deepEqual(calls, [["replace_resident_order", duplicate.id, 1, 0]]);
  assert.equal(state.wallet.pearls, 0);
  assert.equal(state.residentOrders.freeReplacementsUsed, config.freeReplacements);
});

test("weekly review requires explicit acceptance and rejects detached owner or revision confirmations", async () => {
  const hookId = "virtual:weekly-review-hooks";
  const runtime = await createServer({ ...options, cacheDir: `/tmp/zhiv-weekly-review-hooks-${process.pid}`, plugins: [{ name: "weekly-review-hooks", enforce: "pre",
    resolveId(id) { if (id === hookId) return `\0${hookId}`; },
    load(id) { if (id === `\0${hookId}`) return `
      let values = [], cursor = 0, cleanups = [];
      export function reset() { values = []; cursor = 0; cleanups = []; }
      export function frame() { cursor = 0; cleanups = []; }
      export function unmount() { cleanups.forEach(cleanup => cleanup()); }
      export function useRef(value) { const i = cursor++; return values[i] ??= { current: value }; }
      export function useState(value) { const ref = useRef(typeof value === 'function' ? value() : value); return [ref.current, next => { ref.current = typeof next === 'function' ? next(ref.current) : next; }]; }
      export function useId() { return useRef('weekly-review').current; }
      export function useLayoutEffect(effect) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
      export function useEffect() {}
    `; },
    transform(source, id) { if (id.endsWith("/ui/orders/order-weekly-chooser.tsx")) return source.replace('from "react";', `from "${hookId}";`); },
  }] });
  try {
    const hooks = await runtime.ssrLoadModule(hookId);
    const { OrderWeeklyChooser: Chooser } = await runtime.ssrLoadModule("/features/economy/ui/orders/order-weekly-chooser.tsx");
    const calls = [], economy = controller({}, { act(...args) { calls.push(args); return true; } });
    let customer = "builder";
    const draw = () => { hooks.frame(); return Chooser({ economy, customer, available: ids }); };
    const buttons = tree => elements(tree).filter(entry => entry.type === "button");
    const open = () => { const tree = draw(); buttons(tree).find(entry => entry.props["aria-label"]?.startsWith("Посмотреть поручение:")).props.onClick(); return draw(); };
    hooks.reset();
    let review = open();
    assert.deepEqual(calls, []);
    assert.equal(elements(review).filter(entry => entry.type === "ol")[0].props.children.length, 3);
    let accept = buttons(review).find(entry => entry.props.children?.at?.(-1) === "Взять поручение на 7 дней");
    assert.ok(accept);
    accept.props.onClick(); accept.props.onClick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "accept_weekly_order");
    assert.equal(calls[0][2], 1); assert.equal(calls[0][3], 0);

    hooks.reset(); calls.length = 0;
    review = open(); accept = buttons(review).find(entry => entry.props.children?.at?.(-1) === "Взять поручение на 7 дней");
    const oldConfirm = accept.props.onClick;
    economy.snapshot = { ...economy.snapshot, revision: economy.snapshot.revision + 1 };
    review = draw(); oldConfirm();
    assert.deepEqual(calls, []);
    assert.ok(buttons(review).find(entry => entry.props.children?.at?.(-1) === "Взять поручение на 7 дней").props.disabled);

    hooks.reset();
    review = open(); accept = buttons(review).find(entry => entry.props.children?.at?.(-1) === "Взять поручение на 7 дней");
    const previousOwnerConfirm = accept.props.onClick;
    economy.snapshot = { ...economy.snapshot, ownerPublicId: "another-trade-owner", revision: economy.snapshot.revision + 1 };
    draw(); previousOwnerConfirm();
    assert.deepEqual(calls, []);

    hooks.reset();
    review = open(); accept = buttons(review).find(entry => entry.props.children?.at?.(-1) === "Взять поручение на 7 дней");
    const hiddenConfirm = accept.props.onClick;
    customer = "plesk"; draw(); hiddenConfirm();
    assert.deepEqual(calls, [], "switching to another resident revokes a detached weekly confirmation");

    hooks.reset(); customer = "builder";
    review = open(); accept = buttons(review).find(entry => entry.props.children?.at?.(-1) === "Взять поручение на 7 дней");
    const unmountedConfirm = accept.props.onClick;
    hooks.unmount(); unmountedConfirm();
    assert.deepEqual(calls, [], "unmount revokes the weekly confirmation before it can start a contract");
  } finally { await runtime.close(); }
});
