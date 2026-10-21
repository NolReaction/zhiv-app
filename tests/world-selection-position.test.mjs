import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createMapSelectionStore } = await vite.ssrLoadModule("/features/world/scene/map-selection-store.ts");
const { WorldSelectedObjectMenu } = await vite.ssrLoadModule("/features/world/ui/hud/world-selected-object-menu.tsx");
const { WorldObjectMenu } = await vite.ssrLoadModule("/features/economy/ui/stations/world-object-menu.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");

test("the selected menu follows current pixels while preserving its original menu props and identity", () => {
  const position = createMapSelectionStore();
  const selection = { objectId: "workshop", place: "workshop", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 };
  const snapshot = { ownerPublicId: "ME", revision: 1, serverTime: new Date(0).toISOString(), catalog: economyCatalog,
    wallet: { coins: 0, pearls: 0 }, inventory: {}, buildings: { home: 2, warehouse: 1, workshop: 1 }, jobs: [],
    completedExplorations: 0, storage: { capacity: 200, used: 0, reserved: 0, available: 200, overflow: 0 },
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 } };
  const economy = { snapshot, busy: false, uncertain: false, error: null, now: 0, act: assert.fail };
  const props = { position, selection, economy, onClose: assert.fail };
  const render = () => renderToStaticMarkup(createElement(WorldSelectedObjectMenu, props));
  const direct = selection => renderToStaticMarkup(createElement(WorldObjectMenu, { ...props, selection }));
  assert.equal(render(), direct(selection), "a newly opened menu has its current activation position before subscription");
  position.publish(selection);
  const before = render();
  const moved = { ...selection, x: 130, y: 610, viewportWidth: 1280, viewportHeight: 900 };
  position.publish(moved);
  assert.equal(render(), direct(moved));
  assert.notEqual(render(), before, "real menu placement follows the changed viewport without replacing the selected object");
  assert.equal(props.selection, selection, "camera publications do not replace the parent's selected-object state");
  position.publish({ ...moved, objectId: "garden", place: "garden" });
  assert.equal(render(), direct(selection), "a pending publication for another object never replaces this menu's content");
  position.publish(null);
  assert.equal(render(), direct(selection), "the parent remains responsible for the close and focus lifecycle");
});

test("position subscriptions release cleanly and each view owns its own transient coordinates", () => {
  const position = createMapSelectionStore(), other = createMapSelectionStore();
  let notices = 0;
  const stop = position.subscribe(() => notices++);
  const selection = { objectId: "workshop", place: "workshop", x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 };
  position.publish(selection); position.publish(selection);
  assert.equal(notices, 1);
  assert.equal(other.getSnapshot(), null);
  stop(); position.publish(null);
  assert.equal(notices, 1);
  assert.equal(position.getSnapshot(), null);
});
