import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: "/tmp/zhiv-world-market-sale-vite",
  optimizeDeps: { noDiscovery: true, include: [] }, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { pendingMarketSales, watchWorldMarketSales, WORLD_MARKET_POLL_MS } = await vite.ssrLoadModule("/features/world/state/market-sale-notice.ts");
const { WorldMarketSaleStatus, marketSaleMarkerAnchor } = await vite.ssrLoadModule("/features/world/ui/hud/world-market-sale-status.tsx");
const { projectConstructionAnchor } = await vite.ssrLoadModule("/features/world/scene/construction-map-anchor.ts");
const owner = "AAAA-0000-0001";
const sale = (id, extra = {}) => ({ id, owned: true, status: "sold", sale: { buyerName: "Natasha", proceedsCoins: 28, claimedAt: null }, ...extra });
const anchor = (place, x = 200, y = 250) => ({ place, objectId: place, x, y, pointerOffset: 0 });

test("only real owner receipts awaiting collection produce a market notice", () => {
  const market = { ownerPublicId: owner, listings: [sale("public")], mine: [sale("ready"), sale("paid", { sale: { claimedAt: "2026-10-19T10:00:00Z" } }),
    sale("foreign", { owned: false }), sale("active", { status: "active" }), sale("cancelled", { status: "cancelled" }), sale("legacy", { sale: null })] };
  const before = structuredClone(market);
  assert.deepEqual(pendingMarketSales(owner, market).map(entry => entry.id), ["ready"]);
  assert.deepEqual(pendingMarketSales("ANOTHER", market), []);
  assert.deepEqual(pendingMarketSales("", market), []);
  assert.deepEqual(pendingMarketSales(owner, null), []);
  market.mine[0].sale.claimedAt = "2026-10-19T10:01:00Z";
  assert.deepEqual(pendingMarketSales(owner, market), [], "the notice disappears from the confirmed collection result");
  market.mine[0].sale.claimedAt = null;
  assert.deepEqual(market, before, "presentation never moves currency or changes a receipt");
});

test("the compact sale notice is one real touch button with a count and opens my stall", async () => {
  const calls = [], component = WorldMarketSaleStatus({ count: 3, anchor: anchor("market"), onOpen: () => calls.push("mine") });
  const html = renderToStaticMarkup(component);
  assert.equal(component.type, "button"); assert.equal(component.props.type, "button");
  assert.match(html, /Продано/); assert.match(html, /Проданные партии: 3/); assert.match(html, /Открыть мою лавку и забрать монеты/);
  assert.match(html, /data-market-sale-count="3"/); assert.match(html, /left:200px;top:250px/);
  component.props.onClick(); assert.deepEqual(calls, ["mine"]);
  for (const props of [{ count: 0 }, { count: -1 }, { count: NaN }, { count: 0.5 }, { hidden: true }, { anchor: null }]) {
    assert.equal(WorldMarketSaleStatus({ count: 1, anchor: anchor("market"), onOpen() {}, ...props }), null);
  }
  const single = renderToStaticMarkup(WorldMarketSaleStatus({ count: 1, anchor: anchor("market"), onOpen() {} }));
  assert.equal((single.match(/<button/g) ?? []).length, 1);
  const css = await readFile(`${root}features/world/ui/hud/world-market-sale-status.module.css`, "utf8");
  assert.match(css, /width: 98px; height: 44px; min-height: 44px/);
  assert.match(css, /pointer-events: auto/); assert.match(css, /focus-visible/);
  assert.doesNotMatch(css, /animation:|backdrop-filter|filter:/, "sale reminders do not add perpetual GPU work");
});

test("sale notices follow the existing Tiled roof projection, culling and construction footprint", () => {
  assert.equal(marketSaleMarkerAnchor([anchor("house")]), null);
  const initial = anchor("market");
  assert.deepEqual(marketSaleMarkerAnchor([initial]), initial);
  assert.equal(marketSaleMarkerAnchor([initial], [anchor("house", 205, 252)]), null);
  assert.deepEqual(marketSaleMarkerAnchor([initial], [anchor("house", 205, 310)]), initial);
  const object = { id: "market", place: "market", hitArea: [{ x: 100, y: 200 }, { x: 220, y: 280 }] };
  const view = { width: 320, height: 600 }, camera = { x: 160, y: 240, zoom: 1 };
  const first = projectConstructionAnchor(object, camera, view, { top: 100, bottom: 90 });
  const moved = projectConstructionAnchor(object, { ...camera, x: 180, zoom: 1.2 }, view, { top: 100, bottom: 90 });
  assert.notDeepEqual(first, moved); assert.equal(first.place, "market");
  assert.equal(projectConstructionAnchor(object, { ...camera, x: 900 }, view), null);
});

