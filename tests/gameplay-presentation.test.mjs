import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { gameplayPresentation } = await vite.ssrLoadModule("/features/activity/gameplay-presentation.ts");

test("retained world stays browsable during network recovery but only safe local production can start", () => {
  for (const mode of ["offline", "connecting", "error"]) {
    const view = gameplayPresentation({ mode, resumeRequired: false }, true);
    assert.deepEqual(view, { showGate: false, suspended: false, localActions: true, directActions: false }, mode);
  }
  assert.deepEqual(gameplayPresentation({ mode: "active" }, true), {
    showGate: false, suspended: false, localActions: true, directActions: true,
  });
});

test("AFK remains a deliberate pause through failed and offline resume; hidden tabs do not create a dialog", () => {
  for (const mode of ["away", "connecting", "error", "offline"]) {
    assert.deepEqual(gameplayPresentation({ mode, resumeRequired: true }, true), {
      showGate: true, suspended: true, localActions: false, directActions: false,
    }, mode);
  }
  assert.deepEqual(gameplayPresentation({ mode: "away" }, true), {
    showGate: true, suspended: true, localActions: false, directActions: false,
  });
  assert.deepEqual(gameplayPresentation({ mode: "hidden", resumeRequired: true }, true), {
    showGate: false, suspended: true, localActions: false, directActions: false,
  });
});

test("a fresh launch cannot offer offline actions without a retained scene", () => {
  for (const mode of ["offline", "connecting", "error"]) {
    const view = gameplayPresentation({ mode }, false);
    assert.equal(view.showGate, true, mode);
    assert.equal(view.localActions, false, mode);
    assert.equal(view.directActions, false, mode);
  }
});
