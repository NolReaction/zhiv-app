import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), initialMode = process.env.NODE_ENV;
const cookieModule = "\0economy-test-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false },
  plugins: [{ name: "economy-test-cookie", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies() { return { get() { return { value: globalThis.__economyTestToken }; } }; }"; } }],
});
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/model.ts");
const { GET } = await vite.ssrLoadModule("/app/api/v1/economy/route.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/economy/commands/route.ts");
const { GET: marketGET } = await vite.ssrLoadModule("/app/api/v1/economy/market/route.ts");
const { POST: marketPOST } = await vite.ssrLoadModule("/app/api/v1/economy/market/commands/route.ts");
beforeEach(() => { identities.resetDevStoreForTests(); process.env.NODE_ENV = "test"; delete globalThis.__economyTestToken; });
after(async () => {
  delete globalThis.__economyTestToken;
  if (initialMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  await vite.close();
});
function player() { const p = identities.createDevIdentity("Explorer", crypto.randomUUID()); globalThis.__economyTestToken = p.token; return p; }
function command(p) { const s = economy.getDevEconomy(p.token); return { requestId: crypto.randomUUID(), ownerPublicId: s.ownerPublicId, expectedRevision: s.revision, action: "start_production", targetId: "grow_berries", quantity: 1, totalPrice: 0 }; }
const read = (path = "") => new Request(`http://localhost:3000/api/v1/economy${path}`);
function post(body, headers = {}, suffix = "/commands") {
  return new Request(`http://localhost:3000/api/v1/economy${suffix}`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("local economy routes require account cookies and never cache private state", async () => {
  assert.equal((await GET(read())).status, 401); assert.equal((await marketGET(read("/market"))).status, 401);
  const p = player(), response = await GET(read());
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json(); assert.equal(body.ownerPublicId, p.me.user.publicId); assert.equal(model.economyViewSchema.safeParse(body).success, true);
  assert.equal((await GET(read("?ownerPublicId=someone"))).status, 400);
});

test("POST validates payload then atomically replays its original receipt", async () => {
  const p = player(), cmd = command(p);
  const response = await POST(post(cmd)); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(model.economyResultSchema.safeParse(result).success, true); assert.equal(result.replayed, false);
  const repeated = await (await POST(post(cmd))).json(); assert.equal(repeated.replayed, true); assert.equal(repeated.state.jobs.length, 1);
  const conflict = await POST(post({ ...cmd, quantity: 2 })); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, "ECONOMY_REQUEST_CONFLICT");
});

test("HTTP rejects every mining route at an unbuilt quarry without spending or issuing a receipt", async () => {
  const p = player();
  economy.getDevEconomy(p.token);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.buildings = Object.fromEntries(model.economyCatalog.buildings.map(building => [building.id, 5]));
  row.state.buildings.quarry = 0;
  row.state.wallet.coins = 500_000;
  row.state.inventory = { tools: 10, rope: 10, dried_berries: 10, smoked_fish: 10 };
  const before = structuredClone((await (await GET(read())).json()));
  for (const route of model.economyCatalog.explorations.filter(route => route.activity === "mining")) {
    const cmd = { ...command(p), action: "start_exploration", targetId: route.id };
    // A retry of a rejected request is rejected again, rather than replaying a success.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await POST(post(cmd));
      assert.equal(response.status, 409, route.id);
      assert.equal((await response.json()).code, "ECONOMY_BUILDING_REQUIRED", route.id);
    }
    const after = await (await GET(read())).json();
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.wallet, before.wallet);
    assert.deepEqual(after.inventory, before.inventory);
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.progression, before.progression);
  }
});

test("HTTP builds and claims warehouse ten from earned low-home progress using only relics", async () => {
  const p = player();
  economy.getDevEconomy(p.token);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.buildings = { home: 1, warehouse: 9 };
  const target = model.economyCatalog.buildings.find(building => building.id === "warehouse").levels.at(-1);
  row.state.inventory = { ...target.cost.items };
  row.state.wallet = { coins: 0, pearls: 0 };
  const order = { ...command(p), action: "start_construction", targetId: "warehouse" };
  const response = await POST(post(order));
  assert.equal(response.status, 200);
  const started = await response.json();
  assert.equal(model.economyResultSchema.safeParse(started).success, true);
  assert.equal(started.state.jobs[0].targetLevel, 10);
  assert.equal(started.state.storage.capacity, 8200);
  assert.deepEqual(started.state.wallet, { coins: 0, pearls: 0 });
  assert.deepEqual(started.state.inventory, {});
  assert.equal((await (await POST(post(order))).json()).replayed, true);
  // Advance only this fixture's valid saved interval; the client sends no time or capacity.
  const finishedAt = Date.now() - 1000;
  row.state.jobs[0].startedAt = new Date(finishedAt - target.seconds * 1000).toISOString();
  row.state.jobs[0].finishesAt = new Date(finishedAt).toISOString();
  const claim = { ...command(p), action: "claim_job", targetId: row.state.jobs[0].id };
  const claimedResponse = await POST(post(claim));
  assert.equal(claimedResponse.status, 200);
  const claimed = await claimedResponse.json();
  assert.equal(model.economyResultSchema.safeParse(claimed).success, true);
  assert.equal(claimed.state.buildings.home, 1);
  assert.equal(claimed.state.buildings.warehouse, 10);
  assert.equal(claimed.state.storage.capacity, 10000);
  assert.deepEqual(claimed.state.jobs, []);
  const repeated = await (await POST(post(claim))).json();
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.state.revision, claimed.state.revision);
  const maximum = await POST(post({ ...command(p), action: "start_construction", targetId: "warehouse" }));
  assert.equal(maximum.status, 409);
  assert.equal((await maximum.json()).code, "ECONOMY_MAX_LEVEL");
});

