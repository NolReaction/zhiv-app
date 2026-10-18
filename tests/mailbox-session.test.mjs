import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-mailbox-session-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createMailboxSession } = await vite.ssrLoadModule("/features/mailbox/session.ts");
const { createMailNotificationLedger, mailNotificationKey, MAIL_NOTIFICATION_LIMIT } = await vite.ssrLoadModule("/features/mailbox/notification-ledger.ts");
const { mailboxPageSchema, mailMessageSchema } = await vite.ssrLoadModule("/features/mailbox/model.ts");
const { getMailbox, markMailRead } = await vite.ssrLoadModule("/features/mailbox/api.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "7K3P-2Q9M-W8ZR", other = "7K3P-2Q9M-W8ZS", instant = "2026-10-18T12:00:00.000Z";
const message = (index = 1, patch = {}) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  type: "admin_notice", title: "Письмо команды", body: "Ваше письмо остаётся в почте.", createdAt: instant, readAt: null, notify: true, attachments: null, ...patch });
const page = (messages = [message()], patch = {}) => ({ ownerPublicId: owner, unreadCount: messages.filter(value => !value.readAt).length,
  messages, nextCursor: null, serverTime: instant, latestUnreadNotification: messages.find(value => value.notify && !value.readAt)
    ? { id: messages.find(value => value.notify && !value.readAt).id, createdAt: instant } : null, ...patch });
const result = (id, count = 0, serverTime = "2026-10-18T12:01:00Z") => ({ ownerPublicId: owner, id, readAt: serverTime, unreadCount: count, serverTime });
const flush = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const storage = () => { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("signed correction receipts and Unicode code-point limits remain readable alongside ordinary letters", () => {
  const correction = message(1, { type: "balance_correction", title: "🌲".repeat(120), body: "🌳".repeat(2000),
    attachments: { coins: -100, pearls: -2.5, gameItems: ["one"], achievements: ["test"] } });
  const parsed = mailboxPageSchema.parse(page([correction]));
  assert.equal(parsed.messages[0].attachments.coins, -100); assert.equal(parsed.messages[0].attachments.pearls, -2.5);
  assert.deepEqual(parsed.messages[0].attachments.gameItems, ["one"]);
  assert.deepEqual(parsed.messages[0].attachments.achievements, ["test"]);
  assert.equal(mailMessageSchema.safeParse({ ...correction, title: "🌲".repeat(121) }).success, false);
  assert.equal(mailMessageSchema.safeParse({ ...correction, body: "🌳".repeat(2001) }).success, false);
});

test("mail API binds GET and read to the expected owner, bypasses caches and rejects a foreign successful response", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json(options.method === "GET" ? page() : result(message().id)); };
  await getMailbox(owner, "opaque cursor /?", new AbortController().signal); await markMailRead(owner, message().id);
  const query = new URL(calls[0].url, "https://zhiv.example").searchParams;
  assert.equal(query.get("expectedOwnerPublicId"), owner); assert.equal(query.get("cursor"), "opaque cursor /?");
  assert.deepEqual(JSON.parse(calls[1].options.body), { expectedOwnerPublicId: owner });
  assert.match(calls[1].url, /\/api\/v1\/mail\/00000000-0000-4000-8000-000000000001\/read$/);
  for (const call of calls) { assert.equal(call.options.cache, "no-store"); assert.equal(call.options.credentials, "same-origin"); }
  globalThis.fetch = async () => Response.json(page([], { ownerPublicId: other }));
  await assert.rejects(getMailbox(owner, null), error => error.status === 401);
  await assert.rejects(markMailRead(owner, "../foreign"), error => error.status === 400);
});

test("listing and selecting a letter cannot mark it read before its actual detail is visible", async () => {
  const reads = [], wait = deferred(), session = createMailboxSession(owner, { list: async () => page(),
    read: async (id, signal) => { reads.push({ id, signal }); return wait.promise; } });
  const stop = session.activate();
  try {
    await session.refresh(); assert.equal(reads.length, 0); session.open(); await session.refresh();
    session.select(message().id); assert.equal(reads.length, 0); assert.equal(session.getSnapshot().unreadCount, 1);
    const reading = session.messageVisible(message().id); await session.messageVisible(message().id);
    assert.equal(reads.length, 1); assert.equal(session.getSnapshot().selected.readAt, null);
    wait.resolve(result(message().id)); await reading;
    assert.equal(session.getSnapshot().selected.readAt, "2026-10-18T12:01:00Z"); assert.equal(session.getSnapshot().unreadCount, 0);
  } finally { stop(); }
});

test("a stale list response cannot resurrect unread state after the actual letter's read ACK", async () => {
  const oldList = deferred(); let calls = 0;
  const session = createMailboxSession(owner, { list: async () => ++calls === 1 ? page() : oldList.promise,
    read: async id => result(id) }); const stop = session.activate();
  try {
    await session.refresh(); session.open(); session.select(message().id); const listing = session.refresh(); await flush();
    await session.messageVisible(message().id); assert.equal(session.getSnapshot().unreadCount, 0);
    oldList.resolve(page()); await listing;
    assert.ok(session.getSnapshot().messages[0].readAt); assert.ok(session.getSnapshot().selected.readAt);
    assert.equal(session.getSnapshot().unreadCount, 0);
    assert.equal(session.getSnapshot().notification, null, "a stale unread-notification field cannot reannounce the letter already read");
  } finally { stop(); }
});

