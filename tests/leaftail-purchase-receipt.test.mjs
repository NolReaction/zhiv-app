import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { localLeaftailPurchaseFromReceipt } = await vite.ssrLoadModule("/features/economy/domain/local-leaftail-purchase.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { WorldLeaftailMarket } = await vite.ssrLoadModule("/features/economy/ui/market/world-leaftail-market.tsx");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", now = Date.parse("2026-10-18T12:00:00Z");
const cycle = Math.floor(now / 86400000), message = "Покупка у Листохвоста отправлена в кладовую";
function state(revision = 0, bought = false) {
  return { ownerPublicId: owner, revision, serverTime: new Date(now).toISOString(), wallet: { coins: bought ? 9200 : 10000, pearls: 10 },
    inventory: { stone: bought ? 14 : 4 }, buildings: { home: 3, warehouse: 1 },
    storage: { capacity: 50, used: bought ? 14 : 4, available: bought ? 36 : 46, reserved: 0, overflow: 0 },
    jobs: [], completedExplorations: 0, catalog: structuredClone(economyCatalog),
    leaftailShop: { cycle, purchased: bought ? { stone_bundle: 1 } : {} } };
}
const command = () => ({ requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0,
  action: "buy_leaftail_item", targetId: `${cycle}:stone_bundle`, quantity: 1, totalPrice: 800 });
const result = (snapshot = state(1, true)) => ({ state: snapshot, acceptedRevision: 1, message, replayed: false });
const flush = () => new Promise(resolve => setImmediate(resolve));
const transport = overrides => ({ get: async () => state(), send: async () => result(),
  market: async () => ({ ownerPublicId: owner, listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() }),
  trade: async () => result(), ...overrides });
function storage() { const data = new Map(); return { getItem: key => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }

test("a receipt freezes accepted item names, actual bundle delta and wallet debit independently of later offers", () => {
  const before = state(), after = state(1, true), sent = command();
  // Even a changed response catalog cannot substitute its new quote for the paid amount.
  after.catalog.leaftailShop.offers.find(item => item.id === "stone_bundle").priceCoins = 12345;
  const receipt = localLeaftailPurchaseFromReceipt(before, result(after), sent);
  assert.deepEqual(receipt, { id: sent.requestId, ownerPublicId: owner, revision: 1, coins: 800,
    items: [{ itemId: "stone", name: after.catalog.items.find(item => item.id === "stone").name, quantity: 10 }] });
  const name = receipt.items[0].name;
  after.catalog.items.find(item => item.id === "stone").name = "Новая цена и название";
  after.inventory.stone = 500;
  assert.equal(receipt.items[0].name, name); assert.equal(receipt.items[0].quantity, 10); assert.equal(receipt.coins, 800);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.items) && Object.isFrozen(receipt.items[0]));
});

test("foreign, nonadjacent, unpaid, unrelated and unconsumed stock cannot create an exact receipt", () => {
  const before = state(), sent = command();
  const cases = [
    [null, result(), sent],
    [before, result(), { ...sent, ownerPublicId: other }],
    [{ ...before, ownerPublicId: other }, result(), sent],
    [before, result({ ...state(1, true), ownerPublicId: other }), sent],
    [before, result(), { ...sent, action: "sell" }],
    [before, result(), { ...sent, expectedRevision: 1 }],
    [before, { ...result(), acceptedRevision: 2 }, sent],
    [before, result(state(2, true)), sent],
    [state(1, true), { ...result(), replayed: true }, sent],
    [before, result({ ...state(1, true), wallet: before.wallet }), sent],
    [before, result(), { ...sent, totalPrice: 1 }],
    [before, result({ ...state(1, true), inventory: before.inventory }), sent],
    [before, result({ ...state(1, true), leaftailShop: before.leaftailShop }), sent],
    [before, result(), { ...sent, targetId: `${cycle}:wood_bundle` }],
  ];
  for (const args of cases) assert.equal(localLeaftailPurchaseFromReceipt(...args), null);
});

test("an uncertain local purchase keeps its original proof across refresh and publishes one exact result on retry", async () => {
  let latest = state(); const sent = [];
  const session = createEconomySession(owner, transport({ get: async () => latest, send: async value => {
    sent.push(value); latest = state(1, true);
    if (sent.length === 1) throw Error("Committed response lost");
    return { ...result(latest), replayed: true };
  } }), () => assert.fail("owner changed"));
  const stop = session.activate(); await session.refresh();
  session.act("buy_leaftail_item", `${cycle}:stone_bundle`, 1, 800); await flush();
  assert.equal(session.getSnapshot().uncertain, true); assert.equal(session.getSnapshot().localLeaftailPurchase, undefined);
  await session.refresh(); assert.equal(session.getSnapshot().snapshot.revision, 1);
  assert.equal(session.getSnapshot().localLeaftailPurchase, undefined, "GET cannot manufacture a receipt");
  await session.retry();
  const receipt = session.getSnapshot().localLeaftailPurchase;
  assert.equal(receipt.id, sent[0].requestId); assert.equal(receipt.coins, 800); assert.equal(receipt.items[0].quantity, 10);
  assert.deepEqual(sent[0], sent[1]);
  await session.retry(); assert.equal(session.getSnapshot().localLeaftailPurchase, receipt); stop();
});

