import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:currency-storefront-ui-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "currency-storefront-ui", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let values = [], cursor = 0;
      export function reset() { values = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = value; }]; }
      export const useRef = initial => ({current: initial});
      export const useId = () => 'storefront-test';
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/market/currency-shop-panel.tsx"))
      return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { storefrontCatalog } = await vite.ssrLoadModule("/features/economy/domain/storefront.ts");
const { CurrencyShopPanel } = await vite.ssrLoadModule("/features/economy/ui/market/currency-shop-panel.tsx");
const hooks = await vite.ssrLoadModule(hooksId);
const state = home => ({ ownerPublicId: "test-owner", catalog: economyCatalog, buildings: { home }, jobs: [] });

function harness(snapshot, initialPage) {
  hooks.reset();
  const focused = [];
  const render = (nextSnapshot = snapshot) => {
    hooks.render();
    const tree = CurrencyShopPanel({ state: nextSnapshot, initialPage });
    const nodes = [];
    function visit(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, visit); }
    visit(tree);
    nodes.filter(node => node.props.role === "tab").forEach((node, index) => node.props.ref?.({ focus() { focused.push(index); } }));
    return { html: renderToStaticMarkup(tree), nodes, tabs: nodes.filter(node => node.props.role === "tab") };
  };
  return { render, focused };
}

test("general store entry shows the current starter, its exact contents and disabled ruble price", () => {
  const { html } = harness(state(2)).render();
  const pack = storefrontCatalog.starterPacks.find(offer => offer.homeLevel === 2);
  assert.match(html, /aria-label="Лесная лавка"/);
  assert.match(html, /Дом 2 ур\./);
  assert.ok(html.includes(pack.name));
  assert.ok(html.includes(`${pack.priceRub} ₽`));
  assert.match(html, /350<\/strong>/);
  assert.match(html, /Скорость: вылазка \+10% · стройка \+10%/);
  for (const [itemId, quantity] of Object.entries(pack.rewards.items)) {
    assert.ok(html.includes(economyCatalog.items.find(item => item.id === itemId).name));
    assert.ok(html.includes(`×${quantity}`));
  }
  assert.match(html, /<button[^>]*disabled=""[^>]*><span>299 ₽<\/span><small>Скоро/);
  assert.match(html, /Один раз на уровень дома/);
  assert.doesNotMatch(html, /Купить сейчас|Получить набор|осталось.*минут/);
});

test("starter changes only with the completed house and never reveals another tier", () => {
  const snapshot = state(1), h = harness(snapshot);
  snapshot.jobs.push({ kind: "construction", targetId: "home", targetLevel: 2, finishesAt: "2020-01-01T00:00:00Z" });
  assert.match(h.render().html, /data-shop-offer="starter_home_1_v1"/);
  snapshot.buildings.home = 2;
  const html = h.render().html;
  assert.match(html, /data-shop-offer="starter_home_2_v1"/);
  assert.doesNotMatch(html, /data-shop-offer="starter_home_[1345]_v1"/);
  assert.match(h.render(state(5)).html, /Набор для последнего уровня дома/);
  assert.doesNotMatch(h.render(state(5)).html, /После улучшения дома/);
});

test("loading and invalid house snapshots do not invent a starter or cash quote", () => {
  for (const snapshot of [null, state(0), state(6)]) {
    const { html } = harness(snapshot).render();
    assert.match(html, /Загружаем полянку, чтобы подобрать набор/);
    assert.doesNotMatch(html, /data-shop-offer=|\d+ ₽/);
  }
});

test("all four keyboard tabs wrap with Home and End and preserve one focusable selection", () => {
  const h = harness(state(3)); let view = h.render();
  assert.deepEqual(view.tabs.map(tab => tab.props.id.split("-").at(-1)), ["starters", "costumes", "pearls", "gold"]);
  for (const [key, expected] of [["End", 3], ["Home", 0], ["ArrowLeft", 3], ["ArrowRight", 0], ["ArrowRight", 1]]) {
    let prevented = false;
    view.tabs.find(tab => tab.props["aria-selected"]).props.onKeyDown({ key, preventDefault() { prevented = true; } });
    view = h.render();
    assert.equal(prevented, true);
    assert.equal(view.tabs[expected].props["aria-selected"], true);
    assert.equal(view.tabs.filter(tab => tab.props.tabIndex === 0).length, 1);
    assert.equal(h.focused.at(-1), expected);
    const panel = view.nodes.find(node => node.props.role === "tabpanel");
    assert.equal(panel.props["aria-labelledby"], view.tabs[expected].props.id);
    assert.equal(panel.props.id, view.tabs[expected].props["aria-controls"]);
  }
});

test("wallet currency entries keep their page and show visible pearls with ruble prices", () => {
  const pearl = harness(state(1), "pearls").render();
  assert.match(pearl.html, /100<\/strong>/);
  assert.match(pearl.html, /350<\/strong>/);
  assert.match(pearl.html, /800<\/strong>/);
  for (const price of [99, 299, 599]) assert.ok(pearl.html.includes(`${price} ₽`));
  assert.doesNotMatch(pearl.html, /6500|6 500|starter_home_/);
  const gold = harness(state(1), "gold").render();
  assert.match(gold.html, /Золото за жемчуг/);
  assert.equal(gold.nodes.filter(node => node.props["data-shop-offer"]).length, 3);
  assert.doesNotMatch(gold.html, /starter_home_|₽/);
});

test("costumes are a working fitting with real sprites and no ownership or equip action", () => {
  const { html } = harness(state(1), "costumes").render();
  assert.match(html, /Примерка/);
  assert.match(html, /Без игровых бонусов/);
  assert.equal((html.match(/<canvas /g) ?? []).length, 4);
  assert.equal((html.match(/aria-label="Примерить:/g) ?? []).length, 3);
  for (const offer of storefrontCatalog.costumeOffers) assert.ok(html.includes(offer.name));
  assert.match(html, /<button[^>]*disabled=""[^>]*><span>199 ₽<\/span>/);
  assert.doesNotMatch(html, /Надеть|Куплено|Уже есть|Подтвердить покупку/);
});

test("browsing every store department never reads or modifies balances and retains promo entry", () => {
  const snapshot = state(3);
  Object.defineProperty(snapshot, "wallet", { get() { throw new Error("A display must not spend or grant wallet balances"); } });
  const before = structuredClone({ buildings: snapshot.buildings, jobs: snapshot.jobs });
  for (const page of ["starters", "costumes", "pearls", "gold"]) {
    const { html, nodes } = harness(snapshot, page).render();
    assert.match(html, /Покупки и обмен пока недоступны/);
    assert.match(html, /У меня есть промокод/);
    for (const action of nodes.filter(node => node.type === "button" && node.props.role !== "tab")) {
      assert.equal(action.props.disabled, true);
      assert.equal(action.props.onClick, undefined);
      assert.equal(action.props.formAction, undefined);
    }
  }
  assert.deepEqual({ buildings: snapshot.buildings, jobs: snapshot.jobs }, before);
});
