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
const { commandDevPresence } = await vite.ssrLoadModule("/lib/dev/activity-store.ts");
const activePresence = new Map();
function enterGame(p) {
  const id = crypto.randomUUID();
  commandDevPresence(p.me.user.publicId, { kind: "resume", presenceId: id, sequence: 0, active: true }, Date.now(), p.token);
  activePresence.set(p.token, id);
  return p;
}

const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { GET } = await vite.ssrLoadModule("/app/api/v1/economy/route.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/economy/commands/route.ts");
const { GET: marketGET } = await vite.ssrLoadModule("/app/api/v1/economy/market/route.ts");
const { POST: marketPOST } = await vite.ssrLoadModule("/app/api/v1/economy/market/commands/route.ts");
beforeEach(() => { identities.resetDevStoreForTests(); activePresence.clear(); process.env.NODE_ENV = "test"; delete globalThis.__economyTestToken; });
after(async () => {
  delete globalThis.__economyTestToken;
  if (initialMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  await vite.close();
});
function player() { const p = enterGame(identities.createDevIdentity("Explorer", crypto.randomUUID())); globalThis.__economyTestToken = p.token; return p; }
function command(p) { const s = economy.getDevEconomy(p.token); return { requestId: crypto.randomUUID(), ownerPublicId: s.ownerPublicId, expectedRevision: s.revision, action: "start_production", targetId: "grow_berries", quantity: 1, totalPrice: 0 }; }
const read = (path = "") => new Request(`http://localhost:3000/api/v1/economy${path}`);
function post(body, headers = {}, suffix = "/commands") {
  return new Request(`http://localhost:3000/api/v1/economy${suffix}`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...(activePresence.has(globalThis.__economyTestToken) ? { "X-Game-Presence": activePresence.get(globalThis.__economyTestToken) } : {}), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
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

test("HTTP fishSelection cooks exact owned species, binds its receipt and keeps old clients compatible", async () => {
  const p = player();
  economy.getDevEconomy(p.token);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  Object.assign(row.state.buildings, { home: 3, dryer: 2, warehouse: 10 });
  row.state.productionSlots = { dryer: 3 };
  row.state.progression.recipes.cook_grilled_fish = 1;
  // Actual old species inventory is ownership proof, separate from lifetime catches.
  row.state.inventory = { fish_silverfin: 2, fish_rudd: 2, berries: 1, charcoal: 1 };
  row.state.fishing.catches = { fish_sturgeon: 100 };
  const before = await (await GET(read())).json();
  assert.deepEqual(before.fishing.stock, { fish_silverfin: 2, fish_rudd: 2 });
  const cmd = { ...command(p), targetId: "cook_fish_soup", fishSelection: { fish_silverfin: 1, fish_rudd: 1 } };
  const response = await POST(post(cmd));
  assert.equal(response.status, 200);
  const started = await response.json();
  assert.equal(model.economyResultSchema.safeParse(started).success, true);
  assert.deepEqual(started.state.inventory, { fish_common: 2 });
  assert.deepEqual(started.state.fishing.stock, { fish_silverfin: 1, fish_rudd: 1 });
  assert.deepEqual(started.state.fishing.catches, before.fishing.catches);
  assert.deepEqual(started.state.jobs[0].cost.items, { fish_common: 2, berries: 1, charcoal: 1 });
  assert.deepEqual(started.state.jobs[0].fishStockCost, cmd.fishSelection);

  const repeatedResponse = await POST(post({ ...cmd, fishSelection: { fish_rudd: 1, fish_silverfin: 1 } }));
  assert.equal(repeatedResponse.status, 200);
  const repeated = await repeatedResponse.json();
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.acceptedRevision, started.acceptedRevision);
  assert.deepEqual(repeated.state.inventory, started.state.inventory);
  assert.deepEqual(repeated.state.fishing.stock, started.state.fishing.stock);
  assert.deepEqual(repeated.state.jobs, started.state.jobs);

  const changed = await POST(post({ ...cmd, fishSelection: { fish_rudd: 2 } }));
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, "ECONOMY_REQUEST_CONFLICT");
  for (const fishSelection of [{}, { fish_silverfin: 2 }, { fish_sturgeon: 1 }]) {
    const invalid = await POST(post({ ...command(p), targetId: "cook_grilled_fish", fishSelection }));
    assert.equal(invalid.status, 409);
    assert.equal((await invalid.json()).code, "ECONOMY_FISH_SELECTION_CHANGED");
    const unchanged = await (await GET(read())).json();
    assert.equal(unchanged.revision, started.state.revision);
    assert.deepEqual(unchanged.wallet, started.state.wallet);
    assert.deepEqual(unchanged.inventory, started.state.inventory);
    assert.deepEqual(unchanged.fishing, started.state.fishing);
    assert.deepEqual(unchanged.jobs, started.state.jobs);
  }

  const legacy = await POST(post({ ...command(p), targetId: "cook_grilled_fish" }));
  assert.equal(legacy.status, 200);
  const automatic = await legacy.json();
  assert.equal(automatic.state.inventory.fish_common, 1);
  assert.deepEqual(automatic.state.fishing.stock, { fish_rudd: 1 });
  assert.deepEqual(automatic.state.fishing.catches, before.fishing.catches);
  assert.equal(automatic.state.jobs.length, 2);
});

test("HTTP obsolete starter gift remains owner-bound and repeated requests cannot mint any cost", async () => {
  const p = player(), before = economy.getDevEconomy(p.token);
  const cmd = { ...command(p), action: "claim_workshop_starter", targetId: "workshop" };
  assert.equal((await POST(post({ ...cmd, coins: 999999 }))).status, 400);
  const other = identities.createDevIdentity("Other", crypto.randomUUID());
  assert.equal((await POST(post({ ...cmd, ownerPublicId: other.me.user.publicId }))).status, 409);
  for (const payload of [cmd, cmd, { ...cmd, requestId: crypto.randomUUID() }]) {
    const response = await POST(post(payload)); assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "ECONOMY_WORKSHOP_STARTER_UNAVAILABLE");
    assert.deepEqual({ ...economy.getDevEconomy(p.token), serverTime: before.serverTime }, before);
  }
  const loaded = await (await GET(read())).json();
  assert.equal(loaded.workshopStarterClaimed, false); assert.deepEqual(loaded.wallet, before.wallet); assert.deepEqual(loaded.inventory, before.inventory);
});

