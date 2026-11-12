import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const api = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const model = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const boats = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const physics = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const now = Date.parse("2026-11-02T10:00:00Z");
const flush = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => { identities.resetDevStoreForTests(); api.resetDevEconomyStoreForTests(); });
after(() => vite.close());
const read = (p, at = now) => api.getDevEconomy(p.token, at);
const row = p => globalThis.__zhivDevEconomyStore.profiles.get(p.me.user.publicId);
function player() {
  const p = identities.createDevIdentity("Лодочная проверка", crypto.randomUUID()); read(p);
  row(p).state.boat = { ...boats.newBoatState(), level: 1 };
  row(p).state.inventory = {};
  return p;
}
function request(p, action, targetId, at = now, extra = {}) {
  return { requestId: crypto.randomUUID(), ownerPublicId: p.me.user.publicId, expectedRevision: read(p, at).revision,
    action, targetId, quantity: 1, totalPrice: 0, ...extra };
}
const send = (p, action, targetId, at = now, extra = {}) => api.commandDevEconomy(p.token, request(p, action, targetId, at, extra), at);
function trace(challenge, follow = false) {
  let reel = physics.initialBoatReel(challenge), held = false;
  const inputs = [];
  while (reel.status === "active") {
    const next = follow && reel.fish > reel.bar + reel.velocity * 4;
    if (next !== held) { inputs.push({ tick: reel.tick, held: next }); held = next; }
    reel = physics.stepBoatReel(challenge, reel, held);
  }
  return { challengeId: challenge.id, inputs, endTick: reel.tick };
}

test("API keeps all future fish private and does not regenerate a voyage on reads", () => {
  const p = player(), result = send(p, "depart_boat", "river_reach"), hidden = structuredClone(row(p).state.boat.voyage);
  assert.equal(model.economyViewSchema.safeParse(result.state).success, true);
  assert.equal(result.state.boat.voyage.slots, undefined);
  assert.equal(result.state.boat.voyage.catches.length, 0);
  assert.equal(JSON.stringify(result.state.boat).includes("weightGrams"), false);
  read(p, Date.parse(hidden.arrivesAt)); read(p, Date.parse(hidden.arrivesAt) + 10000);
  assert.deepEqual(row(p).state.boat.voyage, hidden);
});

test("a replayed reel command is idempotent and changed controls cannot reuse its receipt", () => {
  const p = player(), voyage = send(p, "depart_boat", "river_reach").state.boat.voyage;
  const arrived = Date.parse(voyage.arrivesAt), challenge = send(p, "begin_boat_cast", voyage.id, arrived).state.boat.voyage.challenge;
  assert.equal(challenge.rulesVersion, 6);
  assert.ok(["steady", "sprightly", "surging", "stubborn"].includes(challenge.resistance));
  assert.equal(challenge.fishId, undefined); assert.equal(challenge.weightGrams, undefined);
  const reel = trace(challenge), finishedAt = Date.parse(challenge.biteAt) + reel.endTick * 50;
  const command = request(p, "submit_boat_cast", voyage.id, finishedAt, { reel });
  const first = api.commandDevEconomy(p.token, command, finishedAt);
  const replayed = api.commandDevEconomy(p.token, command, finishedAt + 1000);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.acceptedRevision, first.acceptedRevision);
  assert.equal(replayed.state.boat.voyage.castsUsed, 1);
  assert.throws(() => api.commandDevEconomy(p.token, { ...command,
    reel: { ...reel, inputs: [{ tick: 0, held: true }] } }, finishedAt + 1000), { code: "ECONOMY_REQUEST_CONFLICT" });
});

