import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createTradeShipArrivalStore: store, tradeShipArrivalStorageKey: key, TRADE_SHIP_ARRIVAL_DURATION: duration } =
  await vite.ssrLoadModule("/features/world/state/trade-ship-arrival-storage.ts");
let sequence = 0;
const owner = () => `ship-storage-${++sequence}`;
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("first-arrival storage is lazy, owner-scoped, and preserves stationary completion after reload", () => {
  const id = owner(), disk = storage(), first = store(id, disk);
  assert.deepEqual(first.getSnapshot(), { loaded: false, progress: null });
  assert.equal(first.getSnapshot(), first.getServerSnapshot());
  assert.equal(disk.values.size, 0);
  first.restore(); assert.deepEqual(first.getSnapshot(), { loaded: true, progress: null });
  assert.equal(first.claimHorn(), false); first.checkpoint(10); assert.equal(disk.values.size, 0);
  first.start(); first.checkpoint(7.75); assert.equal(first.claimHorn(), true);
  assert.equal(JSON.parse(disk.values.get(key(id))).hornClaimed, true, "horn is durably consumed before playback");
  const resumed = store(id, disk); resumed.restore();
  assert.deepEqual(resumed.getSnapshot().progress, { version: 1, started: true, elapsed: 7.75, hornClaimed: true });
  assert.equal(resumed.claimHorn(), false); resumed.start(); assert.equal(resumed.getSnapshot().progress.elapsed, 7.75);
  resumed.checkpoint(duration + 99);
  const docked = store(id, disk); docked.restore();
  assert.equal(docked.getSnapshot().progress.elapsed, duration);
  const other = store(owner(), disk); other.restore(); assert.equal(other.getSnapshot().progress, null);
  assert.notEqual(key("a/b"), key("a%2Fb"));
});

test("same-tab peers share monotonic checkpoints and a consumed horn without per-frame writes", () => {
  const id = owner(), disk = storage(), a = store(id, disk), b = store(id, disk);
  let calls = 0, writes = 0; const set = disk.setItem; disk.setItem = (...args) => { writes++; set(...args); };
  const unsubscribe = b.subscribe(() => calls++);
  a.start(); assert.equal(b.getSnapshot().progress.started, true);
  a.checkpoint(8); assert.equal(b.getSnapshot().progress.elapsed, 8);
  assert.equal(b.claimHorn(), true); assert.equal(a.claimHorn(), false);
  assert.equal(a.getSnapshot().progress.hornClaimed, true);
  const before = a.getSnapshot(), count = writes;
  a.checkpoint(2); a.checkpoint(8); a.checkpoint(NaN); a.checkpoint(Infinity); a.checkpoint(-1); a.start();
  assert.equal(a.getSnapshot(), before); assert.equal(writes, count); assert.ok(calls >= 2);
  unsubscribe(); a.checkpoint(10); b.restore(); assert.equal(b.getSnapshot().progress.elapsed, 10);
});

test("native storage events cannot rewind progress or erase an already consumed horn", () => {
  const id = owner(), disk = storage(), a = store(id, disk);
  a.start(); a.checkpoint(9); assert.equal(a.claimHorn(), true);
  disk.values.set(key(id), JSON.stringify({ version: 1, started: true, elapsed: 12, hornClaimed: false }));
  a.restore(); assert.equal(a.getSnapshot().progress.elapsed, 12); assert.equal(a.getSnapshot().progress.hornClaimed, true);
  disk.values.set(key(id), JSON.stringify({ version: 1, started: false, elapsed: 0, hornClaimed: false }));
  a.restore(); assert.equal(a.getSnapshot().progress.elapsed, 12);
  a.checkpoint(13); assert.equal(JSON.parse(disk.values.get(key(id))).hornClaimed, true);
});

test("blocked storage retains progress and horn consumption for mounts in this document", () => {
  const id = owner(), blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const a = store(id, blocked); a.start(); a.checkpoint(6); assert.equal(a.claimHorn(), true);
  const b = store(id, blocked); b.restore();
  assert.deepEqual(b.getSnapshot().progress, { version: 1, started: true, elapsed: 6, hornClaimed: true });
  assert.equal(b.claimHorn(), false); b.checkpoint(duration);
  a.restore(); assert.equal(a.getSnapshot().progress.elapsed, duration);
});

test("corrupt and future records are ignored; finite elapsed is bounded and unstarted data cannot grant completion", () => {
  for (const raw of ["broken", "null", "[]", "{}", '{"version":2,"started":true,"elapsed":10,"hornClaimed":false}',
    '{"version":1,"started":1,"elapsed":10,"hornClaimed":false}', '{"version":1,"started":true,"elapsed":"10","hornClaimed":false}',
    '{"version":1,"started":true,"elapsed":10,"hornClaimed":1}']) {
    const id = owner(), a = store(id, storage({ [key(id)]: raw })); a.restore(); assert.equal(a.getSnapshot().progress, null);
  }
  for (const [elapsed, expected] of [[-1, 0], [duration + 100, duration]]) {
    const id = owner(), a = store(id, storage({ [key(id)]: JSON.stringify({ version: 1, started: true, elapsed, hornClaimed: false }) }));
    a.restore(); assert.equal(a.getSnapshot().progress.elapsed, expected);
  }
  const id = owner(), a = store(id, storage({ [key(id)]: JSON.stringify({ version: 1, started: false, elapsed: duration, hornClaimed: true }) }));
  a.restore(); assert.deepEqual(a.getSnapshot().progress, { version: 1, started: false, elapsed: 0, hornClaimed: false });
  const blank = store("", { getItem: assert.fail, setItem: assert.fail });
  blank.restore(); blank.start(); blank.checkpoint(1); assert.equal(blank.claimHorn(), false); assert.equal(blank.getSnapshot().progress, null);
});
