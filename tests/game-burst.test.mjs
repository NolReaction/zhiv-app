import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { GameSyncClient } = await vite.ssrLoadModule("/features/game/game-sync.ts");
const { gameTabInbox } = await vite.ssrLoadModule("/features/game/game-tab-inbox.ts");
const { gameJournalStore } = await vite.ssrLoadModule("/features/game/game-sync-journal.ts");
const identities = await vite.ssrLoadModule("/lib/dev/api-store.ts");
const game = await vite.ssrLoadModule("/lib/dev/game-store.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");

function fixture() {
  const player = identities.createDevIdentity("Burst test", crypto.randomUUID());
  const owner = player.me.user.publicId, values = new Map();
  let clock = Date.parse("2026-09-11T12:00:00Z");
  const storage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const unwrap = result => {
    if (result.kind === "ok") return result.value;
    throw new ApiError(result.code, 409, { code: result.code, message: result.code });
  };
  const api = { progress: async () => unwrap(game.getDevGameProgress(player.token, clock)),
    session: async request => unwrap(game.createDevGameSession(player.token, owner, request.requestId, clock)),
    batch: async payload => unwrap(game.submitDevGameBatch(player.token, payload, clock)) };
  const journal = gameJournalStore(owner, storage), inbox = gameTabInbox(owner, storage);
  return { inbox, journal, run: crypto.randomUUID(),
    get clock() { return clock; }, advance: ms => { clock += ms; },
    client: () => new GameSyncClient(owner, false, () => {}, () => assert.fail("session lost"), api,
      () => clock, () => crypto.randomUUID(), async delay => { clock += delay; }, journal, () => clock) };
}

test("1000 immediate offline taps survive reload and are all credited by the real game rules", async () => {
  const f = fixture(), start = performance.now();
  for (let i = 0; i < 1000; i++) assert.equal(f.inbox.record(1, f.run, f.clock), 1);
  assert.equal(f.inbox.snapshot(false, f.run).pendingTaps, 1000);
  const before = f.client(); while (f.inbox.drain(before)) { /* bounded slices */ }
  before.dispose();
  const restored = f.client(); restored.setOnline(true); await restored.flush();
  assert.equal(restored.snapshot().progress.lifetimeTaps, 1000);
  assert.equal(restored.snapshot().rejectedTaps, 0);
  assert.equal(restored.snapshot().pendingTaps, 0);
  assert.equal(restored.snapshot(f.run).run.creditedTaps, 1000);
  console.log(`1000-input offline burst and replay verified in ${Math.round(performance.now() - start)} ms`);
  restored.dispose();
});

test("an extreme live 1000-tap burst respects anti-cheat, accounts for every input and never blocks later taps", async () => {
  const f = fixture(), client = f.client(); client.setOnline(true);
  f.inbox.record(1, f.run, f.clock); f.inbox.drain(client); await client.flush();
  for (let i = 0; i < 1000; i++) {
    assert.equal(f.inbox.record(1, f.run, f.clock), 1); f.inbox.drain(client);
  }
  await client.flush();
  const state = client.snapshot();
  assert.equal(state.pendingTaps, 0); assert.equal(state.archivedTaps, 0);
  assert.equal(state.progress.lifetimeTaps + state.rejectedTaps, 1001);
  assert.ok(state.rejectedTaps > 0, "unrealistic event rates must not bypass server anti-cheat");
  console.log(`Extreme live burst: ${state.progress.lifetimeTaps - 1} credited, ${state.rejectedTaps} rejected by rate rules, zero left pending`);
  f.advance(2000); f.inbox.record(1, f.run, f.clock); f.inbox.drain(client); await client.flush();
  assert.equal(client.snapshot().progress.lifetimeTaps, state.progress.lifetimeTaps + 1);
  assert.equal(client.snapshot().pendingTaps, 0); assert.equal(client.snapshot().status, "ready");
  client.dispose();
});

test("1000 fast taps at 25 per second are all accepted and preserved after reload", async () => {
  const f = fixture(), client = f.client(); client.setOnline(true);
  for (let i = 0; i < 1000; i++) {
    assert.equal(f.inbox.record(1, f.run, f.clock), 1); f.inbox.drain(client);
    f.advance(40); await Promise.resolve();
  }
  await client.flush();
  assert.equal(client.snapshot().progress.lifetimeTaps, 1000);
  assert.equal(client.snapshot().rejectedTaps, 0); assert.equal(client.snapshot().pendingTaps, 0);
  client.dispose(); const restored = f.client();
  assert.equal(restored.snapshot(f.run).run.creditedTaps, 1000); restored.dispose();
});
