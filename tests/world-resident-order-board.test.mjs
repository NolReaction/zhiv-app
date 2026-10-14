import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = { appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } };
const vite = await createServer(options);
const { ResidentOrderBoard, ResidentOrderCard, ResidentOrderReplacement, residentOrderQuoteReason, residentOrderSaleValue } = await vite.ssrLoadModule("/features/economy/ui/food/world-resident-order-board.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { residentOrderBoard, normalizedResidentOrders, advanceResidentOrder } = await vite.ssrLoadModule("/features/economy/domain/food.ts");
const { economyLocalSellPrice } = await vite.ssrLoadModule("/features/economy/domain/local-sale.ts");
const { TUTORIAL_ORDER_ID, tutorialResidentOrder, newTutorialOrder } = await vite.ssrLoadModule("/features/economy/domain/tutorial-order.ts");
const { stageResidentOrder } = await vite.ssrLoadModule("/features/economy/domain/stage-orders.ts");
const { worldDuration } = await vite.ssrLoadModule("/features/economy/ui/shared/world-stations.ts");
after(() => vite.close());
const now = Date.parse("2026-10-07T14:00:00Z");
function controller(overrides = {}, flags = {}) {
  return { snapshot: { ownerPublicId: "ME", revision: 1, serverTime: new Date(now).toISOString(), wallet: { coins: 1000, pearls: 40 },
    inventory: {}, buildings: { home: 5, dryer: 5, workshop: 5, kiln: 5, warehouse: 5, woodlot: 5, garden: 5, quarry: 5 }, jobs: [],
    food: { heroMeal: null, builderMeal: null }, catalog: structuredClone(economyCatalog),
    storage: { capacity: 1000, used: 0, reserved: 0, available: 1000, overflow: 0 }, ...overrides },
    now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "", act() {}, retry() {}, ...flags };
}
function paid(economy) {
  economy.snapshot.residentOrders = normalizedResidentOrders(economy.snapshot, economy.now);
  economy.snapshot.residentOrders.freeReplacementsUsed = economy.snapshot.catalog.food.orders.freeReplacements;
  return economy;
}
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
function elements(tree) {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
}
const buttons = tree => elements(tree).filter(element => element.type === "button");

test("board offers three real portraits and an initial NPC filter without mixing meals into feeding", () => {
  const economy = controller({}, { act() { assert.fail("rendering cannot change an order"); } });
  const all = render(ResidentOrderBoard, { economy });
  assert.equal((all.match(/data-order-id=/g) ?? []).length, 3);
  assert.equal((all.match(/<canvas /g) ?? []).length, 3);
  assert.match(all, /Бесплатных замен: <strong>3 \/ 3/);
  assert.match(all, /затем 5 жемчужин/);
  assert.doesNotMatch(all, /Угостить Шишколапа|Съесть:|Доступен через|новый заказ ждёт/);
  const builder = render(ResidentOrderBoard, { economy, residentId: "builder" });
  assert.match(builder, /Материалы и инструменты/);
  assert.match(builder, /data-resident="builder"/);
  assert.doesNotMatch(builder, /data-resident="plesk"/);
});

test("missing raw fish opens the shore and missing crafted materials open the exact recipe", () => {
  const economy = controller(), calls = [];
  const offer = { ...residentOrderBoard(economy.snapshot, now).offers[0], items: { fish: 3, planks: 2 } };
  const card = ResidentOrderCard({ economy, offer, onNavigateStation: (...args) => calls.push(args), onNavigateExpeditions: sector => calls.push([sector]) });
  const sources = buttons(card).filter(button => button.props["aria-label"]?.startsWith("Где получить для заказа:"));
  assert.equal(sources.length, 2);
  sources.forEach(button => button.props.onClick());
  assert.deepEqual(calls, [["shore"], ["workshop", "make_planks"]]);
});

test("educational order appears only after its activation, respects the resident filter, and cannot be replaced", () => {
  const economy = controller({}, { act() { assert.fail("inspection or a stale callback cannot issue a command"); } });
  const terms = tutorialResidentOrder(economy.snapshot);
  assert.doesNotMatch(render(ResidentOrderBoard, { economy }), /data-tutorial-order/);
  economy.snapshot.tutorialOrder = { ingredientsClaimed: true, completed: false, terms };
  economy.snapshot.inventory = { ...terms.items };
  const markup = render(ResidentOrderBoard, { economy });
  assert.match(markup, /data-tutorial-order="true"/);
  assert.equal((markup.match(/data-order-id=/g) ?? []).length, 4);
  assert.ok(markup.indexOf(`data-order-id="${TUTORIAL_ORDER_ID}"`) < markup.indexOf('aria-label="Заказчик"'), "the practice request is easy to find before normal filters");
  assert.doesNotMatch(render(ResidentOrderBoard, { economy, residentId: "plesk" }), /data-tutorial-order/);
  assert.match(render(ResidentOrderBoard, { economy, residentId: "builder" }), /data-tutorial-order/);
  const card = ResidentOrderCard({ economy, offer: terms });
  assert.equal(buttons(card).length, 1);
  assert.equal(buttons(card)[0].props.disabled, false);
  assert.equal(buttons(card)[0].props.children, "Отдать заказ");
  economy.snapshot.tutorialOrder.completed = true;
  assert.doesNotMatch(render(ResidentOrderBoard, { economy }), /data-tutorial-order/);
  buttons(card)[0].props.onClick(); // Stale callback is rejected by the current confirmed marker.
});

test("house-two course pins one nonreplaceable request before normal filters with frozen accepted terms", () => {
  const economy = controller({ buildings: { home: 2, warehouse: 1, workshop: 1, quarry: 2, kiln: 1 },
    tutorialOrder: { ...newTutorialOrder(), step: 4, completed: true } });
  const course = economy.snapshot.catalog.stageOrders.find(entry => entry.homeLevel === 2);
  assert.equal(course.orders.length, 7);
  const terms = { ...course.orders[0], items: { rope: 3 }, coins: 125 };
  economy.snapshot.stageOrders = { version: 1, stages: { 2: { step: 0, completed: false, terms } } };
  economy.snapshot.inventory = { rope: 3 };
  const before = structuredClone(economy.snapshot), markup = render(ResidentOrderBoard, { economy });
  assert.match(markup, /data-stage-order="true"/);
  assert.match(markup, /К дому 3 · 1 \/ 7/);
  assert.equal((markup.match(/data-stage-order=/g) ?? []).length, 1);
  assert.equal((markup.match(/data-order-id=/g) ?? []).length, 4);
  assert.ok(markup.indexOf(`data-order-id="${terms.id}"`) < markup.indexOf('aria-label="Заказчик"'));
  assert.doesNotMatch(render(ResidentOrderBoard, { economy, residentId: "plesk" }), /data-stage-order/);
  assert.match(render(ResidentOrderBoard, { economy, residentId: "builder" }), /data-stage-order/);
  const offer = stageResidentOrder(economy.snapshot), card = ResidentOrderCard({ economy, offer });
  assert.deepEqual(offer.items, { rope: 3 }); assert.equal(offer.coins, 125);
  assert.equal(buttons(card).length, 1); assert.equal(buttons(card)[0].props.disabled, false);
  assert.doesNotMatch(render(ResidentOrderCard, { economy, offer }), /Заменить заказ:|монет больше продажи/);
  assert.deepEqual(economy.snapshot, before, "rendering cannot freeze, pay or advance the course");
  economy.snapshot.tutorialOrder.completed = false;
  assert.doesNotMatch(render(ResidentOrderBoard, { economy }), /data-stage-order/);
  economy.snapshot.tutorialOrder.completed = true;
  economy.snapshot.buildings.home = 3;
  economy.snapshot.stageOrders.stages[3] = { step: 8, completed: true, terms: null };
  assert.doesNotMatch(render(ResidentOrderBoard, { economy }), /data-stage-order/);
});

test("a completed legacy five-request course stays closed while the current house-two course has seven requests", () => {
  const economy = controller({ buildings: { home: 2, warehouse: 1, workshop: 1, quarry: 2, kiln: 1 },
    tutorialOrder: { ...newTutorialOrder(), step: 4, completed: true },
    stageOrders: { version: 1, stages: { 2: { step: 5, completed: true, terms: null } } } });
  assert.equal(economy.snapshot.catalog.stageOrders.find(entry => entry.homeLevel === 2).orders.length, 7);
  assert.doesNotMatch(render(ResidentOrderBoard, { economy }), /data-stage-order/);
  assert.equal(stageResidentOrder(economy.snapshot), null);
});

test("house-three supply stays pinned while waiting and explains the full interval after handover", () => {
  const economy = controller({ buildings: { home: 3, warehouse: 1, workshop: 2, quarry: 2, kiln: 1 },
    tutorialOrder: { version: 1, ingredientsClaimed: true, completed: true } });
  const course = economy.snapshot.catalog.stageOrders.find(entry => entry.homeLevel === 3);
  assert.equal(course.orders.length, 8); assert.equal(course.intervalSeconds, 86400);
  const terms = course.orders[1], availableAt = new Date(now + 86400000).toISOString();
  economy.snapshot.stageOrders = { version: 1, stages: { 3: { step: 1, completed: false, terms, availableAt,
    intervalSeconds: course.intervalSeconds, completionRewards: course.completionRewards } } };
  economy.snapshot.inventory = { ...terms.items };
  const before = structuredClone(economy.snapshot), offer = stageResidentOrder(economy.snapshot);
  const markup = render(ResidentOrderBoard, { economy });
  assert.match(markup, /К дому 4 · 2 \/ 8/);
  assert.ok(markup.indexOf(`data-order-id="${terms.id}"`) < markup.indexOf('aria-label="Заказчик"'));
  assert.match(markup, /data-stage-order-wait/);
  assert.match(markup, new RegExp(`Следующая поставка через <strong>${worldDuration(course.intervalSeconds)}<\\/strong>`));
  assert.match(markup, new RegExp(`После сдачи этой поставки до следующей пройдёт ${worldDuration(course.intervalSeconds)}`));
  assert.match(markup, /Материалы можно подготовить заранее/);
  assert.match(markup, /Жемчуг не сокращает этот срок/);
  const card = ResidentOrderCard({ economy, offer });
  assert.equal(buttons(card).length, 1); assert.equal(buttons(card)[0].props.disabled, true);
  buttons(card)[0].props.onClick();
  assert.deepEqual(economy.snapshot, before, "waiting views cannot advance the project or award goods");
  assert.doesNotMatch(render(ResidentOrderBoard, { economy, residentId: "plesk" }), /data-stage-order/);
});

test("a stale supply card rechecks the server due time and current goods before issuing a command", () => {
  for (const patch of [
    economy => { economy.snapshot.stageOrders.stages[3].availableAt = new Date(now + 86400000).toISOString(); },
    economy => { economy.snapshot.inventory = {}; },
  ]) {
    const calls = [], economy = controller({ buildings: { home: 3, warehouse: 1 } }, { act: (...args) => calls.push(args) });
    const course = economy.snapshot.catalog.stageOrders.find(entry => entry.homeLevel === 3), terms = course.orders[0];
    economy.snapshot.stageOrders = { version: 1, stages: { 3: { step: 0, completed: false, terms,
      availableAt: new Date(now).toISOString(), intervalSeconds: course.intervalSeconds, completionRewards: course.completionRewards } } };
    economy.snapshot.inventory = { ...terms.items };
    const accept = buttons(ResidentOrderCard({ economy, offer: stageResidentOrder(economy.snapshot) }))[0];
    assert.equal(accept.props.disabled, false);
    patch(economy); accept.props.onClick(); assert.deepEqual(calls, []);
  }
});

test("the final supply previews its guaranteed resin and counts consumed goods when checking reward space", () => {
  const economy = controller({ buildings: { home: 3, warehouse: 1 } });
  const course = economy.snapshot.catalog.stageOrders.find(entry => entry.homeLevel === 3), terms = course.orders.at(-1);
  assert.deepEqual(course.completionRewards, { living_resin: 1 });
  economy.snapshot.stageOrders = { version: 1, stages: { 3: { step: 7, completed: false, terms,
    availableAt: new Date(now).toISOString(), intervalSeconds: course.intervalSeconds, completionRewards: course.completionRewards } } };
  economy.snapshot.inventory = { ...terms.items };
  const consumed = Object.values(terms.items).reduce((total, count) => total + count, 0);
  economy.snapshot.storage = { capacity: 50, used: 50, reserved: 0, available: 0, overflow: 0 };
  const before = structuredClone(economy.snapshot), offer = stageResidentOrder(economy.snapshot);
  const markup = render(ResidentOrderCard, { economy, offer });
  assert.match(markup, /aria-label="Дополнительная награда за этап"/);
  assert.match(markup, /Живая смола × 1/);
  assert.doesNotMatch(markup, /После сдачи этой поставки|Получено:/);
  assert.equal(buttons(ResidentOrderCard({ economy, offer }))[0].props.disabled, false);
  assert.deepEqual(economy.snapshot, before, "the reward preview never creates inventory");
  economy.snapshot.storage.reserved = consumed;
  assert.equal(buttons(ResidentOrderCard({ economy, offer }))[0].props.disabled, true);
  assert.match(render(ResidentOrderCard, { economy, offer }), /Освободите место в кладовой/);
});

test("stage request material shortcuts prefer the independent mine and retain first-house forest recovery", () => {
  const calls = [], economy = controller({ buildings: { home: 2, warehouse: 1, workshop: 1, quarry: 1 } });
  const offer = { ...residentOrderBoard(economy.snapshot, now).offers[0], items: { stone: 6, clay: 4 } };
  const card = () => ResidentOrderCard({ economy, offer, onNavigateStation: (...args) => calls.push(args),
    onNavigateExpeditions: sector => calls.push([sector]) });
  buttons(card()).filter(button => button.props["aria-label"]?.startsWith("Где получить для заказа:")).forEach(button => button.props.onClick());
  assert.deepEqual(calls, [["quarry"], ["quarry"]], "clay points to the mine upgrade even before level two");
  calls.length = 0; economy.snapshot.buildings = { home: 1, warehouse: 1 };
  const first = ResidentOrderCard({ economy, offer: { ...offer, items: { stone: 1 } },
    onNavigateStation: (...args) => calls.push(args), onNavigateExpeditions: sector => calls.push([sector]) });
  buttons(first).find(button => button.props["aria-label"]?.startsWith("Где получить для заказа:")).props.onClick();
  assert.deepEqual(calls, [["forest"]]);
});

test("order premium compares real fish and rounded local sale proceeds, not the nominal catalogue base", () => {
  const economy = controller();
  const fish = economyCatalog.items.find(item => item.id === "fish");
  const planks = economyCatalog.items.find(item => item.id === "planks");
  const offer = { ...residentOrderBoard(economy.snapshot, now).offers[0], items: { fish: 3, planks: 2 }, coins: 3000 };
  const sale = 3 * fish.baseSellPrice + economyLocalSellPrice(planks.baseSellPrice, 2, economyCatalog.localBuyer, planks.id);
  assert.equal(residentOrderSaleValue(economy, offer), sale);
  assert.match(render(ResidentOrderCard, { economy, offer }), new RegExp(`На ${(3000 - sale).toLocaleString("ru-RU")} монет больше продажи`));
  assert.equal(residentOrderSaleValue(economy, { ...offer, items: { unknown_item: 1 } }), null);
});

test("paid replacements display five pearls, exact remaining balance and block stale or raised quotes", () => {
  const economy = paid(controller()), offer = residentOrderBoard(economy.snapshot, now).offers[0];
  const quote = { owner: "ME", revision: 1, offerId: offer.id, price: 10 };
  const markup = render(ResidentOrderReplacement, { economy, quote, offer, onCancel() {}, onConfirm() {} });
  assert.match(markup, /Заменить за 5 жемчужин/);
  assert.match(markup, /Жемчужины: 20 → 15/);
  assert.equal(residentOrderQuoteReason(economy, quote), null);
  assert.match(residentOrderQuoteReason(economy, { ...quote, owner: "OTHER" }), /обновились/);
  assert.match(residentOrderQuoteReason(economy, { ...quote, revision: 0 }), /обновились/);
  assert.match(residentOrderQuoteReason(economy, { ...quote, offerId: "expired" }), /обновились/);
  assert.match(residentOrderQuoteReason(economy, { ...quote, price: 8 }), /Цена изменилась/);
  economy.snapshot.wallet.pearls = 8;
  assert.match(residentOrderQuoteReason(economy, quote), /Не хватает жемчужин: 1/);
  economy.uncertain = true;
  assert.match(residentOrderQuoteReason(economy, quote), /Проверяем/);
});

test("free budget reset can lower the price without spending a previously quoted pearl amount", () => {
  const economy = paid(controller()), offer = residentOrderBoard(economy.snapshot, now).offers[0];
  const quote = { owner: "ME", revision: 1, offerId: offer.id, price: 10 };
  economy.snapshot.residentOrders.freeReplacementsUsed = 0;
  assert.equal(residentOrderQuoteReason(economy, quote), null);
  const markup = render(ResidentOrderReplacement, { economy, quote, offer, onCancel() {}, onConfirm() {} });
  assert.match(markup, /Заменить за 0 жемчужин/);
});

test("paid replacement needs deliberate confirmation, checks fresh state and rejects duplicate presses", async () => {
  const hooksId = "virtual:order-board-hooks";
  const runtime = await createServer({ ...options, plugins: [{ name: "order-board-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useState(initial) { const slot = useRef(typeof initial === 'function' ? initial() : initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useId() { return useRef('order-board').current; }
      export function useEffect() {}
      export function useLayoutEffect(effect) { effect(); }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/food/world-resident-order-board.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }] });
  try {
    const hooks = await runtime.ssrLoadModule(hooksId);
    const { ResidentOrderBoard: Board, ResidentOrderCard: Card } = await runtime.ssrLoadModule("/features/economy/ui/food/world-resident-order-board.tsx");
    const calls = [], economy = paid(controller({}, { act: (...args) => calls.push(args) }));
    const board = () => { hooks.render(); return Board({ economy }); };
    const cards = tree => elements(tree).filter(element => element.type === Card);
    hooks.reset();
    let tree = board(), first = cards(tree)[0], initialId = first.props.offer.id;
    const replace = buttons(Card(first.props)).find(button => button.props["aria-label"]?.startsWith("Заменить заказ:"));
    replace.props.onClick();
    assert.deepEqual(calls, [], "opening consent never sends a command");
    tree = board(); first = cards(tree)[0];
    assert.ok(first.props.confirmation);
    first.props.confirmation.props.onConfirm();
    first.props.confirmation.props.onConfirm();
    assert.deepEqual(calls, [["replace_resident_order", initialId, 1, 10]], "the one receipt uses stored units, never the displayed five");

    hooks.reset(); calls.length = 0;
    tree = board(); cards(tree)[0].props.onReplace(cards(tree)[0].props.offer);
    tree = board(); const oldConfirm = cards(tree)[0].props.confirmation.props.onConfirm;
    economy.snapshot = { ...economy.snapshot, revision: 2 };
    tree = board();
    oldConfirm();
    cards(tree)[0].props.confirmation.props.onConfirm();
    assert.deepEqual(calls, [], "neither captured nor latest callback may debit a different revision");

    hooks.reset(); economy.snapshot.revision = 3;
    economy.snapshot.residentOrders.freeReplacementsUsed = 0;
    tree = board(); first = cards(tree)[0]; initialId = first.props.offer.id;
    first.props.onComplete(first.props.offer);
    assert.deepEqual(calls, [], "missing goods cannot be turned into an order payment");
    economy.snapshot.inventory = { ...first.props.offer.items };
    tree = board(); cards(tree)[0].props.onComplete(cards(tree)[0].props.offer);
    assert.deepEqual(calls, [["complete_resident_order", initialId, 1, 0]]);
    assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ выполнен ·/);
    economy.snapshot.residentOrders = advanceResidentOrder(economy.snapshot, first.props.offer.slot, now);
    economy.snapshot.residentOrders.completed += 1;
    economy.snapshot.revision += 1;
    economy.notice = "Заказ выполнен";
    tree = board();
    assert.ok(cards(tree).every(card => card.props.offer.id !== initialId));
    assert.match(renderToStaticMarkup(tree), /Заказ выполнен ·/);
    assert.equal(cards(tree).length, 3, "the confirmed replacement appears immediately without an empty slot");
    economy.uncertain = true;
    assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ выполнен ·/);

    hooks.reset(); calls.length = 0; economy.uncertain = false; economy.notice = "";
    const terms = tutorialResidentOrder(economy.snapshot);
    economy.snapshot.tutorialOrder = { ingredientsClaimed: true, completed: false, terms };
    economy.snapshot.inventory = { ...terms.items };
    tree = board(); first = cards(tree)[0];
    assert.equal(first.props.offer.id, TUTORIAL_ORDER_ID);
    first.props.onComplete(first.props.offer);
    first.props.onComplete(first.props.offer);
    assert.deepEqual(calls, [["complete_resident_order", TUTORIAL_ORDER_ID, 1, 0]]);
    assert.doesNotMatch(renderToStaticMarkup(board()), /Учебный заказ выполнен ·/);
    economy.snapshot = { ...economy.snapshot, revision: economy.snapshot.revision + 1,
      tutorialOrder: { ...economy.snapshot.tutorialOrder, completed: true }, inventory: {} };
    economy.notice = "Учебный заказ выполнен";
    tree = board();
    assert.equal(cards(tree).length, 3);
    assert.match(renderToStaticMarkup(tree), new RegExp(`Учебный заказ выполнен · \\+${terms.coins} монет`));
    economy.uncertain = true;
    assert.doesNotMatch(renderToStaticMarkup(board()), /Учебный заказ выполнен ·/);

    for (let step = 0; step < 4; step++) {
      hooks.reset(); calls.length = 0; economy.uncertain = false; economy.notice = "";
      const terms = economy.snapshot.catalog.onboarding.residentOrders[step];
      economy.snapshot.tutorialOrder = { ...newTutorialOrder(economy.snapshot.catalog), step, terms };
      economy.snapshot.inventory = { ...terms.items };
      tree = board(); first = cards(tree)[0];
      assert.equal(first.props.offer.id, terms.id);
      assert.match(renderToStaticMarkup(tree), new RegExp(`Учебный заказ · ${step + 1} / 4`));
      assert.equal(buttons(ResidentOrderCard({ economy, offer: first.props.offer })).length, 1, "every tutorial request has no replacement control");
      first.props.onComplete(first.props.offer); first.props.onComplete(first.props.offer);
      assert.deepEqual(calls, [["complete_resident_order", terms.id, 1, 0]]);
      assert.doesNotMatch(renderToStaticMarkup(board()), /Учебный заказ выполнен ·/);
      economy.snapshot = { ...economy.snapshot, revision: economy.snapshot.revision + 1, inventory: {},
        tutorialOrder: { ...economy.snapshot.tutorialOrder, step: step + 1, completed: step === 3,
          terms: economy.snapshot.catalog.onboarding.residentOrders[step + 1] ?? terms } };
      economy.notice = "Учебный заказ выполнен";
      tree = board();
      assert.match(renderToStaticMarkup(tree), new RegExp(`Учебный заказ выполнен · \\+${terms.coins} монет`));
      assert.equal(cards(tree).length, step === 3 ? 3 : 4);
      if (step < 3) assert.equal(cards(tree)[0].props.offer.id, economy.snapshot.catalog.onboarding.residentOrders[step + 1].id);
      first.props.onComplete(first.props.offer);
      assert.equal(calls.length, 1, "a stale tutorial card cannot submit the next pinned request");
    }

    const course = economy.snapshot.catalog.stageOrders.find(entry => entry.homeLevel === 2);
    economy.snapshot.buildings = { home: 2, warehouse: 1, workshop: 1, quarry: 2, kiln: 1 };
    for (let step = 0; step < course.orders.length; step++) {
      hooks.reset(); calls.length = 0; economy.uncertain = false; economy.notice = "";
      const terms = course.orders[step];
      economy.snapshot.stageOrders = { version: 1, stages: { 2: { step, completed: false, terms } } };
      economy.snapshot.inventory = { ...terms.items };
      tree = board(); first = cards(tree)[0];
      assert.equal(first.props.offer.id, terms.id);
      assert.match(renderToStaticMarkup(tree), new RegExp(`К дому 3 · ${step + 1} / 7`));
      assert.equal(buttons(Card(first.props)).length, 1);
      first.props.onComplete(first.props.offer); first.props.onComplete(first.props.offer);
      assert.deepEqual(calls, [["complete_resident_order", terms.id, 1, 0]]);
      assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ этапа выполнен ·/);
      economy.snapshot = { ...economy.snapshot, revision: economy.snapshot.revision + 1 };
      economy.notice = "Фоновый снимок обновлён";
      assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ этапа выполнен ·/, "revision and a notice alone do not confirm payment");
      economy.snapshot.stageOrders.stages[2] = { step: step + 1, completed: step === course.orders.length - 1, terms: course.orders[step + 1] ?? null };
      economy.snapshot.inventory = {};
      economy.notice = "Заказ выполнен";
      tree = board();
      assert.match(renderToStaticMarkup(tree), new RegExp(`Заказ этапа выполнен · \\+${terms.coins.toLocaleString("ru-RU")} монет`));
      assert.equal(cards(tree).length, step === course.orders.length - 1 ? 3 : 4);
      if (step < course.orders.length - 1) assert.equal(cards(tree)[0].props.offer.id, course.orders[step + 1].id);
      else assert.match(renderToStaticMarkup(tree), /Все просьбы этого этапа выполнены/);
      first.props.onComplete(first.props.offer);
      buttons(Card(first.props))[0].props.onClick();
      assert.equal(calls.length, 1, "the saved previous card cannot submit the next stage request");
      economy.uncertain = true;
      assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ этапа выполнен ·/);
      economy.uncertain = false;
      const owner = economy.snapshot.ownerPublicId; economy.snapshot.ownerPublicId = "OTHER";
      assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ этапа выполнен ·/);
      economy.snapshot.ownerPublicId = owner;
    }

    const project = economy.snapshot.catalog.stageOrders.find(entry => entry.homeLevel === 3);
    economy.snapshot.buildings = { home: 3, warehouse: 1, workshop: 2, quarry: 2, kiln: 1 };
    for (const step of [0, 7]) {
      hooks.reset(); calls.length = 0; economy.uncertain = false; economy.notice = "";
      const terms = project.orders[step];
      economy.snapshot.stageOrders = { version: 1, stages: { 3: { step, completed: false, terms,
        availableAt: new Date(now).toISOString(), intervalSeconds: project.intervalSeconds, completionRewards: project.completionRewards } } };
      economy.snapshot.inventory = { ...terms.items };
      tree = board(); first = cards(tree)[0];
      assert.equal(first.props.offer.id, terms.id);
      if (step === 0) {
        economy.snapshot.stageOrders.stages[3].availableAt = new Date(now + 86400000).toISOString();
        first.props.onComplete(first.props.offer); assert.deepEqual(calls, [], "a captured board callback rechecks the latest due time");
        economy.snapshot.stageOrders.stages[3].availableAt = new Date(now).toISOString();
      }
      first.props.onComplete(first.props.offer); first.props.onComplete(first.props.offer);
      assert.deepEqual(calls, [["complete_resident_order", terms.id, 1, 0]]);
      assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ этапа выполнен ·|Получено:/);
      economy.snapshot.revision += 1; economy.notice = "Фоновый снимок обновлён";
      assert.doesNotMatch(renderToStaticMarkup(board()), /Заказ этапа выполнен ·|Получено:/,
        "a higher revision without accepted progress cannot confirm the supply or reward");
      economy.snapshot.stageOrders.stages[3] = { step: step + 1, completed: step === 7, terms: project.orders[step + 1] ?? null,
        availableAt: step === 7 ? null : new Date(now + 86400000).toISOString(), intervalSeconds: project.intervalSeconds,
        completionRewards: project.completionRewards };
      economy.snapshot.inventory = step === 7 ? { living_resin: 1 } : {};
      economy.notice = "Заказ выполнен"; tree = board();
      assert.match(renderToStaticMarkup(tree), new RegExp(`Заказ этапа выполнен · \\+${terms.coins.toLocaleString("ru-RU")} монет`));
      if (step === 0) {
        assert.match(renderToStaticMarkup(tree), new RegExp(`Следующая поставка через ${worldDuration(project.intervalSeconds)}`));
        assert.match(renderToStaticMarkup(tree), /data-stage-order-wait/);
        assert.doesNotMatch(renderToStaticMarkup(tree), /Следующая просьба уже на доске|Получено:/);
      } else {
        assert.equal(cards(tree).length, 3);
        assert.match(renderToStaticMarkup(tree), /Все просьбы этого этапа выполнены/);
        assert.match(renderToStaticMarkup(tree), /Получено: Живая смола × 1/);
        economy.uncertain = true;
        assert.doesNotMatch(renderToStaticMarkup(board()), /Получено:/);
      }
    }
  } finally { await runtime.close(); }
});
