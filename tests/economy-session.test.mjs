import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002", now = Date.now();
const state = (revision = 0, ownerPublicId = owner) => ({ ownerPublicId, revision, serverTime: new Date(now).toISOString(), wallet: { coins: 1000, pearls: 0 }, inventory: {},
  buildings: { home: 1, garden: 1, warehouse: 1, kiln: 0 }, storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 },
  jobs: [], migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog, completedExplorations: 0 });
const market = () => ({ listings: [], mine: [], nextCursor: null, serverTime: new Date(now).toISOString() });
const result = snapshot => ({ state: snapshot, message: "Готово", acceptedRevision: snapshot.revision, replayed: false });
const transport = overrides => ({ get: async () => state(), send: async () => result(state(1)), market: async () => market(), trade: async () => result(state(1)), ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function storage() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }; }

test("fish selections are copied into exactly one accepted command and cannot be edited after sending", async () => {
  const pending = deferred(), sent = [];
  const session = createEconomySession(owner, transport({ send: command => { sent.push(command); return pending.promise; } }), () => assert.fail());
  const stop = session.activate(); await session.refresh();
  const selection = { fish_mirror_koi: 1 };
  assert.equal(session.act("start_production", "cook_epic_fish", 1, 0, selection), true);
  selection.fish_mirror_koi = 99;
  assert.deepEqual(sent[0].fishSelection, { fish_mirror_koi: 1 });
  assert.equal(session.act("start_production", "cook_epic_fish", 1, 0, { fish_sturgeon: 1 }), false);
  assert.equal(sent.length, 1);
  pending.resolve(result(state(1))); await flush(); stop();
});

test("a lost fish order receipt keeps the exact chosen species across session recreation", async () => {
  const cache = storage(), sent = []; let authoritative = state();
  const t = transport({ get: async () => authoritative, send: async command => {
    sent.push(structuredClone(command));
    if (sent.length === 1) { authoritative = state(1); throw Error("Committed fish order response lost"); }
    return { ...result(authoritative), replayed: true };
  } });
  const original = createEconomySession(owner, t, () => assert.fail(), cache), stop = original.activate();
  await original.refresh();
  assert.equal(original.act("complete_resident_order", "fish-order", 1, 0, { fish_sturgeon: 1, fish_rare: 2 }), true);
  await flush(); assert.equal(original.getSnapshot().uncertain, true); stop();
  const restored = createEconomySession(owner, t, () => assert.fail(), cache), deactivate = restored.activate();
  await restored.refresh(); await restored.retry();
  assert.deepEqual(sent[1], sent[0], "the same request id, revision and selection recover together");
  assert.deepEqual(sent[1].fishSelection, { fish_sturgeon: 1, fish_rare: 2 });
  assert.equal(restored.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
  deactivate();
});

test("act reports refusal before snapshot, while suspended or busy, and acceptance only for an issued request", async () => {
  const wait = deferred(), sent = [];
  const session = createEconomySession(owner, transport({ send: command => { sent.push(command); return wait.promise; } }), () => assert.fail());
  assert.equal(session.act("start_garden_collection", "crop"), false);
  const stop = session.activate(); await session.refresh();
  session.setAvailable(false); assert.equal(session.act("start_garden_collection", "crop"), false);
  session.setAvailable(true); assert.equal(session.act("start_garden_collection", "crop"), true);
  assert.equal(session.act("start_garden_collection", "neighbor"), false); assert.equal(sent.length, 1);
  wait.resolve(result(state(1))); await flush(); stop();
  assert.equal(session.act("claim_garden_collection", crypto.randomUUID()), false); assert.equal(sent.length, 1);
});

test("garden receipt recovery replays the exact saved start and atomic claim after full session recreation", async () => {
  for (const action of ["start_garden_collection", "claim_garden_collection"]) {
    const cache = storage(), sent = [], batch = crypto.randomUUID(); let authoritative = state();
    const t = transport({ get: async () => authoritative, send: async command => {
      sent.push(structuredClone(command));
      if (sent.length === 1) {
        authoritative = state(1);
        if (action === "start_garden_collection") authoritative.jobs = [{ id: "crop", kind: "production", targetId: "garden", recipeId: "grow_berries",
          startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now).toISOString(), rewards: { berries: 1 },
          collection: { kind: "berry_harvest", seconds: 8, batchId: command.requestId, startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 8000).toISOString() } }];
        else authoritative.inventory = { berries: 1, strawberries: 1, blueberries: 1 };
        throw Error("Committed response lost before page reload");
      }
      return { ...result(authoritative), replayed: true };
    } });
    const original = createEconomySession(owner, t, () => assert.fail(), cache), stop = original.activate();
    await original.refresh(); assert.equal(original.act(action, action === "start_garden_collection" ? "crop" : batch), true); await flush();
    assert.equal(original.getSnapshot().uncertain, true); stop();
    const restored = createEconomySession(owner, t, () => assert.fail(), cache); restored.activate();
    assert.equal(restored.getSnapshot().snapshot, null);
    assert.equal(restored.retryGardenCollection(), true, "known garden receipts can recover before the initial GET");
    assert.equal(restored.retryGardenCollection(), false, "busy recovery is not accepted twice"); await flush();
    assert.deepEqual(sent[1], sent[0], "requestId and expected revision survive the page reload");
    assert.equal(restored.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
    assert.equal(restored.retryGardenCollection(), false, "completed recovery cannot issue a fresh command");
    if (action === "start_garden_collection") assert.equal(restored.getSnapshot().snapshot.jobs[0].collection.batchId, sent[0].requestId);
    else assert.deepEqual(restored.getSnapshot().snapshot.inventory, { berries: 1, strawberries: 1, blueberries: 1 });
  }
});

