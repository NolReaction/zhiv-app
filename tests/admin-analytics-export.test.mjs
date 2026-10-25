import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { loadAdminAnalyticsExport, isExactAdminPlayerId, downloadAdminAnalyticsExport } =
  await vite.ssrLoadModule("/features/admin/admin-analytics-export.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const actor = "7K3P-2Q9M-W8ZT", player = "7K3P-2Q9M-W8ZS", other = "7K3P-2Q9M-W8ZR";
const snapshotAt = "2026-10-25T18:00:00.123456Z", serverTime = "2026-10-25T18:00:01Z";
const filters = { from: "2026-10-01", to: "2026-10-25", q: "", scope: "players", kind: "", resource: "", direction: "all", allTime: false };
const signal = () => new AbortController().signal;
const event = (id = 1, extra = {}) => ({ id: `${player}:ledger:${String(id).padStart(6, "0")}`, publicId: player,
  displayName: "Игрок", createdAt: "2026-10-24T12:00:00Z", kind: "sell", targetId: "wood", quantity: 1,
  contextKnown: true, category: "gameplay", coins: 10, pearls: 0, items: { wood: -1 }, ...extra });
function page(events, extra = {}, selection = filters) {
  return { serverTime, from: selection.allTime ? "0001-01-01" : selection.from, to: selection.to,
    startAt: selection.allTime ? "0001-01-01T00:00:00Z" : `${selection.from}T00:00:00Z`, endAt: snapshotAt,
    q: selection.q, scope: selection.scope, kind: selection.kind, resource: selection.resource,
    direction: selection.direction, allTime: selection.allTime, snapshotAt, limit: 1000,
    total: events.length, events, nextCursor: null, ...extra };
}
function access(id = actor) { return Response.json({ publicId: id, displayName: "Админ", serverTime }); }
function mockPages(values, { actorAt, onPage } = {}) {
  const calls = []; let pages = 0, accesses = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, "GET"); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.body, undefined);
    if (url.endsWith("/access")) { accesses++; return access(actorAt?.(accesses) ?? actor); }
    const query = new URL(url, "https://test.invalid").searchParams;
    assert.equal(query.has("offset"), false); assert.equal(query.has("at"), false);
    assert.equal(query.get("limit"), "1000");
    const index = pages++;
    return onPage ? onPage(index, query) : Response.json(values[index]);
  };
  return { calls, pages: () => pages, accesses: () => accesses };
}

test("full CSV reads every page from the beginning, keeps exact deltas and escapes spreadsheet input", async () => {
  const selected = { ...filters, q: "Игрок", kind: "sell", resource: "wood", direction: "out" };
  const first = event(1, { displayName: " \t=SUM(1)", coins: -10, pearls: -1, items: { wood: -3, berries: 2 } });
  const mock = mockPages([page([first, event(2)], { total: 3, nextCursor: "second" }, selected),
    page([event(3, { displayName: 'Тестер; "да"\nнет' })], { total: 3, serverTime: "2026-10-25T18:00:02Z" }, selected)]);
  const progress = [];
  const result = await loadAdminAnalyticsExport(actor, selected, "csv", signal(), value => progress.push(value));
  assert.equal(result.count, 3); assert.equal(mock.pages(), 2); assert.equal(mock.accesses(), 3);
  assert.deepEqual(progress, [{ completed: 0, total: null }, { completed: 2, total: 3 }, { completed: 3, total: 3 }]);
  const requests = mock.calls.filter(call => !call.url.endsWith("/access"));
  assert.equal(new URL(requests[0].url, "https://test.invalid").searchParams.get("cursor"), null);
  assert.equal(new URL(requests[1].url, "https://test.invalid").searchParams.get("cursor"), "second");
  const csv = await result.blob.text();
  assert.equal(csv.split("ID операции").length - 1, 1);
  for (const id of [1, 2, 3]) assert.ok(csv.includes(event(id).id));
  assert.ok(csv.includes('"\' \t=SUM(1)"'));
  assert.ok(csv.includes('"-10";"-0.5";"-1"'));
  assert.ok(csv.includes('"Тестер; ""да""\nнет"'));
  assert.ok(csv.includes('{""wood"":-3,""berries"":2}'));
  assert.ok(csv.includes(snapshotAt)); assert.ok(csv.includes('"out";"0"'));
  assert.equal((await result.blob.arrayBuffer()).byteLength > 3, true);
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer()).slice(0, 3)], [239, 187, 191]);
  assert.match(result.filename, /^economy-filtered-2026-10-01_2026-10-25-.*\.csv$/);
});

