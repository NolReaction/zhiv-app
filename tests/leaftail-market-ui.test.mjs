import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), cacheDir = await mkdtemp(join(tmpdir(), "leaftail-market-ui-"));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { leaftailShopView } = await vite.ssrLoadModule("/features/economy/domain/leaftail-shop.ts");
const { fishingClassOdds } = await vite.ssrLoadModule("/features/economy/domain/fishing.ts");
const { FishingCatchOdds } = await vite.ssrLoadModule("/features/economy/ui/fishing/fishing-catch-odds.tsx");
const { WorldLeaftailMarket, leaftailPurchaseQuote, leaftailPurchaseReason, leaftailPurchaseLimit } = await vite.ssrLoadModule("/features/economy/ui/market/world-leaftail-market.tsx");
const hooksId = "virtual:leaftail-market-hooks";
const runtime = await createServer({ appType: "custom", configFile: false, root, cacheDir: `${cacheDir}/hooks`, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "leaftail-market-hooks", enforce: "pre", resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useState(initial) { const slot = useRef(initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useId() { return useRef('leaftail-ui').current; }
      export function useEffect() {}
      export function useLayoutEffect(effect) { effect(); }
    `; }, transform(source, id) { if (id.endsWith("/features/economy/ui/market/world-leaftail-market.tsx")) return source.replace('from "react";', `from "${hooksId}";`); } }] });
const hooks = await runtime.ssrLoadModule(hooksId), { WorldLeaftailMarket: Market } = await runtime.ssrLoadModule("/features/economy/ui/market/world-leaftail-market.tsx");
after(async () => { await Promise.all([runtime.close(), vite.close()]); await rm(cacheDir, { recursive: true, force: true }); });
const now = Date.parse("2026-10-19T12:00:00Z"), owner = "AAAA-0000-0001";
function snapshot() {
  return { ownerPublicId: owner, revision: 7, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
    wallet: { coins: 1_000_000, pearls: 10_000 }, inventory: {}, buildings: { home: 5, warehouse: 1 }, jobs: [], completedExplorations: 0,
    fishing: economyFishingSchema.parse({}), wardrobe: [], storage: { capacity: 500, used: 0, available: 500, reserved: 0, overflow: 0 } };
}
function controller(state = snapshot()) { return { snapshot: state, snapshotConfirmed: true, now, busy: false, uncertain: false, retryAt: 0, directActionsAvailable: true, pendingProductionCount: 0 }; }
const view = state => leaftailShopView(state, now, state.catalog);
function harness(economy = controller()) {
  hooks.reset(); const calls = [];
  economy.act = (...args) => { calls.push(args); return true; };
  function render(patch = {}) {
    hooks.render(); const tree = Market({ economy, isOnline: true, introduced: true, ...patch }), nodes = [];
    const visit = element => { if (React.isValidElement(element)) { nodes.push(element); React.Children.forEach(element.props.children, visit); } };
    visit(tree); return { tree, nodes, html: () => renderToStaticMarkup(tree) };
  }
  const switchTo = label => render().nodes.find(node => node.props.role === "tab" && React.Children.toArray(node.props.children).includes(label)).props.onClick();
  const buy = itemId => render().nodes.find(node => node.props["data-leaftail-purchase"] === itemId);
  const confirm = () => render().nodes.find(node => node.type === "button" && node.props.children?.[0] === "Подтвердить");
  return { economy, calls, render, switchTo, buy, confirm };
}

test("quotes bind selected units, actual item quantities, currency and exact price to one accepted owner/revision/delivery", () => {
  const state = snapshot(), economy = controller(state), offer = view(state).offers.find(offer => offer.section === "supplies");
  const quote = leaftailPurchaseQuote(state, offer, 3);
  assert.equal(quote.quantity, 3); assert.equal(quote.itemQuantity, offer.quantity * 3); assert.equal(quote.price, offer.unitPrice * 3);
  assert.equal(leaftailPurchaseReason(economy, quote, true), null);
  for (const patch of [{ currency: "pearls" }, { unitPrice: offer.unitPrice + 1 }, { price: quote.price + 1 }, { itemQuantity: quote.itemQuantity + 1 },
    { quantity: 0 }, { quantity: -1 }, { quantity: .5 }, { quantity: 21 }, { quantity: NaN }, { targetId: quote.targetId.replace("v2:", "") }, { kind: "rod" }])
    assert.match(leaftailPurchaseReason(economy, { ...quote, ...patch }, true), /Поставка изменилась/);
  assert.match(leaftailPurchaseReason(economy, quote, false), /соединение/);
  assert.match(leaftailPurchaseReason({ ...economy, snapshotConfirmed: false }, quote, true), /подтверждения/);
  assert.match(leaftailPurchaseReason({ ...economy, busy: true }, quote, true), /подтверждения/);
  assert.match(leaftailPurchaseReason({ ...economy, now: now + 86_400_000 }, quote, true), /Поставка изменилась/);
  for (const patch of [{ ownerPublicId: "OTHER" }, { revision: 8 }]) assert.match(leaftailPurchaseReason({ ...economy, snapshot: { ...state, ...patch } }, quote, true), /обновились/);
});

test("a purchase selection respects stock, storage, wallet, twenty-unit cap and permanent ownership", () => {
  const state = snapshot(), offer = view(state).offers.find(offer => offer.section === "supplies"), quote = leaftailPurchaseQuote(state, offer, 3);
  assert.equal(leaftailPurchaseLimit(state, offer), Math.min(20, offer.remaining));
  state.storage.available = 2 * offer.quantity;
  assert.equal(leaftailPurchaseLimit(state, offer), 2);
  assert.match(leaftailPurchaseReason(controller(state), quote, true), /Не хватает места/);
  state.storage.available = 500; state.wallet.coins = 2 * offer.unitPrice;
  assert.equal(leaftailPurchaseLimit(state, offer), 2);
  assert.match(leaftailPurchaseReason(controller(state), quote, true), /Не хватает.*монет/);
  state.wallet.coins = 1_000_000;
  state.leaftailShop = { cycle: view(state).cycle, purchased: { [offer.id]: offer.stock - 2 } };
  assert.match(leaftailPurchaseReason(controller(state), quote, true), /Осталось только 2/);
  const permanent = view(state).offers.find(offer => offer.kind === "wardrobe" || offer.kind === "rod" || offer.kind === "hook");
  state.storage.available = 0;
  const permanentQuote = leaftailPurchaseQuote(state, permanent);
  assert.equal(leaftailPurchaseReason(controller(state), permanentQuote, true), null);
  assert.equal(leaftailPurchaseLimit(state, permanent), 1);
  assert.match(leaftailPurchaseReason(controller(state), leaftailPurchaseQuote(state, permanent, 2), true), /Поставка изменилась/);
  if (permanent.kind === "wardrobe") state.wardrobe.push(permanent.itemId);
  else if (permanent.kind === "rod") state.fishing.ownedRods.push(permanent.itemId);
  else state.fishing.ownedHooks.push(permanent.itemId);
  assert.match(leaftailPurchaseReason(controller(state), permanentQuote, true), /Уже есть/);
});

test("relic cards, confirmations and receipts price the pearl wallet with visible amounts", () => {
  const h = harness(), offer = view(h.economy.snapshot).offers.find(offer => offer.section === "finds");
  assert.equal(offer.currency, "pearls"); assert.equal(offer.unitPrice, 300);
  h.switchTo("Реликвии");
  let current = h.render(); assert.match(current.html(), /Цена: 150 жемчужин/); assert.match(current.html(), /data-leaftail-currency="pearls"/);
  h.buy(offer.itemId).props.onClick(); current = h.render();
  assert.match(current.html(), /за <strong>150 жемчужин/); assert.match(current.html(), /Жемчуг: 5\s000 → 4\s850/);
  const quote = leaftailPurchaseQuote(h.economy.snapshot, offer);
  h.economy.snapshot.wallet.pearls = 299; h.economy.snapshot.wallet.coins = 1_000_000;
  assert.match(leaftailPurchaseReason(h.economy, quote, true), /Не хватает 0,5 жемчужин/);
  h.confirm().props.onClick(); assert.deepEqual(h.calls, []);
  h.economy.snapshot.wallet.pearls = 300; h.confirm().props.onClick();
  assert.deepEqual(h.calls, [["buy_leaftail_item", offer.targetId, 1, 300]]);
  const receipt = { id: "actual-ack", ownerPublicId: owner, revision: 8, coins: 0, pearls: 300, currency: "pearls", quantity: 1,
    kind: "item", destination: "pantry", items: [{ itemId: offer.itemId, name: "Реликвия из подтверждения", quantity: 1 }] };
  const html = renderToStaticMarkup(React.createElement(WorldLeaftailMarket, { economy: { ...controller(), notice: "Покупка у Листохвоста отправлена в кладовую", localLeaftailPurchase: receipt }, introduced: true, isOnline: true }));
  assert.match(html, /Потрачено 150 жемчужин/); assert.doesNotMatch(html, /Потрачено 300|Потрачено 0 монет/);
});

test("supply stepper confirms a chosen quantity exactly once with its exact total", () => {
  const h = harness(), offer = view(h.economy.snapshot).offers.find(offer => offer.section === "supplies");
  h.switchTo("Припасы");
  for (let count = 0; count < 3; count++) {
    const name = h.economy.snapshot.catalog.items.find(item => item.id === offer.itemId).name;
    const plus = h.render().nodes.find(node => node.type === "button" && node.props["aria-label"] === `Увеличить количество: ${name}`);
    assert.equal(plus.props.disabled, false); plus.props.onClick();
  }
  assert.match(h.buy(offer.itemId).props["aria-label"], new RegExp(`4 шт\\. за ${4 * offer.unitPrice} монет`));
  h.buy(offer.itemId).props.onClick();
  const button = h.confirm(); assert.equal(button.props.disabled, false); button.props.onClick(); button.props.onClick();
  assert.deepEqual(h.calls, [["buy_leaftail_item", offer.targetId, 4, 4 * offer.unitPrice]]);
});

test("retained purchase and confirmation handlers cannot act after owner/revision/offline/arrival/cycle changes", () => {
  for (const change of [h => { h.economy.snapshot = { ...h.economy.snapshot, ownerPublicId: "OTHER" }; },
    h => { h.economy.snapshot = { ...h.economy.snapshot, revision: 8 }; }, h => { h.economy.now += 86_400_000; },
    h => { h.economy.busy = true; }, h => { h.economy.uncertain = true; }, h => { h.economy.snapshotConfirmed = false; }]) {
    const h = harness(), offer = view(h.economy.snapshot).offers.find(offer => offer.section === "supplies");
    h.switchTo("Припасы"); const purchase = h.buy(offer.itemId); purchase.props.onClick(); const confirm = h.confirm();
    change(h); h.render(); purchase.props.onClick(); confirm.props.onClick(); assert.deepEqual(h.calls, []);
  }
  for (const patch of [{ isOnline: false }, { introduced: false }]) {
    const h = harness(), offer = view(h.economy.snapshot).offers.find(offer => offer.section === "supplies");
    h.switchTo("Припасы"); const purchase = h.buy(offer.itemId); purchase.props.onClick(); const confirm = h.confirm();
    h.render(patch); purchase.props.onClick(); confirm.props.onClick(); assert.deepEqual(h.calls, []);
  }
});

test("four keyboard-accessible departments expose only this delivery and a real empty state", () => {
  const h = harness(), initial = h.render();
  assert.equal(initial.nodes.filter(node => node.props.role === "tab").length, 4);
  assert.match(initial.html(), /Ваш кошелёк/); assert.match(initial.html(), /Жемчуг/);
  const first = initial.nodes.find(node => node.props.role === "tab" && node.props["aria-selected"]);
  let prevented = false; first.props.onKeyDown({ key: "ArrowRight", preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.match(h.render().html(), /data-leaftail-section="tackle"/);
  const real = view(h.economy.snapshot).offers.filter(offer => offer.section === "tackle");
  assert.equal(h.render().nodes.filter(node => node.props["data-leaftail-item"]).length, real.length);
  // An old API response can validly contain no clothing; never invent stock from the global wardrobe.
  h.economy.snapshot.catalog.leaftailShop.travelOffers = [];
  h.switchTo("Одежда"); assert.match(h.render().html(), /data-leaftail-empty/);
});

test("Leaf-tail tackle keeps its named class visible on cards and purchase confirmation", () => {
  const h = harness(); h.switchTo("Снасти");
  const rendered = h.render(), offers = view(h.economy.snapshot).offers.filter(offer => offer.section === "tackle");
  assert.ok(offers.some(offer => offer.kind === "rod"));
  for (const offer of offers) {
    const gear = offer.kind === "rod" ? h.economy.snapshot.catalog.fishing.rods.find(item => item.id === offer.itemId)
      : offer.kind === "hook" ? h.economy.snapshot.catalog.fishing.hooks.find(item => item.id === offer.itemId)
        : h.economy.snapshot.catalog.fishing.baits.find(item => item.itemId === offer.itemId);
    const card = rendered.nodes.find(node => node.props["data-leaftail-item"] === offer.itemId);
    assert.match(renderToStaticMarkup(card), new RegExp(`data-fish-rarity="${gear.rarity}"`), `${offer.itemId} shows its catalog class without hover`);
  }
  const rod = offers.find(offer => offer.kind === "rod");
  h.buy(rod.itemId).props.onClick();
  const rarity = h.economy.snapshot.catalog.fishing.rods.find(item => item.id === rod.itemId).rarity;
  assert.match(h.render().html(), new RegExp(`data-fish-rarity="${rarity}"`));
});

test("Leaf-tail rods, hooks and bait compare all class chances with the other equipped gear on cards and confirmation", () => {
  const state = snapshot();
  state.fishing = economyFishingSchema.parse({ ownedRods: ["reed_rod", "starfall_rod"], equippedRodId: "starfall_rod",
    ownedHooks: ["bare_hook", "silver_hook"], equippedHookId: "silver_hook", equippedBaitId: "glow_bait" });
  state.inventory.glow_bait = 3;
  const before = structuredClone(state), offers = view(state).offers.filter(offer => offer.section === "tackle");
  assert.deepEqual(new Set(offers.map(offer => offer.kind)), new Set(["rod", "hook", "bait"]));
  const percent = value => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(value * 100)}%`;
  const displayedOdds = html => new Map([...html.matchAll(/data-catch-probability="([^"]+)"[^>]*>([^<]+)<\/strong>/g)].map(match => [match[1], match[2]]));
  for (const offer of offers) {
    const h = harness(controller(state)); h.switchTo("Снасти");
    const override = offer.kind === "rod" ? { rodId: offer.itemId } : offer.kind === "hook" ? { hookId: offer.itemId } : { baitId: offer.itemId };
    const expected = new Map(fishingClassOdds(state, state.catalog.fishing, override).map(odd => [odd.itemId, percent(odd.probability)]));
    if (offer.kind === "rod") assert.notDeepEqual(expected,
      new Map(fishingClassOdds(state, state.catalog.fishing, { ...override, hookId: "bare_hook", baitId: null }).map(odd => [odd.itemId, percent(odd.probability)])),
      "The saved hook and bait materially affect the displayed rod preview");
    const card = h.render().nodes.find(node => node.props["data-leaftail-item"] === offer.itemId), cardHtml = renderToStaticMarkup(card);
    assert.deepEqual(displayedOdds(cardHtml), expected, `${offer.kind} card uses the actual single-item replacement`);
    assert.match(cardHtml, /Сейчас → с этой снастью/);
    assert.match(cardHtml, /data-odds-loadout/);
    const rodId = override.rodId ?? state.fishing.equippedRodId, hookId = override.hookId ?? state.fishing.equippedHookId, baitId = override.baitId ?? state.fishing.equippedBaitId;
    for (const name of [state.catalog.fishing.rods.find(item => item.id === rodId).name,
      state.catalog.fishing.hooks.find(item => item.id === hookId).name, state.catalog.items.find(item => item.id === baitId).name])
      assert.ok(cardHtml.includes(name), `${offer.kind} names every item used for the preview`);
    assert.match(cardHtml, /data-fishing-species-odds/);
    h.buy(offer.itemId).props.onClick();
    assert.deepEqual(displayedOdds(h.render().html()), expected, `${offer.kind} confirmation retains the same odds`);
  }
  assert.deepEqual(state, before, "Reading cards and confirming a selection do not equip or consume tackle");
});

test("rod previews disclose bait removed by the equip rule and bait previews explain an unavailable class", () => {
  const state = snapshot();
  state.fishing = economyFishingSchema.parse({ ownedRods: ["reed_rod", "starfall_rod"], equippedRodId: "starfall_rod",
    ownedHooks: ["bare_hook", "silver_hook"], equippedHookId: "silver_hook", equippedBaitId: "star_bait" });
  const before = structuredClone(state), catalog = state.catalog.fishing;
  const rodHtml = renderToStaticMarkup(React.createElement(FishingCatchOdds, { state, catalog, override: { rodId: "reed_rod" }, preview: true, showLoadout: true }));
  assert.match(rodHtml, /data-odds-loadout[^>]*>Для расчёта: Камышовая удочка · Серебряный крючок · без наживки\./);
  assert.match(rodHtml, /data-odds-bait-removed[^>]*>.*не подходит к этой удочке и будет снята при её выборе/);
  assert.deepEqual(state, before, "Previewing a rod never changes equipped gear");
  state.fishing.equippedRodId = "reed_rod"; state.fishing.equippedBaitId = null;
  const beforeBait = structuredClone(state);
  const baitHtml = renderToStaticMarkup(React.createElement(FishingCatchOdds, { state, catalog, override: { baitId: "firefly_bait" },
    targetRarity: "epic", preview: true, showLoadout: true }));
  assert.match(baitHtml, /Выбранная удочка пока не ловит этот класс рыбы/);
  assert.match(baitHtml, /data-fishing-target="fish_epic"/);
  assert.deepEqual(state, beforeBait, "Previewing an incompatible bait never changes equipped gear");
});
