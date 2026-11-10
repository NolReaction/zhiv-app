import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { sameSceneOptions } = await vite.ssrLoadModule("/features/world/scene/scene-options.ts");

test("UI option wrappers are equal only while game inputs and arrival callbacks remain unchanged", () => {
  const initial = { paused: false, backgrounded: false, reducedMotion: false, lampOn: false, dusk: false,
    presenceKey: "account-a", serverNow: 100_000, view: "world", tutorialActive: true,
    economyProduction: { ownerPublicId: "account-a", revision: 4, jobs: [] },
    residentArrival: { seen: false, enabled: true, onComplete() {} },
    merchantArrival: { seen: true, enabled: false, onComplete() {} }, onGardenHarvestEvent() {} };
  const wrapped = () => ({ ...initial, residentArrival: { ...initial.residentArrival }, merchantArrival: { ...initial.merchantArrival } });
  assert.equal(sameSceneOptions(initial, wrapped()), true);
  assert.equal(sameSceneOptions(initial, { ...wrapped(), items: undefined }), true, "omitted optional values have no scene effect");
  assert.equal(sameSceneOptions(initial, { ...wrapped(), merchantArrival: { ...initial.merchantArrival, open: false } }), true,
    "an omitted greeting flag is the same closed presentation");
  for (const patch of [
    { paused: true }, { backgrounded: true }, { reducedMotion: true }, { lampOn: true }, { dusk: true },
    { presenceKey: "account-b" }, { serverNow: 200_000 }, { view: "circle" }, { tutorialActive: false },
    { economyProduction: { ...initial.economyProduction, revision: 5 } }, { onGardenHarvestEvent() {} },
    { residentArrival: { ...initial.residentArrival, onComplete() {} } },
    { residentArrival: { ...initial.residentArrival, seen: true } },
    { residentArrival: { ...initial.residentArrival, enabled: false } },
    { residentArrival: { ...initial.residentArrival, open: true } },
    { merchantArrival: { ...initial.merchantArrival, onComplete() {} } },
    { merchantArrival: { ...initial.merchantArrival, open: true } },
    { merchantArrival: undefined },
  ]) assert.equal(sameSceneOptions(initial, { ...wrapped(), ...patch }), false, Object.keys(patch).join(", "));
});
