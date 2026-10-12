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
const api = await vite.ssrLoadModule("/features/admin/admin-promo-api.ts");
const model = await vite.ssrLoadModule("/features/admin/admin-promo-model.ts");
const ui = await vite.ssrLoadModule("/features/admin/admin-promo-panel.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const actor = "7K3P-2Q9M-W8ZR", otherActor = "7K3P-2Q9M-W8ZT", now = "2026-10-12T12:00:00Z";
const definition = { id: "autumn-gift", code: "AUTUMN-GIFT", title: "Осенний подарок", enabled: true,
  startsAt: "2026-10-12T12:00:00Z", endsAt: "2026-10-13T12:00:00Z", reward: { coins: 500, pearls: 20, items: { wood: 3 } } };
const entry = { definition, version: 3, redemptions: 17, createdAt: now, updatedAt: now };
const command = { requestId: "00000000-0000-4000-8000-000000000007", action: "update", promoId: definition.id,
  expectedVersion: 3, reason: "Подарок игрокам", definition };
const receipt = { requestId: command.requestId, action: command.action, promoId: command.promoId, version: 4, createdAt: now, replayed: false };
const access = { publicId: actor, displayName: "Админ", serverTime: now };
const data = { serverTime: now, codes: [entry] };

function inspect(element) {
  const elements = [];
  function walk(child) { if (!isValidElement(child)) return; elements.push(child); Children.forEach(child.props.children, walk); }
  walk(element); return { elements, markup: renderToStaticMarkup(element) };
}

test("promo status uses inclusive start and exclusive end in server time, disabled overrides dates", () => {
  assert.equal(model.promoStatus(definition, "2026-10-12T11:59:59Z"), "scheduled");
  assert.equal(model.promoStatus(definition, definition.startsAt), "active");
  assert.equal(model.promoStatus(definition, definition.endsAt), "expired");
  assert.equal(model.promoStatus({ ...definition, enabled: false }, definition.endsAt), "disabled");
  assert.equal(model.promoStatus({ ...definition, startsAt: null, endsAt: null }, now), "active");
});

test("Moscow date editor preserves instant across browser timezones, rejects impossible dates, and presets from scheduled start", () => {
  const oldTimezone = process.env.TZ;
  try {
    for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = timezone;
      assert.equal(model.toPromoLocalTime(now), "2026-10-12T15:00");
      assert.equal(model.fromPromoLocalTime("2026-10-12T15:00"), "2026-10-12T12:00:00.000Z");
      assert.equal(model.promoPresetEnd("2026-12-31T23:30", now, 1), "2027-01-01T23:30");
      assert.equal(model.promoPresetEnd("", now, 7), "2026-10-19T15:00");
    }
  } finally { if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone; }
  for (const invalid of ["2026-02-30T12:00", "2026-01-01T25:00", "12.10.2026", "2026-10-12T15:00Z"]) assert.throws(() => model.fromPromoLocalTime(invalid));
  assert.equal(model.fromPromoLocalTime(""), null);
  assert.equal(model.toPromoLocalTime(null), "");
});

test("draft uses visible currency amounts unchanged and rejects fractional, empty, negative, duplicate or excessive rewards", () => {
  const draft = model.promoDraft(entry, "unused", now);
  const parsed = model.definitionFromPromoDraft(draft);
  assert.equal(parsed.reward.pearls, 20);
  assert.equal(parsed.reward.coins, 500);
  assert.deepEqual(parsed.reward.items, { wood: 3 });
  const seconds = { ...entry, definition: { ...definition, startsAt: "2026-10-12T12:00:38.123Z", endsAt: "2026-10-13T12:00:49Z" } };
  const edited = model.definitionFromPromoDraft({ ...model.promoDraft(seconds, "unused", now), title: "Другое название" });
  assert.equal(edited.startsAt, seconds.definition.startsAt, "editing the reward must not silently truncate original date seconds");
  assert.equal(edited.endsAt, seconds.definition.endsAt);
  assert.equal(model.definitionFromPromoDraft({ ...draft, code: " new-code " }).code, "NEW-CODE");
  for (const coins of ["", "1.5", "-1", "Infinity", "1000001", "1e3"]) assert.throws(() => model.definitionFromPromoDraft({ ...draft, coins }));
  assert.throws(() => model.definitionFromPromoDraft({ ...draft, pearls: "0.5" }));
  assert.throws(() => model.definitionFromPromoDraft({ ...draft, coins: "0", pearls: "0", items: [] }), /хотя бы одну/);
  assert.throws(() => model.definitionFromPromoDraft({ ...draft, endsAt: draft.startsAt }), /позже начала/);
  assert.throws(() => model.definitionFromPromoDraft({ ...draft, items: [{ itemId: "wood", amount: "10000" }, { itemId: "stone", amount: "1" }] }), /10 000/);
  assert.throws(() => model.definitionFromPromoDraft({ ...draft, items: [{ itemId: "wood", amount: "1" }, { itemId: "wood", amount: "1" }] }), /дважды/);
  assert.throws(() => model.definitionFromPromoDraft({ ...draft, items: [{ itemId: "not-a-real-item", amount: "1" }] }));
});