test("JSON export carries effective all-history range, stable raw records and unambiguous currency scale", async () => {
  const selected = { ...filters, q: ` ${player.toLowerCase()} `, scope: "all", allTime: true };
  const effective = { ...selected, q: player };
  const raw = event(1, { pearls: -1, createdAt: "2020-01-01T00:00:00Z" });
  const mock = mockPages([page([raw], {}, effective)]);
  const result = await loadAdminAnalyticsExport(actor, selected, "json", signal());
  const value = JSON.parse(await result.blob.text());
  assert.equal(mock.pages(), 1); assert.equal(value.complete, true); assert.equal(value.total, 1);
  assert.equal(value.from, "0001-01-01"); assert.equal(value.startAt, "0001-01-01T00:00:00Z");
  assert.deepEqual(value.events, [raw]);
  assert.deepEqual(value.currencyUnits, { rawCoinUnitsPerDisplayedCoin: 1, rawPearlUnitsPerDisplayedPearl: 2 });
  assert.match(result.filename, new RegExp(`^economy-${player}-all-history-.*\\.json$`));
  assert.equal(result.filters.q, player); assert.ok(Object.isFrozen(result.filters));
  assert.equal(isExactAdminPlayerId(player), true); assert.equal(isExactAdminPlayerId("Игрок"), false);
});

test("full CSV identifies all three added residents by their actual names", async () => {
  const records = [event(1, { targetId: "lopukh_woodpile_roof" }), event(2, { targetId: "kamneshmyg_timber_posts" }),
    event(3, { targetId: "leaftail_travel_ties" })];
  mockPages([page(records)]);
  const csv = await (await loadAdminAnalyticsExport(actor, filters, "csv", signal())).blob.text();
  for (const label of ["Навес над поленницей · Лопоух", "Подпорки у входа · Камнешмыг", "Перевязать дорожные тюки · Листохвост"])
    assert.ok(csv.includes(label), label);
});

test("export above the ordinary 100000 offset ceiling remains complete without an export row cap", async () => {
  const total = 100001, batch = 1000;
  const mock = mockPages([], { onPage(index, query) {
    assert.equal(query.get("cursor"), index ? `next-${index}` : null);
    const start = index * batch, count = Math.min(batch, total - start);
    return Response.json(page(Array.from({ length: count }, (_, offset) => event(start + offset)),
      { total, nextCursor: start + count < total ? `next-${index + 1}` : null }));
  } });
  const result = await loadAdminAnalyticsExport(actor, filters, "json", signal());
  assert.equal(result.count, total); assert.equal(mock.pages(), 101); assert.equal(mock.accesses(), 102);
  const report = JSON.parse(await result.blob.text());
  assert.equal(report.events.length, total); assert.equal(report.events.at(-1).id, event(total - 1).id);
});

test("a stable empty selection exports an empty complete report instead of looping", async () => {
  const mock = mockPages([page([])]);
  const result = await loadAdminAnalyticsExport(actor, filters, "json", signal());
  assert.equal(result.count, 0); assert.equal(mock.pages(), 1);
  const value = JSON.parse(await result.blob.text()); assert.equal(value.complete, true); assert.deepEqual(value.events, []);
});

test("nanosecond bounds retain a legitimate row in the same JavaScript millisecond below the cutoff", async () => {
  const cutoff = "2026-10-25T18:00:00.123456789Z";
  mockPages([page([event(1, { createdAt: "2026-10-25T18:00:00.123456788Z" })], { snapshotAt: cutoff, endAt: cutoff })]);
  assert.equal((await loadAdminAnalyticsExport(actor, filters, "json", signal())).count, 1);
  mockPages([page([event(1, { createdAt: cutoff })], { snapshotAt: cutoff, endAt: cutoff })]);
  await assert.rejects(loadAdminAnalyticsExport(actor, filters, "json", signal()), error => error.status === 502);
});

test("rows must match the requested operation and actual selected-resource direction", async () => {
  for (const selected of [{ ...filters, kind: "start_production" }, { ...filters, resource: "coins", direction: "out" },
    { ...filters, resource: "pearls", direction: "in" }, { ...filters, resource: "stone" },
    { ...filters, direction: "out" }]) {
    const raw = event(1, { items: {}, coins: 10 });
    mockPages([page([raw], {}, selected)]);
    await assert.rejects(loadAdminAnalyticsExport(actor, selected, "json", signal()), error => error.status === 502);
  }
  const selected = { ...filters, resource: "wood", direction: "out" };
  mockPages([page([event()], {}, selected)]);
  assert.equal((await loadAdminAnalyticsExport(actor, selected, "json", signal())).count, 1);
});

