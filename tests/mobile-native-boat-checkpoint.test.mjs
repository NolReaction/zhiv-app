import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
after(() => vite.close());
const { createNativeBoatReelCheckpoint: open } = await vite.ssrLoadModule("/features/economy/ui/boat/native-boat-reel-checkpoint.ts");
const checkpoint = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-checkpoint.ts");
const { initialBoatReel, replayBoatReel } = await vite.ssrLoadModule("/features/economy/domain/boat-reel.ts");
const { prepareGameplayGeneration } = await vite.ssrLoadModule("/lib/gameplay-generation.ts");
const attempt = { id: "cast-one", rulesVersion: 6, seed: 17, tickMs: 50, maxTicks: 600, zoneWidth: 3200, difficulty: 1,
  fishRarity: "common", resistance: "steady", motorResponse: 0, hullDamping: 0,
  startedAt: "2026-11-14T10:00:00Z", biteAt: "2026-11-14T10:00:04Z", expiresAt: "2026-11-14T10:02:00Z" };
const owner = "owner", key = checkpoint.boatReelCheckpointKey(owner, "voyage", attempt.id);
const hooked = checkpoint.encodeBoatReelCheckpoint(attempt, initialBoatReel(attempt), [], true, Date.parse(attempt.biteAt));
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const rows = new Map(), browser = new Map(), operations = [], waiting = [];
  let blocked = false, failure = false, lostAck = false;
  const storage = { getItem: k => rows.get(k) ?? null, getKeys: () => [...rows.keys()],
    async setItem(k, v) {
      operations.push(["set", k]); if (blocked) await new Promise(resolve => waiting.push(resolve));
      if (failure) throw Error("Disk full"); rows.set(k, v);
      if (lostAck) throw Error("Native acknowledgement lost");
    },
    async removeItem(k) { operations.push(["remove", k]); if (failure) throw Error("Disk full"); rows.delete(k); },
  };
  const legacy = { getItem: k => browser.get(k) ?? null, removeItem: k => { operations.push(["legacy-remove", k]); browser.delete(k); } };
  return { rows, browser, operations, storage, legacy, open: () => open(storage, owner, key, attempt, legacy),
    block() { blocked = true; }, release() { blocked = false; waiting.splice(0).forEach(resolve => resolve()); },
    fail() { failure = true; }, loseAck() { lostAck = true; } };
}

test("legacy reel import keeps the source until SQLite commit and retention are acknowledged", async () => {
  const f = fixture(); f.browser.set(key, hooked); f.block();
  const session = f.open(); let ready = false; void session.ready.then(() => { ready = true; });
  await settle(); assert.equal(ready, false); assert.equal(f.browser.get(key), hooked); assert.equal(f.rows.has(key), false);
  f.release(); const restored = await session.ready;
  assert.equal(restored.hooked, true); assert.equal(f.rows.get(key), hooked); assert.equal(f.browser.has(key), false);
  assert(f.operations.findIndex(([op]) => op === "legacy-remove") > f.operations.findIndex(([op, k]) => op === "set" && k === checkpoint.boatReelCheckpointPointer(owner)));
});

test("failed legacy import leaves the browser trace and retention pointer unchanged", async () => {
  const f = fixture(); f.browser.set(key, hooked); f.fail();
  await assert.rejects(f.open().ready, /Disk full/);
  assert.equal(f.browser.get(key), hooked); assert.equal(f.rows.size, 0);
});

test("a lost native acknowledgement keeps the import and freezes all further writes in that session", async () => {
  const f = fixture(); f.browser.set(key, hooked); f.loseAck();
  const session = f.open(); await assert.rejects(session.ready, /acknowledgement lost/);
  assert.equal(f.rows.get(key), hooked); assert.equal(f.browser.get(key), hooked);
  await assert.rejects(session.write(hooked), /acknowledgement lost/);
  assert.equal(f.operations.length, 1);
});

test("retention only removes the previous checkpoint in the same owner and generation namespace", async () => {
  const f = fixture(), previous = checkpoint.boatReelCheckpointKey(owner, "voyage", "older"), other = checkpoint.boatReelCheckpointKey("other", "voyage", "older");
  f.rows.set(previous, "old"); f.rows.set(other, "foreign"); f.rows.set(checkpoint.boatReelCheckpointPointer(owner), previous);
  await f.open().ready;
  assert.equal(f.rows.has(previous), false); assert.equal(f.rows.get(other), "foreign");
  f.rows.set(checkpoint.boatReelCheckpointPointer(owner), other); await f.open().ready;
  assert.equal(f.rows.get(other), "foreign");
});

test("a corrupt native trace blocks readiness without replacing the stored evidence", async () => {
  const f = fixture(); f.rows.set(key, "broken");
  await assert.rejects(f.open().ready, /прочитать/);
  assert.equal(f.rows.get(key), "broken"); assert.equal(f.operations.length, 0);
});

test("closing accepts no new writes while the next mount waits for already issued commits", async () => {
  const f = fixture(), first = f.open(); await first.ready;
  f.block(); const saved = first.write(hooked); await settle(); first.close();
  await assert.rejects(first.write(hooked), /закрыта/);
  const second = f.open(); let ready = false; void second.ready.then(() => { ready = true; });
  await settle(); assert.equal(ready, false); f.release(); await saved;
  assert.equal((await second.ready).hooked, true);
});

test("native checkpoints preserve missed bites as terminal commands and reject invalid traces", async () => {
  const f = fixture(), session = f.open(); await session.ready;
  const missed = checkpoint.encodeBoatReelCheckpoint(attempt, initialBoatReel(attempt), [], false, undefined, true);
  await session.write(missed); assert.equal((await f.open().ready).missedBite, true);
  const invalid = JSON.stringify({ ...JSON.parse(missed), endTick: 1 });
  await assert.rejects(session.write(invalid), /Некорректная/); assert.equal(f.rows.get(key), missed);
});

test("a gameplay reset scopes keys and retention and never imports the legacy unscoped trace", async () => {
  const f = fixture(); f.browser.set(key, hooked); f.rows.set(key, hooked);
  f.rows.set(checkpoint.boatReelCheckpointPointer(owner), key);
  assert.equal(prepareGameplayGeneration(owner, 1), true);
  const resetKey = checkpoint.boatReelCheckpointKey(owner, "voyage", attempt.id);
  assert.notEqual(resetKey, key);
  const restored = await open(f.storage, owner, resetKey, attempt, f.legacy).ready;
  assert.equal(restored.reel.tick, 0); assert.equal(restored.hooked, undefined);
  assert.equal(f.rows.get(key), hooked); assert.equal(f.browser.get(key), hooked);
  assert.equal(f.rows.get(checkpoint.boatReelCheckpointPointer(owner)), resetKey);
  const reel = replayBoatReel(attempt, [], 1);
  assert.equal(reel.tick, 1);
});
