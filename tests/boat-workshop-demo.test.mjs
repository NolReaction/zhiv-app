import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createBoatWorkshopDemo } = await vite.ssrLoadModule("/features/economy/dev/boat-workshop-demo.ts");
const { default: WorkshopPage } = await vite.ssrLoadModule("/app/prototype/boat-workshop/page.tsx");
const { BoatWorkshopPreview } = await vite.ssrLoadModule("/features/economy/dev/boat-workshop-preview.tsx");
const { boatPhase } = await vite.ssrLoadModule("/features/economy/domain/boat-fishing.ts");
const { economyViewSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const at = Date.parse("2026-11-09T09:00:00Z");

function rehearsal() {
  const demo = createBoatWorkshopDemo({ ownerPublicId: "DEMW-0000-0000", now: () => at });
  const command = (action, targetId) => ({ action, targetId, requestId: crypto.randomUUID(),
    ownerPublicId: demo.ownerPublicId, expectedRevision: demo.read().revision, quantity: 1, totalPrice: 0 });
  return { ...demo, command, act: (action, targetId) => demo.send(command(action, targetId)),
    actDev: (action, targetId) => demo.dev(command(action, targetId)) };
}

test("workshop rehearsal is unavailable outside local development", () => {
  const previous = process.env.NODE_ENV;
  try {
    for (const mode of ["production", "test", "preview", undefined]) {
      if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
      assert.throws(() => WorkshopPage(), error => error.digest === "NEXT_HTTP_ERROR_FALLBACK;404");
    }
    process.env.NODE_ENV = "development";
    assert.equal(WorkshopPage().type, BoatWorkshopPreview);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test("demo starts broken, owns its state, isolates coach keys and needs no IO", () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { assert.fail("The rehearsal must never call an API"); };
  try {
    const a = createBoatWorkshopDemo(), b = createBoatWorkshopDemo();
    assert.match(a.ownerPublicId, /^DEMW-/); assert.notEqual(a.ownerPublicId, b.ownerPublicId);
    const snapshot = a.read(), before = structuredClone(snapshot);
    assert.equal(economyViewSchema.safeParse(snapshot).success, true);
    assert.equal(snapshot.boat.level, 0); assert.equal(Boolean(snapshot.boat.work || snapshot.boat.voyage), false);
    snapshot.boat.level = 5; snapshot.inventory.planks = 0;
    assert.equal(a.read().boat.level, before.boat.level);
    assert.equal(a.read().inventory.planks, before.inventory.planks);
    assert.equal(b.read().boat.level, 0);
  } finally { globalThis.fetch = previous; }
});

test("ordinary repair, claim, departure and cast run real rules against private local authority", () => {
  const demo = rehearsal(), before = demo.read();
  const repair = demo.command("start_boat_upgrade", "repair"), started = demo.send(repair);
  assert.equal(started.state.boat.level, 0);
  assert.equal(started.state.wallet.coins, before.wallet.coins, "first hull repair is free");
  assert.equal(demo.send(repair).replayed, true);
  assert.throws(() => demo.send({ ...repair, targetId: "oars" }), /другими параметрами/);
  assert.equal(demo.read().wallet.coins, started.state.wallet.coins);
  demo.actDev("finish_boat_work", started.state.boat.work.id);
  assert.equal(demo.read().boat.level, 0, "accelerating a timer never claims the paid upgrade");
  const ready = demo.act("claim_boat_upgrade", started.state.boat.work.id).state;
  assert.equal(ready.boat.level, 1);
  const outward = demo.act("depart_boat", ready.catalog.boat.routeId).state;
  assert.equal(boatPhase(outward.boat, at), "fishing");
  assert.equal(outward.boat.voyage.slots, undefined);
  assert.equal(boatPhase(demo.read().boat, at), "fishing");
  const cast = demo.act("begin_boat_cast", outward.boat.voyage.id).state;
  assert.ok(cast.boat.voyage.challenge);
  assert.equal(cast.boat.voyage.slots, undefined);
  assert.equal(cast.boat.voyage.catches.length, 0);
  assert.doesNotMatch(JSON.stringify(cast.boat), /"slots"|"weightGrams"/);
});

test("unrelated actions, stale revisions and another owner cannot mutate the demo", () => {
  const demo = rehearsal(), before = demo.read();
  assert.throws(() => demo.send(demo.command("sell", "planks")), /только лодка/);
  assert.throws(() => demo.send({ ...demo.command("start_boat_upgrade", "repair"), expectedRevision: 0 }), /сцена изменилась/);
  assert.throws(() => demo.send({ ...demo.command("start_boat_upgrade", "repair"), ownerPublicId: "0000-0000-0000" }), /сцена изменилась/);
  assert.deepEqual(demo.read(), before);
});

test("local validation, owner and revision rejections preserve the real API status/code contract", () => {
  const demo = rehearsal();
  const rejects = (callback, status, code) => assert.throws(callback,
    error => error instanceof ApiError && error.status === status && error.body?.code === code);
  rejects(() => demo.send({ ...demo.command("start_boat_upgrade", "repair"), quantity: -1 }), 400, "INVALID_ECONOMY_COMMAND");
  rejects(() => demo.dev({ ...demo.command("finish_boat_work", "invalid"), action: "unsupported" }), 400, "INVALID_ECONOMY_COMMAND");
  rejects(() => demo.send({ ...demo.command("start_boat_upgrade", "repair"), expectedRevision: 0 }), 409, "ECONOMY_REVISION_CONFLICT");
  rejects(() => demo.send({ ...demo.command("start_boat_upgrade", "repair"), ownerPublicId: "0000-0000-0000" }), 403, "ECONOMY_OWNER_MISMATCH");
});

test("the real controller delivers demo work and ordinary claims without an account or saved receipt storage", async () => {
  const demo = rehearsal();
  const session = createEconomySession(demo.ownerPublicId, {
    get: async () => demo.read(), send: async command => demo.send(command), dev: async command => demo.dev(command),
    market: async () => assert.fail("Boat rehearsal cannot access a market"),
    trade: async () => assert.fail("Boat rehearsal cannot access a market"),
  }, () => assert.fail("The memory rehearsal has no login session"));
  const deactivate = session.activate(), flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    await session.refresh();
    assert.equal(session.getSnapshot().snapshotConfirmed, true);
    assert.equal(session.act("start_boat_upgrade", "repair"), true);
    await flush();
    const work = session.getSnapshot().snapshot.boat.work;
    assert.ok(work);
    const paidRevision = session.getSnapshot().snapshot.revision;
    assert.equal(session.act("claim_boat_upgrade", work.id), true);
    await flush();
    assert.equal(session.getSnapshot().busy, false);
    assert.equal(session.getSnapshot().uncertain, false, "an early rejected claim must clear the pending request");
    assert.equal(session.getSnapshot().snapshot.revision, paidRevision);
    assert.equal(session.getSnapshot().snapshot.boat.level, 0);
    assert.match(session.getSnapshot().error, /Работа ещё не закончена/);
    session.actDev("finish_boat_work", work.id);
    await flush();
    assert.equal(session.getSnapshot().snapshot.boat.level, 0);
    assert.equal(session.act("claim_boat_upgrade", work.id), true);
    await flush();
    assert.equal(session.getSnapshot().snapshot.boat.level, 1);
    assert.equal(session.getSnapshot().error, null);
  } finally { deactivate(); }
  assert.equal(session.act("depart_boat", demo.read().catalog.boat.routeId), false);
});

test("an unexpected authority failure remains uncertain and retries its original request", async () => {
  const failure = new Error("Unexpected local rehearsal failure");
  let failing = false;
  const demo = createBoatWorkshopDemo({ ownerPublicId: "DEMW-0000-0000", now: () => { if (failing) throw failure; return at; } });
  const sent = [];
  const session = createEconomySession(demo.ownerPublicId, {
    get: async () => demo.read(), send: async command => { sent.push(structuredClone(command)); return demo.send(command); },
    market: async () => assert.fail(), trade: async () => assert.fail(),
  }, () => assert.fail());
  const deactivate = session.activate(), flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    await session.refresh();
    failing = true;
    assert.equal(session.act("start_boat_upgrade", "repair"), true);
    await flush();
    assert.equal(session.getSnapshot().uncertain, true);
    failing = false;
    assert.equal(demo.read().boat.level, 0);
    assert.equal(Boolean(demo.read().boat.work), false);
    await session.retry();
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(session.getSnapshot().uncertain, false);
    assert.equal(session.getSnapshot().snapshot.boat.work.upgradeId, "repair");
  } finally { deactivate(); }
});
