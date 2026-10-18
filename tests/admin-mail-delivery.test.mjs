import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const mail = await vite.ssrLoadModule("/features/admin/admin-mail-api.ts");
const adjust = await vite.ssrLoadModule("/features/admin/admin-adjustment-api.ts");
const delivery = { ...await vite.ssrLoadModule("/features/admin/admin-delivery-contract.ts"), ...await vite.ssrLoadModule("/features/admin/admin-delivery.tsx") };
const grants = await vite.ssrLoadModule("/features/admin/admin-grants-model.ts");
const grantJournal = await vite.ssrLoadModule("/features/admin/admin-grants-journal.ts");
const legacy = await vite.ssrLoadModule("/features/admin/admin-legacy-delivery-journal.ts");
const { adminActionDetails } = await vite.ssrLoadModule("/features/admin/admin-audit-details.ts");
const { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
const actor = "7K3P-2Q9M-W8ZR", target = "7K3P-2Q9M-W8ZS", other = "7K3P-2Q9M-W8ZT";
const requestId = "00000000-0000-4000-8000-000000000001", serverTime = "2026-10-18T12:00:00Z";
const message = { title: "Спасибо за помощь", body: "Награда начислена.\nПриятной игры!" };
const broadcast = () => ({ requestId, reason: "Внутреннее описание случая", title: message.title, body: message.body, audience: "players", publicIds: [target], notify: false, confirmation: "ОТПРАВИТЬ" });
const correction = () => ({ requestId, confirmationPublicId: target, reason: "Исправление двойного списания", expectedRevision: 42, coinsDelta: -10, pearlsDelta: 3, delivery: "notify", playerMessage: message });
function storage() {
  const data = new Map(); globalThis.window = { sessionStorage: { get length() { return data.size; }, key: index => [...data.keys()][index],
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } }; return data;
}
const signal = () => new AbortController().signal;

test("whole signed adjustments preserve half pearls and reject fractions, overflow, empty or negative results", () => {
  assert.deepEqual(adjust.adjustmentPreview({ coins: 100, pearls: 7 }, "-10", "+3"), { coinsDelta: -10, pearlsDelta: 3, coins: 90, pearls: 13, issue: null });
  for (const values of [["1.5", "0"], ["1e3", "0"], ["", "0"], ["0", "0"], ["-101", "0"], ["0", "-4"], ["1000000001", "0"]])
    assert.ok(adjust.adjustmentPreview({ coins: 100, pearls: 7 }, ...values).issue, values.join("/"));
  assert.ok(adjust.adjustmentPreview({ coins: ECONOMY_MAX_BALANCE, pearls: ECONOMY_MAX_PEARLS }, "1", "0").issue);
  assert.ok(adjust.adjustmentPreview({ coins: ECONOMY_MAX_BALANCE, pearls: ECONOMY_MAX_PEARLS }, "0", "1").issue);
});

test("grant, adjustment, broadcast and legacy journals keep the exact recipient, delivery and player text across reload", () => {
  const data = storage();
  const grant = grants.makeEconomyGrant([{ kind: "coins", id: "coins", amount: 100, name: "Монеты" }], requestId, target, "Internal reason stays internal", { delivery: "notify", playerMessage: message });
  assert.equal(grantJournal.saveGrantAttempt(actor, target, grant), true);
  assert.deepEqual(grantJournal.readGrantAttempt(actor, target), grant);
  assert.equal(grantJournal.readGrantAttempt(other, target), null);
  assert.equal(grant.playerMessage.body, message.body); assert.ok(!grant.playerMessage.body.includes(grant.reason));
  const request = correction(); assert.equal(adjust.saveAdjustmentAttempt(actor, target, request), true);
  assert.deepEqual(adjust.readAdjustmentAttempt(actor, target), request); assert.deepEqual(adjust.pendingAdjustmentTargets(actor), [target]);
  assert.equal(adjust.readAdjustmentAttempt(actor, other), null);
  assert.equal(mail.saveBroadcastAttempt(actor, broadcast()), true); assert.deepEqual(mail.readBroadcastAttempt(actor), broadcast());
  assert.equal(mail.readBroadcastAttempt(other), null);
  const world = { requestId, confirmationPublicId: target, reason: "Помощь в тестировании", action: "grant_world_item", target: "moss", delivery: "notify", playerMessage: message };
  legacy.saveLegacyManageAttempt(actor, target, world); assert.deepEqual(legacy.readLegacyManageAttempt(actor, target), world);
  const reward = { requestId, confirmationPublicId: target, reason: "Помощь в тестировании", kind: "item", rewardId: "leaf_garland", delivery: "notify", playerMessage: message };
  legacy.saveLegacyRewardAttempt(actor, target, reward); assert.deepEqual(legacy.readLegacyRewardAttempt(actor, target), reward);
  data.set("unrelated-app-key", "keep");
  grantJournal.saveGrantAttempt(actor, target, null); adjust.saveAdjustmentAttempt(actor, target, null); mail.saveBroadcastAttempt(actor, null);
  legacy.saveLegacyManageAttempt(actor, target, null); legacy.saveLegacyRewardAttempt(actor, target, null);
  assert.equal(data.size, 1); assert.equal(data.get("unrelated-app-key"), "keep");
});

test("actor journals remain isolated so authentication loss cannot erase an uncertain operation", () => {
  const data = storage(); const otherRequest = { ...broadcast(), title: "Другой администратор" };
  mail.saveBroadcastAttempt(actor, broadcast()); mail.saveBroadcastAttempt(other, otherRequest);
  assert.deepEqual(mail.readBroadcastAttempt(actor), broadcast()); assert.deepEqual(mail.readBroadcastAttempt(other), otherRequest); assert.equal(data.size, 2);
  globalThis.window.sessionStorage.setItem = () => { throw new Error("Quota exceeded"); };
  assert.equal(mail.saveBroadcastAttempt(actor, broadcast()), false);
});

test("delivery and broadcast history accept the server's Unicode code-point boundaries", async () => {
  const value = { title: "😀".repeat(120), body: "😀".repeat(2000) };
  assert.equal(delivery.playerMessageSchema.safeParse(value).success, true);
  assert.equal(delivery.playerMessageSchema.safeParse({ ...value, title: value.title + "😀" }).success, false);
  globalThis.fetch = async url => Response.json(url.endsWith("/access") ? { publicId: actor, displayName: "Админ", serverTime }
    : { serverTime, total: 1, offset: 0, limit: 20, broadcasts: [{ ...value, requestId, actorPublicId: actor, audience: "all", notify: false, recipientCount: 1, createdAt: serverTime, reason: "Внутренняя причина" }] });
  assert.equal((await mail.loadAdminBroadcasts(actor, 0, signal())).broadcasts[0].title, value.title);
});

test("message controls and audience checks reject hidden controls or accidental mass recipients before any POST", async () => {
  const base = broadcast();
  for (const request of [{ ...base, audience: "all" }, { ...base, publicIds: [] }, { ...base, publicIds: [target, target] }, { ...base, title: "x\u202ey" },
    { ...base, body: "Text\u0085payload" }, { ...base, confirmation: "отправить" }, { ...base, title: "a".repeat(121) }]) {
    globalThis.fetch = () => assert.fail("invalid broadcast must not reach the network");
    await assert.rejects(mail.sendAdminBroadcast(actor, request, signal()), error => error.status === 400);
  }
  assert.equal(delivery.deliveryMessage("silent", message.title, message.body), undefined);
  assert.equal(delivery.deliveryMessage("notify", "", ""), undefined);
  assert.ok(delivery.deliveryIssue("notify", "Title", ""));
  assert.equal(delivery.deliveryIssue("notify", message.title, message.body), null);
  const invalid = { ...correction(), delivery: "silent" };
  globalThis.fetch = () => assert.fail("silent requests cannot carry hidden player mail");
  await assert.rejects(adjust.adjustAdminEconomy(actor, target, invalid, signal()), error => error.status === 400);
});

test("broadcast reads and writes verify the same administrator both before and after private requests", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    if (url.endsWith("/access")) return Response.json({ publicId: actor, displayName: "Админ", serverTime });
    if (options.method === "POST") { assert.deepEqual(JSON.parse(options.body), broadcast()); return Response.json({ requestId, recipientCount: 1, changed: true, createdAt: serverTime }); }
    return Response.json({ serverTime, total: 0, offset: 0, limit: 20, broadcasts: [] });
  };
  await mail.loadAdminBroadcasts(actor, 0, signal()); await mail.sendAdminBroadcast(actor, broadcast(), signal());
  assert.deepEqual(calls, ["/api/v1/admin/access", "/api/v1/admin/mail/broadcast?offset=0&limit=20", "/api/v1/admin/access",
    "/api/v1/admin/access", "/api/v1/admin/mail/broadcast", "/api/v1/admin/access"]);
});

