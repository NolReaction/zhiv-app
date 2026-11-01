import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { playerXpGainFromReceipt } = await vite.ssrLoadModule("/features/economy/domain/player-xp-gain.ts");
const { createPlayerXpPlayback, playerXpFillFrames } = await vite.ssrLoadModule("/features/game/player-xp-playback.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const owner = "AAAA-0000-0001", other = "AAAA-0000-0002";
const state = (xp = 29, revision = 0, ownerPublicId = owner) => ({ ownerPublicId, revision, serverTime: "2026-11-01T12:00:00.000Z",
  wallet: { coins: 1000, pearls: 0 }, inventory: {}, buildings: { home: 1, garden: 1, warehouse: 1, kiln: 0 },
  storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 }, jobs: [],
  migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog, completedExplorations: 0,
  progression: { routes: {}, recipes: {}, collections: { finds: [], travelSeconds: 0, quarrySeconds: 0 }, player: { xp } } });
const result = snapshot => ({ state: snapshot, acceptedRevision: snapshot.revision, message: "Готово", replayed: false });
const command = (patch = {}) => ({ requestId: "00000000-0000-4000-8000-000000000001", ownerPublicId: owner, expectedRevision: 0,
  action: "complete_resident_order", targetId: "order", quantity: 1, totalPrice: 0, ...patch });
const flush = () => new Promise(resolve => setImmediate(resolve));
const transport = overrides => ({ get: async () => state(), send: async () => result(state(54, 1)),
  market: async () => ({ ownerPublicId: owner, listings: [], mine: [], nextCursor: null, serverTime: state().serverTime }),
  trade: async () => result(state(54, 1)), ...overrides });
const cache = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; };

test("XP receipt requires the exact owner, revision, positive delta and an awarding action", () => {
  const gain = playerXpGainFromReceipt(state(), result(state(54, 1)), command());
  assert.equal(gain.xp, 25); assert.equal(gain.fromLevel, 1); assert.equal(gain.toLevel, 2);
  for (const [before, after, input] of [
    [state(), state(54, 1, other), command()], [state(), state(54, 2), command()],
    [state(54, 1), state(54, 1), command()], [state(), state(29, 1), command()],
    [state(), state(54, 1), command({ action: "buy_fishing_item" })],
    [state(), state(54, 1), command({ expectedRevision: 1 })],
  ]) assert.equal(playerXpGainFromReceipt(before, result(after), input), null);
});

test("local confirmed order emits one XP event and polling never invents another", async () => {
  let authoritative = state();
  const session = createEconomySession(owner, transport({ get: async () => authoritative, send: async () => {
    authoritative = state(54, 1); return result(authoritative);
  } }), () => assert.fail());
  const stop = session.activate(); await session.refresh();
  assert.equal(session.act("complete_resident_order", "order"), true); await flush();
  assert.equal(session.getSnapshot().playerXpGains.length, 1); assert.equal(session.getSnapshot().playerXpGains[0].xp, 25);
  authoritative = state(200, 2); await session.refresh();
  assert.equal(session.getSnapshot().playerXpGains.length, 1); stop();
});

test("same-session lost response retries celebrate once but recreated receipt sessions stay quiet", async () => {
  for (const recreate of [false, true]) {
    let attempts = 0, authoritative = state(); const storage = cache();
    const t = transport({ get: async () => authoritative, send: async () => {
      authoritative = state(54, 1);
      if (++attempts === 1) throw Error("Receipt response lost");
      return { ...result(authoritative), replayed: true };
    } });
    let session = createEconomySession(owner, t, () => assert.fail(), storage), stop = session.activate();
    await session.refresh(); session.act("complete_resident_order", "order"); await flush();
    assert.equal(session.getSnapshot().playerXpGains?.length ?? 0, 0);
    if (recreate) { stop(); session = createEconomySession(owner, t, () => assert.fail(), storage); stop = session.activate(); }
    await session.retry();
    assert.equal(session.getSnapshot().playerXpGains?.length ?? 0, recreate ? 0 : 1);
    await session.retry(); assert.equal(session.getSnapshot().playerXpGains?.length ?? 0, recreate ? 0 : 1);
    stop();
  }
});

