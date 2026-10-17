import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const api = await vite.ssrLoadModule("/features/admin/admin-api.ts");
const { AdminSecurityContent, AdminSecuritySummary, adminReviewReasons, loadAdminPlayerReview } = await vite.ssrLoadModule("/features/admin/admin-security-panel.tsx");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const actor = "7K3P-2Q9M-W8ZR", target = "7K3P-2Q9M-W8ZS", otherActor = "7K3P-2Q9M-W8ZT";
const serverTime = "2026-10-18T01:00:00Z", before = "2026-10-17T20:00:00Z";
const requestId = "00000000-0000-4000-8000-000000000001";
const baseSignal = { code: "ECONOMY_REQUEST_TAMPER", reason: "Повтор запроса с изменённым игровым действием", severity: "review",
  count: 4, pendingCount: 1, firstAt: before, lastAt: serverTime, lastAction: "start_production", lastRequestId: requestId,
  status: "active", reviewedAt: before, threshold: 1, windowMinutes: null };
const security = (extra = {}) => ({ publicId: target, serverTime, watchlisted: false, manualWatchReason: null,
  tapSignalAt: null, securitySignalAt: serverTime, signals: [{ ...baseSignal }], ...extra });
function player() {
  return { publicId: target, displayName: "Игрок", tag: null, bannedAt: null, banReason: null,
    watchlisted: false, tapSignalAt: null, securitySignalAt: serverTime, world: newWorldState(), revision: 0, serverTime };
}
const abortSignal = () => new AbortController().signal;
function inspect(element) {
  const elements = [];
  function walk(child) { if (!isValidElement(child)) return; elements.push(child); Children.forEach(child.props.children, walk); }
  walk(element); return { elements, markup: renderToStaticMarkup(element) };
}

test("security reads use authenticated no-store requests and bind the response to the selected player", async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `/api/v1/admin/users/${target}/security`);
    assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    assert.equal(options.method, "GET"); assert.ok(options.signal instanceof AbortSignal);
    return Response.json(security());
  };
  assert.deepEqual(await api.getAdminSecurity(target), security());
  for (const value of [security({ publicId: otherActor }), security({ signals: [{ ...baseSignal, count: -1 }] }),
    security({ signals: [{ ...baseSignal, pendingCount: 5 }] }), security({ signals: [baseSignal, baseSignal] }),
    security({ signals: [{ ...baseSignal, status: "reviewed", reviewedAt: null }] }),
    security({ signals: [{ ...baseSignal, code: "EVERY_SLOW_PLAYER_IS_A_CHEATER" }] }),
    security({ signals: [{ ...baseSignal, lastAt: "2026-01-01T00:00:00Z" }] })]) {
    globalThis.fetch = async () => Response.json(value);
    await assert.rejects(api.getAdminSecurity(target), error => error.status === 502);
  }
});

test("standalone local admin route does not fabricate player observations", async () => {
  const route = await vite.ssrLoadModule("/app/api/v1/admin/[...path]/route.ts");
  const response = await route.GET(new Request(`http://localhost/api/v1/admin/users/${target}/security`));
  assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.code, "ADMIN_UNAVAILABLE"); assert.equal(body.signals, undefined);
});

test("same administrator is checked before and after private player and security reads", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url); assert.equal(options.cache, "no-store");
    return Response.json(url.endsWith("/access") ? { publicId: actor, displayName: "Админ", serverTime }
      : url.endsWith("/security") ? security() : player());
  };
  const result = await loadAdminPlayerReview(actor, target, abortSignal());
  assert.equal(result.security.publicId, target); assert.equal(result.player.publicId, target);
  assert.deepEqual(calls, ["/api/v1/admin/access", `/api/v1/admin/users/${target}/player`, `/api/v1/admin/users/${target}/security`, "/api/v1/admin/access"]);
});

test("denied and switched administrators never receive a retained private result", async () => {
  for (const stage of ["before", "after"]) for (const status of [401, 403, "changed"]) {
    let accesses = 0, privateReads = 0;
    globalThis.fetch = async url => {
      if (!url.endsWith("/access")) { privateReads++; return Response.json(url.endsWith("/security") ? security() : player()); }
      accesses++;
      if (stage === "after" && accesses === 1) return Response.json({ publicId: actor, displayName: "Админ", serverTime });
      return status === "changed" ? Response.json({ publicId: otherActor, displayName: "Другой админ", serverTime })
        : Response.json({ code: "ACCESS_DENIED", message: "Нет доступа" }, { status });
    };
    await assert.rejects(loadAdminPlayerReview(actor, target, abortSignal()), error => error.status === (status === "changed" ? 403 : status));
    assert.equal(privateReads, stage === "before" ? 0 : 2);
  }
});

