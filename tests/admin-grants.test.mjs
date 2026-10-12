import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { makeEconomyGrant, grantBasketIssue } = await vite.ssrLoadModule("/features/admin/admin-grants-model.ts");
const { readGrantAttempt, saveGrantAttempt, pendingGrantTargets, entriesFromGrant } = await vite.ssrLoadModule("/features/admin/admin-grants-journal.ts");
const { grantAdminEconomy } = await vite.ssrLoadModule("/features/admin/admin-grants-api.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const actor = "7K3P-2Q9M-W8ZR", target = "7K3P-2Q9M-W8ZS", another = "7K3P-2Q9M-W8ZT";
const requestId = "9a272b65-8ada-4b0d-aad8-6a6ef845f41b";
const entry = (kind, id, amount) => ({ kind, id, amount, name: id });
const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });

test("basket sends visible currency units with every selected kind in one request", () => {
  const basket = [entry("coins", "coins", 500), entry("pearls", "pearls", 10), entry("item", "wood", 5),
    entry("building", "home", 2), entry("slots", "workshop", 2), entry("rod", "reed_rod", 1), entry("hook", "bare_hook", 1)];
  const request = makeEconomyGrant(basket, requestId, target, "  Награда за тестирование  ");
  assert.deepEqual(request, { requestId, confirmationPublicId: target, reason: "Награда за тестирование", coins: 500, pearls: 10,
    items: { wood: 5 }, buildings: { home: 2 }, productionSlots: { workshop: 2 }, rods: ["reed_rod"], hooks: ["bare_hook"] });
  assert.deepEqual(makeEconomyGrant(entriesFromGrant(request), requestId, target, request.reason), request);
});

test("preflight accounts for market reservation and a warehouse upgrade in the same package", () => {
  const state = { buildings: { home: 1, warehouse: 1 }, jobs: [], storage: { used: 285, reserved: 10, capacity: 300 } };
  assert.match(grantBasketIssue([entry("item", "wood", 10)], state, economyCatalog), /Не хватает места/);
  assert.equal(grantBasketIssue([entry("item", "wood", 10), entry("building", "warehouse", 2)], state, economyCatalog), null);
  assert.match(grantBasketIssue([entry("item", "wood", 8000), entry("item", "stone", 8000)], state, economyCatalog), /10 000/);
  assert.match(grantBasketIssue([entry("coins", "coins", 0.5)], state, economyCatalog), /целое/);
});

test("preflight catches active construction, missing home requirements and insufficient production prerequisites", () => {
  const state = { buildings: { home: 1, warehouse: 1 }, jobs: [{ kind: "construction", targetId: "home" }], storage: { used: 0, reserved: 0, capacity: 300 } };
  assert.match(grantBasketIssue([entry("building", "home", 2)], state, economyCatalog), /сейчас строится/);
  assert.match(grantBasketIssue([entry("building", "workshop", 2)], state, economyCatalog), /дом уровня 2/);
  assert.match(grantBasketIssue([entry("slots", "workshop", 2)], state, economyCatalog), /построенная станция/);
});

test("uncertain journal survives reload and cannot be restored for another actor or recipient", () => {
  const data = new Map();
  globalThis.window = { sessionStorage: { get length() { return data.size; }, key: index => [...data.keys()][index],
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } };
  const request = makeEconomyGrant([entry("coins", "coins", 500)], requestId, target, "Компенсация за ошибку");
  assert.equal(saveGrantAttempt(actor, target, request), true);
  assert.deepEqual(readGrantAttempt(actor, target), request);
  assert.deepEqual(pendingGrantTargets(actor), [target]);
  assert.equal(readGrantAttempt(another, target), null);
  assert.equal(readGrantAttempt(actor, another), null);
  const storedKey = [...data.keys()][0];
  data.set(storedKey, JSON.stringify({ ...request, confirmationPublicId: another }));
  assert.equal(readGrantAttempt(actor, target), null);
  data.set(storedKey, "broken json"); assert.equal(readGrantAttempt(actor, target), null);
  saveGrantAttempt(actor, target, null); assert.deepEqual(pendingGrantTargets(actor), []);
});

test("lost response and rate limit retry send the identical request; wrong recipient receipt is rejected", async () => {
  const request = makeEconomyGrant([entry("pearls", "pearls", 10)], requestId, target, "Компенсация за ошибку");
  const sent = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `/api/v1/admin/users/${target}/grant-economy`);
    assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) throw new TypeError("Response lost after commit");
    if (sent.length === 2) return Response.json({ code: "RATE_LIMITED", message: "Повторите позже" }, { status: 429 });
    return Response.json({ requestId, publicId: target, changed: true, acceptedRevision: 5, createdAt: "2026-10-12T12:00:00Z" });
  };
  await assert.rejects(grantAdminEconomy(target, request));
  await assert.rejects(grantAdminEconomy(target, request), error => error.status === 429);
  assert.equal((await grantAdminEconomy(target, request)).acceptedRevision, 5);
  assert.deepEqual(sent, [request, request, request]);
  globalThis.fetch = async () => Response.json({ requestId, publicId: another, changed: true, acceptedRevision: 5, createdAt: "2026-10-12T12:00:00Z" });
  await assert.rejects(grantAdminEconomy(target, request), error => error.status === 502);
});
