import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const economy = await vite.ssrLoadModule("/lib/dev/economy-store.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { createGardenCollectionController } = await vite.ssrLoadModule("/features/economy/integration/garden-collection.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");

const epoch = Date.UTC(2026, 9, 15, 0);
beforeEach(() => identities.resetDevStoreForTests());
const flush = () => new Promise(resolve => setImmediate(resolve));
const settled = async () => { for (let turn = 0; turn < 6; turn++) await flush(); };
function receiptStorage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

/** Real development transactions run applyEconomyCommand on a clone and retain
 * the same server receipt ledger throughout all reconstructed client sessions. */
function server() {
  const player = identities.createDevIdentity("Садовник", crypto.randomUUID());
  const owner = player.me.user.publicId;
  let now = epoch;
  economy.initializeDevEconomy(player.token, now);
  const profile = globalThis.__zhivDevEconomyStore.profiles.get(owner);
  const crop = (recipeId, itemId, finishesAt) => ({ id: crypto.randomUUID(), kind: "production", actorId: null,
    targetId: "garden", recipeId, targetLevel: null, startedAt: new Date(epoch - 300_000).toISOString(),
    finishesAt: new Date(finishesAt).toISOString(), cost: { coins: 0, items: {} }, rewards: { [itemId]: 1 },
    catalogVersion: 10, collection: { kind: "berry_harvest", seconds: 8, startedAt: null, finishesAt: null } });
  const raspberry = crop("grow_berries", "berries", epoch), strawberry = crop("grow_strawberries", "strawberries", epoch);
  const blueberry = crop("grow_blueberries", "blueberries", epoch + 4000);
  profile.state.inventory = {};
  profile.state.buildings.home = 5;
  profile.state.buildings.garden = 5;
  profile.state.buildings.warehouse = 1;
  profile.state.productionSlots = { garden: 3 };
  profile.state.jobs = [raspberry, strawberry, blueberry];
  const cache = receiptStorage(), sent = [], results = [], errors = [];
  let lostAction = null, rejectLost;
  const read = () => economy.getDevEconomy(player.token, now);
  const transport = {
    get: async () => read(),
    send: async command => {
      sent.push(structuredClone(command));
      let result;
      try { result = economy.commandDevEconomy(player.token, command, now); }
      catch (error) {
        errors.push(error.code);
        throw new ApiError(error.message, error.status, { code: error.code, message: error.message });
      }
      results.push(result);
      if (lostAction === command.action) {
        lostAction = null;
        return new Promise((_, reject) => { rejectLost = reject; });
      }
      return result;
    },
    market: async () => assert.fail("Harvest must not read the market"),
    trade: async () => assert.fail("Harvest must not issue a trade"),
  };
  async function page(sceneAvailable = true) {
    const session = createEconomySession(owner, transport, () => assert.fail("Owner must stay signed in"), cache);
    const controller = createGardenCollectionController(owner);
    const sync = () => {
      const view = session.getSnapshot();
      controller.update({ snapshot: view.snapshot, now, busy: view.busy, uncertain: view.uncertain,
        retryAt: view.retryAt, error: view.error, sceneAvailable }, session.act, session.retryGardenCollection);
    };
    const unsubscribe = session.subscribe(sync), deactivate = session.activate();
    await session.refresh(); await settled(); sync();
    return { session, controller, sync,
      event(status) { const request = controller.getSnapshot().request; assert.ok(request); controller.sceneEvent({ ...request, status }); },
      close() { unsubscribe(); controller.deactivate(); deactivate(); },
    };
  }
  return { owner, raspberry, strawberry, blueberry, cache, sent, results, errors, profile, read, page,
    at(value) { now = value; },
    loseResponse(action) { lostAction = action; },
    disconnectLostResponse() { assert.ok(rejectLost); rejectLost(Error("Page reloaded before the accepted response arrived")); rejectLost = undefined; },
  };
}

function assertDelivered(server) {
  const state = server.read();
  assert.deepEqual(state.inventory, { berries: 1, strawberries: 1 });
  assert.deepEqual(state.jobs.map(job => job.id), [server.blueberry.id]);
  assert.equal(state.jobs[0].collection.startedAt, null, "A later ripe berry stays outside the saved batch");
  assert.equal(state.progression.recipes.grow_berries, 1);
  assert.equal(state.progression.recipes.grow_strawberries, 1);
  assert.equal(state.progression.recipes.grow_blueberries, undefined);
  assert.equal(server.cache.data.size, 0);
}

for (const restoredAt of [epoch + 3000, epoch + 10_000]) {
  test(`a real session and controller recreated ${restoredAt < epoch + 8000 ? "before" : "after"} the deadline delivers the whole basket once`, async () => {
    const backend = server(), first = await backend.page();
    assert.equal(first.controller.start(backend.strawberry.id), true);
    await settled(); first.event("started");
    assert.equal(first.controller.getSnapshot().phase, "walking");
    const started = backend.read(), batch = started.jobs.filter(job => job.collection.batchId);
    assert.equal(batch.length, 2);
    assert.ok(batch.every(job => job.collection.batchId === backend.sent[0].requestId));
    assert.ok(batch.every(job => Date.parse(job.collection.finishesAt) === epoch + 8000));
    assert.deepEqual(started.inventory, {});
    first.close(); backend.at(restoredAt);
    const restored = await backend.page();
    if (restoredAt < epoch + 8000) {
      assert.equal(restored.controller.getSnapshot().phase, "waiting");
      assert.equal(restored.controller.getSnapshot().request, null, "Reload uses the persisted deadline without restarting the walk");
      assert.equal(backend.sent.length, 1);
      backend.at(epoch + 8000); restored.sync(); await settled();
    }
    assertDelivered(backend);
    assert.equal(restored.controller.getSnapshot().phase, "idle");
    assert.deepEqual(backend.sent.map(command => command.action), ["start_garden_collection", "claim_garden_collection"]);
    for (let tick = 0; tick < 3; tick++) { restored.sync(); await settled(); }
    assert.equal(backend.sent.length, 2, "Repeated reconciliations must not generate another claim");
    restored.close();
  });
}

for (const lostAction of ["start_garden_collection", "claim_garden_collection"]) {
  test(`reloading after an accepted ${lostAction} loses its response replays the original persisted request`, async () => {
    const backend = server(), first = await backend.page();
    if (lostAction === "start_garden_collection") backend.loseResponse(lostAction);
    assert.equal(first.controller.start(backend.raspberry.id), true); await settled();
    if (lostAction === "claim_garden_collection") {
      first.event("started"); backend.at(epoch + 8000); first.sync();
      backend.loseResponse(lostAction); first.event("completed"); await settled();
    }
    assert.equal(first.session.getSnapshot().busy, true);
    assert.equal(backend.cache.data.size, 1);
    const lostRequest = structuredClone(backend.sent.at(-1));
    assert.equal(lostRequest.action, lostAction);
    first.close(); backend.disconnectLostResponse(); await settled();
    backend.at(epoch + 9000);
    const restored = await backend.page(); await settled();
    const replays = backend.sent.filter(command => command.requestId === lostRequest.requestId);
    assert.equal(replays.length, 2);
    assert.deepEqual(replays[0], replays[1], "Owner, expected revision, target and request UUID must all survive reload");
    assert.equal(backend.results.filter(result => result.replayed).length, 1);
    assert.equal(restored.session.getSnapshot().uncertain, false);
    assert.equal(restored.controller.getSnapshot().phase, "idle");
    assertDelivered(backend);
    assert.equal(backend.results.filter(result => !result.replayed).length, 2, "Only one start and one delivery may commit");
    assert.deepEqual(backend.errors, []);
    restored.close();
  });
}

test("a stale warehouse quote cannot partially deliver a batch, and freeing space permits an explicit retry", async () => {
  const backend = server(), page = await backend.page();
  assert.equal(page.controller.start(backend.raspberry.id), true); await settled(); page.event("started");
  const batchId = backend.sent[0].requestId;
  // Seed authoritative occupancy after the accepted walk. Keeping the old client
  // quote exercises the domain storage guard rather than only the UI shortfall.
  backend.profile.state.inventory = { wood: 50 };
  backend.at(epoch + 8000); page.sync(); page.event("completed"); await settled();
  assert.deepEqual(backend.errors, ["ECONOMY_STORAGE_FULL"]);
  assert.deepEqual(backend.read().inventory, { wood: 50 });
  assert.equal(backend.read().jobs.filter(job => job.collection.batchId === batchId).length, 2);
  assert.equal(page.controller.getSnapshot().phase, "claim-ready");
  assert.equal(page.session.getSnapshot().busy, false);
  assert.equal(page.session.getSnapshot().uncertain, false);
  assert.equal(backend.cache.data.size, 0, "A definitive refusal releases the failed receipt");
  const claimAttempts = backend.sent.filter(command => command.action === "claim_garden_collection");
  assert.equal(page.controller.start(backend.raspberry.id), false, "Combined basket must fit before retrying");
  assert.equal(backend.sent.filter(command => command.action === "claim_garden_collection").length, claimAttempts.length);
  assert.equal(page.session.act("sell", "wood", 50, 50), true); await settled();
  assert.deepEqual(backend.read().inventory, {});
  assert.equal(page.controller.start(backend.strawberry.id), true); await settled();
  assertDelivered(backend);
  assert.equal(page.controller.getSnapshot().phase, "idle");
  assert.equal(backend.sent.filter(command => command.action === "claim_garden_collection").length, 2);
  assert.ok(backend.sent.filter(command => command.action === "claim_garden_collection").every(command => command.targetId === batchId));
  page.close();
});

test("a real session refusing an unavailable write leaves a retryable harvest instead of a permanent claiming state", async () => {
  const backend = server(), first = await backend.page();
  first.session.setAvailable(false); first.sync();
  assert.equal(first.controller.start(backend.raspberry.id), false);
  assert.equal(first.controller.getSnapshot().phase, "idle");
  assert.deepEqual(backend.sent, []);
  first.session.setAvailable(true);
  assert.equal(first.controller.start(backend.raspberry.id), true); await settled(); first.event("started");
  first.session.setAvailable(false);
  backend.at(epoch + 8000); first.sync(); first.event("completed"); await settled();
  assert.equal(first.controller.getSnapshot().phase, "claim-ready");
  assert.equal(backend.sent.length, 1);
  assert.deepEqual(backend.read().inventory, {});
  first.session.setAvailable(true);
  assert.equal(first.controller.start(backend.strawberry.id), true); await settled();
  assertDelivered(backend);
  assert.equal(first.controller.getSnapshot().phase, "idle");
  first.close();
});
