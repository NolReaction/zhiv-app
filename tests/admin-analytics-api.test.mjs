import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const api = await vite.ssrLoadModule("/features/admin/admin-analytics-api.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => vite.close());
const actor = "7K3P-2Q9M-W8ZR", target = "7K3P-2Q9M-W8ZS";
const serverTime = "2026-10-07T10:00:00Z";
const filters = { from: "2026-10-01", to: "2026-10-07", q: "100%_игрок", scope: "players" };
const shared = { ...filters, serverTime, startAt: "2026-10-01T00:00:00Z", endAt: serverTime };
const snapshot = {
  ...shared,
  summary: { activePlayers: 1, events: 2, spendingPlayers: 1, constructionStarts: 1, constructionClaims: 0, constructionPlayers: 1 },
  daily: [{ date: "2026-10-01", players: 1, events: 2, constructionStarts: 1 }],
  resources: [{ resourceId: "pearls", received: 3, spent: 1, reserved: 0, returned: 0, net: 2, players: 1 },
    { resourceId: "wood", received: 0, spent: 5, reserved: 7, returned: 2, net: -10, players: 1 }],
  flows: [{ kind: "start_construction", targetId: "warehouse", resourceId: "wood", category: "gameplay", received: 0, spent: 5, players: 1, events: 1 }],
  actions: [{ kind: "start_construction", targetId: "warehouse", events: 1, players: 1 }],
  construction: [{ buildingId: "warehouse", starts: 1, claims: 0, players: 1 }],
  firstConstructions: [{ buildingId: null, players: 1 }],
  buildingLevels: [{ buildingId: "home", level: 1, players: 1 }],
  gameplay: { mealsConsumed: 0, foodPlayers: 0, ordersCompleted: 0, orderPlayers: 0, orderCoinsEarned: 0, orderReplacements: 0, paidOrderReplacements: 0, orderPearlsSpent: 0 }, meals: [], orders: [], presence: { coverageFrom: null, players: 0, onlineSeconds: 0, flaggedPlayers: 0, daily: [], reviewDays: [], reviewDaysTruncated: false }, coverage: { firstRecordedAt: "2026-09-01T12:00:00Z", unattributedEvents: 1, matchingPlayers: 2, initializedPlayers: 1, flowsTruncated: false, actionsTruncated: false, ordersTruncated: false },
};
const eventFilters = { ...filters, kind: "start_construction", resource: "wood", direction: "out", offset: 0, limit: 25, at: null };
const event = { id: `${target}:command:fixture`, publicId: target, displayName: "<Игрок>", createdAt: "2026-10-01T12:00:00Z",
  kind: "start_construction", targetId: "warehouse", quantity: 1, contextKnown: true, category: "gameplay", coins: -10, pearls: -1, items: { wood: -5 } };
const page = { ...shared, kind: eventFilters.kind, resource: eventFilters.resource, direction: eventFilters.direction,
  at: null, offset: 0, limit: 25, total: 1, events: [event] };

function reply(body) { globalThis.fetch = async () => Response.json(body); }

test("analytics is a read-only same-origin request with literal scope and private fields stripped", async () => {
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url, "https://example.invalid");
    assert.equal(parsed.pathname, "/api/v1/admin/analytics");
    assert.deepEqual(Object.fromEntries(parsed.searchParams), filters);
    assert.equal(options.method, "GET"); assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "same-origin"); assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ ...snapshot, sessionHash: "private", signature: { secret: true } });
  };
  const value = await api.getAdminAnalytics(filters);
  assert.deepEqual(value, snapshot);
  assert.equal(value.resources[0].received, 3, "half-pearl units stay exact until formatting");
  assert.equal(value.firstConstructions[0].buildingId, null, "unknown history stays unknown");
});

