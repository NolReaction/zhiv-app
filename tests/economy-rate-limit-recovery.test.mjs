import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:economy-recovery-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "economy-recovery-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { for (const slot of slots) slot.cleanup?.(); slots = []; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useMemo(factory, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) slots[i] = { value: factory(), deps }; return slots[i].value; }
      export function useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = value; }]; }
      export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
      export function useEffect(callback, deps) { const i = cursor++, previous = slots[i]; if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; }); }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/sync/use-economy.ts")) return source.replace('from "react";', `from "${hooksId}";`); },
  }] });
const hooks = await vite.ssrLoadModule(hooksId);
after(() => { hooks.reset(); return vite.close(); });
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { useEconomy } = await vite.ssrLoadModule("/features/economy/sync/use-economy.ts");
const { getEconomy, sendEconomyCommand } = await vite.ssrLoadModule("/features/economy/sync/api.ts");
const { economyCatalog, economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const { setGamePresence, gamePresenceHeaders } = await vite.ssrLoadModule("/features/activity/transport-state.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", time = Date.parse("2026-10-22T03:00:00.000Z");
const state = (revision = 0, ownerPublicId = owner) => economyViewSchema.parse({ ownerPublicId, revision, serverTime: new Date(time).toISOString(),
  wallet: { coins: 1000, pearls: 0 }, inventory: { wood: 3, berries: 3 },
  buildings: { home: 5, garden: 3, woodlot: 3, workshop: 3, warehouse: 1, dryer: 3, kiln: 3 }, productionSlots: { garden: 3, workshop: 3 },
  storage: { capacity: 50, used: 6, reserved: 0, available: 44, overflow: 0 }, jobs: [],
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, completedExplorations: 0, catalog: economyCatalog });
const result = snapshot => ({ state: snapshot, message: "Готово", acceptedRevision: snapshot.revision, replayed: false });
const transport = overrides => ({ get: async () => state(), send: async () => result(state(1)), market: async () => assert.fail(), trade: async () => assert.fail(), ...overrides });
const command = () => ({ requestId: crypto.randomUUID(), ownerPublicId: owner, expectedRevision: 0, action: "start_construction", targetId: "home", quantity: 1, totalPrice: 0 });
const limited = delay => new ApiError("Сервер попросил сделать паузу.", 429, { code: "RATE_LIMITED", message: "Сервер попросил сделать паузу." }, undefined, delay);
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function storage() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; }
function globalValue(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; });
}

for (const body of ["", "Too Many Requests", "<html>Too many requests</html>", '{"message":"wait"}']) {
  test(`HTTP 429 with ${JSON.stringify(body)} preserves the full cooldown without calling it a network failure`, async t => {
    const requestId = crypto.randomUUID(), presence = crypto.randomUUID();
    setGamePresence(presence); t.after(() => setGamePresence(null));
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 429, headers: { "Retry-After": "2051", "X-Request-ID": requestId } }));
    await assert.rejects(sendEconomyCommand(command()), error => {
      assert.ok(error instanceof ApiError); assert.equal(error.status, 429);
      assert.equal(error.body.code, "RATE_LIMITED"); assert.match(error.message, /Сервер.*паузу/);
      assert.doesNotMatch(error.message, /связ|сеть|соединен/i);
      assert.equal(error.retryAfterMs, 2_051_000); assert.equal(error.requestId, requestId);
      return true;
    });
    assert.equal(gamePresenceHeaders()["X-Game-Presence"], presence, "a rate limit is not a lost game lease");
  });
}

test("valid JSON 429 keeps the server error and supports HTTP-date Retry-After", async t => {
  t.mock.method(Date, "now", () => time);
  const body = { code: "ECONOMY_RATE_LIMITED", message: "Подождите перед следующим действием." };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status: 429, headers: { "Retry-After": new Date(time + 1_323_000).toUTCString() } }));
  await assert.rejects(getEconomy(), error => {
    assert.deepEqual(error.body, body); assert.equal(error.message, body.message); assert.equal(error.retryAfterMs, 1_323_000); return true;
  });
});

test("missing or malformed Retry-After stays unknown; fractional and expired dates remain valid", async t => {
  t.mock.method(Date, "now", () => time);
  for (const [header, expected] of [[undefined, undefined], ["", undefined], ["later", undefined], ["1.5", 1500], [new Date(time - 1000).toUTCString(), 0]]) {
    t.mock.method(globalThis, "fetch", async () => new Response("", { status: 429, headers: header === undefined ? {} : { "Retry-After": header } }));
    await assert.rejects(getEconomy(), error => { assert.equal(error.retryAfterMs, expected); return true; });
  }
});

