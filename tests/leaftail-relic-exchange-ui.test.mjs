import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), cacheDir = await mkdtemp(join(tmpdir(), "leaftail-exchange-ui-"));
const hooksId = "virtual:leaftail-exchange-hooks";
const runtime = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "leaftail-exchange-hooks", enforce: "pre", resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useState(initial) { const slot = useRef(initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useId() { return useRef('relic-ui').current; }
      export function useEffect() {}
      export function useLayoutEffect(effect) { effect(); }
    `; }, transform(source, id) { if (id.endsWith("/features/economy/ui/market/leaftail-relic-exchange.tsx")) return source.replace('from "react";', `from "${hooksId}";`); } }] });
const hooks = await runtime.ssrLoadModule(hooksId);
const { economyCatalog } = await runtime.ssrLoadModule("/features/economy/domain/model.ts");
const { LeaftailRelicExchange, leaftailRelicExchangeQuote, leaftailRelicExchangeReason } = await runtime.ssrLoadModule("/features/economy/ui/market/leaftail-relic-exchange.tsx");
after(async () => { await runtime.close(); await rm(cacheDir, { recursive: true, force: true }); });
function controller() {
  return { snapshot: { ownerPublicId: "PLAYER", revision: 7, catalog: structuredClone(economyCatalog),
    inventory: { ancient_core: 1, moon_crystal: 4, living_resin: 0 }, wallet: { coins: 50_000, pearls: 0 }, buildings: { home: 4 } },
    snapshotConfirmed: true, now: 1_000_000, busy: false, uncertain: false, retryAt: 0, directActionsAvailable: true, pendingProductionCount: 0 };
}
function harness() {
  hooks.reset(); const economy = controller(), calls = [], original = structuredClone(economy.snapshot);
  economy.act = (...args) => { calls.push(args); return true; };
  function render(patch = {}) {
    hooks.render(); const tree = LeaftailRelicExchange({ economy, isOnline: true, ...patch }), nodes = [];
    const visit = element => { if (React.isValidElement(element)) { nodes.push(element); React.Children.forEach(element.props.children, visit); } }; visit(tree);
    return { tree, nodes, html: () => renderToStaticMarkup(tree), find: prop => nodes.find(node => node.props[prop] !== undefined) };
  }
  return { economy, calls, render, original };
}

test("relic exchange freezes the exact coin quote and protects confirmed owner/revision/inventory", () => {
  const economy = controller(), quote = leaftailRelicExchangeQuote(economy.snapshot, "moon_crystal", "ancient_core");
  assert.equal(quote.quantity, 2); assert.equal(quote.priceCoins, 20_000); assert.equal(quote.targetId, "moon_crystal:ancient_core");
  assert.equal(leaftailRelicExchangeReason(economy, quote, true), null);
  for (const patch of [{ targetId: "moon_crystal:living_resin" }, { quantity: 1 }, { priceCoins: 19_999 }])
    assert.match(leaftailRelicExchangeReason(economy, { ...quote, ...patch }, true), /Условия обмена изменились/);
  for (const patch of [{ ownerPublicId: "OTHER" }, { revision: 8 }])
    assert.match(leaftailRelicExchangeReason({ ...economy, snapshot: { ...economy.snapshot, ...patch } }, quote, true), /Запасы обновились/);
  economy.snapshot.wallet.coins = 19_999;
  assert.match(leaftailRelicExchangeReason(economy, quote, true), /Не хватает 1 монет/);
  economy.snapshot.wallet.coins = 50_000; economy.snapshot.inventory.moon_crystal = 1;
  assert.match(leaftailRelicExchangeReason(economy, quote, true), /Сейчас 1/);
  economy.snapshot.inventory.moon_crystal = 4; economy.snapshot.buildings.home = 3;
  assert.match(leaftailRelicExchangeReason(economy, quote, true), /уровня 4/);
});

test("choosing and reviewing relics cannot spend; confirmation sends one exact authoritative command", () => {
  const h = harness();
  assert.equal(h.render().find("data-relic-from").props.value, "moon_crystal");
  h.render().find("data-relic-to").props.onChange({ target: { value: "living_resin" } });
  h.render().find("data-relic-review").props.onClick();
  const preview = h.render(); assert.match(preview.html(), /Подтвердить обмен/); assert.match(preview.html(), /50\s000 → 30\s000/);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.economy.snapshot, h.original);
  const confirm = preview.find("data-relic-confirm"); confirm.props.onClick(); confirm.props.onClick();
  assert.deepEqual(h.calls, [["exchange_leaftail_relic", "moon_crystal:living_resin", 1, 20_000]]);
  assert.deepEqual(h.economy.snapshot, h.original, "The UI waits for server acknowledgement instead of changing stock or coins");
});

test("retained preview/confirmation handlers cannot submit a stale quote or act offline/pending", () => {
  for (const mutate of [h => { h.economy.snapshot = { ...h.economy.snapshot, ownerPublicId: "OTHER" }; },
    h => { h.economy.snapshot = { ...h.economy.snapshot, revision: 8 }; }, h => { h.economy.busy = true; },
    h => { h.economy.uncertain = true; }, h => { h.economy.snapshotConfirmed = false; },
    h => { h.economy.snapshot.wallet.coins = 0; }, h => { h.economy.snapshot.inventory.moon_crystal = 1; },
    h => { h.economy.snapshot.catalog.leaftailShop.relicExchange.priceCoins = 25_000; },
    h => { h.economy.snapshot.buildings.home = 3; }]) {
    const h = harness(), review = h.render().find("data-relic-review"); review.props.onClick();
    const confirm = h.render().find("data-relic-confirm"); mutate(h); h.render();
    review.props.onClick(); confirm.props.onClick(); assert.deepEqual(h.calls, []);
  }
  const h = harness(); h.render().find("data-relic-review").props.onClick(); const confirm = h.render().find("data-relic-confirm");
  h.render({ isOnline: false }); confirm.props.onClick(); assert.deepEqual(h.calls, []);
});

test("Escape cancels without spending and unavailable stock/gates stay visible with disabled review", () => {
  const h = harness(); h.render().find("data-relic-review").props.onClick();
  let prevented = false;
  h.render().tree.props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true); assert.equal(h.render().find("data-relic-confirm"), undefined); assert.deepEqual(h.calls, []);
  h.economy.snapshot.buildings.home = 3;
  assert.match(h.render().html(), /Доступно с дома 4/); assert.equal(h.render().find("data-relic-review").props.disabled, true);
  h.economy.snapshot.buildings.home = 4; h.economy.snapshot.inventory.moon_crystal = 1;
  assert.equal(h.render().find("data-relic-review").props.disabled, true);
});