function withEnvironment(run) {
  const previous = Object.fromEntries(["document", "window", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const doc = new EventTarget(), win = new EventTarget(), timers = new Map(), navigator = { onLine: true };
  doc.hidden = false;
  let sequence = 0;
  win.setInterval = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; };
  win.clearInterval = id => timers.delete(id);
  for (const [key, value] of Object.entries({ document: doc, window: win, navigator })) Object.defineProperty(globalThis, key, { configurable: true, value });
  try { run({ doc, win, timers, navigator }); }
  finally { for (const [key, descriptor] of Object.entries(previous)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
}

test("background sale checks use a 30-second cadence, wait while offline or hidden and fully dispose", () => {
  withEnvironment(({ doc, win, timers, navigator }) => {
    let reads = 0;
    const stop = watchWorldMarketSales(async () => { reads++; });
    assert.equal(reads, 1); assert.equal(timers.size, 1);
    const timer = [...timers.values()][0];
    assert.equal(timer.delay, 30_000); assert.equal(WORLD_MARKET_POLL_MS, 30_000);
    timer.callback(); assert.equal(reads, 2);
    doc.hidden = true; timer.callback(); doc.dispatchEvent(new Event("visibilitychange")); win.dispatchEvent(new Event("online"));
    assert.equal(reads, 2);
    doc.hidden = false; navigator.onLine = false; timer.callback(); doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(reads, 2);
    navigator.onLine = true; win.dispatchEvent(new Event("online")); assert.equal(reads, 3);
    doc.dispatchEvent(new Event("visibilitychange")); assert.equal(reads, 4);
    stop(); assert.equal(timers.size, 0);
    timer.callback(); doc.dispatchEvent(new Event("visibilitychange")); win.dispatchEvent(new Event("online")); assert.equal(reads, 4);
  });
});

test("hidden or offline initial worlds do not start a request, and switching owners disposes the old watcher", () => {
  withEnvironment(({ doc, win, navigator }) => {
    let first = 0, second = 0;
    doc.hidden = true;
    const stop = watchWorldMarketSales(async () => { first++; });
    assert.equal(first, 0);
    doc.hidden = false; navigator.onLine = false; doc.dispatchEvent(new Event("visibilitychange")); assert.equal(first, 0);
    stop(); navigator.onLine = true;
    const stopNext = watchWorldMarketSales(async () => { second++; });
    win.dispatchEvent(new Event("online"));
    assert.equal(first, 0); assert.equal(second, 2);
    stopNext();
  });
});

test("the world wires sales only to own map feedback and camera movement stays in its small subscription", async () => {
  const scene = await readFile(`${root}features/world/scene/world-scene.tsx`, "utf8");
  const world = await readFile(`${root}features/world/world-view.tsx`, "utf8");
  const hook = await readFile(`${root}features/world/state/use-world-market-sales.ts`, "utf8");
  assert.match(world, /useWorldMarketSales\(economy, ownerPublicId, open && !suspended && !marketOpen\)/);
  assert.match(world, /marketSales=\{marketSales\} onOpenMarket=\{\(\) => \{ clearObject\(\); setQuickMenu\(null\); openEconomy\("market"\); \}\}/);
  assert.match(hook, /snapshotConfirmed && economy\.snapshot\?\.ownerPublicId === owner/);
  assert.match(hook, /\[active, confirmed, owner, refresh\]/);
  assert.match(scene, /salesActive = !readOnly && marketSales > 0/);
  assert.match(scene, /marketSales=\{readOnly \? 0 : marketSales\} onOpenMarket=\{readOnly \? undefined : onOpenMarket\}/);
  assert.match(scene, /tracker\.enabled = constructionActive \|\| productionActive \|\| salesActive/);
  assert.match(scene, /function MapFeedback[\s\S]*useSyncExternalStore\(anchorStore\.subscribe/);
  assert.match(scene, /reserved=\{productionReserved\}/);
});
