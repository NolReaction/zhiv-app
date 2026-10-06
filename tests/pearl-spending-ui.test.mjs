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
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = value; }]; }
      export function useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; }
      export function useId() { return 'pearl-' + cursor++; }
      export function useEffect() {}
    `; },
    transform(source, id) { if (mocked.some(file => id.endsWith(`/features/economy/${file}`))) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/model.ts");
const { PleskMerchantHeader } = await vite.ssrLoadModule("/features/economy/plesk-fishing-shop.tsx");
const { ConstructionSpeedup } = await vite.ssrLoadModule("/features/economy/construction-speedup.tsx");
const hooks = await vite.ssrLoadModule(hookModule);
const now = Date.parse("2026-10-06T12:00:00Z");
function harness(Component = PleskMerchantHeader) {
  hooks.reset();
  const state = { ownerPublicId: "ME", revision: 1, catalog: economyCatalog, wallet: { coins: 0, pearls: 100 },
    buildings: { home: 5 }, fishing: economyFishingSchema.parse(undefined), fishingShop: {
      id: "shop-one", refreshAt: new Date(now + 3600000).toISOString(), refreshPricePearls: 100,
      offers: [{ id: "shop-one:river_rod", kind: "rod", itemId: "river_rod", remaining: 1, unitPrice: 10000 }],
    } };
  const calls = [], economy = { snapshot: state, busy: false, uncertain: false, error: null, now, retryAt: 0,
    act(...args) { calls.push(args); }, refresh() {} };
  const job = { id: "house-job", kind: "construction", targetId: "home", targetLevel: 2, finishesAt: new Date(now + 300000).toISOString() };
  function render() {
    hooks.render(); const tree = Component({ state, economy, job }), nodes = [];
    function visit(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, visit); }
    visit(tree);
    const button = label => {
      const node = nodes.find(element => element.type === "button" && (element.props["aria-label"] === label || element.props.children === label));
      assert.ok(node, `Missing button: ${label}`); return node;
    };
    return { html: renderToStaticMarkup(tree), button };
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
  for (const change of [h => { h.economy.now += 3600000; }, h => { h.economy.snapshot = { ...h.state, revision: 2 }; },
    h => { h.economy.busy = true; }, h => { h.economy.uncertain = true; }, h => { h.economy.retryAt = now + 1000; }]) {
    const h = harness(); h.render().button("Обновить предложения за 50 жемчужин").props.onClick(); change(h);
    const view = h.render(); assert.equal(view.button("Обновить").props.disabled, true);
    assert.doesNotMatch(view.html, /Не хватает/);
    view.button("Обновить").props.onClick(); assert.deepEqual(h.calls, []);
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
  view.button("Ускорить за 25 жемчужин").props.onClick(); assert.deepEqual(h.calls, []);
  view = h.render(); assert.match(view.html, />50</); assert.match(view.html, /<strong>25<\/strong>/);
  view.button("Завершить сейчас за 25 жемчужин").props.onClick();
  assert.deepEqual(h.calls, [["speedup_construction", "house-job", 1, 50]]);
  assert.equal(h.state.wallet.pearls, 100);
});
