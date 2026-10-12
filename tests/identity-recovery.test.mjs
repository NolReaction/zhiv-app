import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createIdentityRecovery } = await vite.ssrLoadModule("/features/app/identity-recovery.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const identity = { user: { publicId: "7K3P-2Q9M-W8ZR" } };
const drain = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function fixture(t, load) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const state = { online: true, visible: true, calls: [], failures: [], identities: [], loading: 0 };
  const recovery = createIdentityRecovery({
    load: signal => { state.calls.push(signal); return load(signal, state.calls.length); },
    isOnline: () => state.online,
    isVisible: () => state.visible,
    onLoading: () => state.loading++,
    onIdentity: value => state.identities.push(value),
    onFailure: (error, attempted) => state.failures.push({ error, attempted }),
  });
  t.after(() => recovery.dispose());
  return { state, recovery, tick: async ms => { t.mock.timers.tick(ms); await drain(); } };
}

test("startup recovers from network failure and timeout with bounded backoff", async t => {
  const { state, recovery, tick } = fixture(t, async (_signal, attempt) => {
    if (attempt === 1) throw new TypeError("Failed to fetch");
    if (attempt === 2) throw new DOMException("Request timed out", "TimeoutError");
    return identity;
  });
  recovery.retry(); await drain();
  assert.equal(state.calls.length, 1);
  await tick(999); assert.equal(state.calls.length, 1);
  await tick(1); assert.equal(state.calls.length, 2);
  await tick(3_000);
  assert.deepEqual(state.identities, [identity]);
  assert.equal(state.failures.length, 2);
  assert.ok(state.failures.every(failure => failure.attempted));
  recovery.resume(); recovery.retry(); await tick(60_000);
  assert.equal(state.calls.length, 3, "successful identity stops all startup retries");
});

test("a prolonged outage keeps retrying with capped backoff until identity loads", async t => {
  let available = false;
  const { state, recovery, tick } = fixture(t, async () => {
    if (!available) throw new ApiError("Unavailable", 503);
    return identity;
  });
  recovery.retry(); await drain();
  for (const [index, delay] of [1_000, 3_000, 8_000, 15_000, 15_000].entries()) {
    recovery.resume(); recovery.resume();
    await tick(delay - 1);
    assert.equal(state.calls.length, index + 1, "foreground events cannot bypass the pending retry");
    await tick(1);
    assert.equal(state.calls.length, index + 2);
  }
  available = true;
  await tick(15_000);
  assert.equal(state.calls.length, 7);
  assert.deepEqual(state.identities, [identity]);
  await tick(60_000);
  assert.equal(state.calls.length, 7, "successful identity ends recurring recovery");
});

test("a queued retry stops on offline state and resumes with one read after reconnect", async t => {
  const { state, recovery, tick } = fixture(t, async (_signal, attempt) => {
    if (attempt === 1) throw new TypeError("Failed to fetch");
    return identity;
  });
  recovery.retry(); await drain();
  state.online = false;
  await tick(1_000); await tick(60_000);
  assert.equal(state.calls.length, 1, "no network read is attempted while offline");
  assert.equal(state.failures.at(-1).attempted, false);
  state.online = true;
  recovery.resume(); recovery.resume(); recovery.retry(); await drain();
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.identities, [identity]);
});

test("hidden page pauses recurring retry timers until a visible resume", async t => {
  const { state, recovery, tick } = fixture(t, async (_signal, attempt) => {
    if (attempt === 1) throw new ApiError("Unavailable", 503);
    return identity;
  });
  recovery.retry(); await drain();
  state.visible = false; recovery.pause();
  await tick(60_000); recovery.resume(); await drain();
  assert.equal(state.calls.length, 1);
  state.visible = true;
  recovery.resume(); recovery.resume(); await drain();
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.identities, [identity]);
});

test("offline startup waits for connectivity without emitting a failed request", async t => {
  const { state, recovery, tick } = fixture(t, async () => identity);
  state.online = false;
  recovery.retry(); await tick(60_000);
  assert.equal(state.calls.length, 0);
  assert.equal(state.failures[0].attempted, false);
  state.online = true;
  recovery.resume(); recovery.resume(); await drain();
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.identities, [identity]);
});

test("invalid session settles as unauthenticated without automatic account creation", async t => {
  const { state, recovery, tick } = fixture(t, async () => null);
  recovery.retry(); await drain();
  recovery.resume(); recovery.retry(); await tick(60_000);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.identities, [null]);
  assert.deepEqual(state.failures, []);
});

test("permanent account failures do not auto-retry on timers or foreground events", async t => {
  const error = new ApiError("Account banned", 403, { code: "ACCOUNT_BANNED", message: "Account banned" });
  const { state, recovery, tick } = fixture(t, async () => { throw error; });
  recovery.retry(); await drain();
  recovery.resume(); await tick(60_000);
  assert.equal(state.calls.length, 1);
  assert.equal(state.failures[0].error, error);
  recovery.retry(); await drain();
  assert.equal(state.calls.length, 2, "explicit user retry remains available");
});

test("a permanent failure after a transient outage stops recurring retries", async t => {
  const { state, recovery, tick } = fixture(t, async (_signal, attempt) => {
    if (attempt < 3) throw new ApiError("Unavailable", 503);
    throw new ApiError("Account banned", 403, { code: "ACCOUNT_BANNED", message: "Account banned" });
  });
  recovery.retry(); await drain(); await tick(1_000); await tick(3_000);
  recovery.resume(); await tick(60_000);
  assert.equal(state.calls.length, 3);
  assert.equal(state.failures.at(-1).error.status, 403);
});

test("Retry-After is respected even across manual retry and suspension", async t => {
  const { state, recovery, tick } = fixture(t, async (_signal, attempt) => {
    if (attempt === 1) throw new ApiError("Rate limited", 429, undefined, undefined, 15_000);
    return identity;
  });
  recovery.retry(); await drain(); await tick(1_000);
  recovery.retry(); recovery.pause(); recovery.resume(); await tick(13_999);
  assert.equal(state.calls.length, 1);
  await tick(1);
  assert.deepEqual(state.identities, [identity]);
});

test("hidden page cancels startup and ignores an old response after a newer resume", async t => {
  const pending = [];
  const { state, recovery } = fixture(t, signal => new Promise(resolve => pending.push({ signal, resolve })));
  recovery.retry(); recovery.resume(); await drain();
  assert.equal(pending.length, 1);
  state.visible = false; recovery.pause(); recovery.resume(); await drain();
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending.length, 1);
  state.visible = true; recovery.resume(); await drain();
  pending[1].resolve(identity); await drain();
  pending[0].resolve(null); await drain();
  assert.deepEqual(state.identities, [identity], "stale null cannot overwrite the current account");
  assert.deepEqual(state.failures, []);
});

test("large Retry-After cannot overflow the browser timer into an immediate retry", async t => {
  const { state, recovery, tick } = fixture(t, async () => {
    throw new ApiError("Rate limited", 429, undefined, undefined, 3_000_000_000);
  });
  recovery.retry(); await drain();
  await tick(2_147_483_647);
  assert.equal(state.calls.length, 1);
  recovery.retry(); await tick(1_000);
  assert.equal(state.calls.length, 1);
});

test("unmount cancels an in-flight request and never reports intentional cancellation", async t => {
  const { state, recovery, tick } = fixture(t, signal => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
  }));
  recovery.retry(); await drain(); recovery.dispose(); await drain();
  recovery.resume(); recovery.retry(); await tick(60_000);
  assert.equal(state.calls[0].aborted, true);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.identities, []);
});
