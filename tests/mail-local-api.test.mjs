import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), initialMode = process.env.NODE_ENV;
const cookieModule = "\0mail-local-test-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "mail-local-test-cookie", resolveId(id) { if (id === cookieModule) return id; }, load(id) {
    if (id === cookieModule) return "export async function cookies() { if(globalThis.__mailFailCookie) throw new Error('cookie read before production gate'); return { get() { return { value: globalThis.__mailToken }; } }; }";
  } }],
});
const identity = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const store = await vite.ssrLoadModule("/lib/dev/mail-store.ts");
const model = await vite.ssrLoadModule("/features/mailbox/model.ts");
const { GET } = await vite.ssrLoadModule("/app/api/v1/mail/route.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/mail/[id]/read/route.ts");
beforeEach(() => { process.env.NODE_ENV = "test"; identity.resetDevStoreForTests(); delete globalThis.__mailToken; delete globalThis.__mailFailCookie; });
after(async () => {
  if (initialMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  delete globalThis.__mailToken; delete globalThis.__mailFailCookie; await vite.close();
});
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const letter = (value, overrides = {}) => ({ id: id(value), type: "admin_notice", title: "Новость", body: "Личное сообщение",
  createdAt: "2026-10-18T10:00:00.000Z", readAt: null, notify: true, attachments: null, ...overrides });
const player = () => identity.createDevIdentity("Тест", crypto.randomUUID());
function inbox(p, query = "") {
  return GET(new Request(`http://localhost:3000/api/v1/mail?expectedOwnerPublicId=${p.me.user.publicId}${query}`));
}
function read(p, messageId, patch = {}, headers = {}) {
  const request = new Request(`http://localhost:3000/api/v1/mail/${messageId}/read`, { method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ expectedOwnerPublicId: p.me.user.publicId, ...patch }) });
  return POST(request, { params: Promise.resolve({ id: messageId }) });
}
async function status(response, expected) {
  assert.equal(response.status, expected);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response;
}

