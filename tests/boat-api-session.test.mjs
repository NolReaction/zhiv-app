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