test("changed metadata, totals, duplicate rows and stalled cursors never return a partial file", async () => {
  const mutations = [
    () => page([event(2)], { total: 3 }),
    () => page([event(2)], { total: 2, snapshotAt: "2026-10-25T18:00:00.123457Z", endAt: "2026-10-25T18:00:00.123457Z" }),
    () => page([event(1)], { total: 2 }),
    () => page([], { total: 2 }),
    () => page([event(2)], { total: 3, nextCursor: "next" }),
    () => page([event(2, { createdAt: "2026-10-24T12:00:00.000001Z" })], { total: 2 }),
    () => page([event(2, { publicId: other })], { total: 2, q: player }),
  ];
  for (const mutation of mutations) {
    mockPages([page([event(1)], { total: 2, nextCursor: "next" }), mutation()]);
    await assert.rejects(loadAdminAnalyticsExport(actor, filters, "json", signal()), error => [409, 502].includes(error.status));
  }
  mockPages([page([], { total: 1, nextCursor: "next" })]);
  await assert.rejects(loadAdminAnalyticsExport(actor, filters, "json", signal()), error => error.status === 502);
  mockPages([page([event(1)], { total: 3, nextCursor: "next" }), page([event(2)], { total: 3, nextCursor: "next" })]);
  await assert.rejects(loadAdminAnalyticsExport(actor, filters, "json", signal()), error => error.status === 502);
});

test("exact-player exports reject another player's row even if metadata echoes the filter", async () => {
  const selected = { ...filters, q: player };
  mockPages([page([event(1, { publicId: other })], {}, selected)]);
  await assert.rejects(loadAdminAnalyticsExport(actor, selected, "json", signal()), error => error.status === 502);
});

test("administrator identity is checked before every page and once more before file creation", async () => {
  for (const changedAt of [1, 2, 3]) {
    const mock = mockPages([page([event(1)], { total: 2, nextCursor: "next" }), page([event(2)], { total: 2 })],
      { actorAt: count => count === changedAt ? other : actor });
    await assert.rejects(loadAdminAnalyticsExport(actor, filters, "csv", signal()), error => error.status === 403);
    assert.equal(mock.pages(), changedAt - 1);
  }
});

test("cancellation after an in-flight response or final access check cannot produce a file", async () => {
  const controller = new AbortController(); let finish;
  const pendingResponse = new Promise(resolve => { finish = resolve; });
  globalThis.fetch = async url => url.endsWith("/access") ? access() : pendingResponse;
  const pending = loadAdminAnalyticsExport(actor, filters, "csv", controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); finish(Response.json(page([event()])));
  await assert.rejects(pending, error => error.name === "AbortError");
  const final = new AbortController(); let accesses = 0;
  globalThis.fetch = async url => {
    if (!url.endsWith("/access")) return Response.json(page([event()]));
    if (++accesses === 2) final.abort();
    return access();
  };
  await assert.rejects(loadAdminAnalyticsExport(actor, filters, "json", final.signal), error => error.name === "AbortError");
  const already = new AbortController(); already.abort();
  globalThis.fetch = () => assert.fail("an already cancelled export must not read private data");
  await assert.rejects(loadAdminAnalyticsExport(actor, filters, "json", already.signal), error => error.name === "AbortError");
});

test("filter objects are captured before the first await and all-history requires an exact ID", async () => {
  const mutable = { ...filters, q: "Игрок" }, selected = { ...mutable };
  let release; const gate = new Promise(resolve => { release = resolve; }); let pages = 0;
  globalThis.fetch = async url => {
    if (url.endsWith("/access")) return access();
    assert.equal(new URL(url, "https://test.invalid").searchParams.get("q"), selected.q);
    pages++; await gate; return Response.json(page([event()], {}, selected));
  };
  const pending = loadAdminAnalyticsExport(actor, mutable, "json", signal());
  mutable.q = "Другой"; mutable.direction = "out"; release();
  const result = await pending;
  assert.equal(pages, 1); assert.equal(result.filters.q, selected.q); assert.equal(result.filters.direction, "all");
  globalThis.fetch = () => assert.fail("invalid all-history target must not read data");
  await assert.rejects(loadAdminAnalyticsExport(actor, { ...filters, allTime: true }, "json", signal()), error => error.status === 400);
});

test("completed download uses a Blob URL only through the explicit synchronous helper", async () => {
  const previousDocument = globalThis.document, create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const calls = [], link = { href: "", download: "", click() { calls.push("click"); }, remove() { calls.push("remove"); } };
  try {
    globalThis.document = { createElement(tag) { assert.equal(tag, "a"); return link; }, body: { append(value) { assert.equal(value, link); calls.push("append"); } } };
    URL.createObjectURL = () => { calls.push("create"); return "blob:completed"; };
    URL.revokeObjectURL = value => { assert.equal(value, "blob:completed"); calls.push("revoke"); };
    mockPages([page([event()])]);
    const result = await loadAdminAnalyticsExport(actor, filters, "json", signal());
    assert.deepEqual(calls, [], "data preparation itself must never download a file");
    downloadAdminAnalyticsExport(result);
    assert.deepEqual(calls, ["create", "append", "click", "remove", "revoke"]);
    assert.equal(link.download, result.filename); assert.equal(link.href, "blob:completed");
  } finally { globalThis.document = previousDocument; URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
});