test("an exact older ACK retains its paid receipt even if a later GET already changed the stock and catalog", async () => {
  let latest = state(), attempt = 0;
  const accepted = result();
  const session = createEconomySession(owner, transport({ get: async () => latest, send: async () => {
    if (++attempt === 1) {
      latest = state(2, true); latest.wallet.coins = 100;
      latest.catalog.items.find(item => item.id === "stone").name = "Позднее название";
      throw Error("Response lost");
    }
    return { ...accepted, replayed: true };
  } }), () => assert.fail());
  const stop = session.activate(); await session.refresh(); session.act("buy_leaftail_item", `${cycle}:stone_bundle`, 1, 800); await flush();
  await session.refresh(); await session.retry();
  assert.equal(session.getSnapshot().snapshot.revision, 2);
  assert.equal(session.getSnapshot().localLeaftailPurchase.coins, 800);
  assert.notEqual(session.getSnapshot().localLeaftailPurchase.items[0].name, "Позднее название"); stop();
});

test("a restored request, denied purchase or a replay with a nonadjacent state has only generic feedback", async () => {
  const cache = storage(); let latest = state(), attempt = 0;
  const t = transport({ get: async () => latest, send: async () => {
    latest = state(1, true); if (++attempt === 1) throw Error("Lost response"); return { ...result(latest), replayed: true };
  } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh(); first.act("buy_leaftail_item", `${cycle}:stone_bundle`, 1, 800); await flush(); stop();
  const restored = createEconomySession(owner, t, () => assert.fail(), cache), close = restored.activate();
  await restored.refresh(); await restored.retry();
  assert.equal(restored.getSnapshot().notice, message); assert.equal(restored.getSnapshot().localLeaftailPurchase, undefined); close();
  for (const send of [async () => { throw new ApiError("Недостаточно монет", 409); }, async () => result(state(2, true))]) {
    const session = createEconomySession(owner, transport({ send }), () => assert.fail()), done = session.activate();
    await session.refresh(); session.act("buy_leaftail_item", `${cycle}:stone_bundle`, 1, 800); await flush();
    assert.equal(session.getSnapshot().localLeaftailPurchase, undefined); done();
  }
});

test("another purchase clears the previous receipt before sending and cannot reuse it as a success", async () => {
  let latest = state(), attempt = 0;
  const session = createEconomySession(owner, transport({ get: async () => latest, send: async () => {
    if (++attempt === 1) { latest = state(1, true); return result(latest); }
    return { ...result(latest), replayed: true };
  } }), () => assert.fail()), stop = session.activate();
  await session.refresh(); session.act("buy_leaftail_item", `${cycle}:stone_bundle`, 1, 800); await flush();
  assert.ok(session.getSnapshot().localLeaftailPurchase);
  session.act("buy_leaftail_item", `${cycle}:wood_bundle`, 1, 600);
  assert.equal(session.getSnapshot().localLeaftailPurchase, undefined);
  await flush(); assert.equal(session.getSnapshot().localLeaftailPurchase, undefined); stop();
});

test("the merchant renders frozen names, quantity and debit, with no exact success during errors, pending actions or account changes", () => {
  const receipt = localLeaftailPurchaseFromReceipt(state(), result(), command());
  const ready = { snapshot: state(2, true), snapshotConfirmed: true, now, retryAt: 0, busy: false, uncertain: false,
    directActionsAvailable: true, pendingProductionCount: 0, notice: message, localLeaftailPurchase: receipt };
  ready.snapshot.catalog.items.find(item => item.id === "stone").name = "Changed catalog name";
  const render = (patch = {}, introduced = true) => renderToStaticMarkup(React.createElement(WorldLeaftailMarket,
    { economy: { ...ready, ...patch }, isOnline: true, introduced }));
  const html = render();
  assert.match(html, /data-leaftail-receipt=/); assert.match(html, /В кладовую: Камень ×10\./); assert.match(html, /Потрачено 800 монет\./);
  assert.match(html, /role="status"/);
  for (const patch of [{ busy: true }, { uncertain: true }, { error: "Нет места" }, { notice: "Готово" },
    { snapshot: { ...ready.snapshot, ownerPublicId: other } }]) assert.doesNotMatch(render(patch), /В кладовую: Камень ×10|Потрачено 800/);
  assert.doesNotMatch(render({}, false), /data-leaftail-receipt|В кладовую: Камень ×10/);
  const fallback = render({ localLeaftailPurchase: undefined });
  assert.match(fallback, /Покупка отправлена в кладовую\./); assert.doesNotMatch(fallback, /Потрачено/);
});