test("garden receipt recovery leaves unrelated sales and rate-limited garden writes untouched", async () => {
  for (const scenario of ["sale", "throttled"]) {
    const sent = [];
    const session = createEconomySession(owner, transport({ send: async command => {
      sent.push(command);
      if (scenario === "throttled") throw new ApiError("Подождите", 429, undefined, undefined, 60_000);
      throw Error("Lost sale response");
    } }), () => assert.fail(), storage());
    session.activate(); await session.refresh(); session.act(scenario === "sale" ? "sell" : "start_garden_collection", scenario === "sale" ? "wood" : "crop"); await flush();
    assert.equal(session.retryGardenCollection(), false); assert.equal(sent.length, 1);
    assert.equal(session.getSnapshot().uncertain, true); assert.equal(session.act("start_garden_collection", "neighbor"), false);
  }
});

test("uncertain purchase uses same receipt, blocks other writes and survives session recreation", async () => {
  const cache = storage(), sent = []; let wallet = state();
  const t = transport({ trade: async command => {
    sent.push(structuredClone(command));
    if (sent.length === 1) { wallet = state(1); wallet.wallet.coins = 700; throw Error("Response lost after commit"); }
    return { ...result(wallet), replayed: true };
  }, get: async () => wallet });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh();
  first.actMarket("buy_listing", crypto.randomUUID(), 6, 300); await flush();
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(cache.data.size, 1);
  first.act("start_exploration", "forest"); first.actMarket("create_listing", "wood", 1, 40);
  assert.equal(sent.length, 1);
  stop();
  const next = createEconomySession(owner, t, () => assert.fail(), cache); next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().uncertain, true);
  await next.retry();
  assert.deepEqual(sent[0], sent[1]); assert.equal(next.getSnapshot().snapshot.wallet.coins, 700);
  assert.equal(next.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
});

test("definitive conflict refreshes balance and permits a deliberate new command", async () => {
  let sent = 0, latest = state();
  const session = createEconomySession(owner, transport({ get: async () => latest, send: async () => {
    sent++; if (sent === 1) { latest = state(5); throw new ApiError("Обновите хозяйство", 409); }
    return result(state(6));
  } }), () => assert.fail());
  session.activate(); await session.refresh(); session.act("start_exploration", "forest"); await flush();
  assert.equal(session.getSnapshot().uncertain, false); assert.equal(session.getSnapshot().snapshot.revision, 5);
  session.act("start_exploration", "forest"); await flush(); assert.equal(sent, 2); assert.equal(session.getSnapshot().snapshot.revision, 6);
});

test("429 writes retain command and respect Retry-After rather than resending rapidly", async () => {
  let sends = 0, gets = 0;
  const session = createEconomySession(owner, transport({ get: async () => { gets++; return state(); }, send: async () => {
    sends++; throw new ApiError("Подождите", 429, undefined, undefined, 60_000);
  } }), () => assert.fail());
  session.activate(); await session.refresh(); session.act("start_production", "grow_berries"); await flush();
  for (let i = 0; i < 10; i++) { await session.retry(); await session.refresh(); }
  assert.equal(sends, 1); assert.equal(gets, 1); assert.equal(session.getSnapshot().uncertain, true);
  assert.ok(session.getSnapshot().retryAt > now + 55_000);
});

