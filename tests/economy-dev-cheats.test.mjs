import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), initialMode = process.env.NODE_ENV;
const cookieModule = "\0economy-cheats-test-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "economy-cheats-test-cookie", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies() { return { get() { return { value: globalThis.__economyCheatsTestToken }; } }; }"; } }],
});
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/model.ts");
const { economyDevCommandSchema } = await vite.ssrLoadModule("/features/economy/dev-model.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/economy/dev/route.ts");
const { POST: ordinaryPOST } = await vite.ssrLoadModule("/app/api/v1/economy/commands/route.ts");
const now = Date.now();
beforeEach(() => { identities.resetDevStoreForTests(); process.env.NODE_ENV = "development"; delete globalThis.__economyCheatsTestToken; });
after(async () => {
  delete globalThis.__economyCheatsTestToken;
  if (initialMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  await vite.close();
});
function player() { const p = identities.createDevIdentity("Тестовый житель", crypto.randomUUID()); globalThis.__economyCheatsTestToken = p.token; return p; }
const read = p => economy.getDevEconomy(p.token, now);
const command = (p, action = "grant_currency", targetId = "coins", quantity = 100) => ({
  requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p).revision, action, targetId, quantity, totalPrice: 0,
});
const cheat = (p, action, targetId, quantity = 1) => economy.commandDevEconomyCheat(p.token, command(p, action, targetId, quantity), now);
const normal = (p, action, targetId, quantity = 1, at = now) => economy.commandDevEconomy(p.token, command(p, action, targetId, quantity), at);
function post(body, headers = {}) {
  return new Request("http://localhost:3000/api/v1/economy/dev", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
function fixture(p) { read(p); return globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId); }

test("DEV currency and item grants return the real snapshot, preserve normal commands and replay once", async () => {
  const p = player(), cmd = command(p);
  const response = await POST(post(cmd)), result = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(model.economyResultSchema.safeParse(result).success, true);
  assert.equal(result.state.wallet.coins, 100); assert.equal(result.acceptedRevision, 1);
  const replay = economy.commandDevEconomyCheat(p.token, { ...cmd, requestId: cmd.requestId.toUpperCase() }, now);
  assert.equal(replay.replayed, true); assert.equal(replay.state.wallet.coins, 100); assert.equal(replay.state.revision, 1);
  assert.throws(() => economy.commandDevEconomyCheat(p.token, { ...cmd, quantity: 200 }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  cheat(p, "grant_currency", "pearls", 25);
  const granted = cheat(p, "grant_item", "berries", 400).state;
  assert.equal(granted.wallet.pearls, 25); assert.equal(granted.inventory.berries, 400);
  assert.equal(granted.storage.overflow, 200, "DEV grants explicitly permit storage overflow");
  const sold = normal(p, "sell", "berries", 10).state;
  assert.equal(sold.inventory.berries, 390); assert.equal(sold.storage.overflow, 190);
  assert.ok(sold.wallet.coins > granted.wallet.coins);
});

test("DEV API requires development, account, trusted origin, JSON and a bounded body", async () => {
  assert.equal((await POST(post({}))).status, 401);
  const p = player(), cmd = command(p), before = read(p);
  for (const headers of [{ Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }])
    assert.equal((await POST(post(cmd, headers))).status, 403);
  assert.equal((await POST(post(cmd, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(post(" ".repeat(4097)))).status, 413);
  assert.equal((await POST(post(cmd, { "Content-Length": "4097" }))).status, 413);
  for (const mode of ["test", "production", ""]) {
    process.env.NODE_ENV = mode;
    const response = await POST(post(cmd)); assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "DEV_API_DISABLED");
    assert.throws(() => economy.commandDevEconomyCheat(p.token, cmd, now), { code: "DEV_TOOLS_DISABLED" });
  }
  assert.deepEqual(read(p), before);
});

test("DEV commands cannot enter ordinary gameplay endpoints or reuse an ordinary receipt", async () => {
  const p = player(), cmd = command(p);
  assert.equal(model.economyCommandSchema.safeParse(cmd).success, false);
  assert.equal((await ordinaryPOST(post(cmd))).status, 400);
  assert.throws(() => economy.commandDevEconomy(p.token, cmd, now), { code: "INVALID_ECONOMY_COMMAND" });
  const ordinary = command(p, "start_production", "grow_berries", 1);
  economy.commandDevEconomy(p.token, ordinary, now);
  assert.throws(() => economy.commandDevEconomyCheat(p.token, { ...cmd, requestId: ordinary.requestId }, now), { code: "ECONOMY_REQUEST_CONFLICT" });
  assert.equal(read(p).wallet.coins, 0); assert.equal(read(p).jobs.length, 1);
});

test("bad actions, items, quantities, zero-level homes and extra fields cannot mutate the snapshot", async () => {
  const p = player(), base = command(p), before = read(p);
  const invalid = [null, [], { ...base, action: "erase_save" }, { ...base, action: "grant_item", targetId: "__proto__" },
    { ...base, targetId: "sparks" }, { ...base, quantity: 0 }, { ...base, quantity: -1 }, { ...base, quantity: 1.5 },
    { ...base, quantity: 1_000_001 }, { ...base, quantity: "100" }, { ...base, totalPrice: 1 }, { ...base, extra: true },
    { ...base, action: "finish_jobs", targetId: "market", quantity: 1 }, { ...base, action: "finish_jobs", targetId: "all", quantity: 2 },
    { ...base, action: "set_building_level", targetId: "home", quantity: 0 },
    { ...base, action: "set_building_level", targetId: "warehouse", quantity: 0 },
    { ...base, action: "set_building_level", targetId: "no-building", quantity: 1 },
    { ...base, action: "grant_upgrade_cost", targetId: "workshop", quantity: 2 }];
  for (const input of invalid) {
    assert.equal(economyDevCommandSchema.safeParse(input).success, false);
    assert.equal((await POST(post(input))).status, 400);
  }
  assert.equal((await POST(post("{broken"))).status, 400);
  assert.deepEqual(read(p), before);
});

test("owner switches and stale revisions fail before any change and do not poison the retry ID", () => {
  const p = player(), other = player(), stale = command(p), before = read(p);
  assert.throws(() => economy.commandDevEconomyCheat(undefined, stale, now), { code: "UNAUTHORIZED" });
  assert.throws(() => economy.commandDevEconomyCheat(other.token, stale, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.deepEqual(read(p), before);
  cheat(p, "grant_currency", "coins", 1);
  assert.throws(() => economy.commandDevEconomyCheat(p.token, stale, now), { code: "ECONOMY_REVISION_CONFLICT" });
  const fixed = economy.commandDevEconomyCheat(p.token, { ...stale, expectedRevision: read(p).revision }, now);
  assert.equal(fixed.state.wallet.coins, 101); assert.equal(fixed.replayed, false);
});

test("numeric overflow including market escrow is atomic and records no successful receipt", () => {
  const p = player(), row = fixture(p);
  row.state.wallet.coins = model.ECONOMY_MAX_BALANCE;
  row.state.wallet.pearls = model.ECONOMY_MAX_BALANCE;
  row.state.inventory.wood = model.ECONOMY_MAX_BALANCE - 2;
  globalThis.__zhivDevEconomyStore.listings.set("reserved", { id: "reserved", sellerPublicId: p.me.user.publicId,
    itemId: "wood", quantity: 2, totalPrice: 4, status: "active", createdAt: new Date(now).toISOString(), closedAt: null });
  const before = read(p), receipts = row.receipts.size;
  for (const [action, targetId] of [["grant_currency", "coins"], ["grant_currency", "pearls"], ["grant_item", "wood"]])
    assert.throws(() => cheat(p, action, targetId), { code: "ECONOMY_CAPACITY" });
  assert.deepEqual(read(p), before); assert.equal(row.receipts.size, receipts);
  row.revision = Number.MAX_SAFE_INTEGER - 1;
  const last = cheat(p, "grant_item", "berries").state; assert.equal(last.revision, Number.MAX_SAFE_INTEGER);
  const exhausted = { ...command(p, "grant_item", "berries", 1), expectedRevision: Number.MAX_SAFE_INTEGER - 1 };
  assert.throws(() => economy.commandDevEconomyCheat(p.token, exhausted, now), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.equal(read(p).inventory.berries, 1);
});

test("upgrade cost grants only the missing cost and leave prerequisite buildings and paid work intact", () => {
  const p = player(), row = fixture(p);
  const home = model.economyCatalog.buildings.find(building => building.id === "home").levels.find(level => level.level === 2);
  row.state.wallet.coins = home.cost.coins + 50;
  row.state.inventory = { wood: 500 };
  const expected = { ...row.state.inventory };
  for (const [item, amount] of Object.entries(home.cost.items)) expected[item] = Math.max(expected[item] ?? 0, amount);
  const before = read(p), granted = cheat(p, "grant_upgrade_cost", "home").state;
  assert.deepEqual(granted.inventory, expected); assert.equal(granted.wallet.coins, before.wallet.coins);
  assert.deepEqual(granted.buildings, before.buildings);
  assert.throws(() => normal(p, "start_construction", "home"), { code: "ECONOMY_BUILDING_REQUIRED" });
  assert.deepEqual(cheat(p, "grant_upgrade_cost", "home").state.inventory, expected, "repeated grants do not accumulate ingredients");
  cheat(p, "set_building_level", "home", 5);
  const max = read(p);
  assert.throws(() => cheat(p, "grant_upgrade_cost", "home"), { code: "ECONOMY_MAX_LEVEL" });
  assert.deepEqual(read(p), max);
});

test("instant building levels use catalog bounds, can bypass gates and preserve unrelated jobs and market", () => {
  const p = player(), production = normal(p, "start_production", "grow_berries").state.jobs[0];
  for (const building of model.economyCatalog.buildings) {
    const maximum = Math.max(...building.levels.map(level => level.level));
    if (building.id !== "garden") {
      assert.equal(cheat(p, "set_building_level", building.id, maximum).state.buildings[building.id], maximum);
      const minimum = ["home", "warehouse"].includes(building.id) ? 1 : 0;
      assert.equal(cheat(p, "set_building_level", building.id, minimum).state.buildings[building.id], minimum);
    }
    assert.throws(() => cheat(p, "set_building_level", building.id, maximum + 1), { code: "INVALID_ECONOMY_COMMAND" });
  }
  const before = read(p);
  assert.throws(() => cheat(p, "set_building_level", "garden", 0), { code: "ECONOMY_BUILDING_BUSY" });
  assert.deepEqual(read(p), before); assert.deepEqual(read(p).jobs, [production]);
  assert.equal(cheat(p, "set_building_level", "quarry", 1).state.buildings.home, 1, "DEV may inspect locked scenery without changing the house");
  cheat(p, "set_building_level", "home", 2);
  const row = fixture(p); row.state.completedExplorations = 1;
  cheat(p, "grant_item", "wood", 3);
  const listing = economy.commandDevEconomyMarket(p.token, { ...command(p, "create_listing", "wood", 2), totalPrice: 4 }, now).listing;
  cheat(p, "set_building_level", "home", 1);
  assert.equal(globalThis.__zhivDevEconomyStore.listings.get(listing.id).status, "active");
  assert.equal(read(p).storage.reserved, 2); assert.deepEqual(read(p).jobs, [production]);
});

test("finishing jobs preserves paid snapshots and requires ordinary claims for rewards and construction", () => {
  const p = player();
  const production = normal(p, "start_production", "grow_berries").state.jobs[0];
  const exploration = normal(p, "start_exploration", "forest").state.jobs.find(job => job.kind === "exploration");
  cheat(p, "grant_upgrade_cost", "woodlot");
  const construction = normal(p, "start_construction", "woodlot").state.jobs.find(job => job.kind === "construction");
  const before = read(p);
  const ready = cheat(p, "finish_jobs", "construction").state;
  assert.equal(ready.buildings.woodlot, 0); assert.deepEqual(ready.wallet, before.wallet); assert.deepEqual(ready.inventory, before.inventory);
  assert.deepEqual(ready.jobs.find(job => job.kind === "construction"), { ...construction, finishesAt: new Date(now).toISOString() });
  assert.deepEqual(ready.jobs.find(job => job.kind === "production"), production);
  assert.deepEqual(ready.jobs.find(job => job.kind === "exploration"), exploration);
  assert.throws(() => cheat(p, "set_building_level", "woodlot", 2), { code: "ECONOMY_BUILDING_BUSY" });
  assert.equal(normal(p, "claim_job", construction.id).state.buildings.woodlot, 1);
  const all = cheat(p, "finish_jobs", "all").state;
  assert.equal(all.completedExplorations, 0); assert.equal(all.jobs.length, 2);
  assert.ok(all.jobs.every(job => job.finishesAt === new Date(now).toISOString()));
  const collecting = normal(p, "start_collection", production.id).state.jobs.find(job => job.id === production.id);
  normal(p, "claim_job", production.id, 1, Date.parse(collecting.collection.finishesAt));
  const claimed = normal(p, "claim_job", exploration.id).state;
  assert.equal(claimed.completedExplorations, 1); assert.equal(claimed.jobs.length, 0);
  for (const [item, amount] of Object.entries(exploration.rewards)) assert.ok(claimed.inventory[item] >= amount);
  assert.throws(() => cheat(p, "finish_jobs", "all"), { code: "ECONOMY_DEV_NO_JOBS" });
  assert.deepEqual(read(p), claimed);
});

test("DEV command defaults still produce a strict, ordinary result-compatible request", () => {
  const p = player(), input = command(p, "finish_jobs", "production", 1);
  delete input.quantity; delete input.totalPrice;
  assert.deepEqual(economyDevCommandSchema.parse(input), { ...input, quantity: 1, totalPrice: 0 });
});
