import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), initialMode = process.env.NODE_ENV;
const cookieModule = "\0boat-dev-test-cookie";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root, "next/headers": cookieModule } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "boat-dev-test-cookie", resolveId(id) { if (id === cookieModule) return id; },
    load(id) { if (id === cookieModule) return "export async function cookies() { return { get() { return { value: globalThis.__boatDevTestToken }; } }; }"; } }],
});
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const { commandDevPresence } = await vite.ssrLoadModule("/lib/dev/activity-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const boats = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const physics = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const { economyDevCommandSchema } = await vite.ssrLoadModule("/features/economy/dev/dev-model.ts");
const { POST } = await vite.ssrLoadModule("/app/api/v1/economy/dev/route.ts");
const { POST: ordinaryPOST } = await vite.ssrLoadModule("/app/api/v1/economy/commands/route.ts");
const now = Date.now(), presence = new Map();
beforeEach(() => {
  identities.resetDevStoreForTests(); api.resetDevEconomyStoreForTests(); presence.clear();
  process.env.NODE_ENV = "development"; delete globalThis.__boatDevTestToken;
});
after(async () => {
  delete globalThis.__boatDevTestToken;
  if (initialMode == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = initialMode;
  await vite.close();
});
function player() {
  const p = identities.createDevIdentity("Лодочная DEV-проверка", crypto.randomUUID());
  globalThis.__boatDevTestToken = p.token;
  const id = crypto.randomUUID();
  commandDevPresence(p.me.user.publicId, { kind: "resume", presenceId: id, sequence: 0, active: true }, Date.now(), p.token);
  presence.set(p.token, id); read(p); return p;
}
const read = (p, at = now) => api.getDevEconomy(p.token, at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
function request(p, action, targetId, quantity = 1, at = now, extra = {}) {
  return { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision,
    action, targetId, quantity, totalPrice: 0, ...extra };
}
const cheat = (p, action, targetId, quantity = 1, at = now) => api.commandDevEconomyCheat(p.token, request(p, action, targetId, quantity, at), at);
const normal = (p, action, targetId, at = now, extra = {}) => api.commandDevEconomy(p.token, request(p, action, targetId, 1, at, extra), at);
const post = (body, headers = {}) => new Request("http://localhost:3000/api/v1/economy/dev", { method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://localhost:3000",
    ...(presence.has(globalThis.__boatDevTestToken) ? { "X-Game-Presence": presence.get(globalThis.__boatDevTestToken) } : {}), ...headers },
  body: JSON.stringify(body) });
function paidRepair(p) {
  cheat(p, "set_building_level", "home", 2); cheat(p, "set_building_level", "workshop", 1);
  cheat(p, "grant_boat_upgrade_cost", "repair");
  return normal(p, "start_boat_upgrade", "repair").state.boat.work;
}
function caughtTrace(challenge) {
  let reel = physics.initialBoatReel(challenge), held = false;
  const inputs = [];
  while (reel.status === "active") {
    const next = reel.fish > reel.bar + reel.velocity * 4;
    if (next !== held) { inputs.push({ tick: reel.tick, held: next }); held = next; }
    reel = physics.stepBoatReel(challenge, reel, held);
  }
  assert.equal(reel.status, "caught");
  return { challengeId: challenge.id, inputs, endTick: reel.tick };
}

test("boat DEV commands remain behind development, session, presence and origin gates and never enter player commands", async () => {
  assert.equal((await POST(post({}))).status, 401);
  const p = player(), before = read(p);
  const commands = [request(p, "prepare_boat", "boat"), request(p, "grant_boat_upgrade_cost", "repair"),
    request(p, "finish_boat_work", crypto.randomUUID()), request(p, "finish_boat_travel", crypto.randomUUID()),
    request(p, "set_boat_blueprint", "landing_net", 2)];
  for (const command of commands) {
    assert.equal(economyDevCommandSchema.safeParse(command).success, true);
    assert.equal(model.economyCommandSchema.safeParse(command).success, false);
    assert.equal((await ordinaryPOST(post(command))).status, 400);
    assert.equal((await POST(post(command, { Origin: "https://foreign.example" }))).status, 403);
    assert.equal((await POST(post(command, { "X-Game-Presence": "" }))).status, 409);
    process.env.NODE_ENV = "production";
    assert.equal((await POST(post(command))).status, 503);
    assert.throws(() => api.commandDevEconomyCheat(p.token, command, now), { code: "DEV_TOOLS_DISABLED" });
    process.env.NODE_ENV = "development";
  }
  assert.deepEqual(read(p), before);
});

test("boat DEV validates exact targets and bounded fragment counts before any mutation", () => {
  const p = player(), before = read(p);
  for (const [action, targetId, quantity] of [
    ["prepare_boat", "all", 1], ["prepare_boat", "boat", 2],
    ["grant_boat_upgrade_cost", "home", 1], ["grant_boat_upgrade_cost", "repair", 0],
    ["finish_boat_work", "boat", 1], ["finish_boat_travel", crypto.randomUUID(), 2],
    ["set_boat_blueprint", "crate", 1], ["set_boat_blueprint", "telescope", -1],
    ["set_boat_blueprint", "telescope", 4], ["set_boat_blueprint", "telescope", 1.5],
  ]) {
    const command = request(p, action, targetId, quantity);
    assert.equal(economyDevCommandSchema.safeParse(command).success, false);
    assert.throws(() => api.commandDevEconomyCheat(p.token, command, now), { code: "INVALID_ECONOMY_COMMAND" });
  }
  assert.deepEqual(read(p), before);
});

test("preparing a repaired boat preserves earned progress and assets, checks owners and replays only once", () => {
  const building = player();
  cheat(building, "grant_upgrade_cost", "workshop");
  normal(building, "start_construction", "workshop");
  const pendingBuilding = read(building);
  const preparedDuringWork = cheat(building, "prepare_boat", "boat").state;
  assert.deepEqual(preparedDuringWork.jobs, pendingBuilding.jobs, "Starter access cannot overwrite paid workshop construction");
  assert.deepEqual(preparedDuringWork.buildings, pendingBuilding.buildings);
  const p = player(), other = player();
  row(p).state.boat = { ...boats.newBoatState(), upgrades: ["crate"], blueprints: { landing_net: 2, telescope: 1 },
    completedVoyages: 7, qualifiedVoyages: 5, records: { fish_dace: { weightGrams: 100, caughtAt: new Date(now).toISOString() } } };
  row(p).state.buildings.home = 4;
  const before = read(p), command = request(p, "prepare_boat", "boat");
  assert.throws(() => api.commandDevEconomyCheat(other.token, command, now), { code: "ECONOMY_OWNER_CHANGED" });
  assert.deepEqual(read(p), before);
  const prepared = api.commandDevEconomyCheat(p.token, command, now);
  assert.deepEqual(prepared.state.boat, { ...before.boat, level: 1 });
  assert.equal(prepared.state.buildings.home, 4);
  assert.deepEqual(prepared.state.buildings, before.buildings);
  assert.deepEqual(prepared.state.wallet, before.wallet); assert.deepEqual(prepared.state.inventory, before.inventory);
  const replay = api.commandDevEconomyCheat(p.token, command, now + 1000);
  assert.equal(replay.replayed, true); assert.equal(replay.acceptedRevision, prepared.acceptedRevision);
  assert.equal(replay.state.revision, prepared.state.revision);
  assert.throws(() => api.commandDevEconomyCheat(p.token, { ...command, requestId: crypto.randomUUID() }, now), { code: "ECONOMY_REVISION_CONFLICT" });
  const voyage = normal(p, "depart_boat", "river_reach").state.boat.voyage;
  assert.throws(() => cheat(p, "prepare_boat", "boat"), { code: "ECONOMY_BOAT_BUSY" });
  assert.deepEqual(read(p).boat.voyage, voyage);
});

test("missing-only boat upgrade funding retains building gates and same-millisecond timer acceleration requires an ordinary claim", () => {
  const p = player();
  const funded = cheat(p, "grant_boat_upgrade_cost", "repair").state;
  assert.deepEqual(cheat(p, "grant_boat_upgrade_cost", "repair").state.inventory, funded.inventory);
  assert.equal(cheat(p, "grant_boat_upgrade_cost", "repair").state.wallet.coins, funded.wallet.coins);
  assert.throws(() => normal(p, "start_boat_upgrade", "tank_1"), { code: "ECONOMY_BOAT_UPGRADE" });
  const work = paidRepair(p), paid = read(p), finish = request(p, "finish_boat_work", work.id);
  assert.throws(() => cheat(p, "prepare_boat", "boat"), { code: "ECONOMY_BOAT_BUSY" });
  assert.throws(() => cheat(p, "finish_boat_work", crypto.randomUUID()), { code: "ECONOMY_BOAT_WORK_GONE" });
  const finished = api.commandDevEconomyCheat(p.token, finish, now);
  assert.equal(model.economyResultSchema.safeParse(finished).success, true);
  assert.equal(finished.state.boat.level, 0);
  assert.equal(finished.state.boat.work.id, work.id); assert.deepEqual(finished.state.boat.work.cost, work.cost);
  assert.equal(Date.parse(finished.state.boat.work.finishesAt), now);
  assert.ok(Date.parse(finished.state.boat.work.startedAt) < now);
  assert.deepEqual(finished.state.wallet, paid.wallet); assert.deepEqual(finished.state.inventory, paid.inventory);
  const replay = api.commandDevEconomyCheat(p.token, finish, now + 1000);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state.boat, finished.state.boat);
  assert.equal(normal(p, "claim_boat_upgrade", work.id).state.boat.level, 1);
  assert.throws(() => normal(p, "claim_boat_upgrade", work.id), { code: "ECONOMY_BOAT_WORK_GONE" });
});

test("the shared construction and all-jobs controls include boat work without claiming the upgrade", () => {
  for (const filter of ["construction", "all"]) {
    const p = player(), work = paidRepair(p), before = read(p);
    const finished = cheat(p, "finish_jobs", filter).state;
    assert.equal(model.economyViewSchema.safeParse(finished).success, true);
    assert.equal(finished.boat.work.id, work.id); assert.equal(Date.parse(finished.boat.work.finishesAt), now);
    assert.equal(finished.boat.level, 0); assert.deepEqual(finished.wallet, before.wallet);
    assert.deepEqual(finished.inventory, before.inventory); assert.deepEqual(finished.jobs, before.jobs);
    assert.equal(normal(p, "claim_boat_upgrade", work.id).state.boat.level, 1);
  }
});

test("DEV travel skips retain private draws and catches, leave full fishing time, and award only through ordinary delivery", () => {
  const p = player(); cheat(p, "prepare_boat", "boat"); row(p).state.inventory = {};
  normal(p, "depart_boat", "river_reach");
  // Imported timed voyage from before the introduction of instant travel.
  const saved = row(p).state.boat.voyage;
  saved.outboundSeconds = 300; saved.inboundSeconds = 300;
  saved.arrivesAt = new Date(now + 300000).toISOString();
  saved.fishingUntil = new Date(now + 2100000).toISOString();
  const initial = structuredClone(saved);
  row(p).state.boat.voyage.slots[0].challengeSeed = 37;
  row(p).state.boat.voyage.slots[0].difficulty = 1;
  const savedSlots = structuredClone(row(p).state.boat.voyage.slots), before = read(p);
  const outbound = request(p, "finish_boat_travel", initial.id), arrived = api.commandDevEconomyCheat(p.token, outbound, now);
  assert.equal(model.economyResultSchema.safeParse(arrived).success, true);
  assert.equal(boats.boatPhase(arrived.state.boat, now), "fishing");
  assert.equal(Date.parse(arrived.state.boat.voyage.arrivesAt), now);
  assert.equal(Date.parse(arrived.state.boat.voyage.fishingUntil) - now, Date.parse(initial.fishingUntil) - Date.parse(initial.arrivesAt));
  assert.deepEqual(row(p).state.boat.voyage.slots, savedSlots);
  assert.equal(arrived.state.boat.voyage.slots, undefined);
  assert.equal(JSON.stringify(arrived.state.boat).includes("challengeSeed"), false);
  assert.deepEqual(arrived.state.inventory, before.inventory); assert.deepEqual(arrived.state.wallet, before.wallet);
  assert.deepEqual(api.commandDevEconomyCheat(p.token, outbound, now + 1000).state.boat, arrived.state.boat);
  assert.throws(() => cheat(p, "finish_boat_travel", initial.id), { code: "ECONOMY_BOAT_PHASE" });
  const challenge = normal(p, "begin_boat_cast", initial.id).state.boat.voyage.challenge;
  const reel = caughtTrace(challenge), at = Date.parse(challenge.biteAt) + reel.endTick * 50;
  const caught = normal(p, "submit_boat_cast", initial.id, at, { reel }).state.boat.voyage.catches[0];
  assert.ok(caught);
  const returning = normal(p, "return_boat", initial.id, at).state;
  const inbound = request(p, "finish_boat_travel", initial.id, 1, at), ready = api.commandDevEconomyCheat(p.token, inbound, at);
  assert.equal(model.economyResultSchema.safeParse(ready).success, true);
  assert.equal(boats.boatPhase(ready.state.boat, at), "ready");
  assert.deepEqual(ready.state.boat.voyage.catches, returning.boat.voyage.catches);
  assert.deepEqual(row(p).state.boat.voyage.slots, savedSlots);
  assert.equal(ready.state.boat.completedVoyages, 0); assert.deepEqual(ready.state.boat.records, {});
  assert.deepEqual(ready.state.inventory, before.inventory);
  const claim = request(p, "claim_boat", initial.id, 1, at), delivered = api.commandDevEconomy(p.token, claim, at);
  assert.equal(delivered.state.boat.completedVoyages, 1);
  assert.equal(delivered.state.fishing.stock[caught.fishId], 1);
  assert.equal(delivered.state.boat.records[caught.fishId].weightGrams, caught.weightGrams);
  assert.deepEqual(api.commandDevEconomy(p.token, claim, at + 1000).state.inventory, delivered.state.inventory);
});

test("blueprint controls inspect every puzzle stage without manufacturing the item or rewriting voyage progress", () => {
  const p = player(); cheat(p, "prepare_boat", "boat");
  const before = read(p);
  for (const fragments of [1, 2, 3, 0]) {
    const result = cheat(p, "set_boat_blueprint", "landing_net", fragments).state;
    assert.equal(result.boat.blueprints.landing_net, fragments);
    assert.deepEqual(result.boat.artifacts, []);
    assert.equal(result.boat.completedVoyages, before.boat.completedVoyages);
    assert.equal(result.boat.qualifiedVoyages, before.boat.qualifiedVoyages);
    assert.deepEqual(result.wallet, before.wallet); assert.deepEqual(result.inventory, before.inventory);
  }
  cheat(p, "set_building_level", "home", 2); cheat(p, "set_building_level", "workshop", 1);
  cheat(p, "set_boat_blueprint", "landing_net", 3); cheat(p, "grant_boat_upgrade_cost", "landing_net");
  const work = normal(p, "start_boat_upgrade", "landing_net").state.boat.work;
  const pending = read(p);
  assert.throws(() => cheat(p, "set_boat_blueprint", "landing_net", 0), { code: "ECONOMY_BOAT_BUSY" });
  assert.deepEqual(read(p), pending);
  cheat(p, "finish_boat_work", work.id);
  assert.deepEqual(normal(p, "claim_boat_upgrade", work.id).state.boat.artifacts, ["landing_net"]);
});