test("gameplay requires a live session even for receipt replay and explicit return preserves the original command", async () => {
  const p = player(), cmd = command(p), before = economy.getDevEconomy(p.token);
  for (const id of ["", crypto.randomUUID()]) {
    const response = await POST(post(cmd, { "X-Game-Presence": id }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "GAME_SESSION_INACTIVE");
  }
  assert.equal(economy.getDevEconomy(p.token).revision, before.revision);
  const first = await (await POST(post(cmd))).json();
  commandDevPresence(p.me.user.publicId, { kind: "suspend", presenceId: activePresence.get(p.token), sequence: 1, active: false }, Date.now(), p.token);
  const denied = await POST(post(cmd));
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, "GAME_SESSION_INACTIVE");
  enterGame(p);
  const recovered = await (await POST(post(cmd))).json();
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.acceptedRevision, first.acceptedRevision);
  assert.deepEqual(recovered.state.wallet, first.state.wallet);
  assert.deepEqual(recovered.state.jobs, first.state.jobs);
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

test("HTTP gates warehouse two at home two and keeps warehouse three independent while preserving paid costs and one builder", async () => {
  const p = player();
  economy.getDevEconomy(p.token);
  const row = globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
  row.state.buildings = { ...row.state.buildings, home: 1, warehouse: 1, workshop: 0 };
  const targets = model.economyCatalog.buildings.find(building => building.id === "warehouse").levels.slice(1, 3);
  for (const target of targets) {
    row.state.inventory = { ...target.cost.items, wood: 2 };
    row.state.wallet = { coins: target.cost.coins, pearls: 0 };
    if (target.level === 2) {
      const before = structuredClone(row.state), revision = row.revision, receipts = row.receipts.size;
      const blocked = await POST(post({ ...command(p), action: "start_construction", targetId: "warehouse" }));
      assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "ECONOMY_HOME_REQUIRED");
      assert.deepEqual(row.state, before); assert.equal(row.revision, revision); assert.equal(row.receipts.size, receipts);
    }
    row.state.buildings.home = target.level === 2 ? 2 : 1;
    const buildings = structuredClone(row.state.buildings);
    const order = { ...command(p), action: "start_construction", targetId: "warehouse" };
    const response = await POST(post(order));
    assert.equal(response.status, 200);
    const started = await response.json(), job = started.state.jobs[0];
    assert.equal(model.economyResultSchema.safeParse(started).success, true);
    assert.equal(job.targetLevel, target.level); assert.deepEqual(job.cost, target.cost);
    assert.equal(Date.parse(job.finishesAt) - Date.parse(job.startedAt), target.seconds * 1000);
    assert.deepEqual(started.state.buildings, { ...buildings, warehouse: target.level - 1 });
    assert.deepEqual(started.state.inventory, { wood: 2 }); assert.deepEqual(started.state.wallet, { coins: 0, pearls: 0 });
    assert.equal((await (await POST(post(order))).json()).replayed, true);
    const busy = await POST(post({ ...command(p), action: "start_construction", targetId: "warehouse" }));
    assert.equal(busy.status, 409); assert.equal((await busy.json()).code, "ECONOMY_CONSTRUCTION_BUSY");
    const tooSoon = await POST(post({ ...command(p), action: "claim_job", targetId: job.id }));
    assert.equal(tooSoon.status, 409); assert.equal((await tooSoon.json()).code, "ECONOMY_JOB_NOT_READY");
    // Move only the valid saved interval; no client command supplies time, levels or capacity.
    const finishedAt = Date.now() - 1000;
    row.state.jobs[0].startedAt = new Date(finishedAt - target.seconds * 1000).toISOString();
    row.state.jobs[0].finishesAt = new Date(finishedAt).toISOString();
    const claim = { ...command(p), action: "claim_job", targetId: job.id };
    const claimedResponse = await POST(post(claim));
    assert.equal(claimedResponse.status, 200);
    const claimed = await claimedResponse.json();
    assert.equal(model.economyResultSchema.safeParse(claimed).success, true);
    assert.deepEqual(claimed.state.buildings, { ...buildings, warehouse: target.level });
    assert.equal(claimed.state.storage.capacity, target.warehouseCapacity);
    assert.deepEqual(claimed.state.inventory, { wood: 2 }); assert.deepEqual(claimed.state.jobs, []);
    const repeated = await (await POST(post(claim))).json();
    assert.equal(repeated.replayed, true); assert.equal(repeated.state.revision, claimed.state.revision);
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
  assert.equal(started.state.storage.capacity, 450);
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
  assert.equal(claimed.state.storage.capacity, 500);
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
