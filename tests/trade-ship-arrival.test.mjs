import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createTradeShipArrivalRuntime, connectTradeShipArrival } = await vite.ssrLoadModule("/features/world/state/trade-ship-arrival.ts");
const { createTradeShipArrivalStore, TRADE_SHIP_ARRIVAL_DURATION: duration } =
  await vite.ssrLoadModule("/features/world/state/trade-ship-arrival-storage.ts");

let sequence = 0;
const ownerId = () => `arrival-runtime-${++sequence}`;
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
function disk() {
  const values = new Map(); let writes = 0;
  return { values, get writes() { return writes; }, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes++; values.set(key, value); } };
}
function access(owner, revision = 1, lighthouse = 1) {
  return { ownerPublicId: owner, revision, buildings: { home: 3, lighthouse },
    production: { ownerPublicId: owner, revision, jobs: [] } };
}
function fixture(owner = ownerId(), storage = disk()) {
  const store = createTradeShipArrivalStore(owner, storage), runtime = createTradeShipArrivalRuntime(owner, store);
  let frame = 0;
  return { owner, storage, store, runtime,
    ready() { runtime.restore(); runtime.configure(access(owner)); },
    advance(seconds) {
      for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += .05) runtime.advance(Math.min(.05, seconds - elapsed), ++frame);
    },
  };
}

test("only an owner-matched confirmed revision can reveal a pending ship; storage alone cannot unlock it", () => {
  const f = fixture();
  f.runtime.configure(access(f.owner));
  assert.equal(f.runtime.getFrame(), null, "first storage hydration must finish before exposing the intro");
  assert.equal(f.runtime.start(), false);
  f.runtime.restore();
  const pending = f.runtime.getFrame();
  assert.equal(pending.kind, "arrival"); assert.equal(pending.pending, true);
  assert.equal(pending.motion.phase, "arriving"); assert.equal(pending.motion.elapsed, 0);
  f.runtime.advance(.05, 1); assert.equal(f.runtime.getFrame().motion, pending.motion, "unrevealed intro cannot spend time");
  assert.equal(f.storage.writes, 0);
  f.runtime.dispose();

  const locked = fixture(); locked.runtime.restore();
  for (const incoming of [null, undefined, { buildings: { lighthouse: 1 } },
    access("another-account"), { ...access(locked.owner), revision: NaN },
    { ...access(locked.owner), production: { ownerPublicId: "another-account", revision: 1, jobs: [] } },
    { ...access(locked.owner), production: { ownerPublicId: locked.owner, revision: 2, jobs: [] } }]) {
    locked.runtime.configure(incoming); assert.equal(locked.runtime.getFrame(), null);
  }
  const building = access(locked.owner, 2, 0);
  building.production.jobs.push({ id: "ready-lighthouse", stationId: "lighthouse", phase: "ready" });
  locked.runtime.configure(building);
  assert.equal(locked.runtime.getFrame(), null, "a ready but unclaimed construction is not a lighthouse level");
  locked.runtime.configure(access(locked.owner, 3, 1)); assert.equal(locked.runtime.getFrame().pending, true);
  locked.runtime.dispose();
});

test("last confirmed lighthouse access survives transient null and stale snapshots but a new confirmed zero hides it", () => {
  const f = fixture(); f.runtime.restore(); f.runtime.configure(access(f.owner, 10)); f.runtime.start();
  f.runtime.advance(.05, 1); const moving = f.runtime.getFrame().motion;
  for (const incoming of [null, undefined, access("another-account", 100, 0), access(f.owner, 9, 0), access(f.owner, 10, 0)]) {
    f.runtime.configure(incoming); assert.equal(f.runtime.getFrame().motion, moving, "optimistic/cache gaps cannot rewind a known arrival");
  }
  f.runtime.configure(access(f.owner, 11, 0)); assert.equal(f.runtime.getFrame(), null);
  f.runtime.advance(.05, 2); f.runtime.flush(); near(f.store.getSnapshot().progress.elapsed, .05);
  f.runtime.configure(access(f.owner, 12));
  assert.equal(f.runtime.getFrame().pending, false); assert.equal(f.runtime.getFrame().motion, moving);
  f.runtime.advance(.05, 3); near(f.runtime.getFrame().motion.elapsed, .1);
  f.runtime.dispose();
});

test("an empty owner and malformed lighthouse levels never acquire visibility or persistent progress", () => {
  const blank = fixture(""); blank.runtime.restore(); blank.runtime.configure(access(""));
  assert.equal(blank.runtime.getFrame(), null); assert.equal(blank.runtime.start(), false);
  blank.runtime.advance(.05, 1); assert.equal(blank.runtime.claimHorn(), false); assert.equal(blank.storage.writes, 0);
  blank.runtime.dispose();
  const f = fixture(); f.runtime.restore();
  for (const [index, level] of [NaN, Infinity, -1, .5, "1", undefined].entries()) {
    f.runtime.configure({ ...access(f.owner, index + 1), buildings: { lighthouse: level } }); assert.equal(f.runtime.getFrame(), null);
  }
  f.runtime.dispose();
});

