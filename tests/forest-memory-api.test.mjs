import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const initialMode = process.env.NODE_ENV;
const vite = await createServer({
  appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": "\0forest-memory-test-cookie" } }, server: { middlewareMode: true, hmr: false },
  plugins: [{
    name: "forest-memory-test-cookie",
    resolveId(id) { if (id === "\0forest-memory-test-cookie") return id; },
    load(id) {
      if (id === "\0forest-memory-test-cookie") return "export async function cookies() { return { get() { return { value: globalThis.__forestMemoryTestToken }; } }; }";
    },
  }],
});
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const memory = await vite.ssrLoadModule("/lib/dev/forest-memory-store.ts");
const model = await vite.ssrLoadModule("/features/world/forest-memory-model.ts");
const { GET } = await vite.ssrLoadModule("/app/api/v1/world/forest-memory/route.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/world/forest-memory/commands/route.ts");
const { readDevForestMemoryBody } = await vite.ssrLoadModule("/lib/dev/forest-memory-route.ts");
const { getDevWorld } = await vite.ssrLoadModule("/lib/dev/world-store.ts");
const now = Date.now();
beforeEach(() => { identities.resetDevStoreForTests(); process.env.NODE_ENV = "test"; delete globalThis.__forestMemoryTestToken; });
after(async () => {
  delete globalThis.__forestMemoryTestToken;
  if (initialMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  await vite.close();
});

function player(key = crypto.randomUUID()) {
  return { ...identities.createDevIdentity("Explorer", key), clientId: crypto.randomUUID(), key };
}
function payload(energy = 0.7) {
  return {
    version: 1, sceneId: "tiled-forest", fingerprint: "geometry-v1",
    mind: { elapsed: 150, needs: { energy, curiosity: 0.6, comfort: 0.8, attention: 0.5 }, attentionUntil: 160,
      recent: [{ key: "bush:1", action: "bush", outcome: "completed", at: 120, duration: 4 }] },
    hero: { position: { x: 120, y: 240 }, sleepingHome: false, awakeFor: 10, restFor: 2,
      recent: [{ id: "clearing", activity: "look", age: 20 }] },
    mushrooms: [{ id: "mushroom:1", position: { x: 100, y: 200 }, growth: 0.5, regrowIn: 12 }],
  };
}
const query = p => ({ expectedOwnerPublicId: p.me.user.publicId, clientId: p.clientId });
const read = (p, time = now) => memory.readDevForestMemory(p.token, query(p), time);
function command(p, action = "acquire", overrides = {}, time = now) {
  return { ownerPublicId: p.me.user.publicId, clientId: p.clientId, requestId: crypto.randomUUID(),
    expectedRevision: read(p, time).revision, action, ...overrides };
}
const issue = (p, action = "acquire", overrides = {}, time = now) => memory.commandDevForestMemory(p.token, command(p, action, overrides, time), time);
function getRequest(p, suffix = "") {
  return new Request(`http://localhost:3000/api/v1/world/forest-memory?${new URLSearchParams(query(p))}${suffix}`);
}
function postRequest(body, headers = {}) {
  return new Request("http://localhost:3000/api/v1/world/forest-memory/commands", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("account memory round trip is validated, immutable and independent of economy", () => {
  const p = player();
  const initial = read(p);
  assert.equal(initial.revision, 0); assert.equal(initial.snapshot, null); assert.equal(initial.updatedAt, null);
  assert.deepEqual(initial.lease, { owned: false, expiresAt: null, token: null });
  const economy = getDevWorld(p.token, now);
  const acquired = issue(p);
  assert.equal(acquired.state.revision, 1);
  const snapshot = payload();
  const saved = issue(p, "save", { leaseToken: acquired.state.lease.token, snapshot }, now + 10_000);
  assert.ok(model.forestMemoryResultSchema.safeParse(saved).success);
  assert.equal(saved.acceptedRevision, 2);
  assert.equal(saved.state.updatedAt, new Date(now + 10_000).toISOString());
  assert.equal(Date.parse(saved.state.lease.expiresAt), now + 100_000);
  snapshot.mind.needs.energy = 0;
  saved.state.snapshot.hero.position.x = 0;
  assert.equal(read(p).snapshot.mind.needs.energy, 0.7);
  assert.equal(read(p).snapshot.hero.position.x, 120);
  assert.deepEqual(getDevWorld(p.token, now), economy);
  const released = issue(p, "release", { leaseToken: acquired.state.lease.token }, now + 20_000);
  assert.equal(released.state.revision, 3); assert.equal(released.state.lease.owned, false);
  assert.deepEqual(released.state.snapshot, payload());
});

test("leases bind session and client, require explicit takeover and prevent old writes", () => {
  const desktop = player(), phone = player(desktop.key), tab = { ...desktop, clientId: crypto.randomUUID() };
  const acquired = issue(desktop), leaseToken = acquired.state.lease.token;
  const staleSave = command(desktop, "save", { leaseToken, snapshot: payload(0.2) });
  for (const other of [phone, tab]) {
    assert.equal(read(other).lease.owned, false); assert.equal(read(other).lease.token, null);
    assert.throws(() => issue(other), { code: "FOREST_MEMORY_ACTIVE_ELSEWHERE" });
    assert.throws(() => issue(other, "save", { leaseToken, snapshot: payload() }), { code: "FOREST_MEMORY_LEASE_LOST" });
  }
  const transfer = issue(phone, "acquire", { takeover: true }, now + 1_000);
  assert.notEqual(transfer.state.lease.token, leaseToken);
  assert.throws(() => memory.commandDevForestMemory(desktop.token, staleSave, now + 2_000), { code: "FOREST_MEMORY_REVISION_CONFLICT" });
  assert.throws(() => issue(desktop, "save", { leaseToken, snapshot: payload() }, now + 2_000), { code: "FOREST_MEMORY_LEASE_LOST" });
  assert.throws(() => issue(desktop, "release", { leaseToken }, now + 2_000), { code: "FOREST_MEMORY_LEASE_LOST" });
  const saved = issue(phone, "save", { leaseToken: transfer.state.lease.token, snapshot: payload(0.9) }, now + 3_000);
  assert.equal(read(desktop, now + 4_000).snapshot.mind.needs.energy, 0.9);
  assert.equal(saved.state.revision, 3);
});

test("lease expiry rotates token, read never renews and live same-writer acquire keeps token", () => {
  const p = player(), first = issue(p);
  const renewed = issue(p, "acquire", {}, now + 10_000);
  assert.equal(renewed.state.lease.token, first.state.lease.token);
  assert.equal(renewed.state.revision, 2);
  assert.equal(read(p, now + 99_999).lease.expiresAt, renewed.state.lease.expiresAt);
  assert.deepEqual(read(p, now + 100_000).lease, { owned: false, expiresAt: null, token: null });
  assert.throws(() => issue(p, "save", { leaseToken: first.state.lease.token, snapshot: payload() }, now + 100_000), { code: "FOREST_MEMORY_LEASE_LOST" });
  const next = issue(p, "acquire", {}, now + 100_000);
  assert.notEqual(next.state.lease.token, first.state.lease.token);
});

test("lost-response replay returns latest state and original revision without replaying or renewing", () => {
  const p = player(), acquire = command(p), first = memory.commandDevForestMemory(p.token, acquire, now);
  const save = command(p, "save", { leaseToken: first.state.lease.token, snapshot: payload(0.3) });
  const saved = memory.commandDevForestMemory(p.token, save, now + 1_000);
  const latest = issue(p, "save", { leaseToken: first.state.lease.token, snapshot: payload(0.8) }, now + 2_000);
  const replay = memory.commandDevForestMemory(p.token, save, now + 10_000);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, saved.acceptedRevision);
  assert.equal(replay.state.revision, latest.state.revision);
  assert.equal(replay.state.snapshot.mind.needs.energy, 0.8);
  assert.equal(replay.state.lease.expiresAt, latest.state.lease.expiresAt);
  const other = player(p.key);
  assert.throws(() => memory.commandDevForestMemory(other.token, save, now + 10_000), { code: "FOREST_MEMORY_REQUEST_CONFLICT" });
  assert.throws(() => memory.commandDevForestMemory(p.token, { ...save, snapshot: payload(0.9) }, now + 10_000), { code: "FOREST_MEMORY_REQUEST_CONFLICT" });
  issue(p, "release", { leaseToken: first.state.lease.token }, now + 11_000);
  const oldAcquire = memory.commandDevForestMemory(p.token, acquire, now + 12_000);
  assert.equal(oldAcquire.replayed, true); assert.equal(oldAcquire.state.lease.owned, false);
});

test("only 64 command receipts remain and pruned requests cannot resurrect stale state", () => {
  const p = player(), acquire = command(p);
  const first = memory.commandDevForestMemory(p.token, acquire, now);
  let last;
  for (let index = 0; index < 64; index++) {
    last = command(p, "save", { leaseToken: first.state.lease.token, snapshot: payload(index / 100) });
    memory.commandDevForestMemory(p.token, last, now + index);
  }
  assert.throws(() => memory.commandDevForestMemory(p.token, acquire, now + 1_000), { code: "FOREST_MEMORY_REVISION_CONFLICT" });
  assert.equal(memory.commandDevForestMemory(p.token, last, now + 1_000).replayed, true);
  assert.equal(read(p).snapshot.mind.needs.energy, 0.63);
});

test("foreign accounts and missing sessions cannot read or write another account's memory", () => {
  const owner = player(), stranger = player();
  const acquire = command(owner);
  assert.throws(() => memory.readDevForestMemory(undefined, query(owner)), { code: "UNAUTHORIZED", status: 401 });
  assert.throws(() => memory.commandDevForestMemory(undefined, acquire), { code: "UNAUTHORIZED", status: 401 });
  assert.throws(() => memory.readDevForestMemory(stranger.token, query(owner)), { code: "FOREST_MEMORY_ACCOUNT_CHANGED" });
  assert.throws(() => memory.commandDevForestMemory(stranger.token, acquire), { code: "FOREST_MEMORY_ACCOUNT_CHANGED" });
  issue(owner);
  assert.equal(read(stranger).revision, 0);
});

test("recovery preserves snapshot, invalidates old session and allows immediate new writer", () => {
  const p = player(), first = issue(p);
  issue(p, "save", { leaseToken: first.state.lease.token, snapshot: payload() });
  const code = "forest-memory-test-recovery", retrySecret = "forest-memory-test-retry";
  identities.activateDevRecoveryCode(p.token, code);
  const recovered = identities.redeemDevRecoveryCode(code, retrySecret);
  assert.ok(recovered);
  assert.throws(() => read(p), { code: "UNAUTHORIZED" });
  const next = { ...p, token: recovered.token, clientId: crypto.randomUUID() };
  assert.equal(read(next).snapshot.mind.needs.energy, 0.7);
  assert.equal(read(next).lease.expiresAt, null);
  const acquired = issue(next);
  assert.notEqual(acquired.state.lease.token, first.state.lease.token);
});

test("identity reset also removes forest snapshots and receipts", () => {
  const p = player(), first = issue(p);
  issue(p, "save", { leaseToken: first.state.lease.token, snapshot: payload() });
  assert.ok(globalThis.__zhivDevForestMemory.size);
  identities.resetDevStoreForTests();
  assert.equal(globalThis.__zhivDevForestMemory, undefined);
  assert.throws(() => read(p), { code: "UNAUTHORIZED" });
  assert.equal(read(player(p.key)).snapshot, null);
});

test("snapshot schema rejects oversized, duplicate, future and injected gameplay data", () => {
  const p = player(), first = issue(p);
  const invalid = [];
  const modify = mutation => { const value = payload(); mutation(value); invalid.push(value); };
  modify(value => { value.resources = { sparks: 9999 }; });
  modify(value => { value.mind.needs.energy = NaN; });
  modify(value => { value.mind.attentionUntil = 181; });
  modify(value => { value.mind.recent[0].at = 151; });
  modify(value => { value.mind.elapsed = 500; });
  modify(value => { value.hero.position.x = -1; });
  modify(value => { value.mushrooms.push(value.mushrooms[0]); });
  modify(value => { value.sceneId = "invalid\nscene"; });
  modify(value => { value.mushrooms = Array.from({ length: 128 }, (_, i) => ({ ...value.mushrooms[0], id: `${i}${"я".repeat(150)}` })); });
  for (const snapshot of invalid) {
    assert.throws(() => issue(p, "save", { leaseToken: first.state.lease.token, snapshot }), { code: "INVALID_FOREST_MEMORY", status: 400 });
    assert.equal(read(p).revision, 1); assert.equal(read(p).snapshot, null);
  }
  assert.throws(() => issue(p, "acquire", { snapshot: payload() }), { code: "INVALID_FOREST_MEMORY" });
  assert.throws(() => issue(p, "save", { leaseToken: first.state.lease.token, snapshot: payload(), takeover: true }), { code: "INVALID_FOREST_MEMORY" });
});

test("HTTP routes authenticate and reject duplicate query keys, owner mismatch and malformed bodies", async () => {
  const p = player();
  assert.equal((await GET(getRequest(p))).status, 401);
  assert.equal((await POST(postRequest(command(p)))).status, 401);
  globalThis.__forestMemoryTestToken = p.token;
  const initial = await GET(getRequest(p));
  assert.equal(initial.status, 200); assert.equal(initial.headers.get("Cache-Control"), "no-store");
  assert.ok(model.forestMemoryViewSchema.safeParse(await initial.json()).success);
  assert.equal((await GET(getRequest(p, `&clientId=${p.clientId}`))).status, 400);
  assert.equal((await GET(getRequest(p, "&extra=1"))).status, 400);
  assert.equal((await GET(getRequest(player()))).status, 409);
  assert.equal((await POST(postRequest("{"))).status, 400);
  assert.equal((await POST(postRequest({ ...command(p), extra: true }))).status, 400);
  const acquired = await POST(postRequest(command(p)));
  assert.equal(acquired.status, 200); assert.equal(acquired.headers.get("Cache-Control"), "no-store");
  assert.ok(model.forestMemoryResultSchema.safeParse(await acquired.json()).success);
});

test("HTTP gates close production first and bound both declared and actual UTF-8 body length", async () => {
  const p = player();
  globalThis.__forestMemoryTestToken = p.token;
  process.env.NODE_ENV = "production";
  for (const response of [await GET(getRequest(p)), await POST(postRequest(command(p)))]) {
    assert.equal(response.status, 503); assert.equal((await response.json()).code, "DEV_API_DISABLED");
  }
  process.env.NODE_ENV = "test";
  assert.equal((await POST(postRequest(command(p), { Origin: "https://foreign.test" }))).status, 403);
  assert.equal((await POST(postRequest(command(p), { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(postRequest("{}", { "Content-Length": "65537" }))).status, 413);
  const response = await POST(postRequest(`"${"я".repeat(32_768)}"`, { "Content-Length": "1" }));
  assert.equal(response.status, 413); assert.equal((await response.json()).code, "BODY_TOO_LARGE");
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(32_768)); },
    cancel() { cancelled = true; },
  });
  const streamed = await readDevForestMemoryBody(new Request("http://localhost/", { method: "POST", body, duplex: "half" }));
  assert.equal(streamed.response.status, 413); assert.equal(cancelled, true);
});
