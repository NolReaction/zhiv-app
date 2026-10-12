import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:wardrobe-ui-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "wardrobe-ui-handlers", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { effects.forEach(callback => callback()); }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }
      export function useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; }
      export function useEffect(callback) { effects.push(callback); }
      export function useId() { return 'market-' + cursor++; }
    `; },
    transform(source, id) { if (id.endsWith("/features/world/ui/wardrobe/world-wardrobe.tsx")) return source.replace('from "react";', `from "${hookModule}";`); },
  }],
});
after(() => vite.close());

const { WorldWardrobe } = await vite.ssrLoadModule("/features/world/ui/wardrobe/world-wardrobe.tsx");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const hooks = await vite.ssrLoadModule(hookModule);
function harness() {
  hooks.reset(); const calls = [], equips = [], focused = []; let refreshes = 0;
  const world = { snapshot: { ownerPublicId: "ME", revision: 1, state: newWorldState() }, busy: false, uncertain: false,
    act: (...args) => equips.push(args), refreshNow: async () => { refreshes++; } };
  const economy = { snapshot: { ownerPublicId: "ME", revision: 1, wallet: { coins: 20000, pearls: 2000 }, wardrobe: ["moss", "amber_scarf"] },
    busy: false, uncertain: false, now: 1000, retryAt: 0, act: (...args) => calls.push(args), retry() {} };
  const render = () => {
    hooks.render(); const tree = WorldWardrobe({ world, economy }), nodes = [];
    function visit(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, visit); }
    visit(tree);
    for (const node of nodes) if (node.props.ref && typeof node.props.ref !== "function")
      node.props.ref.current = { focus() { focused.push(node.props.role); } };
    hooks.flush(); return { nodes, html: renderToStaticMarkup(tree) };
  };
  return { render, world, economy, calls, equips, focused, refreshes: () => refreshes };
}
const button = (view, label) => view.nodes.find(node => node.type === "button" && renderToStaticMarkup(node).includes(label));
const shop = h => { button(h.render(), "Магазин").props.onClick(); return h.render(); };

test("wardrobe separates owned cosmetics from sale, supports category and currency filters, and hides legacy rods", () => {
  const h = harness(); h.world.snapshot.state.inventory.push("willow_rod");
  let view = h.render(); assert.match(view.html, /Мои вещи/); assert.doesNotMatch(view.html, /Ивовая|Новые рецепты/);
  view = shop(h); assert.match(view.html, /Купить/);
  view.nodes.find(node => node.type === "select").props.onChange({ target: { value: "pearls" } });
  button(view, "Шапки").props.onClick(); view = h.render();
  const list = view.nodes.find(node => node.props["aria-label"] === "Вещи в магазине");
  const html = renderToStaticMarkup(list); assert.match(html, /Лунный венок/); assert.doesNotMatch(html, /Шарф|Жёлудевая/);
});

test("purchase confirms the currency quote once and waits for authoritative wardrobe before equipping", () => {
  const h = harness(); let view = shop(h);
  button(view, "Купить").props.onClick(); assert.deepEqual(h.calls, []); view = h.render();
  assert.ok(view.nodes.some(node => node.props["aria-label"] === "Подтверждение покупки"));
  const confirm = button(view, "Подтвердить покупку"); confirm.props.onClick(); confirm.props.onClick();
  assert.deepEqual(h.calls, [["buy_wardrobe_item", "coins:fern", 1, 1200]]);
  h.economy.snapshot.wardrobe.push("fern"); h.economy.snapshot.revision++;
  view = h.render(); assert.equal(button(view, "Получаем вещь").props.disabled, true); assert.equal(h.refreshes(), 1);
  h.render(); assert.equal(h.refreshes(), 1);
  h.world.snapshot.state.inventory.push("fern"); h.world.snapshot.revision++;
  view = h.render(); button(view, "Выбрать оттенок").props.onClick(); assert.deepEqual(h.equips, [["equip", "fern"]]);
});

test("uncertain owner funds or cooldown changes block an open confirmation without spending", () => {
  for (const change of [h => { h.economy.uncertain = true; }, h => { h.economy.snapshot.wallet.coins = 0; },
    h => { h.economy.retryAt = 3000; }, h => { h.world.uncertain = true; }]) {
    const h = harness(); button(shop(h), "Купить").props.onClick(); change(h);
    const confirm = button(h.render(), "Подтвердить покупку"); assert.equal(confirm.props.disabled, true);
    confirm.props.onClick(); assert.deepEqual(h.calls, []);
  }
  const h = harness(); button(shop(h), "Купить").props.onClick(); h.world.snapshot.ownerPublicId = "OTHER";
  assert.equal(button(h.render(), "Подтвердить покупку"), undefined); assert.deepEqual(h.calls, []);
});

test("failed projection refresh offers recovery while paid ownership stays visible", () => {
  const h = harness(); h.economy.snapshot.wardrobe.push("fern"); h.world.error = "offline";
  let view = h.render(); assert.match(view.html, /Вещь куплена/);
  button(view, "Обновить гардероб").props.onClick(); assert.equal(h.refreshes(), 2);
  const tabs = view.nodes.filter(node => node.props.role === "tab");
  tabs[0].props.onKeyDown({ key: "End", preventDefault() {} }); view = h.render();
  assert.equal(view.nodes.filter(node => node.props.role === "tab")[1].props["aria-selected"], true);
});

test("pearl wardrobe quotes and shortages use visible units while purchase keeps the exact raw price", () => {
  const h = harness(); let view = shop(h);
  view.nodes.find(node => node.type === "select").props.onChange({ target: { value: "pearls" } });
  button(view, "Шапки").props.onClick(); view = h.render();
  const buy = button(view, "Купить");
  assert.equal(buy.props["aria-label"], "Купить Лунный венок за 300 жемчужин");
  assert.match(view.html, /aria-label="1 000 жемчужин"/);
  buy.props.onClick(); button(h.render(), "Подтвердить покупку").props.onClick();
  assert.deepEqual(h.calls, [["buy_wardrobe_item", "pearls:moon_crown", 1, 600]]);
  const poor = harness(); view = shop(poor);
  view.nodes.find(node => node.type === "select").props.onChange({ target: { value: "pearls" } });
  button(view, "Шапки").props.onClick(); poor.economy.snapshot.wallet.pearls = 599; view = poor.render();
  assert.match(view.html, /Не хватает 0,5 жемчужин/);
  assert.equal(button(view, "Купить").props.disabled, true);
  button(view, "Купить").props.onClick(); assert.deepEqual(poor.calls, []);
});
