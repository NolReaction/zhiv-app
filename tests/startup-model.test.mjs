import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { startupPresentation } = await vite.ssrLoadModule("/features/startup/startup-model.ts");
const ready = { screen: "home", online: true, identityError: null, appearanceReady: true, simpleView: false, sceneRequired: true,
  activityMode: "active", activityError: null, worldReady: true, economyReady: true, gameReady: true,
  gameFailed: false, scene: "ready", modules: "ready" };

test("entry never reveals a partial world even when the other startup work has completed", () => {
  assert.equal(startupPresentation(ready).ready, true);
  for (const patch of [{ worldReady: false }, { economyReady: false }, { gameReady: false },
    { appearanceReady: false }, { scene: "loading" }, { scene: "error" }, { modules: "loading" },
    { modules: "error" }, { activityMode: "connecting" }]) {
    const state = startupPresentation({ ...ready, ...patch });
    assert.equal(state.ready, false, JSON.stringify(patch));
    assert.ok(state.progress < 100, JSON.stringify(patch));
  }
});

test("a lost connection cancels readiness even after all work has finished", () => {
  const state = startupPresentation({ ...ready, online: false });
  assert.equal(state.ready, false);
  assert.match(state.message, /подключения/);
  assert.equal(state.retryAvailable, false);
  assert.equal(startupPresentation({ ...ready, activityMode: "error", activityError: "Повторите позже" }).ready, false);
});

test("first visit and expired identity reveal account entry without requiring a forest or game data", () => {
  for (const screen of ["onboarding", "session-lost"]) {
    assert.equal(startupPresentation({ ...ready, screen, worldReady: false, economyReady: false, gameReady: false,
      scene: "loading", modules: "error", activityMode: "connecting" }).ready, true);
  }
});

test("simple view skips graphics only after the actual saved preference and data are loaded", () => {
  const input = { ...ready, simpleView: true, scene: "error", modules: "loading" };
  assert.equal(startupPresentation(input).ready, true);
  assert.equal(startupPresentation({ ...input, appearanceReady: false }).ready, false);
  assert.equal(startupPresentation({ ...input, economyReady: false }).ready, false);
});

test("account callbacks and invitations do not wait for a scene absent from the selected screen", () => {
  const state = startupPresentation({ ...ready, sceneRequired: false, scene: "loading", modules: "error" });
  assert.equal(state.ready, true);
  assert.equal(startupPresentation({ ...ready, sceneRequired: false, gameReady: false }).ready, false);
});

test("AFK reveals the existing return gate rather than trapping or automatically resuming it", () => {
  const input = { ...ready, activityMode: "away", online: false, worldReady: false, scene: "error" };
  const state = startupPresentation(input);
  assert.equal(state.ready, true);
  assert.equal(state.retryAvailable, false);
  assert.match(state.message, /приостановлена/);
  assert.equal(startupPresentation({ ...input, activityMode: "hidden" }).ready, false);
});

test("read errors keep progress below completion and expose a manual retry with an honest status", () => {
  const state = startupPresentation({ ...ready, screen: "load-error", identityError: "Слишком много запросов" });
  assert.equal(state.progress, 0);
  assert.equal(state.ready, false);
  assert.equal(state.retryAvailable, true);
  assert.equal(state.detail, "Слишком много запросов");
  const artwork = startupPresentation({ ...ready, scene: "error" });
  assert.equal(artwork.retryAvailable, true);
  assert.ok(artwork.progress > 0 && artwork.progress < 100);
});