test("late GET cannot overwrite a newer command and lower revision cannot roll back wallet", async () => {
  const stale = deferred(); let gets = 0;
  const session = createEconomySession(owner, transport({ get: async () => ++gets === 1 ? state() : stale.promise, send: async () => result(state(3)) }), () => assert.fail());
  session.activate(); await session.refresh(); const oldRead = session.refresh();
  session.act("start_production", "grow_berries"); await flush(); stale.resolve(state(1)); await oldRead;
  assert.equal(session.getSnapshot().snapshot.revision, 3);
  await session.refresh(); assert.equal(session.getSnapshot().snapshot.revision, 3);
});

test("owner changes discard in-flight responses and never replay another account's pending command", async () => {
  const wait = deferred(), cache = storage(); let lost = 0, sends = 0;
  const session = createEconomySession(owner, transport({ get: () => wait.promise }), () => lost++, cache);
  const stop = session.activate(), read = session.refresh(); stop();
  const next = createEconomySession(other, transport({ get: async () => state(0, other), send: async () => { sends++; return result(state(1, other)); } }), () => lost++, cache);
  next.activate(); await next.refresh(); wait.resolve(state(10)); await read;
  assert.equal(session.getSnapshot().snapshot, null); assert.equal(next.getSnapshot().snapshot.ownerPublicId, other);
  assert.equal(lost, 0); assert.equal(sends, 0);
});

test("unauthorized read calls sessionLost and a foreign-owner view is never published", async () => {
  let lost = 0;
  const denied = createEconomySession(owner, transport({ get: async () => { throw new ApiError("Войдите", 401); } }), () => lost++);
  denied.activate(); await denied.refresh(); assert.equal(lost, 1);
  const mismatch = createEconomySession(owner, transport({ get: async () => state(0, other) }), () => lost++);
  mismatch.activate(); await mismatch.refresh(); assert.equal(lost, 2); assert.equal(mismatch.getSnapshot().snapshot, null);
});

test("read polling is coalesced, throttled and never grants timer results locally", async () => {
  let gets = 0;
  const session = createEconomySession(owner, transport({ get: async () => { gets++; return state(); } }), () => assert.fail());
  session.activate(); await Promise.all(Array.from({ length: 50 }, () => session.refreshSoft()));
  await session.refreshSoft(); assert.equal(gets, 1); assert.deepEqual(session.getSnapshot().snapshot.inventory, {});
  assert.ok(Number.isFinite(session.now()));
});

test("market refresh replaces the fixed showcase and drops closed stale listings", async () => {
  let calls = 0;
  const first = { id: "a" }, second = { id: "b" };
  const session = createEconomySession(owner, transport({ market: async () => ({ ...market(), listings: ++calls === 1 ? [first] : calls === 2 ? [second] : [] }) }), () => assert.fail());
  session.activate(); await session.refreshMarket(); await session.refreshMarket();
  assert.deepEqual(session.getSnapshot().market.listings.map(lot => lot.id), ["b"]);
  await session.refreshMarket(); assert.equal(session.getSnapshot().market.listings.length, 0);
});

test("a trade refreshes market even while an invalidated old page is still loading", async () => {
  const stale = deferred(); let reads = 0;
  const session = createEconomySession(owner, transport({ market: () => ++reads === 1 ? stale.promise : Promise.resolve(market()) }), () => assert.fail());
  session.activate(); await session.refresh(); const oldRead = session.refreshMarket();
  session.actMarket("buy_listing", crypto.randomUUID(), 1, 40); await flush();
  assert.equal(reads, 2); assert.deepEqual(session.getSnapshot().market.listings, []);
  stale.resolve({ ...market(), listings: [{ id: "already-sold" }] }); await oldRead;
  assert.deepEqual(session.getSnapshot().market.listings, []);
});