const gain = (id, xp = 25, fromLevel = 1, toLevel = 2, ownerPublicId = owner) => ({ id, xp, fromLevel, toLevel, ownerPublicId, revision: 1 });
function playback(initial = []) {
  const calls = [], timers = [], levels = []; let time = 0;
  const player = createPlayerXpPlayback(owner, initial, {
    show: (value, entering) => calls.push({ value, entering }), levelUp: value => levels.push(value), hide: () => calls.push("hide"), now: () => time,
    schedule: (run, delay) => { const timer = { run, delay, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });
  return { player, calls, timers, levels, advance: value => { time = value; } };
}

test("level sound follows the first actual crossing in each visible XP burst", () => {
  const p = playback(), a = gain("small", 2, 1, 1), b = gain("level", 25, 1, 2), c = gain("another-level", 200, 2, 3);
  p.player.receive(owner, [a], true); assert.equal(p.levels.length, 0);
  p.player.receive(owner, [a, b], true); assert.deepEqual(p.levels, [b]);
  p.player.receive(owner, [a, b, c], true); assert.deepEqual(p.levels, [b], "rapid level crossings share one chime");
  p.player.receive(owner, [a, b, c], true); assert.equal(p.levels.length, 1, "polls and rerenders remain silent");
  p.timers.at(-1).run();
  const d = gain("later-level", 300, 3, 4);
  p.player.receive(owner, [a, b, c, d], true); assert.deepEqual(p.levels, [b, d]);
});

test("quick XP awards coalesce and stale timeout cannot dismiss a fresh burst", () => {
  const p = playback(), a = gain("a"), b = gain("b", 30, 2, 2);
  p.player.receive(owner, [a], true); const stale = p.timers[0]; p.advance(500);
  p.player.receive(owner, [a, b], true);
  assert.deepEqual(p.calls.at(-1), { value: { xp: 55, fromLevel: 1, toLevel: 2 }, entering: false });
  assert.equal(stale.cancelled, true); stale.run(); assert.notEqual(p.calls.at(-1), "hide");
  p.advance(4500); p.player.receive(owner, [a, b, gain("c")], true);
  assert.equal(p.timers.at(-1).delay, 500, "continuous claims cannot hold the toast forever");
  p.timers.at(-1).run(); assert.equal(p.calls.at(-1), "hide");
});

test("mount, hidden awards, returning to the screen and owner switches never replay", () => {
  const a = gain("a"), p = playback([a]);
  p.player.receive(owner, [a], true); assert.equal(p.calls.length, 0);
  const b = gain("b"); p.player.receive(owner, [a, b], false);
  p.player.receive(owner, [a, b], true); assert.equal(p.calls.filter(item => item !== "hide").length, 0);
  const foreign = gain("foreign", 50, 1, 3, other);
  p.player.receive(other, [foreign], true); p.player.receive(other, [foreign], true);
  assert.equal(p.calls.filter(item => item !== "hide").length, 0);
  p.player.receive(other, [foreign, gain("fresh", 2, 3, 3, other)], true);
  assert.equal(p.calls.at(-1).value.xp, 2);
  assert.equal(p.levels.length, 0, "no level chime for hydration, hidden history, owner changes or ordinary XP");
});

test("level-up bar completes the previous level before filling the new confirmed fraction", () => {
  const frames = playerXpFillFrames({ level: 1, ratio: .98 }, { level: 2, ratio: .16 });
  assert.equal(frames[0].width, "98%"); assert.equal(frames[1].width, "100%");
  assert.equal(frames[3].width, "0%"); assert.equal(frames.at(-1).width, "16%");
  assert.equal(playerXpFillFrames({ level: 2, ratio: .2 }, { level: 2, ratio: .5 }).length, 2);
});