test("local inbox starts empty and exposes the real account bound contract without simulated administration", async () => {
  const p = player(); globalThis.__mailToken = p.token;
  const response = await status(await inbox(p), 200), body = model.mailboxPageSchema.parse(await response.json());
  assert.equal(body.ownerPublicId, p.me.user.publicId);
  assert.deepEqual(body.messages, []); assert.equal(body.unreadCount, 0);
  assert.equal(body.nextCursor, null); assert.equal(body.latestUnreadNotification, null);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("mail reads require the current owner and a foreign UUID is indistinguishable from missing mail", async () => {
  const a = player(), b = player();
  store.seedDevMailForTests(a.me.user.publicId, [letter(1)]);
  store.seedDevMailForTests(b.me.user.publicId, [letter(2, { body: "Секрет второго" })]);
  await status(await inbox(a), 401);
  globalThis.__mailToken = a.token;
  await status(await inbox(b), 409); await status(await read(b, id(2)), 409);
  const foreign = await (await status(await read(a, id(2)), 404)).json();
  const missing = await (await status(await read(a, id(99)), 404)).json();
  assert.deepEqual(foreign, missing);
  assert.equal(store.getDevMail(b.token, b.me.user.publicId).value.messages[0].readAt, null);
});

test("pagination is stable across tied timestamps and notification metadata is independent of the page", async () => {
  const p = player(); globalThis.__mailToken = p.token;
  const seeded = [letter(1), letter(2), letter(3, { notify: false })];
  store.seedDevMailForTests(p.me.user.publicId, seeded); seeded[2].body = "Изменённый fixture";
  const first = await (await status(await inbox(p, "&limit=1"), 200)).json();
  assert.equal(first.messages[0].id, id(3)); assert.equal(first.messages[0].body, "Личное сообщение");
  assert.deepEqual(first.latestUnreadNotification, { id: id(2), createdAt: letter(2).createdAt });
  assert.equal(first.unreadCount, 3); assert.ok(first.nextCursor);
  const second = await (await status(await inbox(p, `&limit=1&cursor=${first.nextCursor}`), 200)).json();
  assert.equal(second.messages[0].id, id(2));
  const third = await (await status(await inbox(p, `&limit=1&cursor=${second.nextCursor}`), 200)).json();
  assert.equal(third.messages[0].id, id(1)); assert.equal(third.nextCursor, null);
  const accepted = model.mailReadResultSchema.parse(await (await status(await read(p, id(2)), 200)).json());
  assert.equal(accepted.unreadCount, 2);
  const repeated = await (await status(await read(p, id(2)), 200)).json();
  assert.equal(repeated.readAt, accepted.readAt); assert.equal(repeated.unreadCount, 2);
  assert.equal((await (await inbox(p)).json()).latestUnreadNotification.id, id(1));
  first.messages[0].body = "Клиентская подмена";
  assert.equal(store.getDevMail(p.token, p.me.user.publicId).value.messages[0].body, "Личное сообщение");
});

test("malformed cursor limits duplicate selectors extra body fields and noncanonical IDs are rejected", async () => {
  const p = player(); globalThis.__mailToken = p.token; store.seedDevMailForTests(p.me.user.publicId, [letter(1)]);
  for (const query of ["&limit=0", "&limit=51", "&limit=NaN", "&limit=1&limit=2", "&cursor=not-a-cursor", "&cursor=",
    "&cursor=a&cursor=b", "&unknown=1", `&expectedOwnerPublicId=${p.me.user.publicId}`]) await status(await inbox(p, query), 400);
  await status(await GET(new Request("http://localhost:3000/api/v1/mail")), 400);
  await status(await read(p, id(1), { claim: true }), 400);
  await status(await read(p, "not-a-uuid"), 400);
  await status(await read(p, id(1), {}, { "Content-Type": "application/jsonp" }), 415);
  assert.equal(store.getDevMail(p.token, p.me.user.publicId).value.unreadCount, 1);
});

test("mail write rejects cross origin and streamed body overflow without changing the inbox", async () => {
  const p = player(); globalThis.__mailToken = p.token; store.seedDevMailForTests(p.me.user.publicId, [letter(1)]);
  await status(await read(p, id(1), {}, { Origin: "https://evil.example" }), 403);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } });
  const request = new Request(`http://localhost:3000/api/v1/mail/${id(1)}/read`, { method: "POST", duplex: "half", body,
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" } });
  await status(await POST(request, { params: Promise.resolve({ id: id(1) }) }), 413);
  assert.equal(cancelled, true); assert.equal(store.getDevMail(p.token, p.me.user.publicId).value.unreadCount, 1);
});

test("recovery revokes former sessions and retains mail only for the recovered owner", async () => {
  const p = player(); globalThis.__mailToken = p.token; store.seedDevMailForTests(p.me.user.publicId, [letter(1)]);
  const code = `recovery-${crypto.randomUUID()}`;
  identity.activateDevRecoveryCode(p.token, code);
  const recovered = identity.redeemDevRecoveryCode(code, `retry-${crypto.randomUUID()}`);
  await status(await inbox(p), 401); await status(await read(p, id(1)), 401);
  globalThis.__mailToken = recovered.token;
  assert.equal((await (await status(await inbox(p), 200)).json()).unreadCount, 1);
  identity.resetDevStoreForTests();
  const fresh = player(); globalThis.__mailToken = fresh.token;
  assert.deepEqual((await (await status(await inbox(fresh), 200)).json()).messages, []);
});

test("production gates run before cookies identity or local mail access", async () => {
  const p = player(); globalThis.__mailToken = p.token; store.seedDevMailForTests(p.me.user.publicId, [letter(1)]);
  process.env.NODE_ENV = "production"; globalThis.__mailFailCookie = true;
  await status(await inbox(p), 503); await status(await read(p, id(1)), 503);
  assert.throws(() => store.seedDevMailForTests(p.me.user.publicId, [letter(2)]), /NODE_ENV=test/);
});