test("closing or switching while a late response arrives cannot complete the protected read", async () => {
  for (const stage of ["before", "private", "after"]) {
    const controller = new AbortController(); let accesses = 0;
    globalThis.fetch = async url => {
      if (url.endsWith("/access")) {
        accesses++; if ((stage === "before" && accesses === 1) || (stage === "after" && accesses === 2)) controller.abort();
        return Response.json({ publicId: actor, displayName: "Админ", serverTime });
      }
      if (stage === "private") controller.abort();
      return Response.json(url.endsWith("/security") ? security() : player());
    };
    await assert.rejects(loadAdminPlayerReview(actor, target, controller.signal), error => error.name === "AbortError");
  }
});

test("review content separates active signals, threshold context, manual reason and reviewed history", () => {
  const context = { ...baseSignal, code: "MARKET_OWNERSHIP_DENIED", status: "context", count: 2, pendingCount: 2, threshold: 3, windowMinutes: 30, reviewedAt: null };
  const reviewed = { ...baseSignal, code: "BARTER_OWNERSHIP_DENIED", status: "reviewed", pendingCount: 0, threshold: 3, windowMinutes: 30 };
  const view = inspect(AdminSecurityContent({ detail: security({ watchlisted: true, manualWatchReason: "Проверка переводов между своими аккаунтами", tapSignalAt: serverTime, signals: [baseSignal, context, reviewed] }),
    canManage: false, locked: false, onClear() {}, onWatch() {} }));
  for (const text of ["Проверка переводов между своими аккаунтами", "Требует проверки", "Контекст, порог не достигнут", "Отметка снята администратором",
    "Автобана", "Равномерная активность кликов", "30 мин.", "ID последнего запроса", requestId, "История операций сохранится", "UTC"]) assert.ok(view.markup.includes(text), text);
  assert.equal((view.markup.match(/<details[^>]*open=""/g) ?? []).length, 1);
  const buttons = view.elements.filter(element => element.type === "button");
  assert.ok(buttons.length >= 2 && buttons.every(button => button.props.disabled));
});

test("manual and server supplied reasons are inert text and do not grant actions", () => {
  const markup = renderToStaticMarkup(AdminSecurityContent({ detail: security({ watchlisted: true,
    manualWatchReason: '<script>alert(1)</script>', signals: [{ ...baseSignal, reason: '<img src=x onerror="alert(1)">' }] }),
    canManage: true, locked: true, onClear() {}, onWatch() {} }));
  assert.match(markup, /&lt;script&gt;/); assert.match(markup, /&lt;img src=x/);
  assert.doesNotMatch(markup, /<script|<img|<a\b/);
});

test("no current signals is explicit and summary opens reasons for each review category", () => {
  const markup = renderToStaticMarkup(AdminSecurityContent({ detail: security({ securitySignalAt: null, signals: [] }),
    canManage: true, locked: false, onClear() {}, onWatch() {} }));
  assert.match(markup, /Серверных сигналов по операциям пока нет/); assert.match(markup, /прежние действия не восстановлены/);
  assert.doesNotMatch(markup, /Снять автоматические отметки|Требует проверки/);
  assert.deepEqual(adminReviewReasons({ watchlisted: true, tapSignalAt: before, securitySignalAt: serverTime }),
    ["Наблюдение", "Проверить клики", "Проверить операции"]);
  let opens = 0;
  const view = inspect(AdminSecuritySummary({ user: { displayName: "Тестер", watchlisted: true, tapSignalAt: null, securitySignalAt: serverTime }, onOpen() { opens++; } }));
  const button = view.elements.find(element => element.type === "button");
  assert.match(button.props["aria-label"], /Причины наблюдения: Тестер/); button.props.onClick(); assert.equal(opens, 1);
  assert.equal(AdminSecuritySummary({ user: { displayName: "Тестер" }, onOpen() {} }), null);
});