test("release accuracy commits one private weight and changes the actual catch and dock payout", () => {
  const voyageId = "00000000-0000-4000-8000-000000000001";
  for (const [heldMs, grams, price] of [[undefined, 500, 16], [0, 395, 15], [570, 575, 16]]) {
    const p = player(), voyage = send(p, "depart_boat", "river_reach").state.boat.voyage;
    const saved = row(p).state.boat.voyage;
    saved.id = voyageId;
    Object.assign(saved.slots[0], { fishId: "fish_silverfin", weightGrams: 500, difficulty: 1, challengeSeed: 37 });
    const at = Date.parse(voyage.arrivesAt);
    const cast = request(p, "begin_boat_cast", voyageId, at, heldMs === undefined ? {} : { castHeldMs: heldMs });
    for (const extra of [{ castHeldMs: -1 }, { castHeldMs: 60001 }, { castHeldMs: 1.5 }, { castQuality: 100 }])
      assert.throws(() => api.commandDevEconomy(p.token, { ...cast, ...extra }, at), { code: "INVALID_ECONOMY_COMMAND" });
    const result = api.commandDevEconomy(p.token, cast, at);
    assert.equal(result.state.boat.voyage.slots, undefined);
    assert.deepEqual(result.state.boat.voyage.catches, []);
    assert.equal(api.commandDevEconomy(p.token, cast, at).replayed, true);
    assert.throws(() => api.commandDevEconomy(p.token, { ...cast, castHeldMs: 1000 }, at), { code: "ECONOMY_REQUEST_CONFLICT" });
    const challenge = result.state.boat.voyage.challenge, reel = trace(challenge, true);
    const done = Date.parse(challenge.biteAt) + reel.endTick * 50;
    const caught = send(p, "submit_boat_cast", voyageId, done, { reel }).state.boat.voyage.catches;
    assert.deepEqual(caught.map(fish => [fish.fishId, fish.weightGrams]), [["fish_silverfin", grams]]);
    const docked = send(p, "return_boat", voyageId, done + 1).state;
    const sold = send(p, "sell_boat_catch", voyageId, done + 2, { totalPrice: price }).state;
    assert.equal(sold.wallet.coins - docked.wallet.coins, price);
    assert.equal(sold.boat.records.fish_silverfin.weightGrams, grams);
  }
});

test("two clients cannot start different casts from one revision", () => {
  const p = player(), voyage = send(p, "depart_boat", "river_reach").state.boat.voyage;
  const at = Date.parse(voyage.arrivesAt), first = request(p, "begin_boat_cast", voyage.id, at);
  const second = { ...first, requestId: crypto.randomUUID() };
  api.commandDevEconomy(p.token, first, at);
  assert.throws(() => api.commandDevEconomy(p.token, second, at), { code: "ECONOMY_REVISION_CONFLICT" });
  assert.equal(read(p, at).boat.voyage.castsUsed, 1);
});

test("delivered species and records survive repeated claim without duplicating inventory", () => {
  const p = player(), voyage = send(p, "depart_boat", "river_reach").state.boat.voyage;
  row(p).state.boat.voyage.slots[0].challengeSeed = 37;
  const arrived = Date.parse(voyage.arrivesAt), challenge = send(p, "begin_boat_cast", voyage.id, arrived).state.boat.voyage.challenge;
  const reel = trace(challenge, true), done = Date.parse(challenge.biteAt) + reel.endTick * 50;
  const caught = send(p, "submit_boat_cast", voyage.id, done, { reel }).state.boat.voyage.catches[0];
  assert(caught);
  assert.deepEqual(read(p, done).inventory, {});
  // A complete saved outing with one catch must not mint blueprint fragments.
  row(p).state.boat.voyage.castsUsed = row(p).state.boat.voyage.maxCasts;
  const returning = send(p, "return_boat", voyage.id, done).state.boat.voyage;
  const at = Date.parse(returning.returnsAt), command = request(p, "claim_boat", voyage.id, at);
  const delivered = api.commandDevEconomy(p.token, command, at);
  assert.equal(delivered.state.fishing.stock[caught.fishId], 1);
  assert.equal(delivered.state.boat.records[caught.fishId].weightGrams, caught.weightGrams);
  assert.equal(delivered.state.boat.qualifiedVoyages, 1);
  assert.deepEqual(delivered.state.boat.blueprints, { landing_net: 0, telescope: 0 });
  const repeated = api.commandDevEconomy(p.token, command, at + 1000);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.state.inventory, delivered.state.inventory);
});

