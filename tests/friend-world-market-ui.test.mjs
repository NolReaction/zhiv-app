import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:friend-market-hooks";
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-friend-market-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "friend-market-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0, layouts = [], effects = [];
      export function reset() { slots = []; cursor = 0; layouts = []; effects = []; }
      export function render() { cursor = 0; layouts = []; effects = []; }
      export function flush() { layouts.forEach(effect => effect()); effects.forEach(effect => effect()); }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useState(initial) { const ref = useRef(typeof initial === 'function' ? initial() : initial); return [ref.current, value => { ref.current = typeof value === 'function' ? value(ref.current) : value; }]; }
      export function useId() { return 'friend-market-' + cursor++; }
      function enqueue(effect, dependencies, queue) { const i = cursor++, prior = slots[i]; if (!prior || dependencies.some((value, index) => !Object.is(value, prior[index]))) { slots[i] = dependencies; queue.push(effect); } }
      export function useLayoutEffect(effect, dependencies) { enqueue(effect, dependencies, layouts); }
      export function useEffect(effect, dependencies) { enqueue(effect, dependencies, effects); }
    `; },
    transform(source, id) {
      if (id.endsWith("/features/economy/ui/market/friend-world-market.tsx"))
        return source.replace('from "react";', `from "${hooksId}";`).replace("function FriendMarketContents(", "export function FriendMarketContents(");
    },
  }],
});
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const { FriendWorldMarket, FriendMarketContents, friendMarketQuoteReason } = await vite.ssrLoadModule("/features/economy/ui/market/friend-world-market.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const hooks = await vite.ssrLoadModule(hooksId), now = Date.parse("2026-10-18T22:00:00Z");
function fixtures() {
  const listing = { id: "0c4c50db-3a21-4b56-a432-cbcfb4c5877c", sellerPublicId: "THEM", sellerName: "Друг <лес>", itemId: "wood", quantity: 6, totalPrice: 300, owned: false, status: "active" };
  const visit = { ownerPublicId: "ME", circleId: "9d2e5d5f-8e6e-4d38-b9fb-53a3611e6e98", user: { publicId: "THEM", displayName: "Друг <лес>" },
    market: { listings: [listing], available: true, reason: null } };
  const economy = { snapshot: { ownerPublicId: "ME", revision: 4, wallet: { coins: 1000, pearls: 0 }, inventory: {}, unlockedItems: ["wood"], itemUnlockVersion: 1,
    buildings: { home: 3, bridge: 1 }, completedExplorations: 1, storage: { available: 50 }, catalog: structuredClone(economyCatalog) },
    now, retryAt: 0, snapshotConfirmed: true, directActionsAvailable: true, busy: false, uncertain: false, syncPending: false, error: null, notice: "",
    actFriendMarket() { assert.fail("Viewing goods must not buy anything"); }, retry() { assert.fail("Must explicitly ask to check the pending receipt"); } };
  return { economy, visit, listing, refreshing: false, onRefresh() {} };
}
function quoteFor({ economy, visit, listing }) {
  return { buyer: "ME", revision: economy.snapshot.revision, circleId: visit.circleId, seller: "THEM", listingId: listing.id,
    itemId: listing.itemId, quantity: listing.quantity, totalPrice: listing.totalPrice, expiresAt: now + 60_000 };
}
function elements(tree) {
  const result = []; const visit = element => { if (isValidElement(element)) { result.push(element); Children.forEach(element.props.children, visit); } };
  visit(tree); return result;
}
function harness(props) {
  hooks.reset(); return { render() { hooks.render(); const tree = FriendMarketContents(props), nodes = elements(tree);
    for (const node of nodes) if (node.props.ref) node.props.ref.current = { focus() {}, querySelector() { return { focus() {} }; } };
    hooks.flush(); return { nodes, tree }; } };
}
const button = (view, prefix) => view.nodes.find(node => node.type === "button" && node.props["aria-label"]?.startsWith(prefix));

test("closing the storefront restores the supplied visit control and Escape never closes the whole guest world", () => {
  const props = fixtures(), events = [];
  const content = elements(FriendWorldMarket({ ...props, open: true, onClose() {}, onReturnFocus: () => events.push("restore visit control") }))
    .find(node => typeof node.props.onCloseAutoFocus === "function");
  content.props.onCloseAutoFocus({ preventDefault: () => events.push("prevent default focus") });
  assert.deepEqual(events, ["prevent default focus", "restore visit control"]);
  events.length = 0;
  content.props.onEscapeKeyDown({ stopPropagation: () => events.push("stop parent Escape"), preventDefault: () => events.push("prevent modal close") });
  assert.deepEqual(events, ["stop parent Escape"]);
  const ordinary = elements(FriendWorldMarket({ ...props, open: true, onClose() {} })).find(node => typeof node.props.onCloseAutoFocus === "function");
  ordinary.props.onCloseAutoFocus({ preventDefault: () => assert.fail("retain Radix default focus without a supplied target") });
});

test("friend lot requires explicit confirmation and sends the exact quantity and full price once", () => {
  const props = fixtures(), calls = [], h = harness(props); props.economy.actFriendMarket = (...args) => { calls.push(args); return true; };
  button(h.render(), "Выбрать:").props.onClick(); assert.deepEqual(calls, []);
  const view = h.render(), confirm = button(view, "Подтвердить покупку:");
  assert.match(confirm.props["aria-label"], /6 шт. за 300 монет/); assert.equal(confirm.props.disabled, false);
  confirm.props.onClick(); confirm.props.onClick(); button(h.render(), "Подтвердить покупку:").props.onClick();
  assert.deepEqual(calls, [[props.visit.circleId, props.listing.id, 6, 300]]);
});

test("captured confirmation rejects latest state, owner, quote, availability and connectivity changes", () => {
  for (const invalidate of [
    p => p.economy.snapshot.revision++, p => { p.economy.snapshot.ownerPublicId = "OTHER"; }, p => { p.visit.ownerPublicId = "OTHER"; },
    p => { p.visit.user.publicId = "OTHER"; }, p => { p.visit.circleId = "other"; }, p => { p.listing.totalPrice++; },
    p => { p.listing.quantity++; }, p => { p.visit.market.listings = []; }, p => { p.listing.status = "sold"; },
    p => { p.economy.snapshot.wallet.coins = 1; }, p => { p.economy.snapshot.storage.available = 1; }, p => { p.economy.snapshot.catalog.items = []; },
    p => { p.visit.market.available = false; p.visit.market.reason = "home_band"; }, p => { p.economy.snapshot.buildings.bridge = 0; },
    p => { p.economy.busy = true; }, p => { p.economy.uncertain = true; }, p => { p.economy.directActionsAvailable = false; },
    p => { p.economy.pendingProductionCount = 1; }, p => { p.economy.retryAt = now + 1000; }, p => { p.economy.now += 60_000; }, p => { p.refreshing = true; },
  ]) {
    const props = fixtures(), calls = [], h = harness(props); props.economy.actFriendMarket = (...args) => { calls.push(args); return true; };
    button(h.render(), "Выбрать:").props.onClick(); const captured = button(h.render(), "Подтвердить покупку:").props.onClick;
    invalidate(props); h.render(); captured(); assert.deepEqual(calls, [], invalidate.toString());
  }
});

test("uncertain purchase is recovered through the same session receipt and storefront refresh does not buy again", () => {
  const props = fixtures(), buys = [], retries = [], refreshes = [], h = harness(props);
  props.economy.actFriendMarket = (...args) => { buys.push(args); return true; }; props.economy.retry = () => retries.push("same receipt"); props.onRefresh = () => refreshes.push("guest snapshot");
  button(h.render(), "Выбрать:").props.onClick(); button(h.render(), "Подтвердить покупку:").props.onClick();
  props.economy.uncertain = true; props.economy.error = "Ответ не пришёл";
  let view = h.render(); assert.equal(button(view, "Подтвердить покупку:").props.disabled, true);
  view.nodes.find(node => node.type === "button" && node.props.children === "Проверить результат").props.onClick();
  view.nodes.find(node => node.type === "button" && node.props.children?.[1] === "Обновить лавку").props.onClick();
  assert.deepEqual(retries, ["same receipt"]); assert.equal(refreshes.length, 1); assert.equal(buys.length, 1);
  props.economy.uncertain = false; props.economy.error = null; props.economy.snapshot.revision++; props.economy.notice = "Лот куплен";
  h.render(); view = h.render(); assert.equal(button(view, "Подтвердить покупку:"), undefined); assert.equal(refreshes.length, 2);
  h.render(); assert.equal(refreshes.length, 2, "settled receipt refreshes the host exactly once");
  props.economy.busy = true; props.economy.notice = "";
  assert.equal(button(h.render(), "Подтвердить покупку:"), undefined, "later background work never resurrects a purchased quote");
  props.economy.busy = false; props.economy.error = "Другая ошибка подключения";
  assert.equal(button(h.render(), "Подтвердить покупку:"), undefined);
});

test("read-only shelf exposes no invented goods or seller-management actions and never changes the snapshot", () => {
  const props = fixtures(), before = structuredClone(props.economy.snapshot), h = harness(props);
  let view = h.render(); assert.equal(view.nodes.filter(node => node.type === "article").length, 1);
  assert.equal(view.nodes.some(node => node.props.children === "Создать лот" || node.props.children === "Снять с продажи"), false);
  props.visit.market.listings = []; view = h.render(); assert.equal(view.nodes.filter(node => node.type === "article").length, 0);
  assert.ok(view.nodes.some(node => node.type === "h3" && node.props.children === "Прилавок пока пуст"));
  assert.deepEqual(props.economy.snapshot, before);
});

test("quote reasons include trade budget and expires at the exact deadline", () => {
  const props = fixtures(), quote = quoteFor(props);
  assert.equal(friendMarketQuoteReason(props.economy, props.visit, quote), null);
  assert.match(friendMarketQuoteReason(props.economy, props.visit, quote, quote.expiresAt), /устарело/);
  props.economy.market = { ownerPublicId: "ME", tradeBudget: { resetsAt: new Date(now + 1000).toISOString(), buysUsed: 1000, limit: 1000 } };
  assert.match(friendMarketQuoteReason(props.economy, props.visit, quote), /Дневной объём/);
});