test("list shows recognizable rewards, Moscow dates, redemptions, escaping and explicit actions without writing", () => {
  const calls = [];
  const options = { data, query: "осенний", status: "active", onEdit: value => calls.push(["edit", value.definition.id]),
    onToggle: value => calls.push(["toggle", value.definition.id]), onDelete: value => calls.push(["delete", value.definition.id]), onCopy: code => calls.push(["copy", code]) };
  const view = inspect(ui.AdminPromoList(options));
  assert.ok(view.markup.includes(model.promoItemName("wood")));
  for (const text of ["500 монет", "20 жемчуга", "МСК", "17", "Действует", "один раз на игрока"]) assert.ok(view.markup.includes(text), text);
  for (const label of ["Изменить AUTUMN-GIFT", "Выключить AUTUMN-GIFT", "Удалить AUTUMN-GIFT", "Скопировать AUTUMN-GIFT"])
    view.elements.find(element => element.props["aria-label"] === label).props.onClick();
  assert.deepEqual(calls, [["edit", definition.id], ["toggle", definition.id], ["delete", definition.id], ["copy", definition.code]]);
  const empty = renderToStaticMarkup(ui.AdminPromoList({ ...options, status: "expired" }));
  assert.match(empty, /По этому запросу промокодов нет/);
  const unsafe = renderToStaticMarkup(ui.AdminPromoList({ ...options, query: "", data: { ...data, codes: [{ ...entry, definition: { ...definition, title: "<script>alert(1)</script>" } }] } }));
  assert.match(unsafe, /&lt;script&gt;/); assert.doesNotMatch(unsafe, /<script>/);
});

test("review explains real deletion consequences and repeats exact reward, timeframe and reason before save", () => {
  const saved = renderToStaticMarkup(ui.AdminPromoReview({ command, entry }));
  for (const label of ["AUTUMN-GIFT", "20 жемчуга", "Подарок игрокам", "Окончание:", "МСК", "не получат его повторно"]) assert.ok(saved.includes(label), label);
  const deleted = renderToStaticMarkup(ui.AdminPromoReview({ command: { ...command, action: "delete", definition: undefined }, entry }));
  for (const label of ["Удаление промокода", "подарки останутся", "История активаций сохранится", "нельзя будет создать повторно"]) assert.ok(deleted.includes(label), label);
});

test("promo reads and writes verify same actor, use no-store credentials and reject account changes before touching data", async () => {
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(url); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith("/access")) return Response.json(access);
    if (url.endsWith("/manage")) { assert.equal(options.method, "POST"); assert.deepEqual(JSON.parse(options.body), command); return Response.json(receipt); }
    return Response.json(data);
  };
  assert.deepEqual(await api.loadAdminPromos(actor, new AbortController().signal), data);
  assert.deepEqual(await api.manageAdminPromo(actor, command, new AbortController().signal), receipt);
  assert.deepEqual(urls, ["/api/v1/admin/access", "/api/v1/admin/promos", "/api/v1/admin/access", "/api/v1/admin/promos/manage"]);
  for (const operation of [signal => api.loadAdminPromos(actor, signal), signal => api.manageAdminPromo(actor, command, signal)]) {
    for (const status of [401, 403, "changed"]) {
      const requests = [];
      globalThis.fetch = async url => { requests.push(url); return status === "changed" ? Response.json({ ...access, publicId: otherActor }) : Response.json({ code: "DENIED", message: "Нет доступа" }, { status }); };
      await assert.rejects(operation(new AbortController().signal), error => error.status === (status === "changed" ? 403 : status));
      assert.deepEqual(requests, ["/api/v1/admin/access"]);
    }
  }
});

test("cancellation between auth and promo data prevents request; malformed or mismatched receipt is not accepted", async () => {
  const controller = new AbortController(), urls = [];
  globalThis.fetch = async url => { urls.push(url); controller.abort(); return Response.json(access); };
  await assert.rejects(api.manageAdminPromo(actor, command, controller.signal), error => error.name === "AbortError");
  assert.deepEqual(urls, ["/api/v1/admin/access"]);
  for (const mismatch of [{ requestId: "00000000-0000-4000-8000-000000000008" }, { promoId: "other-promo" }, { action: "delete" }, { version: 3 }]) {
    globalThis.fetch = async url => Response.json(url.endsWith("/access") ? access : { ...receipt, ...mismatch });
    await assert.rejects(api.manageAdminPromo(actor, command, new AbortController().signal), error => error.status === 502);
  }
});

test("lost response replay keeps exactly the same UUID, version and payload and persistence is scoped to actor", async () => {
  const values = new Map(), storage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key) };
  api.writePendingAdminPromo(storage, actor, command);
  assert.equal(api.readPendingAdminPromo(storage, otherActor), null);
  const resumed = api.readPendingAdminPromo(storage, actor);
  assert.deepEqual(resumed, command);
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/access")) return Response.json(access);
    writes.push(options.body);
    if (writes.length === 1) throw new TypeError("Lost reply after commit");
    return Response.json({ ...receipt, replayed: true });
  };
  await assert.rejects(api.manageAdminPromo(actor, resumed, new AbortController().signal), /Lost reply/);
  assert.equal((await api.manageAdminPromo(actor, resumed, new AbortController().signal)).replayed, true);
  assert.equal(writes[0], writes[1]);
  api.writePendingAdminPromo(storage, actor, null);
  assert.equal(api.readPendingAdminPromo(storage, actor), null);
  storage.setItem(`zhiv.admin.promo.pending.${actor}`, "{broken-json");
  assert.equal(api.readPendingAdminPromo(storage, actor), null);
});

test("client refuses empty/reused ids and duplicate list records rather than silently displaying misleading admin data", async () => {
  for (const body of [{ ...command, action: "create" }, { ...command, promoId: "other-promo" }, { ...command, reason: "short" }, { ...command, action: "delete" }])
    assert.throws(() => api.manageAdminPromo(actor, body, new AbortController().signal));
  globalThis.fetch = async url => Response.json(url.endsWith("/access") ? access : { ...data, codes: [entry, entry] });
  await assert.rejects(api.loadAdminPromos(actor, new AbortController().signal), error => error.status === 502);
});