test("analytics rejects mismatched selections, unsafe numeric values and inconsistent resource balances", async () => {
  for (const body of [
    { ...snapshot, q: "different player" }, { ...snapshot, scope: "all" },
    { ...snapshot, from: "2026-09-01" }, { ...snapshot, to: "2026-10-06" },
    { ...snapshot, gameplay: { ...snapshot.gameplay, orderReplacements: 1, paidOrderReplacements: 2 } },
    { ...snapshot, presence: { ...snapshot.presence, onlineSeconds: -1 } },
    { ...snapshot, presence: { ...snapshot.presence, reviewDays: [{ publicId: target, displayName: "Игрок", date: "2026-10-02", onlineSeconds: 86401, flaggedAt: serverTime, watchlisted: true }] } },
    { ...snapshot, endAt: "2026-10-08T00:00:00Z" },
    { ...snapshot, summary: { ...snapshot.summary, activePlayers: -1 } },
    { ...snapshot, resources: [{ ...snapshot.resources[0], received: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...snapshot, resources: [{ ...snapshot.resources[0], spent: 0.5 }] },
    { ...snapshot, resources: [{ ...snapshot.resources[0], net: 999 }] },
  ]) {
    reply(body);
    await assert.rejects(api.getAdminAnalytics(filters), error => error.status === 502);
  }
});

test("operation history keeps signs and unknown context while preserving the pagination anchor", async () => {
  const anchored = { ...eventFilters, at: "2026-10-07T09:00:00Z" };
  globalThis.fetch = async (url, options) => {
    const query = new URL(url, "https://example.invalid").searchParams;
    for (const [key, value] of Object.entries(anchored)) assert.equal(query.get(key), String(value));
    assert.equal(options.method, "GET"); assert.equal(options.cache, "no-store");
    return Response.json({ ...page, endAt: anchored.at, at: anchored.at, events: [{ ...event, contextKnown: false, targetId: null, privateSeed: "hidden" }] });
  };
  const result = await api.getAdminAnalyticsEvents(anchored);
  assert.equal(result.events[0].pearls, -1);
  assert.equal(result.events[0].items.wood, -5);
  assert.equal(result.events[0].targetId, null);
  assert.equal("privateSeed" in result.events[0], false);
});

test("history rejects another page, duplicate identities, records outside its interval and a stale anchor", async () => {
  for (const body of [
    { ...page, offset: 25 }, { ...page, resource: "coins" }, { ...page, direction: "in" },
    { ...page, at: "2026-10-07T09:00:00Z" },
    { ...page, events: [event, event], total: 2 },
    { ...page, total: 0 },
    { ...page, events: [{ ...event, createdAt: "2026-09-30T23:59:59Z" }] },
    { ...page, events: [{ ...event, createdAt: page.endAt }] },
  ]) {
    reply(body);
    await assert.rejects(api.getAdminAnalyticsEvents(eventFilters), error => error.status === 502);
  }
});

test("both loaders reject a changed administrator before requesting analytics", async () => {
  for (const loader of [signal => api.loadAdminAnalytics(actor, filters, signal), signal => api.loadAdminAnalyticsEvents(actor, eventFilters, signal)]) {
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(url);
      return Response.json({ publicId: target, displayName: "Другой администратор", serverTime });
    };
    await assert.rejects(loader(new AbortController().signal), error => error.status === 403);
    assert.deepEqual(calls, ["/api/v1/admin/access"]);
  }
});

test("authorization failures stay distinguishable and cancellation reaches the underlying request", async () => {
  for (const status of [401, 403, 503]) {
    globalThis.fetch = async () => Response.json({ code: "UNAVAILABLE", message: "Unavailable" }, { status });
    await assert.rejects(api.getAdminAnalytics(filters), error => error.status === status);
    await assert.rejects(api.getAdminAnalyticsEvents(eventFilters), error => error.status === status);
  }
  const controller = new AbortController();
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  const pending = api.getAdminAnalytics(filters, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
});

function progression() {
  return { observedUntil: serverTime,
    cohort: { players: 2, initializedPlayers: 1, home2Players: 1, playersWithEvents: 1, firstRecordedAt: null,
      stages: [{ id: "first_action", players: 1, medianSeconds: 0 }, { id: "first_work_started", players: 0, medianSeconds: null }] },
    snapshot: { matchingPlayers: 2, initializedPlayers: 1, unknownHistoryPlayers: 1, noAction72hPlayers: 0, ready24hPlayers: 1, awaitingCollection24hPlayers: 0,
      review: [{ publicId: target, displayName: "Игрок", homeLevel: null, lastActionAt: null, readySince: "2026-10-01T12:00:00Z", awaitingCollectionSince: null, signals: ["ready_24h"] }], reviewTruncated: false } };
}
test("optional progression accepts old and nullable responses while preserving unknown history and null medians", async () => {
  for (const extra of [{}, { progression: null }, { progression: progression() }]) {
    reply({ ...snapshot, ...extra });
    assert.deepEqual(await api.getAdminAnalytics(filters), { ...snapshot, ...extra });
  }
});
test("progression rejects misleading denominators, unknown signals, duplicate steps or players and a future snapshot", async () => {
  const invalid = [];
  for (const change of [
    p => { p.cohort.initializedPlayers = 3; }, p => { p.cohort.home2Players = 2; },
    p => { p.cohort.playersWithEvents = 3; }, p => { p.cohort.stages[0].players = 3; },
    p => { p.cohort.stages[0].medianSeconds = -1; }, p => { p.cohort.stages[0].medianSeconds = 0.5; },
    p => { p.cohort.stages.push({ ...p.cohort.stages[0] }); },
    p => { p.snapshot.unknownHistoryPlayers = 2; }, p => { p.snapshot.ready24hPlayers = 3; },
    p => { p.snapshot.review[0].signals = ["offline"]; }, p => { p.snapshot.review[0].signals = ["ready_24h", "ready_24h"]; },
    p => { p.snapshot.review.push({ ...p.snapshot.review[0] }); },
    p => { p.observedUntil = "2026-10-08T12:00:00Z"; },
  ]) { const p = progression(); change(p); invalid.push(p); }
  for (const p of invalid) {
    reply({ ...snapshot, progression: p });
    await assert.rejects(api.getAdminAnalytics(filters), error => error.status === 502);
  }
});
