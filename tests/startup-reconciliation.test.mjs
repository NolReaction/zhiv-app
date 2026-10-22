import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createActivitySession } = await vite.ssrLoadModule("/features/activity/session.ts");
const { reconcileGameplaySessions } = await vite.ssrLoadModule("/features/activity/reconcile-gameplay.ts");
const { createWorldSession } = await vite.ssrLoadModule("/features/world/state/session.ts");
const { createEconomySession } = await vite.ssrLoadModule("/features/economy/sync/session.ts");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
const owner = "AAAA-0000-0001";
const serverTime = "2026-10-22T12:00:00.000Z";
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const failed of ["world", "economy"]) test(`startup shows the actual ${failed} read error without accepting unconfirmed progress`, async () => {
  let failing = true, time = Date.parse(serverTime);
  const message = failed === "world" ? "Обновите приложение: мир получил новую версию" : "Обновите приложение: хозяйство получило новую версию";
  const world = createWorldSession(owner, {
    get: async () => {
      if (failed === "world" && failing) throw new ApiError(message, 502);
      return { ownerPublicId: owner, revision: 40, serverTime, state: newWorldState(), gifts: [], dailySparksEarned: 0, catalogVersion: 3 };
    }, send: async () => assert.fail("Startup cannot manufacture a command"),
  }, () => assert.fail("A decoding error does not revoke the account"));
  const economy = createEconomySession(owner, {
    get: async () => {
      if (failed === "economy" && failing) throw new ApiError(message, 502);
      return { ownerPublicId: owner, revision: 40, serverTime, wallet: { coins: 100, pearls: 0 }, inventory: {}, buildings: { home: 1 }, jobs: [] };
    }, send: async () => assert.fail(), market: async () => assert.fail(), trade: async () => assert.fail(),
  }, () => assert.fail("A decoding error does not revoke the account"));
  const stopWorld = world.activate(), stopEconomy = economy.activate();
  const connected = [];
  const activity = createActivitySession({ now: () => time,
    send: async command => ({ presenceId: command.presenceId, status: "active" }),
    reconcile: () => reconcileGameplaySessions(world, economy), connected: id => connected.push(id),
    sessionLost: () => assert.fail("Existing authorization must remain"),
  });
  const stop = activity.start(true, true);
  try {
    await flush();
    assert.equal(activity.getSnapshot().mode, "error");
    assert.equal(activity.getSnapshot().error, `${failed === "world" ? "Мир" : "Хозяйство"}: ${message}`);
    assert.equal(connected.at(-1), null, "A failed snapshot cannot enable gameplay");
    failing = false; time += 4000;
    // Connection retry clears transport backoff, as the real AppShell pause/resume does.
    world.setAvailable(false); economy.setAvailable(false);
    await activity.retry();
    assert.equal(activity.getSnapshot().mode, "active");
    assert.equal(activity.getSnapshot().error, null);
  } finally { stop(); stopWorld(); stopEconomy(); }
});

test("unknown exceptions remain a generic connection error rather than leaking internal details", async () => {
  const activity = createActivitySession({ send: async command => ({ presenceId: command.presenceId, status: "active" }),
    reconcile: async () => { throw new Error("private diagnostic detail"); }, connected: () => {}, sessionLost: () => assert.fail() });
  const stop = activity.start(true, true);
  try { await flush(); assert.equal(activity.getSnapshot().error, "Не удалось сверить сохранённые действия. Повторите проверку."); }
  finally { stop(); }
});
