import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createDevBotSession } = await vite.ssrLoadModule("/features/world/dev/dev-bot-session.ts");
const { getDevBots, sendDevBotCommand } = await vite.ssrLoadModule("/features/world/dev/dev-bot-api.ts");
const { setGamePresence } = await vite.ssrLoadModule("/features/activity/transport-state.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", botId = crypto.randomUUID();
const snapshot = (ownerPublicId = owner) => ({ ownerPublicId, serverTime: "2026-10-19T00:00:00Z", maxBots: 5, bots: [] });
const result = (ownerPublicId = owner) => ({ snapshot: snapshot(ownerPublicId), botId, message: "Бот изменён", replayed: false });
const action = { action: "grant_item", botId, itemId: "wood", quantity: 2 };
const fullCommand = () => ({ ...action, ownerPublicId: owner, requestId: crypto.randomUUID() });
const receiptKey = id => `zhiv:dev:bots:pending:v1:${id}`;
function storage() { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k), data }; }
const transport = overrides => ({ get: async id => snapshot(id), send: async () => result(), ...overrides });
const fetchBefore = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchBefore; setGamePresence(null); });

test("lost bot mutation ACK survives panel closure and reload with the exact request and one grant", async () => {
  const cache = storage(), sent = [], accepted = new Set(); let grants = 0;
  const t = transport({ send: async command => {
    sent.push(structuredClone(command));
    if (!accepted.has(command.requestId)) { accepted.add(command.requestId); grants++; throw Error("ACK lost"); }
    return { ...result(), replayed: true };
  } });
  const first = createDevBotSession(owner, t, cache), stop = first.activate(); await first.refresh();
  assert.equal(await first.command(action), null);
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(cache.data.size, 1);
  await first.command({ action: "create", displayName: "Двойник", homeLevel: 2 });
  assert.equal(sent.length, 1); stop();
  const next = createDevBotSession(owner, t, cache); next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().uncertain, true);
  assert.equal((await next.retry()).replayed, true);
  assert.deepEqual(sent[1], sent[0]); assert.equal(grants, 1);
  assert.equal(next.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
});

test("bot writes have one synchronous lock and cannot be overwritten by a pre-write read", async () => {
  let finishRead, finishWrite, slow = false, calls = 0;
  const session = createDevBotSession(owner, transport({
    get: id => slow ? new Promise(resolve => { finishRead = () => resolve(snapshot(id)); }) : Promise.resolve(snapshot(id)),
    send: async () => { calls++; return new Promise(resolve => { finishWrite = () => resolve({ ...result(), message: "Latest write" }); }); },
  }));
  session.activate(); await session.refresh(); slow = true;
  const reading = session.refresh();
  // Loading blocks a new form action until the read is finished.
  assert.equal(await session.command(action), null); finishRead(); await reading;
  const writing = session.command(action); await session.command(action); await session.retry();
  assert.equal(calls, 1); assert.equal(session.getSnapshot().busy, true);
  finishWrite(); await writing; assert.equal(session.getSnapshot().notice, "Latest write");
  assert.equal(session.getSnapshot().busy, false);
});

test("closing a panel discards late responses and keeps the pending mutation recoverable", async () => {
  const cache = storage(); let complete;
  const session = createDevBotSession(owner, transport({ send: () => new Promise(resolve => { complete = () => resolve(result()); }) }), cache);
  const stop = session.activate(); await session.refresh();
  const writing = session.command(action); stop(); complete(); await writing;
  assert.equal(session.getSnapshot().snapshot, null); assert.equal(cache.data.size, 1);
  assert.equal(session.getSnapshot().busy, false);
});

test("pending commands are scoped to the current account, including copied or damaged storage", async () => {
  const cache = storage(), pending = fullCommand(); let sends = 0;
  cache.setItem(receiptKey(owner), JSON.stringify(pending));
  cache.setItem(receiptKey(other), JSON.stringify(pending));
  const session = createDevBotSession(other, transport({ send: async () => { sends++; return result(other); } }), cache);
  session.activate(); await session.refresh(); await session.retry();
  assert.equal(sends, 0); assert.equal(session.getSnapshot().uncertain, false);
  assert.equal(cache.getItem(receiptKey(other)), null); assert.ok(cache.getItem(receiptKey(owner)));
});

test("definitive rejection permits correction while an unbound result requires the same request", async () => {
  let wrong = false, sends = 0;
  const session = createDevBotSession(owner, transport({ send: async () => { sends++; if (!wrong) throw new ApiError("Цена недопустима", 400); return result(other); } }));
  session.activate(); await session.refresh(); await session.command(action);
  assert.equal(session.getSnapshot().uncertain, false);
  wrong = true; await session.command(action);
  assert.equal(session.getSnapshot().uncertain, true); await session.command(action); assert.equal(sends, 2);
});

test("offline and invalid actions never create deferred writes", async () => {
  let online = true, sends = 0;
  const cache = storage(), session = createDevBotSession(owner, transport({ send: async () => { sends++; return result(); } }), cache, () => online);
  session.activate(); await session.refresh(); online = false;
  await session.command(action); assert.equal(sends, 0); assert.equal(cache.data.size, 0);
  online = true; await session.command({ ...action, quantity: -1 }); assert.equal(sends, 0);
});

test("DEV transport binds responses and sends presence, cookies and an exact JSON command", async () => {
  const command = fullCommand(); let called;
  setGamePresence("presence-for-bot-test");
  globalThis.fetch = async (url, options) => { called = { url, options }; return Response.json(result()); };
  assert.deepEqual(await sendDevBotCommand(command), result());
  assert.equal(called.url, "/api/v1/dev/bots"); assert.equal(called.options.method, "POST");
  assert.equal(called.options.cache, "no-store"); assert.equal(called.options.credentials, "same-origin");
  assert.equal(called.options.headers["X-Game-Presence"], "presence-for-bot-test");
  assert.deepEqual(JSON.parse(called.options.body), command);
  globalThis.fetch = async () => Response.json(result(other));
  await assert.rejects(sendDevBotCommand(command), { status: 502 });
  globalThis.fetch = async () => Response.json({ ...result(), botId: crypto.randomUUID() });
  await assert.rejects(sendDevBotCommand(command), { status: 502 });
});

test("bot reads reject cross-account or private-extra responses and honour cancellation", async () => {
  globalThis.fetch = async () => Response.json(snapshot(other));
  await assert.rejects(getDevBots(owner), { status: 502 });
  globalThis.fetch = async () => Response.json({ ...snapshot(), token: "never-expose-a-session" });
  await assert.rejects(getDevBots(owner), { status: 502 });
  const controller = new AbortController(); let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = () => resolve(Response.json(snapshot())); });
  const request = getDevBots(owner, controller.signal); controller.abort(); finish();
  await assert.rejects(request, { name: "AbortError" });
});
