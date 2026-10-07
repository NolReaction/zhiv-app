import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { createRecoveryAttemptStore, RECOVERY_ATTEMPT_KEY, RECOVERY_ATTEMPT_TTL_MS, recoveryAttemptRejected } =
  await vite.ssrLoadModule("/features/account/recovery-attempt.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const { createRecoveryCode } = await vite.ssrLoadModule("/lib/recovery-code.ts");
after(() => vite.close());

function storage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
const codeA = "ZHIV-R1-" + "A".repeat(43), codeB = "ZHIV-R1-" + "B".repeat(43);

test("a consumed code with a lost response survives dialog recreation and reload with the same receipt", async () => {
  identities.resetDevStoreForTests();
  const owner = identities.createDevIdentity("Восстановление", crypto.randomUUID());
  const code = createRecoveryCode(), cache = storage();
  assert.equal(identities.activateDevRecoveryCode(owner.token, code).kind, "ok");
  const first = await createRecoveryAttemptStore(cache).prepare(code);
  assert.ok(cache.getItem(RECOVERY_ATTEMPT_KEY), "receipt exists before POST can consume the code");
  const accepted = identities.redeemDevRecoveryCode(code, first.retrySecret);
  assert.ok(accepted);
  assert.equal(identities.getDevIdentity(owner.token), null);
  assert.equal(identities.redeemDevRecoveryCode(code, "X".repeat(43)), null, "old behavior loses access after consumption");
  // Drop both response and Set-Cookie, then recreate the browser-side controller.
  const afterReload = await createRecoveryAttemptStore(cache).prepare(" " + code + " ");
  assert.equal(afterReload.retrySecret, first.retrySecret);
  const replay = identities.redeemDevRecoveryCode(code, afterReload.retrySecret);
  assert.equal(replay.token, accepted.token, "retry returns the original session, not another recovery");
  assert.equal(replay.me.user.publicId, owner.me.user.publicId);
  const saved = cache.getItem(RECOVERY_ATTEMPT_KEY);
  assert.ok(!saved.includes(code) && !saved.includes("ZHIV-R1-"), "raw code is never persisted");
  assert.match(JSON.parse(saved).attempts[0].fingerprint, /^[a-f0-9]{64}$/);
});

test("retries never extend the ten minute window and expired receipts are removed", async () => {
  let now = 10_000;
  const cache = storage(), session = createRecoveryAttemptStore(cache, () => now);
  const first = await session.prepare(codeA);
  now += RECOVERY_ATTEMPT_TTL_MS - 1;
  const retry = await createRecoveryAttemptStore(cache, () => now).prepare(codeA);
  assert.equal(retry.retrySecret, first.retrySecret);
  assert.equal(retry.createdAt, first.createdAt);
  now++;
  session.prune();
  assert.equal(cache.getItem(RECOVERY_ATTEMPT_KEY), null);
  assert.notEqual((await session.prepare(codeA)).retrySecret, first.retrySecret);
});

test("different codes stay separate and rejecting a mistyped code preserves the original unknown operation", async () => {
  const cache = storage(), session = createRecoveryAttemptStore(cache);
  const original = await session.prepare(codeA), other = await session.prepare(codeB);
  assert.notEqual(other.retrySecret, original.retrySecret);
  session.clear(other);
  const reloaded = createRecoveryAttemptStore(cache);
  assert.equal((await reloaded.prepare(codeA)).retrySecret, original.retrySecret);
  assert.notEqual((await reloaded.prepare(codeB)).retrySecret, other.retrySecret);
  session.clear(original);
  assert.ok(!cache.getItem(RECOVERY_ATTEMPT_KEY)?.includes(original.retrySecret));
});

test("a late success cannot clear a newer receipt for the same code", async () => {
  let now = 1_000;
  const cache = storage(), session = createRecoveryAttemptStore(cache, () => now);
  const first = await session.prepare(codeA);
  now += RECOVERY_ATTEMPT_TTL_MS;
  const next = await session.prepare(codeA);
  session.clear(first);
  assert.equal((await createRecoveryAttemptStore(cache, () => now).prepare(codeA)).retrySecret, next.retrySecret);
});

test("success clears its receipt; only definitive recovery refusals discard an uncertain request", async () => {
  const cache = storage(), session = createRecoveryAttemptStore(cache);
  const attempt = await session.prepare(codeA);
  session.clear(attempt);
  assert.equal(cache.getItem(RECOVERY_ATTEMPT_KEY), null);
  for (const error of [new TypeError("Connection lost"), new ApiError("Bad gateway", 502),
    new ApiError("Retry", 429), new ApiError("Timeout", 408), new ApiError("Proxy auth", 401),
    new ApiError("Origin rejected", 403, { code: "UNTRUSTED_ORIGIN", message: "Origin rejected" })]) {
    assert.equal(recoveryAttemptRejected(error), false);
  }
  for (const status of [400, 401]) assert.equal(recoveryAttemptRejected(new ApiError("Invalid", status,
    { code: "INVALID_CODE", message: "Invalid" })), true);
  assert.equal(recoveryAttemptRejected(new ApiError("Banned", 403,
    { code: "ACCOUNT_BANNED", message: "Banned" })), true);
});

test("unavailable storage or hashing keeps recovery working in memory without persisting the code", async () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  for (const [cache, digest] of [[blocked, undefined], [storage(), async () => null], [undefined, undefined]]) {
    const session = createRecoveryAttemptStore(cache, Date.now, digest);
    const first = await session.prepare(codeA), retry = await session.prepare(codeA);
    assert.equal(first.persisted, false);
    assert.equal(retry.retrySecret, first.retrySecret);
    assert.ok(!cache?.data?.size);
  }
});

test("corrupt, foreign and future records cannot supply a secret or preserve a raw code", async () => {
  const fixtureReceiptToken = Buffer.from(new Uint8Array(32).fill(65)).toString("base64url");
  const valid = { version: 1, attempts: [{ fingerprint: "a".repeat(64), retrySecret: fixtureReceiptToken, createdAt: 2_000 }] };
  for (const raw of ["{broken", JSON.stringify({ version: 2, attempts: [] }),
    JSON.stringify({ ...valid, attempts: [{ ...valid.attempts[0], code: codeA }] }), JSON.stringify(valid)]) {
    const cache = storage(); cache.setItem(RECOVERY_ATTEMPT_KEY, raw);
    const session = createRecoveryAttemptStore(cache, () => 1_000);
    session.prune();
    assert.equal(cache.getItem(RECOVERY_ATTEMPT_KEY), null);
    const next = await session.prepare(codeA);
    assert.notEqual(next.retrySecret, fixtureReceiptToken);
  }
});

test("pending receipts are bounded and creating/pruning the store never sends a recovery request", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Unexpected request"); });
  const cache = storage(), session = createRecoveryAttemptStore(cache);
  session.prune();
  for (const character of ["A", "B", "C", "D"]) await session.prepare("ZHIV-R1-" + character.repeat(43));
  assert.equal(JSON.parse(cache.getItem(RECOVERY_ATTEMPT_KEY)).attempts.length, 3);
  assert.equal(requests, 0);
  await assert.rejects(session.prepare("invalid"), /Проверьте код/);
});