test("pending controls are copied, persisted and retried unchanged after a lost response", async () => {
  const p = player(), base = read(p), memory = new Map(), sent = [];
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  let authoritative = base;
  const transport = { get: async () => authoritative, market: async () => ({ ownerPublicId: base.ownerPublicId, listings: [], mine: [], nextCursor: null, serverTime: base.serverTime }),
    send: async command => {
      sent.push(structuredClone(command));
      authoritative = { ...base, revision: base.revision + 1 };
      if (sent.length === 1) throw Error("Response was lost after commit");
      return { state: authoritative, acceptedRevision: authoritative.revision, message: "Рыба в лодке", replayed: true };
    } };
  const first = createEconomySession(base.ownerPublicId, transport, () => assert.fail(), storage), stop = first.activate();
  await first.refresh();
  const reel = { challengeId: crypto.randomUUID(), inputs: [{ tick: 0, held: true }], endTick: 300 };
  assert.equal(first.act("submit_boat_cast", crypto.randomUUID(), 1, 0, undefined, undefined, reel), true);
  reel.inputs[0].held = false;
  await flush(); assert.equal(first.getSnapshot().uncertain, true); stop();
  const restored = createEconomySession(base.ownerPublicId, transport, () => assert.fail(), storage), deactivate = restored.activate();
  await restored.refresh(); await restored.retry();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[1].reel.inputs[0].held, true);
  assert.equal(restored.getSnapshot().uncertain, false);
  deactivate();
});

const store = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
function fishingAttempt() {
  const p = player(), voyage = send(p, "depart_boat", "river_reach").state.boat.voyage;
  row(p).state.boat.voyage.slots[0].challengeSeed = 37;
  const cast = send(p, "begin_boat_cast", voyage.id, Date.parse(voyage.arrivesAt)).state;
  const challenge = cast.boat.voyage.challenge, reel = { ...trace(challenge, true), deferred: true };
  return { p, voyage, cast, challenge, reel, late: Date.parse(challenge.expiresAt) + 3_600_000 };
}

test("the last issued cast accepts one late terminal replay with its original time budget", () => {
  const { p, voyage, challenge, reel, late } = fishingAttempt();
  const original = structuredClone(row(p).state.boat.voyage.challenge);
  assert.throws(() => send(p, "submit_boat_cast", voyage.id, late, { reel: { ...reel, deferred: false } }), { code: "ECONOMY_BOAT_CAST_EXPIRED" });
  assert.throws(() => send(p, "submit_boat_cast", voyage.id, Date.parse(challenge.expiresAt) + 86_400_001, { reel }), { code: "ECONOMY_BOAT_CAST_EXPIRED" });
  row(p).state.boat.voyage.challenge.expiresAt = new Date(Date.parse(challenge.biteAt) + 60).toISOString();
  assert.throws(() => send(p, "submit_boat_cast", voyage.id, late, { reel }), { code: "ECONOMY_BOAT_CAST_EXPIRED" });
  row(p).state.boat.voyage.challenge = original;
  const result = send(p, "submit_boat_cast", voyage.id, late, { reel });
  assert.equal(result.state.boat.voyage.catches.length, 1);
  assert.equal(result.state.boat.voyage.catches[0].caughtAt, challenge.expiresAt);
  assert.deepEqual(result.state.inventory, {});
  assert.throws(() => send(p, "submit_boat_cast", voyage.id, late, { reel }), { code: "ECONOMY_BOAT_CAST_GONE" });
});

test("a delayed online landing sends one POST, keeps the known state and adopts its ACK without a GET", async () => {
  const { p, voyage, cast, challenge, reel, late } = fishingAttempt();
  let reads = 0, writes = 0, finish;
  const session = createEconomySession(cast.ownerPublicId, {
    get: async () => { reads++; return cast; },
    send: command => { writes++; return new Promise(resolve => { finish = () => resolve(api.commandDevEconomy(p.token, command, late)); }); },
  }, () => assert.fail(), store());
  const stop = session.activate(); await session.refresh();
  assert(session.act("submit_boat_cast", voyage.id, 1, 0, undefined, undefined, reel));
  assert.equal(session.getSnapshot().busy, true); assert.equal(session.getSnapshot().uncertain, false);
  assert.equal(session.getSnapshot().snapshot.boat.voyage.catches.length, 0);
  await session.refreshSoft(); assert.equal(writes, 1);
  finish(); await flush();
  const view = session.getSnapshot();
  assert.deepEqual(view.lastBoatLanding, { challengeId: challenge.id, revision: view.snapshot.revision });
  assert.equal(view.snapshot.boat.voyage.catches.length, 1); assert.equal(reads, 1); assert.equal(writes, 1);
  stop();
});