test("lost ACK and rate limiting keep the same correction UUID, revision, deltas, delivery and message", async () => {
  const request = correction(), sent = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/access")) return Response.json({ publicId: actor, displayName: "Админ", serverTime });
    assert.equal(url, `/api/v1/admin/users/${target}/adjust-economy`); sent.push(JSON.parse(options.body));
    if (sent.length === 1) throw new TypeError("ACK lost after commit");
    if (sent.length === 2) return Response.json({ code: "RATE_LIMITED", message: "Позже" }, { status: 429 });
    return Response.json({ requestId, publicId: target, changed: true, acceptedRevision: 43, createdAt: serverTime });
  };
  await assert.rejects(adjust.adjustAdminEconomy(actor, target, request, signal()));
  await assert.rejects(adjust.adjustAdminEconomy(actor, target, request, signal()), error => error.status === 429);
  assert.equal((await adjust.adjustAdminEconomy(actor, target, request, signal())).acceptedRevision, 43);
  assert.deepEqual(sent, [request, request, request]);
});

test("denied, switched and late cancelled reads or writes never publish private responses", async () => {
  for (const status of [401, 403, "switched"]) for (const after of [false, true]) {
    let accesses = 0;
    globalThis.fetch = async url => {
      if (!url.endsWith("/access")) return Response.json({ requestId, recipientCount: 1, changed: true, createdAt: serverTime });
      if (++accesses === 1 && after) return Response.json({ publicId: actor, displayName: "Админ", serverTime });
      return status === "switched" ? Response.json({ publicId: other, displayName: "Другой", serverTime }) : Response.json({}, { status });
    };
    await assert.rejects(mail.sendAdminBroadcast(actor, broadcast(), signal()), error => error.status === (status === "switched" ? 403 : status));
  }
  const controller = new AbortController();
  globalThis.fetch = async () => { controller.abort(); return Response.json({ publicId: actor, displayName: "Админ", serverTime }); };
  await assert.rejects(mail.sendAdminBroadcast(actor, broadcast(), controller.signal), error => error.name === "AbortError");
});

test("mail preview escapes HTML and separates delivery from internal audit text", () => {
  const html = renderToStaticMarkup(createElement(delivery.AdminDeliveryPreview, { delivery: "notify", playerMessage: { title: "<script>test</script>", body: '<img src=x onerror="alert(1)">\nText' } }));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<script|<img|href=/);
  const fields = renderToStaticMarkup(createElement(delivery.AdminDeliveryFields, { delivery: "silent", title: "", body: "", disabled: false, onDelivery() {}, onTitle() {}, onBody() {} }));
  assert.match(fields, /Тихо, без письма/); assert.match(fields, /type="radio"[^>]*checked=""/); assert.doesNotMatch(fields, /textarea/);
  const audit = adminActionDetails(JSON.stringify({ request: correction() })); assert.match(audit, /-10/); assert.match(audit, /\+3/); assert.match(audit, /Письмо и уведомление/);
});