test("other HTTP and transport failures keep their distinct errors", async t => {
  for (const status of [403, 409, 500]) {
    const body = { code: "ECONOMY_UNAVAILABLE", message: "Действие пока недоступно." };
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status }));
    await assert.rejects(getEconomy(), error => { assert.equal(error.status, status); assert.deepEqual(error.body, body); assert.equal(error.message, body.message); return true; });
  }
  t.mock.method(globalThis, "fetch", async () => new Response("upstream unavailable", { status: 502 }));
  await assert.rejects(getEconomy(), error => { assert.equal(error.body, undefined); assert.equal(error.message, "Не удалось связаться с хозяйством"); return true; });
  const network = new TypeError("Failed to fetch");
  t.mock.method(globalThis, "fetch", async () => { throw network; });
  await assert.rejects(getEconomy(), error => error === network);
});

test("a long server wait retries the same construction receipt once at its deadline, including visibility pauses", async t => {
  let clock = 0, reads = 0; t.mock.method(performance, "now", () => clock);
  const cache = storage(), sent = [], answer = deferred();
  const session = createEconomySession(owner, transport({ get: async () => { reads++; return state(); }, send: async value => {
    sent.push(structuredClone(value)); if (sent.length === 1) throw limited(2_051_000); return answer.promise;
  } }), () => assert.fail("429 must not end the session"), cache);
  t.after(session.activate()); await session.refresh();
  assert.equal(session.act("start_construction", "home"), true); await flush();
  assert.equal(session.getSnapshot().rateLimited, true); assert.equal(session.getSnapshot().uncertain, true);
  assert.equal(session.getSnapshot().retryAt - session.now(), 2_051_000); assert.equal(cache.data.size, 1);
  session.setAvailable(false); clock = 1_800_000; session.setAvailable(true);
  for (let i = 0; i < 30; i++) { await session.retryThrottled(); await session.retry(); await session.refreshSoft(); }
  assert.equal(sent.length, 1); assert.equal(reads, 1, "polling also respects the cooldown");
  clock = 2_050_999; await session.retryThrottled(); assert.equal(sent.length, 1);
  clock++; const retry = session.retryThrottled();
  for (let i = 0; i < 30; i++) { await session.retryThrottled(); await session.retry(); }
  assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
  assert.equal(session.getSnapshot().busy, true); assert.equal(session.getSnapshot().rateLimited, false);
  answer.resolve(result(state(1))); await retry;
  assert.equal(session.getSnapshot().uncertain, false); assert.equal(session.getSnapshot().syncPending, false); assert.equal(cache.data.size, 0);
});

test("a repeated 429 establishes a fresh full wait; a later network failure retains the receipt without an automatic retry loop", async t => {
  let clock = 0; t.mock.method(performance, "now", () => clock);
  const sent = [], cache = storage();
  const session = createEconomySession(owner, transport({ send: async value => {
    sent.push(structuredClone(value));
    if (sent.length === 1) throw limited(2000);
    if (sent.length === 2) throw limited(30_000);
    throw new TypeError("Failed to fetch");
  } }), () => assert.fail(), cache);
  t.after(session.activate()); await session.refresh(); session.act("start_construction", "home"); await flush();
  clock = 2000; await session.retryThrottled(); assert.equal(sent.length, 2);
  assert.equal(session.getSnapshot().retryAt - session.now(), 30_000);
  clock = 31_999; await session.retryThrottled(); assert.equal(sent.length, 2);
  clock++; await session.retryThrottled(); assert.equal(sent.length, 3);
  assert.equal(session.getSnapshot().rateLimited, false); assert.equal(session.getSnapshot().uncertain, true); assert.equal(cache.data.size, 1);
  for (let i = 0; i < 120; i++) { clock += 1000; await session.retryThrottled(); }
  assert.equal(sent.length, 3); assert.deepEqual(sent[2], sent[0]);
});