test("offline landing is saved before any network call and delivered from a fresh tab after the voyage timer", async () => {
  const { p, voyage, cast, challenge, reel, late } = fishingAttempt();
  const disk = store(), transport = { get: async () => cast, send: async () => assert.fail("offline") };
  const journal = { storage: disk, coordinate: async () => () => {} };
  const first = createEconomySession(cast.ownerPublicId, transport, () => assert.fail(), store(), journal);
  const stop = first.activate(); await first.refresh();
  first.setAvailable(false); first.setDirectActionsAvailable(false);
  const sendLocal = () => first.act("submit_boat_cast", voyage.id, 1, 0, undefined, undefined, reel);
  assert.equal(sendLocal(), true); assert.equal(sendLocal(), false);
  assert.equal(first.getSnapshot().pendingBoatCastId, challenge.id);
  assert.equal(first.getSnapshot().uncertain, true);
  assert.equal(first.getSnapshot().snapshot.boat.voyage.catches.length, 0);
  stop();
  const sent = [];
  const second = createEconomySession(cast.ownerPublicId, { get: async () => read(p, late), send: async command => {
    sent.push(structuredClone(command));
    const result = api.commandDevEconomy(p.token, command, late);
    if (sent.length === 1) throw Error("lost ACK");
    return result;
  } }, () => assert.fail(), store(), journal);
  const stopSecond = second.activate(); await second.refresh();
  assert.equal(second.getSnapshot().pendingBoatCastId, challenge.id);
  stopSecond();
  const third = createEconomySession(cast.ownerPublicId, { get: async () => read(p, late), send: async command => {
    sent.push(structuredClone(command)); return api.commandDevEconomy(p.token, command, late);
  } }, () => assert.fail(), store(), journal);
  const stopThird = third.activate(); await third.refresh();
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
  assert.equal(third.getSnapshot().pendingBoatCastId, undefined);
  assert.equal(third.getSnapshot().lastBoatLanding, undefined, "a replay cannot release a new cast");
  assert.equal(third.getSnapshot().snapshot.boat.voyage.catches.length, 1);
  assert.equal(disk.getItem("zhiv:economy:boat-landing:v1:" + cast.ownerPublicId), null);
  stopThird();
});

test("only a definite stale revision can replace an outstanding landing receipt for the same challenge", async () => {
  const { p, voyage, cast, reel, late } = fishingAttempt();
  const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
  const sent = [], snapshotAt = () => read(p, late);
  const session = createEconomySession(cast.ownerPublicId, { get: async () => snapshotAt(), send: async command => {
    sent.push(structuredClone(command));
    if (sent.length === 1) throw new ApiError("Поменялась ревизия", 409, { code: "ECONOMY_REVISION_CONFLICT" });
    return api.commandDevEconomy(p.token, command, late);
  } }, () => assert.fail(), store());
  const stop = session.activate(); await session.refresh();
  row(p).revision++;
  const accepted = session.act("submit_boat_cast", voyage.id, 1, 0, undefined, undefined, reel);
  assert.equal(accepted, true); await flush();
  await session.refreshSoft();
  assert.equal(sent.length, 2); assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.equal(sent[1].expectedRevision, sent[0].expectedRevision + 1);
  assert.deepEqual(sent[1].reel, sent[0].reel);
  assert.equal(session.getSnapshot().snapshot.boat.voyage.catches.length, 1); stop();
});

test("an unavailable receipt store rejects an offline landing visibly and permits an online revision retry", async () => {
  const { p, voyage, cast, reel, late } = fishingAttempt();
  const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
  const sent = [];
  const session = createEconomySession(cast.ownerPublicId, {
    get: async () => read(p, late),
    send: async command => {
      sent.push(structuredClone(command));
      if (sent.length === 1) throw new ApiError("Поменялась ревизия", 409, { code: "ECONOMY_REVISION_CONFLICT" });
      return api.commandDevEconomy(p.token, command, late);
    },
  }, () => assert.fail());
  const deactivate = session.activate();
  await session.refresh();
  const land = () => session.act("submit_boat_cast", voyage.id, 1, 0, undefined, undefined, reel);
  session.setAvailable(false);
  assert.equal(land(), false);
  assert.match(session.getSnapshot().storageError, /восстановите соединение/);
  assert.equal(session.getSnapshot().pendingBoatCastId, undefined);
  assert.equal(sent.length, 0);
  row(p).revision++;
  session.setAvailable(true);
  assert.equal(land(), true);
  await flush();
  await session.refreshSoft();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.deepEqual(sent[0].reel, sent[1].reel);
  assert.equal(session.getSnapshot().snapshot.boat.voyage.catches.length, 1);
  assert.equal(session.getSnapshot().storageError, null);
  deactivate();
});
