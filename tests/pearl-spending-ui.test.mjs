import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:pearl-spending-hooks";
const mocked = ["plesk-fishing-shop.tsx", "use-fishing-command.ts", "construction-speedup.tsx"];
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "pearl-spending-handlers", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; }
      export function useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; }
      export function useId() { return 'pearl-' + cursor++; }
      export function useEffect(callback, dependencies) {
        const index = cursor++, previous = slots[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
          slots[index] = dependencies; effects.push(callback);
        }
      }
      export function flushEffects() { const pending = effects; effects = []; pending.forEach(callback => callback()); }
      export const useLayoutEffect = useEffect;
    `; },
    transform(source, id) { if (mocked.some(file => id.endsWith(`/features/economy/${file}`))) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { PleskMerchantHeader } = await vite.ssrLoadModule("/features/economy/plesk-fishing-shop.tsx");
const { ConstructionSpeedup } = await vite.ssrLoadModule("/features/economy/construction-speedup.tsx");
const { BuilderConversation } = await vite.ssrLoadModule("/features/world/world-builder-dialog.tsx");
const { WorldUpgradeContent } = await vite.ssrLoadModule("/features/economy/world-upgrade-dialog.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const now = Date.parse("2026-10-06T12:00:00Z");
function harness(Component = PleskMerchantHeader) {
  hooks.reset();
  const state = { ownerPublicId: "ME", revision: 1, catalog: economyCatalog, wallet: { coins: 0, pearls: 100 },
    buildings: { home: 5 }, fishing: economyFishingSchema.parse(undefined), fishingShop: {
      id: "shop-one", openedAt: new Date(now).toISOString(), refreshAt: new Date(now + 6 * 3600000).toISOString(), refreshPricePearls: 100,
      offers: [{ id: "shop-one:river_rod", kind: "rod", itemId: "river_rod", remaining: 1, unitPrice: 10000 }],
    } };
  const calls = [], economy = { snapshot: state, busy: false, uncertain: false, error: null, now, retryAt: 0,
    act(...args) { calls.push(args); }, refresh() {} };
  const job = { id: "house-job", kind: "construction", targetId: "home", targetLevel: 2, finishesAt: new Date(now + 300000).toISOString() };
  state.jobs = [job];
  function render() {
    hooks.render(); const tree = Component({ state, economy, job }), nodes = [];
    function visit(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, visit); }
    visit(tree);
    const button = label => {
      const node = nodes.find(element => element.type === "button" && (element.props["aria-label"] === label || element.props.children === label));
      assert.ok(node, `Missing button: ${label}`); return node;
    };
    const html = renderToStaticMarkup(tree); hooks.flushEffects();
    return { html, button };
  }
  return { state, economy, job, calls, render };
}

test("empty-wallet refresh explains its displayed shortfall and points the disabled control to it", () => {
  const h = harness(); h.state.wallet.pearls = 0;
  const view = h.render(), button = view.button("Обновить предложения за 50 жемчужин");
  assert.equal(button.props.disabled, true);
  assert.match(view.html, /Не хватает 50 жемчужин для обновления/);
  assert.ok(view.html.includes(`id="${button.props["aria-describedby"]}"`));
  button.props.onClick(); assert.deepEqual(h.calls, []);
});

test("funded refresh confirms fifty displayed pearls while sending and retaining the one-hundred-unit quote", () => {
  const h = harness(); let view = h.render();
  assert.equal(view.button("Обновить предложения за 50 жемчужин").props.disabled, false);
  view.button("Обновить предложения за 50 жемчужин").props.onClick(); assert.deepEqual(h.calls, []);
  view = h.render(); assert.match(view.html, /Заменить все товары на другие за/); assert.match(view.html, />50</);
  view.button("Обновить").props.onClick(); view.button("Обновить").props.onClick();
  assert.deepEqual(h.calls, [["refresh_fishing_shop", "shop-one", 1, 100]]);
  assert.equal(h.state.wallet.pearls, 100);
});

test("an open confirmation cannot spend after expiry, a revision change, or a pending request", () => {
  for (const change of [h => { h.economy.now += 6 * 3600000; }, h => { h.economy.snapshot = { ...h.state, revision: 2 }; },
    h => { h.economy.busy = true; }, h => { h.economy.uncertain = true; }, h => { h.economy.retryAt = now + 1000; }]) {
    const h = harness(); h.render().button("Обновить предложения за 50 жемчужин").props.onClick(); change(h);
    const view = h.render(); assert.equal(view.button(h.economy.now >= now + 6 * 3600000 ? "Обновить предложения за 0 жемчужин" : "Обновить").props.disabled, true);
    assert.doesNotMatch(view.html, /Не хватает/);
    view.button(h.economy.now >= now + 6 * 3600000 ? "Обновить предложения за 0 жемчужин" : "Обновить").props.onClick(); assert.deepEqual(h.calls, []);
  }
});

test("lack of replacement and uncertain balances have distinct explanations", () => {
  let h = harness(); h.state.buildings.home = 1; h.state.fishing.ownedRods.push("brook_rod");
  let view = h.render(); assert.match(view.html, /Пока не все товары можно заменить на другие/);
  assert.equal(view.button("Обновить предложения за 50 жемчужин").props.disabled, true);
  view.button("Обновить предложения за 50 жемчужин").props.onClick(); assert.deepEqual(h.calls, []);
  h = harness(); h.state.wallet.pearls = 0; h.economy.uncertain = true;
  view = h.render(); assert.match(view.html, /Проверяем последнее действие/); assert.doesNotMatch(view.html, /Не хватает/);
});

test("construction confirmation displays halved prices and balance but sends the original maximum quote", () => {
  const h = harness(ConstructionSpeedup); let view = h.render();
  view.button("Завершить сейчас за 25 жемчужин").props.onClick(); assert.deepEqual(h.calls, []);
  view = h.render(); assert.match(view.html, />50</); assert.match(view.html, /<strong>25<\/strong>/);
  view.button("Подтвердить завершение за 25 жемчужин").props.onClick();
  view.button("Подтвердить завершение за 25 жемчужин").props.onClick();
  assert.deepEqual(h.calls, [["speedup_construction", "house-job", 1, 50]]);
  assert.equal(h.state.wallet.pearls, 100);
});

test("construction confirmation rechecks the job, owner, revision, wallet, time and transport even before rerender", () => {
  for (const change of [
    h => { h.economy.snapshot = { ...h.state, ownerPublicId: "OTHER" }; },
    h => { h.economy.snapshot = { ...h.state, revision: 2 }; },
    h => { h.economy.snapshot = { ...h.state, jobs: [] }; },
    h => { h.job.kind = "production"; },
    h => { h.state.wallet.pearls = 0; },
    h => { h.economy.now += 300000; },
    h => { h.economy.now -= 300000; },
    h => { h.economy.busy = true; },
    h => { h.economy.uncertain = true; },
    h => { h.economy.retryAt = now + 1000; },
  ]) {
    const h = harness(ConstructionSpeedup);
    h.render().button("Завершить сейчас за 25 жемчужин").props.onClick();
    const confirm = h.render().button("Подтвердить завершение за 25 жемчужин");
    change(h); confirm.props.onClick(); assert.deepEqual(h.calls, []);
  }
});

test("construction quotes cannot cross rendered revisions or replaced jobs, and elapsed work has no pearl control", () => {
  const h = harness(ConstructionSpeedup);
  h.render().button("Завершить сейчас за 25 жемчужин").props.onClick();
  const previous = h.render().button("Подтвердить завершение за 25 жемчужин");
  h.economy.snapshot = { ...h.state, revision: 2 };
  let view = h.render();
  assert.match(view.html, /Данные обновились/);
  assert.equal(view.button("Подтвердить завершение за 25 жемчужин").props.disabled, true);
  previous.props.onClick(); assert.deepEqual(h.calls, []);
  h.job.id = "another-house-job";
  view = h.render(); assert.doesNotMatch(view.html, /Подтвердить завершение/);
  previous.props.onClick(); assert.deepEqual(h.calls, []);
  h.economy.now += 300000;
  assert.equal(h.render().html, "");
});

test("a definitive construction failure allows confirmation again while uncertainty preserves the send latch", () => {
  const h = harness(ConstructionSpeedup);
  h.render().button("Завершить сейчас за 25 жемчужин").props.onClick();
  h.render().button("Подтвердить завершение за 25 жемчужин").props.onClick();
  h.economy.busy = true; h.render();
  h.economy.busy = false; h.economy.uncertain = true; h.economy.error = "Нет связи";
  h.render().button("Подтвердить завершение за 25 жемчужин").props.onClick();
  assert.equal(h.calls.length, 1);
  h.economy.uncertain = false; h.economy.error = "Улучшение не выполнено";
  h.render();
  h.render().button("Подтвердить завершение за 25 жемчужин").props.onClick();
  assert.equal(h.calls.length, 2);
});

test("both the builder and building expose the same confirmation bound to the active construction", () => {
  for (const source of [BuilderConversation, WorldUpgradeContent]) {
    const h = harness(props => {
      const tree = source({ ...props, stationId: "home", onOpenConstruction() {}, onClose() {} });
      let control;
      function find(element) {
        if (!isValidElement(element)) return;
        if (element.type === ConstructionSpeedup) control = element;
        Children.forEach(element.props.children, find);
      }
      find(tree); assert.ok(control, `${source.name} must offer immediate completion`);
      assert.equal(control.props.job, props.job);
      return ConstructionSpeedup(control.props);
    });
    h.render().button("Завершить сейчас за 25 жемчужин").props.onClick();
    assert.deepEqual(h.calls, [], "opening the quote is free");
    h.render().button("Подтвердить завершение за 25 жемчужин").props.onClick();
    assert.deepEqual(h.calls, [["speedup_construction", "house-job", 1, 50]]);
    assert.equal(h.state.wallet.pearls, 100, "only the server may debit the wallet");
  }
});


test("shop price and an open confirmation count down without snapshot replacement", () => {
  const h = harness();
  h.render().button("Обновить предложения за 50 жемчужин").props.onClick();
  h.economy.now += 3 * 3600000;
  let view = h.render(); assert.match(view.html, />25</);
  h.economy.now += 2 * 3600000;
  view = h.render(); assert.match(view.html, />9</);
  view.button("Обновить").props.onClick();
  assert.deepEqual(h.calls, [["refresh_fishing_shop", "shop-one", 1, 18]]);
});

test("shop confirmation rechecks clock balance owner revision stock and expiry even before rerender", () => {
  for (const change of [
    h => { h.economy.snapshot = { ...h.state, ownerPublicId: "OTHER" }; },
    h => { h.economy.snapshot = { ...h.state, revision: 2 }; },
    h => { h.economy.snapshot = { ...h.state, fishingShop: null }; },
    h => { h.state.wallet.pearls = 0; },
    h => { h.economy.now += 6 * 3600000; },
    h => { h.economy.busy = true; },
    h => { h.economy.uncertain = true; },
    h => { h.economy.retryAt = now + 1000; },
  ]) {
    const h = harness(); h.render().button("Обновить предложения за 50 жемчужин").props.onClick();
    const confirmation = h.render().button("Обновить");
    change(h); confirmation.props.onClick(); assert.deepEqual(h.calls, []);
  }
});

test("resynchronized higher shop quote needs new consent and expired confirmation closes", () => {
  const h = harness(); h.economy.now += 3 * 3600000;
  h.render().button("Обновить предложения за 25 жемчужин").props.onClick();
  const old = h.render().button("Обновить");
  h.economy.now -= 3600000;
  let view = h.render(); assert.match(view.html, /Цена изменилась/);
  assert.equal(view.button("Обновить").props.disabled, true);
  old.props.onClick(); assert.deepEqual(h.calls, []);
  h.economy.now = now + 6 * 3600000;
  view = h.render(); assert.doesNotMatch(view.html, /Подтверждение обновления прилавка/);
  assert.match(view.html, /Открываем новые предложения/);
  old.props.onClick(); assert.deepEqual(h.calls, []);
});

test("construction quote counts down inside the open confirmation and uses the cheaper charge", () => {
  const h = harness(ConstructionSpeedup);
  h.render().button("Завершить сейчас за 25 жемчужин").props.onClick();
  h.economy.now += 180000;
  const view = h.render(); assert.match(view.html, /Подтвердить завершение за 10 жемчужин/);
  view.button("Подтвердить завершение за 10 жемчужин").props.onClick();
  assert.deepEqual(h.calls, [["speedup_construction", "house-job", 1, 20]]);
});
