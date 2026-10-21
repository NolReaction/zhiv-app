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
const { POST: CLAIM } = await vite.ssrLoadModule("/app/api/v1/mail/[id]/claim/route.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { ECONOMY_MAX_PEARLS } = await vite.ssrLoadModule("/features/economy/domain/money.ts");
beforeEach(() => { process.env.NODE_ENV = "test"; identity.resetDevStoreForTests(); delete globalThis.__mailToken; delete globalThis.__mailFailCookie; });
after(async () => {
  if (initialMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  delete globalThis.__mailToken; delete globalThis.__mailFailCookie; await vite.close();
});
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const letter = (value, overrides = {}) => ({ id: id(value), type: "admin_notice", title: "Новость", body: "Личное сообщение",
  createdAt: "2099-10-18T10:00:00.000Z", readAt: null, notify: true, attachments: null, ...overrides });
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
function claim(p, messageId, patch = {}, headers = {}) {
  return CLAIM(new Request(`http://localhost:3000/api/v1/mail/${messageId}/claim`, { method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ expectedOwnerPublicId: p.me.user.publicId, ...patch }) }), { params: Promise.resolve({ id: messageId }) });
}
async function status(response, expected) {
  assert.equal(response.status, expected);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response;
}

test("local inbox delivers one real welcome gift without automatically crediting its fixed pearls", async () => {
  const p = player(); globalThis.__mailToken = p.token;
  const response = await status(await inbox(p), 200), body = model.mailboxPageSchema.parse(await response.json());
  assert.equal(body.ownerPublicId, p.me.user.publicId);
  assert.equal(body.messages.length, 1); assert.equal(body.unreadCount, 1);
  assert.equal(body.messages[0].gift.pearls, 100); assert.equal(body.messages[0].gift.claimedAt, null);
  assert.match(body.messages[0].body, /Я делаю эту игру один/); assert.doesNotMatch(body.messages[0].body, /команд/);
  assert.equal(body.messages[0].attachments, null);
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
  assert.equal(first.unreadCount, 4); assert.ok(first.nextCursor);
  const second = await (await status(await inbox(p, `&limit=1&cursor=${first.nextCursor}`), 200)).json();
  assert.equal(second.messages[0].id, id(2));
  const third = await (await status(await inbox(p, `&limit=1&cursor=${second.nextCursor}`), 200)).json();
  assert.equal(third.messages[0].id, id(1)); assert.ok(third.nextCursor);
  const fourth = await (await inbox(p, `&limit=1&cursor=${third.nextCursor}`)).json();
  assert.equal(fourth.messages[0].gift.pearls, 100); assert.equal(fourth.nextCursor, null);
  const accepted = model.mailReadResultSchema.parse(await (await status(await read(p, id(2)), 200)).json());
  assert.equal(accepted.unreadCount, 3);
  const repeated = await (await status(await read(p, id(2)), 200)).json();
  assert.equal(repeated.readAt, accepted.readAt); assert.equal(repeated.unreadCount, 3);
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
  assert.equal(store.getDevMail(p.token, p.me.user.publicId).value.unreadCount, 2);
});

test("mail write rejects cross origin and streamed body overflow without changing the inbox", async () => {
  const p = player(); globalThis.__mailToken = p.token; store.seedDevMailForTests(p.me.user.publicId, [letter(1)]);
  await status(await read(p, id(1), {}, { Origin: "https://evil.example" }), 403);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } });
  const request = new Request(`http://localhost:3000/api/v1/mail/${id(1)}/read`, { method: "POST", duplex: "half", body,
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" } });
  await status(await POST(request, { params: Promise.resolve({ id: id(1) }) }), 413);
  assert.equal(cancelled, true); assert.equal(store.getDevMail(p.token, p.me.user.publicId).value.unreadCount, 2);
});

test("recovery revokes former sessions and retains mail only for the recovered owner", async () => {
  const p = player(); globalThis.__mailToken = p.token; store.seedDevMailForTests(p.me.user.publicId, [letter(1)]);
  const code = `recovery-${crypto.randomUUID()}`;
  identity.activateDevRecoveryCode(p.token, code);
  const recovered = identity.redeemDevRecoveryCode(code, `retry-${crypto.randomUUID()}`);
  await status(await inbox(p), 401); await status(await read(p, id(1)), 401);
  globalThis.__mailToken = recovered.token;
  assert.equal((await (await status(await inbox(p), 200)).json()).unreadCount, 2);
  identity.resetDevStoreForTests();
  const fresh = player(); globalThis.__mailToken = fresh.token;
  assert.equal((await (await status(await inbox(fresh), 200)).json()).messages[0].gift.pearls, 100);
});

