import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const api = await vite.ssrLoadModule("/lib/check-in-api.ts");
const auth = await vite.ssrLoadModule("/lib/auth-api.ts");
const { retryAfterMs } = await vite.ssrLoadModule("/lib/request-deadline.ts");
const requestId = "2ef7601b-548a-4eae-8cdb-16f7f5294ce1";
const waitForAbort = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("caller-owned cancellation cannot disable the deadline for people, groups or calendar", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals = [];
  t.mock.method(globalThis, "fetch", (_, init) => { signals.push(init.signal); return waitForAbort(init.signal); });
  const controller = new AbortController();
  const requests = [api.getPeople(controller.signal), api.getGroups(controller.signal), api.getCheckInCalendar(null, controller.signal)];
  const rejected = requests.map(request => assert.rejects(request, { name: "TimeoutError" }));
  t.mock.timers.tick(7999);
  assert.ok(signals.every(signal => !signal.aborted));
  t.mock.timers.tick(1);
  await Promise.all(rejected);
  assert.equal(signals.length, 3);
  assert.equal(controller.signal.aborted, false, "the caller's controller is not mutated");
});

test("startup getMe supports cancellation before and during fetch without losing the abort reason", async t => {
  const caller = new AbortController(), reason = new DOMException("Page hidden", "AbortError");
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_, init) => { calls++; return waitForAbort(init.signal); });
  const running = api.getMe(caller.signal);
  const rejected = assert.rejects(running, error => error === reason);
  caller.abort(reason);
  await rejected;
  await assert.rejects(api.getMe(caller.signal), error => error === reason);
  assert.equal(calls, 1, "an already cancelled request never reaches fetch");
});

test("a deadline while reading the identity body stays a timeout instead of a fabricated schema502", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reading = false;
  t.mock.method(globalThis, "fetch", async (_, init) => ({
    ok: true, status: 200, headers: new Headers({ "Content-Type": "application/json", "X-Request-ID": requestId }),
    json: () => { reading = true; return waitForAbort(init.signal); },
  }));
  const request = api.getMe(), rejected = assert.rejects(request, { name: "TimeoutError" });
  await Promise.resolve();
  assert.equal(reading, true);
  t.mock.timers.tick(8000);
  await rejected;
});

test("completed requests clear their deadline and detach caller cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController(), remove = t.mock.method(caller.signal, "removeEventListener");
  let signal;
  t.mock.method(globalThis, "fetch", async (_, init) => {
    signal = init.signal;
    return Response.json({ code: "UNAUTHORIZED", message: "Sign in" }, { status: 401 });
  });
  assert.equal(await api.getMe(caller.signal), null);
  assert.equal(remove.mock.callCount(), 1);
  t.mock.timers.tick(30_000);
  caller.abort();
  assert.equal(signal.aborted, false);
});

test("identity and auth work without AbortSignal.timeout and expose retry limits plus correlation IDs", async t => {
  t.mock.method(AbortSignal, "timeout", undefined);
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ code: "RATE_LIMITED", message: "Wait" }, { status: 429,
      headers: { "Retry-After": "12", "X-Request-ID": requestId } });
  });
  const check = error => error instanceof api.ApiError && error.status === 429 && error.retryAfterMs === 12_000 && error.requestId === requestId;
  await assert.rejects(api.getMe(), check);
  await assert.rejects(auth.startAuth("email", "login", "fixture@example.test"), check);
  assert.equal(calls, 2, "an uncertain auth mutation is never replayed by transport");
});

test("invalid successful JSON retains the request ID for both API and auth diagnosis", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ wrong: true }, { headers: { "X-Request-ID": requestId } }));
  const check = error => error instanceof api.ApiError && error.status === 502 && error.requestId === requestId;
  await assert.rejects(api.getMe(), check);
  await assert.rejects(auth.getAuthOptions(), check);
});

test("Retry-After accepts seconds and HTTP dates without producing NaN delays", () => {
  const now = Date.parse("2026-10-01T13:00:00Z");
  assert.equal(retryAfterMs("1.5", now), 1500);
  assert.equal(retryAfterMs("Thu, 01 Oct 2026 13:00:12 GMT", now), 12_000);
  assert.equal(retryAfterMs("Thu, 01 Oct 2026 12:00:00 GMT", now), 0);
  assert.equal(retryAfterMs(null, now), undefined);
  assert.equal(retryAfterMs(" ", now), undefined);
  assert.equal(retryAfterMs("unavailable", now), undefined);
});