test("cross-site writes and wrong content types cannot change economy", async () => {
  const p = player(), cmd = command(p), before = economy.getDevEconomy(p.token);
  for (const headers of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await POST(post(cmd, headers))).status, 403);
    assert.equal((await marketPOST(post({ ...cmd, action: "create_listing", targetId: "wood", totalPrice: 40 }, headers, "/market/commands"))).status, 403);
  }
  assert.equal((await POST(post(cmd, { "Content-Type": "text/plain" }))).status, 415);
  const after = economy.getDevEconomy(p.token); assert.equal(after.revision, before.revision); assert.deepEqual(after.inventory, before.inventory);
});

test("HTTP cancellation confirms the forfeiture once and replay never restores or rewards the trip", async () => {
  const p = player();
  const start = { ...command(p), action: "start_exploration", targetId: "shore" };
  const started = await (await POST(post(start))).json();
  const cancel = { ...command(p), action: "cancel_exploration", targetId: started.state.jobs[0].id };
  assert.equal((await POST(post(cancel, { Origin: "https://foreign.example" }))).status, 403);
  assert.equal((await POST(post({ ...cancel, refund: true }))).status, 400);
  const response = await POST(post(cancel));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(model.economyResultSchema.safeParse(result).success, true);
  assert.deepEqual(result.state.jobs, []);
  assert.deepEqual(result.state.inventory, started.state.inventory);
  assert.deepEqual(result.state.wallet, started.state.wallet);
  assert.equal(result.state.completedExplorations, started.state.completedExplorations);
  const replay = await (await POST(post(cancel))).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.acceptedRevision, result.acceptedRevision);
  assert.equal(replay.state.revision, result.state.revision);
  const claim = await POST(post({ ...command(p), action: "claim_job", targetId: cancel.targetId }));
  assert.equal(claim.status, 409);
  assert.equal((await claim.json()).code, "ECONOMY_JOB_GONE");
});

test("commands reject hostile JSON shape, extra fields, fractions and body overflow", async () => {
  const p = player(), cmd = command(p);
  for (const bad of ["{broken", [], null, { ...cmd, quantity: "2" }, { ...cmd, quantity: 1.5 }, { ...cmd, pearls: 100 }, { ...cmd, action: "buy_pearls" }, { ...cmd, requestId: "not-a-receipt" }])
    assert.equal((await POST(post(bad))).status, 400);
  assert.equal((await POST(post(" ".repeat(4097)))).status, 413);
  assert.equal((await marketPOST(post(" ".repeat(2049), {}, "/market/commands"))).status, 413);
  assert.equal(economy.getDevEconomy(p.token).revision, 0);
});

test("market read validates cursor and limits, while trade requires progression and exact quantity", async () => {
  const p = player(), cmd = command(p);
  const response = await marketGET(read("/market")); assert.equal(response.status, 200); assert.equal(model.marketViewSchema.safeParse(await response.json()).success, true);
  for (const suffix of ["?limit=0", "?limit=13", "?limit=51", "?limit=3.5", "?limit=1&limit=2", "?cursor=", "?cursor=bad", "?other=1"])
    assert.equal((await marketGET(read(`/market${suffix}`))).status, 400);
  const locked = await marketPOST(post({ ...cmd, action: "create_listing", targetId: "wood", totalPrice: 40 }, {}, "/market/commands"));
  assert.equal(locked.status, 409); assert.equal((await locked.json()).code, "ECONOMY_MARKET_LOCKED");
  assert.equal((await marketPOST(post({ ...cmd, action: "create_listing", targetId: "wood", quantity: 1.5, totalPrice: 40 }, {}, "/market/commands"))).status, 400);
});

test("the in-memory economy cannot accidentally become the deployed backend", async () => {
  const p = player(), cmd = command(p); process.env.NODE_ENV = "production";
  for (const response of [await GET(read()), await POST(post(cmd)), await marketGET(read("/market")), await marketPOST(post(cmd, {}, "/market/commands"))]) {
    assert.equal(response.status, 503); assert.equal((await response.json()).code, "DEV_API_DISABLED");
  }
});