test("construction speedup sends the approved pearl quote once and waits for server balance", async () => {
  const wait = deferred(), sent = [];
  const initial = state(); initial.wallet.pearls = 70;
  const session = createEconomySession(owner, transport({ get: async () => initial, send: command => {
    sent.push(structuredClone(command)); return wait.promise;
  } }), () => assert.fail());
  session.activate(); await session.refresh();
  const jobId = crypto.randomUUID();
  session.act("speedup_construction", jobId, 1, 30);
  session.act("speedup_construction", jobId, 1, 30);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "speedup_construction");
  assert.equal(sent[0].targetId, jobId);
  assert.equal(sent[0].totalPrice, 30);
  assert.equal(session.getSnapshot().snapshot.wallet.pearls, 70);
  assert.equal(session.getSnapshot().snapshot.buildings.home, 1);
  const confirmed = state(1); confirmed.wallet.pearls = 40; confirmed.buildings.home = 2;
  wait.resolve(result(confirmed)); await flush();
  assert.equal(session.getSnapshot().snapshot.wallet.pearls, 40);
  assert.equal(session.getSnapshot().snapshot.buildings.home, 2);
});

test("uncertain pearl speedup restores the exact maximum price and request ID", async () => {
  const cache = storage(), sent = [];
  let wallet = state(); wallet.wallet.pearls = 70;
  const t = transport({ get: async () => wallet, send: async command => {
    sent.push(structuredClone(command));
    if (sent.length === 1) { wallet = state(1); wallet.wallet.pearls = 40; wallet.buildings.home = 2; throw Error("Lost response"); }
    return { ...result(wallet), replayed: true };
  } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh(); first.act("speedup_construction", crypto.randomUUID(), 1, 30); await flush();
  assert.equal(first.getSnapshot().uncertain, true);
  first.act("speedup_construction", crypto.randomUUID(), 1, 80);
  assert.equal(sent.length, 1); stop();
  const next = createEconomySession(owner, t, () => assert.fail(), cache); next.activate(); await next.refresh();
  assert.equal(next.getSnapshot().uncertain, true);
  await next.retry();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[1].totalPrice, 30);
  assert.equal(next.getSnapshot().snapshot.wallet.pearls, 40);
  assert.equal(next.getSnapshot().uncertain, false);
  assert.equal(cache.data.size, 0);
});

const explorationJob = (id = crypto.randomUUID()) => ({ id, kind: "exploration", targetId: "shore", recipeId: null, targetLevel: null,
  startedAt: new Date(now - 1000).toISOString(), finishesAt: new Date(now + 1000).toISOString(), rewards: { fish: 4 },
  cost: { coins: 0, items: {} }, catalogVersion: 2 });

test("confirmed cancellation emits a bounded cosmetic event only after the job is absent", async () => {
  const saved = explorationJob(), wait = deferred();
  const initial = { ...state(), jobs: [saved] }, sent = [];
  const session = createEconomySession(owner, transport({ get: async () => initial, send: command => { sent.push(command); return wait.promise; } }), () => assert.fail());
  session.activate(); await session.refresh(); session.act("cancel_exploration", saved.id);
  assert.equal(session.getSnapshot().cancelledExplorations, undefined);
  assert.equal(session.getSnapshot().snapshot.jobs[0], saved);
  wait.resolve(result(state(1))); await flush();
  assert.deepEqual(session.getSnapshot().cancelledExplorations, [saved.id]);
  assert.ok(Object.isFrozen(session.getSnapshot().cancelledExplorations));
  assert.deepEqual(session.getSnapshot().snapshot.inventory, {});
  assert.deepEqual(session.getSnapshot().completedConstructions, []);
  assert.equal(sent[0].action, "cancel_exploration");
});

test("lost cancellation response preserves its receipt and restored replay reports cancellation once", async () => {
  const cache = storage(), saved = explorationJob(), sent = [];
  let latest = { ...state(), jobs: [saved] };
  const t = transport({ get: async () => latest, send: async command => {
    sent.push(structuredClone(command)); latest = state(1);
    if (sent.length === 1) throw Error("response lost after cancellation");
    return { ...result(latest), replayed: true };
  } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh(); first.act("cancel_exploration", saved.id); await flush();
  assert.equal(first.getSnapshot().uncertain, true); assert.equal(first.getSnapshot().cancelledExplorations, undefined);
  assert.equal(first.getSnapshot().snapshot.jobs.length, 1); stop();
  const restored = createEconomySession(owner, t, () => assert.fail(), cache); restored.activate(); await restored.refresh();
  assert.equal(restored.getSnapshot().cancelledExplorations, undefined, "polling an absent job is not a cancellation acknowledgement");
  await restored.retry();
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(restored.getSnapshot().cancelledExplorations, [saved.id]);
  assert.equal(restored.getSnapshot().uncertain, false); assert.equal(cache.data.size, 0);
  await restored.retry();
  assert.deepEqual(restored.getSnapshot().cancelledExplorations, [saved.id]);
});

test("foreign, obsolete or incomplete cancellation responses cannot mark a live job cancelled", async () => {
  const saved = explorationJob(), initial = { ...state(5), jobs: [saved] };
  for (const answer of [state(6, other), state(4), { ...state(6), jobs: [saved] }]) {
    let lost = 0;
    const session = createEconomySession(owner, transport({ get: async () => initial, send: async () => result(answer) }), () => lost++);
    session.activate(); await session.refresh(); session.act("cancel_exploration", saved.id); await flush();
    assert.equal(session.getSnapshot().cancelledExplorations, undefined);
    assert.equal(session.getSnapshot().snapshot.jobs[0].id, saved.id);
    assert.equal(lost, answer.ownerPublicId === other ? 1 : 0);
  }
});

test("cancellation notifications deduplicate acknowledgements and retain at most eight jobs", async () => {
  let latest = state(), revision = 0;
  const ids = Array.from({ length: 10 }, () => crypto.randomUUID());
  const session = createEconomySession(owner, transport({ get: async () => latest,
    send: async () => { latest = state(++revision); return result(latest); } }), () => assert.fail());
  session.activate();
  for (const id of ids) {
    latest = { ...state(revision), jobs: [explorationJob(id)] }; await session.refresh();
    session.act("cancel_exploration", id); await flush();
  }
  assert.deepEqual(session.getSnapshot().cancelledExplorations, ids.slice(-8));
  session.act("cancel_exploration", ids.at(-1)); await flush();
  assert.deepEqual(session.getSnapshot().cancelledExplorations, ids.slice(-8));
});

test("offline suspension aborts pending work and resumes the original receipt before a fresh snapshot", async () => {
  const cache = storage(), delayed = deferred(), sent = []; let latest = state(), gets = 0;
  const session = createEconomySession(owner, transport({ get: async () => { gets++; return latest; }, send: async command => {
    sent.push(structuredClone(command)); latest = state(3); latest.wallet.coins = 600;
    return sent.length === 1 ? delayed.promise : { ...result(latest), replayed: true };
  } }), () => assert.fail(), cache);
  session.activate(); await session.refresh(); session.act("start_exploration", "forest");
  session.setAvailable(false); session.act("start_production", "grow_berries"); await session.refresh();
  assert.equal(session.getSnapshot().busy, false); assert.equal(sent.length, 1); assert.equal(gets, 1);
  assert.equal(await session.reconcile(), true);
  assert.deepEqual(sent[0], sent[1]); assert.equal(gets, 2); assert.equal(cache.data.size, 0);
  delayed.resolve(result(state(1))); await flush();
  assert.equal(session.getSnapshot().snapshot.revision, 3); assert.equal(session.getSnapshot().snapshot.wallet.coins, 600);
});

test("request timeout, too-early and inactive presence responses retain the exact pending command", async () => {
  for (const error of [new ApiError("Wait", 408), new ApiError("Wait", 425), new ApiError("Resume", 409, { code: "GAME_SESSION_INACTIVE", message: "Resume" })]) {
    const sent = [], cache = storage();
    const session = createEconomySession(owner, transport({ send: async command => { sent.push({ ...command }); if (sent.length === 1) throw error; return result(state(1)); } }), () => assert.fail(), cache);
    session.activate(); await session.refresh(); session.act("start_exploration", "forest"); await flush();
    assert.equal(session.getSnapshot().uncertain, true); assert.equal(cache.data.size, 1);
    await session.retry(); assert.deepEqual(sent[0], sent[1]); assert.equal(cache.data.size, 0);
  }
});

test("failed reconciliation returns false and remount retries without stale coalescing promises", async () => {
  let gets = 0;
  const session = createEconomySession(owner, transport({ get: async () => { gets++; if (gets === 1) throw Error("offline"); return state(2); } }), () => assert.fail());
  const stop = session.activate();
  assert.equal(await session.reconcile(), false); stop();
  session.setAvailable(false); session.activate();
  assert.equal(await session.reconcile(), true); assert.equal(gets, 2);
});

const saleState = (revision = 0, sold = false, ownerPublicId = owner) => ({ ...state(revision, ownerPublicId),
  inventory: { wood: sold ? 9 : 10 }, wallet: { coins: sold ? 1002 : 1000, pearls: 0 } });

test("local sale feedback waits for the exact confirmed command and never comes from polling", async () => {
  const wait = deferred(), sent = [];
  let latest = saleState();
  const session = createEconomySession(owner, transport({ get: async () => latest,
    send: command => { sent.push(command); return wait.promise; } }), () => assert.fail());
  session.activate(); await session.refresh();
  session.act("sell", "wood", 1, 2);
  assert.equal(session.getSnapshot().localSale, undefined);
  latest = saleState(1, true); wait.resolve(result(latest)); await flush();
  const receipt = session.getSnapshot().localSale;
  assert.deepEqual(receipt, { id: sent[0].requestId, ownerPublicId: owner, revision: 1, itemId: "wood", quantity: 1, coins: 2 });
  assert.ok(Object.isFrozen(receipt));
  latest = saleState(2, true); latest.wallet.coins += 100;
  await session.refresh(); await session.retry();
  assert.equal(session.getSnapshot().localSale, receipt, "a wallet refresh cannot manufacture another sale receipt");
  const reopened = createEconomySession(owner, transport({ get: async () => latest }), () => assert.fail());
  reopened.activate(); await reopened.refresh();
  assert.equal(reopened.getSnapshot().localSale, undefined);
});

test("a rejected sale has no success feedback, while a lost response is acknowledged only once after confirmation", async () => {
  const denied = createEconomySession(owner, transport({ get: async () => saleState(),
    send: async () => { throw new ApiError("Недостаточно припасов", 409); } }), () => assert.fail());
  denied.activate(); await denied.refresh(); denied.act("sell", "wood", 1, 2); await flush();
  assert.equal(denied.getSnapshot().localSale, undefined);
  assert.equal(denied.getSnapshot().uncertain, false);

  const sent = [];
  const session = createEconomySession(owner, transport({ get: async () => saleState(), send: async command => {
    sent.push(command);
    if (sent.length === 1) throw Error("response lost");
    return { ...result(saleState(1, true)), replayed: true };
  } }), () => assert.fail());
  session.activate(); await session.refresh(); session.act("sell", "wood", 1, 2); await flush();
  assert.equal(session.getSnapshot().uncertain, true);
  assert.equal(session.getSnapshot().localSale, undefined);
  await session.retry();
  assert.deepEqual(sent[0], sent[1]);
  const receipt = session.getSnapshot().localSale;
  assert.equal(receipt.id, sent[0].requestId);
  await session.retry();
  assert.equal(session.getSnapshot().localSale, receipt);
});

test("restoring an already applied sale receipt never replays practice feedback", async () => {
  const cache = storage(), sent = [];
  let latest = saleState();
  const t = transport({ get: async () => latest, send: async command => {
    sent.push(command); latest = saleState(1, true);
    if (sent.length === 1) throw Error("response lost");
    return { ...result(latest), replayed: true };
  } });
  const first = createEconomySession(owner, t, () => assert.fail(), cache), stop = first.activate();
  await first.refresh(); first.act("sell", "wood", 1, 2); await flush(); stop();
  const restored = createEconomySession(owner, t, () => assert.fail(), cache);
  restored.activate(); await restored.refresh(); await restored.retry();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(restored.getSnapshot().uncertain, false);
  assert.equal(restored.getSnapshot().localSale, undefined);
});

test("unrelated commands, foreign owners, stale revisions and mismatched sale quantities cannot create sale feedback", async () => {
  const answers = [saleState(1, true), saleState(1, true, other), saleState(0, true),
    { ...saleState(1, true), inventory: { wood: 8 } }, { ...saleState(1, true), wallet: { coins: 1000, pearls: 0 } }];
  for (const [index, answer] of answers.entries()) {
    let lost = 0;
    const session = createEconomySession(owner, transport({ get: async () => saleState(), send: async () => result(answer) }), () => lost++);
    session.activate(); await session.refresh(); session.act(index === 0 ? "start_production" : "sell", "wood", 1, 2); await flush();
    assert.equal(session.getSnapshot().localSale, undefined);
    assert.equal(lost, answer.ownerPublicId === other ? 1 : 0);
  }
});