test("production gates run before cookies identity or local mail access", async () => {
  const p = player(); globalThis.__mailToken = p.token; store.seedDevMailForTests(p.me.user.publicId, [letter(1)]);
  process.env.NODE_ENV = "production"; globalThis.__mailFailCookie = true;
  await status(await inbox(p), 503); await status(await read(p, id(1)), 503);
  await status(await claim(p, id(1)), 503);
  assert.throws(() => store.seedDevMailForTests(p.me.user.publicId, [letter(2)]), /NODE_ENV=test/);
});

test("welcome open and read do not pay, explicit concurrent retries credit exactly 100 visible pearls once", async () => {
  const p = player(); globalThis.__mailToken = p.token;
  const before = economy.getDevEconomy(p.token), welcome = (await (await inbox(p)).json()).messages[0];
  await status(await read(p, welcome.id), 200);
  assert.equal(economy.getDevEconomy(p.token).wallet.pearls, before.wallet.pearls);
  const results = await Promise.all(Array.from({ length: 8 }, () => claim(p, welcome.id)));
  const gifts = await Promise.all(results.map(async response => model.mailClaimResultSchema.parse(await (await status(response, 200)).json())));
  assert.ok(gifts.every(result => result.gift.pearls === 100 && result.gift.claimedAt === gifts[0].gift.claimedAt));
  const paid = economy.getDevEconomy(p.token);
  assert.equal(paid.wallet.pearls, before.wallet.pearls + 200); assert.equal(paid.revision, before.revision + 1);
  await claim(p, welcome.id); await inbox(p);
  assert.equal(economy.getDevEconomy(p.token).wallet.pearls, paid.wallet.pearls);
  economy.resetDevEconomyStoreForTests();
  const reset = economy.getDevEconomy(p.token); await status(await claim(p, welcome.id), 200);
  assert.equal(economy.getDevEconomy(p.token).wallet.pearls, reset.wallet.pearls, "mail claim fence survives economy recreation");
  assert.equal((await (await inbox(p)).json()).messages.filter(message => message.gift).length, 1);
});

test("gift claim rejects foreign owners, unknown IDs, ordinary receipts, changed amounts and untrusted writes", async () => {
  const p = player(), other = player(); globalThis.__mailToken = p.token;
  const welcome = (await (await inbox(p)).json()).messages[0], before = economy.getDevEconomy(p.token);
  store.seedDevMailForTests(p.me.user.publicId, [letter(1, { attachments: { pearls: 100, coins: 0 } })]);
  for (const extra of [{ pearls: 10000 }, { gift: { pearls: 10000 } }, { claimedAt: "2099-01-01T00:00:00Z" }, { requestId: crypto.randomUUID() }])
    await status(await claim(p, welcome.id, extra), 400);
  await status(await claim(other, welcome.id), 409);
  await status(await claim(p, id(1)), 404); await status(await claim(p, id(999)), 404);
  await status(await claim(p, welcome.id, {}, { Origin: "https://evil.example" }), 403);
  globalThis.__mailToken = other.token; await status(await claim(other, welcome.id), 404);
  assert.equal(economy.getDevEconomy(p.token).wallet.pearls, before.wallet.pearls);
  assert.equal(store.getDevMail(p.token, p.me.user.publicId).value.messages.find(message => message.gift).gift.claimedAt, null);
});

test("wallet capacity rolls back the gift fence and later retry can still collect it", async () => {
  const p = player(); globalThis.__mailToken = p.token;
  const welcome = (await (await inbox(p)).json()).messages[0], before = economy.getDevEconomy(p.token);
  economy.creditDevProgressionReward(p.token, p.me.user.publicId, crypto.randomUUID(),
    { coins: 0, pearls: ECONOMY_MAX_PEARLS - before.wallet.pearls, items: {} }, "capacity-fixture");
  const revision = economy.getDevEconomy(p.token).revision;
  await status(await claim(p, welcome.id), 409);
  assert.equal(economy.getDevEconomy(p.token).revision, revision);
  assert.equal(store.getDevMail(p.token, p.me.user.publicId).value.messages[0].gift.claimedAt, null);
  economy.resetDevEconomyStoreForTests(); const reset = economy.getDevEconomy(p.token);
  await status(await claim(p, welcome.id), 200);
  assert.equal(economy.getDevEconomy(p.token).wallet.pearls, reset.wallet.pearls + 200);
});