test("a poll that is throttled at a pending command's deadline publishes the full extended wait and preserves its receipt", async t => {
  let clock = 0, reads = 0; t.mock.method(performance, "now", () => clock);
  const sent = [], cache = storage();
  const session = createEconomySession(owner, transport({
    get: async () => {
      if (++reads > 1) throw new ApiError("Пауза чтения", 429, { code: "RATE_LIMITED", message: "Пауза чтения" }, undefined, 1_323_000);
      return state();
    },
    send: async value => { sent.push(structuredClone(value)); if (sent.length === 1) throw limited(2000); return result(state(1)); },
  }), () => assert.fail(), cache);
  t.after(session.activate()); await session.refresh(); session.act("start_construction", "home"); await flush();
  const original = session.getSnapshot(), receipt = [...cache.data.values()][0];
  clock = 2000; await session.refresh();
  assert.equal(reads, 2); assert.equal(session.getSnapshot().rateLimited, true);
  assert.equal(session.getSnapshot().retryAt - session.now(), 1_323_000, "the displayed deadline follows the newly enforced server wait");
  assert.equal(session.getSnapshot().error, original.error); assert.equal(session.getSnapshot().syncError, original.syncError);
  assert.equal([...cache.data.values()][0], receipt); assert.equal(session.getSnapshot().uncertain, true);
  for (let i = 0; i < 10; i++) { await session.retryThrottled(); await session.retry(); }
  assert.equal(sent.length, 1);
  clock += 1_322_999; await session.retryThrottled(); assert.equal(sent.length, 1);
  clock++; await session.retryThrottled();
  assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
  assert.equal(session.getSnapshot().uncertain, false); assert.equal(session.getSnapshot().rateLimited, false);
});

test("a throttled GET cannot enable automatic recovery for an ordinary unknown network receipt", async t => {
  let clock = 0, reads = 0; t.mock.method(performance, "now", () => clock);
  const sent = [], cache = storage();
  const session = createEconomySession(owner, transport({
    get: async () => { if (++reads > 1) throw limited(30_000); return state(); },
    send: async value => { sent.push(structuredClone(value)); if (sent.length === 1) throw new TypeError("Failed to fetch"); return result(state(1)); },
  }), () => assert.fail(), cache);
  t.after(session.activate()); await session.refresh(); session.act("start_construction", "home"); await flush();
  const original = session.getSnapshot(), receipt = [...cache.data.values()][0];
  await session.refresh();
  assert.equal(session.getSnapshot().rateLimited, false); assert.equal(session.getSnapshot().error, original.error);
  assert.equal([...cache.data.values()][0], receipt); assert.equal(session.getSnapshot().uncertain, true);
  await session.retryThrottled(); await session.retry(); assert.equal(sent.length, 1, "manual recovery also honors the GET cooldown");
  clock = 30_000;
  for (let i = 0; i < 10; i++) await session.retryThrottled();
  assert.equal(sent.length, 1, "GET throttling cannot turn an unknown write into automatic work");
  await session.retry(); assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
});