test("out-of-order read ACKs retain the newest total even within one millisecond", async () => {
  const first = deferred(), second = deferred(), messages = [message(1), message(2)];
  const session = createMailboxSession(owner, { list: async () => page(messages), read: id => id === messages[0].id ? first.promise : second.promise });
  const stop = session.activate();
  try {
    await session.refresh(); session.open(); await session.refresh(); session.select(messages[0].id); const a = session.messageVisible(messages[0].id);
    session.select(messages[1].id); const b = session.messageVisible(messages[1].id);
    second.resolve(result(messages[1].id, 0, "2026-10-18T12:01:00.000002Z")); await b;
    first.resolve(result(messages[0].id, 1, "2026-10-18T12:01:00.000001Z")); await a;
    assert.equal(session.getSnapshot().unreadCount, 0); assert.ok(session.getSnapshot().messages.every(value => value.readAt));
  } finally { stop(); }
});

test("account disposal aborts transport and late private mail never enters the replacement account", async () => {
  const pending = deferred(); let signal, lost = 0;
  const first = createMailboxSession(owner, { list: async (_cursor, requestSignal) => { signal = requestSignal; return pending.promise; }, read: async () => assert.fail() }, () => lost++);
  const stop = first.activate(), reading = first.refresh(); await flush(); stop(); assert.equal(signal.aborted, true);
  const second = createMailboxSession(other, { list: async () => page([], { ownerPublicId: other }), read: async () => assert.fail() });
  const stopSecond = second.activate();
  try {
    await second.refresh(); pending.resolve(page([message(1, { body: "Secret from previous player" })])); await reading;
    assert.deepEqual(second.getSnapshot().messages, []); assert.equal(second.getSnapshot().ownerPublicId, other); assert.equal(lost, 0);
  } finally { stopSecond(); }
});

test("refresh reserves one operation before publishing and cancelled scheduled work never starts", async () => {
  let calls = 0; const session = createMailboxSession(owner, { list: async () => { calls++; return page(); }, read: async () => assert.fail() });
  const stop = session.activate(), unsubscribe = session.subscribe(() => { if (session.getSnapshot().loading) void session.refresh(); });
  await Promise.all([session.refresh(), session.refresh(), session.refresh()]); assert.equal(calls, 1);
  const scheduled = session.refresh(); stop(); await scheduled; assert.equal(calls, 1); unsubscribe();
});

test("focus or offline suspension aborts requests while retaining the actual letter and does not fabricate read success", async () => {
  const delayed = deferred(); let readingSignal;
  const session = createMailboxSession(owner, { list: async () => page(), read: async (_id, signal) => { readingSignal = signal; return delayed.promise; } });
  const stop = session.activate();
  try {
    await session.refresh(); session.open(); await session.refresh(); session.select(message().id); const reading = session.messageVisible(message().id);
    session.setAvailable(false); assert.equal(readingSignal.aborted, true); assert.equal(session.getSnapshot().opened, true);
    delayed.resolve(result(message().id)); await reading; assert.equal(session.getSnapshot().selected.readAt, null);
    assert.equal(session.getSnapshot().unreadCount, 1); session.setAvailable(true); await session.refresh();
  } finally { stop(); }
});

test("latest notify outside the first page alerts once while silent letters and archival pages never manufacture alerts", async () => {
  const latest = { id: message(99).id, createdAt: "2026-10-18T13:00:00Z" }, cache = storage();
  let head = page([message(1, { notify: false })], { nextCursor: "older", latestUnreadNotification: latest });
  const session = createMailboxSession(owner, { list: async cursor => cursor ? page([message(2)], { latestUnreadNotification: { id: message(2).id, createdAt: instant } }) : head,
    read: async () => assert.fail() }, undefined, cache); const stop = session.activate();
  try {
    await session.refresh(); assert.deepEqual(session.getSnapshot().notification, latest);
    assert.equal(session.claimNotification(latest.id), true); assert.equal(session.claimNotification(latest.id), false);
    await session.loadMore(); assert.deepEqual(session.getSnapshot().notification, latest, "loading old pages cannot create a new notification");
    head = page([message(1, { notify: false })], { latestUnreadNotification: null }); await session.refresh();
    assert.equal(session.getSnapshot().notification, null);
    const raw = cache.getItem(mailNotificationKey(owner)); assert.ok(raw); assert.equal(raw.includes("Письмо"), false);
    assert.equal(createMailNotificationLedger(owner, cache).claim(latest), false, "reload cannot repeat the same alert");
    assert.equal(createMailNotificationLedger(other, cache).claim(latest), true, "one account's metadata cannot suppress another account's own letter");
  } finally { stop(); }
});

test("notification metadata stays bounded and old unread notifications remain suppressed after ID eviction", () => {
  const cache = storage(), ledger = createMailNotificationLedger(owner, cache);
  for (let index = 1; index <= MAIL_NOTIFICATION_LIMIT + 20; index++) assert.equal(ledger.claim({ id: message(index).id,
    createdAt: new Date(Date.parse(instant) + index * 1000).toISOString() }), true);
  const saved = JSON.parse(cache.getItem(mailNotificationKey(owner)));
  assert.equal(saved.ids.length, MAIL_NOTIFICATION_LIMIT); assert.equal(ledger.claim({ id: message(1).id, createdAt: instant }), false);
  assert.deepEqual(Object.keys(saved).sort(), ["ids", "owner", "version", "watermark"]);
});

test("foreign successful responses and lost authorization clear the retained inbox before notifying its parent", async () => {
  for (const foreign of [true, false]) {
    let broken = false, lost = 0;
    const session = createMailboxSession(owner, { list: async () => {
      if (!broken) return page();
      if (foreign) return page([], { ownerPublicId: other });
      throw new ApiError("Войдите", 401);
    }, read: async () => assert.fail() }, () => { lost++; assert.deepEqual(session.getSnapshot().messages, []); });
    const stop = session.activate(); await session.refresh(); broken = true; await session.refresh();
    assert.equal(lost, 1); assert.equal(session.getSnapshot().opened, false); assert.equal(session.isActive(), false); stop();
  }
});