test("one valid RAF advances once, pathological frame gaps are capped and ordinary frames do not write storage", () => {
  const f = fixture(); f.ready(); f.runtime.start();
  const initial = f.runtime.getFrame().motion, writes = f.storage.writes;
  for (const [seconds, frame] of [[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [.02, NaN], [.02, Infinity]])
    f.runtime.advance(seconds, frame);
  assert.equal(f.runtime.getFrame().motion, initial);
  f.runtime.advance(.02, 1); near(f.runtime.getFrame().motion.elapsed, .02);
  const once = f.runtime.getFrame().motion;
  f.runtime.advance(.02, 1); assert.equal(f.runtime.getFrame().motion, once);
  f.runtime.advance(1e20, 2); near(f.runtime.getFrame().motion.elapsed, .07);
  assert.equal(f.storage.writes, writes, "sub-checkpoint frames cannot write localStorage every RAF");
  for (let frame = 3; frame < 10; frame++) f.runtime.advance(.05, frame);
  assert.ok(f.storage.writes > writes);
  assert.ok(f.store.getSnapshot().progress.elapsed <= f.runtime.getFrame().motion.elapsed);
  f.runtime.dispose();
});

test("restoring a partial intro resumes its exact active time and keeps a durably consumed horn", () => {
  const f = fixture(); f.ready(); f.runtime.start(); f.advance(4.13);
  const before = f.runtime.getFrame().motion;
  assert.equal(f.runtime.claimHorn(), true);
  const saved = JSON.parse(f.storage.values.get(f.store.storageKey));
  near(saved.elapsed, 4.13); assert.equal(saved.hornClaimed, true);
  f.runtime.dispose();
  const resumed = fixture(f.owner, f.storage); resumed.ready();
  const frame = resumed.runtime.getFrame(); assert.equal(frame.pending, false);
  for (const key of ["x", "y", "heading", "elapsed", "velocityX", "velocityY"]) near(frame.motion[key], before[key]);
  resumed.runtime.restore(); resumed.runtime.configure(null);
  assert.equal(resumed.runtime.getFrame().motion, frame.motion, "restoration does not accrue wall time");
  resumed.runtime.start(); assert.equal(resumed.runtime.getFrame().motion, frame.motion, "remount handshake cannot restart an in-flight intro");
  assert.equal(resumed.runtime.claimHorn(), false);
  const other = fixture(ownerId(), f.storage); other.ready(); assert.equal(other.runtime.getFrame().pending, true);
  assert.notEqual(other.runtime.getFrame().voyageId, frame.voyageId);
  other.runtime.dispose(); resumed.runtime.dispose();
});

test("arrival and gangway complete once, then stay docked across remounts and transient authority gaps", () => {
  const f = fixture(); f.ready(); f.runtime.start(); f.advance(duration + 1);
  const docked = f.runtime.getFrame();
  assert.equal(docked.pending, false); assert.equal(docked.motion.phase, "docked"); assert.equal(docked.motion.gangway, 1);
  near(f.store.getSnapshot().progress.elapsed, duration);
  f.runtime.advance(.05, 100_000); assert.equal(f.runtime.getFrame().motion, docked.motion);
  f.runtime.dispose();
  const restored = fixture(f.owner, f.storage); restored.ready();
  assert.equal(restored.runtime.getFrame().motion.phase, "docked");
  restored.runtime.configure(null); assert.equal(restored.runtime.getFrame().motion.phase, "docked");
  restored.runtime.configure(access(f.owner, 2, 0)); assert.equal(restored.runtime.getFrame(), null, "stored completion cannot override a locked authoritative world");
  restored.runtime.configure(access(f.owner, 3)); assert.equal(restored.runtime.getFrame().motion.phase, "docked");
  restored.runtime.dispose();
});

test("reduced-motion settlement is static and repeated reveal handshakes cannot create notification loops", () => {
  const f = fixture(); f.ready(); let changes = 0;
  const unsubscribe = f.runtime.subscribe(() => changes++);
  assert.equal(f.runtime.start(true), true);
  const docked = f.runtime.getFrame().motion, settledChanges = changes, writes = f.storage.writes;
  assert.equal(docked.phase, "docked"); near(f.store.getSnapshot().progress.elapsed, duration);
  for (let n = 0; n < 10; n++) f.runtime.start(true);
  assert.equal(changes, settledChanges, "settled reveal must not notify a subscriber that calls resume/syncOwner");
  assert.equal(f.storage.writes, writes); assert.equal(f.runtime.getFrame().motion, docked);
  unsubscribe(); f.runtime.dispose();
});

test("circle/map connections share one clock, one horn claim and release safely", async () => {
  const owner = ownerId(); let changes = 0;
  const circle = connectTradeShipArrival(owner, () => changes++), map = connectTradeShipArrival(owner, () => changes++);
  circle.configure(access(owner)); assert.equal(map.getFrame().pending, true);
  map.start(); circle.advance(.02, 100); map.advance(.02, 100);
  near(map.getFrame().motion.elapsed, .02); assert.equal(circle.getFrame().motion, map.getFrame().motion);
  assert.equal(map.getFrame().claimHorn(), true); assert.equal(circle.getFrame().claimHorn(), false);
  const inFlight = map.getFrame().motion;
  map.release(); assert.equal(map.getFrame(), null); assert.equal(map.start(), false);
  map.advance(.02, 101); assert.equal(circle.getFrame().motion, inFlight);
  await Promise.resolve(); assert.ok(changes > 0);
  circle.release();
  const reopened = connectTradeShipArrival(owner, () => {});
  reopened.configure(access(owner)); assert.equal(reopened.getFrame().pending, false);
  near(reopened.getFrame().motion.elapsed, .02); assert.equal(reopened.getFrame().claimHorn(), false);
  reopened.release();
});