test("429 without a usable server deadline waits a minute; explicit rejection never retries automatically", async t => {
  let clock = 0; t.mock.method(performance, "now", () => clock);
  const sent = [], cache = storage();
  const session = createEconomySession(owner, transport({ send: async value => {
    sent.push(value); if (sent.length === 1) throw limited(undefined);
    throw new ApiError("Недостаточно материалов", 409, { code: "ECONOMY_RESOURCES", message: "Недостаточно материалов" });
  } }), () => assert.fail(), cache);
  t.after(session.activate()); await session.refresh(); session.act("start_construction", "home"); await flush();
  assert.equal(session.getSnapshot().retryAt - session.now(), 60_000);
  clock = 59_999; await session.retryThrottled(); assert.equal(sent.length, 1);
  clock++; await session.retryThrottled(); assert.equal(sent.length, 2);
  assert.equal(session.getSnapshot().rateLimited, false); assert.equal(session.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
  for (let i = 0; i < 10; i++) await session.retryThrottled();
  assert.equal(sent.length, 2); assert.match(session.getSnapshot().error, /Недостаточно/);
});

test("paused, deactivated, or different-owner sessions cannot send a throttled receipt", async t => {
  let clock = 0; t.mock.method(performance, "now", () => clock);
  const sent = [], cache = storage();
  const wire = transport({ send: async value => { sent.push(value); if (sent.length === 1) throw limited(1000); return result(state(1)); } });
  const session = createEconomySession(owner, wire, () => assert.fail(), cache), stop = session.activate();
  await session.refresh(); session.act("start_construction", "home"); await flush(); clock = 2000;
  session.setAvailable(false); await session.retryThrottled(); assert.equal(sent.length, 1);
  stop(); session.setAvailable(true); await session.retryThrottled(); assert.equal(sent.length, 1);
  const foreign = createEconomySession(other, wire, () => assert.fail(), cache); t.after(foreign.activate());
  await foreign.retryThrottled(); assert.equal(sent.length, 1); assert.equal(foreign.getSnapshot().syncPending, false);
  t.after(session.activate()); await session.retryThrottled(); assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
});

test("queued production keeps its receipt and full 429 wait before draining once", async t => {
  let clock = 0; t.mock.method(performance, "now", () => clock);
  const sent = [], journal = storage();
  const session = createEconomySession(owner, transport({ send: async value => {
    sent.push(structuredClone(value)); if (sent.length === 1) throw limited(2_051_000); return result(state(1));
  } }), () => assert.fail(), undefined, { storage: journal, coordinate: async () => () => {} });
  t.after(session.activate()); await session.refresh();
  assert.equal(session.act("start_production", "grow_berries"), true); await flush();
  assert.equal(session.getSnapshot().pendingProductionCount, 1); assert.equal(session.getSnapshot().rateLimited, true);
  assert.equal(session.getSnapshot().error, null); assert.match(session.getSnapshot().syncError, /Сервер/);
  clock = 2_050_999;
  for (let i = 0; i < 20; i++) await session.refreshSoft();
  assert.equal(sent.length, 1); assert.equal(JSON.parse([...journal.data.values()][0]).entries[0].requestId, sent[0].requestId);
  clock++; await session.refreshSoft();
  assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
  assert.equal(session.getSnapshot().pendingProductionCount, 0); assert.equal(session.getSnapshot().rateLimited, false);
});

test("the real economy hook only resumes a throttled command while visible, online, enabled, and still owned", async t => {
  hooks.reset(); t.after(() => hooks.reset());
  let clock = 0; t.mock.method(performance, "now", () => clock);
  const timers = new Map(), kickoff = new Map(), sent = [], answer = deferred();
  const document = new EventTarget(); document.hidden = false;
  const window = new EventTarget(); window.sessionStorage = storage();
  const navigator = { onLine: true };
  globalValue(t, "document", document); globalValue(t, "window", window); globalValue(t, "navigator", navigator);
  t.mock.method(globalThis, "setInterval", (callback, delay) => { const id = {}; timers.set(id, { callback, delay }); return id; });
  t.mock.method(globalThis, "clearInterval", id => timers.delete(id));
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { if (delay !== 0) return realTimeout(callback, delay); const id = {}; kickoff.set(id, callback); return id; });
  t.mock.method(globalThis, "clearTimeout", id => { if (!kickoff.delete(id)) realClear(id); });
  t.mock.method(globalThis, "fetch", async (_path, options) => {
    if (options.method === "GET") return Response.json(state());
    sent.push(JSON.parse(options.body));
    if (sent.length === 1) return new Response("", { status: 429, headers: { "Retry-After": "2" } });
    await answer.promise; return Response.json(result(state(1)));
  });
  const onSessionLost = () => assert.fail();
  const Render = (enabled = true, identity = owner) => { hooks.render(); const view = useEconomy(identity, onSessionLost, enabled); hooks.flush(); return view; };
  const tick = async () => { for (const timer of timers.values()) if (timer.delay === 1000) timer.callback(); await flush(); };
  let view = Render(); for (const callback of kickoff.values()) callback(); kickoff.clear(); await flush();
  view = Render(); assert.ok(view.snapshot); view.act("start_construction", "home"); await flush();
  assert.equal(Render().rateLimited, true);
  clock = 2000; document.hidden = true; await tick(); assert.equal(sent.length, 1);
  document.hidden = false; navigator.onLine = false; await tick(); assert.equal(sent.length, 1);
  navigator.onLine = true; Render(false); await tick(); assert.equal(sent.length, 1);
  Render(true); await tick(); assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
  for (let i = 0; i < 10; i++) await tick(); assert.equal(sent.length, 2, "only one recovery is in flight");
  Render(true, other); answer.resolve(); await flush(); await tick();
  assert.equal(sent.length, 2, "changing account cannot resend the previous owner's receipt");
  assert.equal(Render(true, other).uncertain, false);
  hooks.reset(); assert.equal(timers.size, 0, "unmount removes the retry clock");
});
