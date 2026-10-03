import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
const { worldMenuPosition, worldStableMenuPosition } = await vite.ssrLoadModule("/features/economy/world-stations.ts");
after(() => vite.close());

function assertInside(position, viewport, bounds) {
  assert.ok(position.x >= bounds.left, `left edge: ${position.x}`);
  assert.ok(position.x + position.width <= viewport.viewportWidth - bounds.right, `right edge: ${position.x + position.width}`);
  assert.ok(position.y >= bounds.top, `top edge: ${position.y}`);
  assert.ok(position.y + position.height <= viewport.viewportHeight - bounds.bottom, `bottom edge: ${position.y + position.height}`);
  assert.ok(position.width > 0 && position.height > 0);
}

test("production menu reserves its expanded frame before a detail can make it switch sides", () => {
  const selection = { x: 195, y: 380, viewportWidth: 390, viewportHeight: 844 };
  const bounds = { top: 120, right: 8, bottom: 110, left: 8 };
  const compact = worldMenuPosition(selection, { width: 320, height: 214 }, bounds);
  const expanded = worldMenuPosition(selection, { width: 320, height: 294.72 }, bounds);
  assert.equal(compact.side, "above");
  assert.equal(expanded.side, "below");

  const reserved = worldStableMenuPosition(selection, bounds);
  assert.equal(reserved.side, "below");
  assert.equal(reserved.y, selection.y + 18);
  assert.equal(reserved.width, 320);
  assert.ok(reserved.height > 294 && reserved.height < 295);
  assertInside(reserved, selection, bounds);
  // Recipe and stock updates have no geometry input; the same anchor keeps its frame.
  assert.deepEqual(worldStableMenuPosition({ ...selection }, { ...bounds }), reserved);
});

test("stable frames stay inside HUD insets at phone, narrow, desktop and landscape edges", () => {
  const viewports = [
    { viewportWidth: 390, viewportHeight: 844, bounds: { top: 120, right: 8, bottom: 110, left: 8 } },
    { viewportWidth: 320, viewportHeight: 568, bounds: { top: 80, right: 16, bottom: 90, left: 16 } },
    { viewportWidth: 1440, viewportHeight: 1000, bounds: { top: 120, right: 24, bottom: 110, left: 24 } },
    { viewportWidth: 844, viewportHeight: 390, bounds: { top: 140, right: 8, bottom: 90, left: 8 } },
    { viewportWidth: 568, viewportHeight: 320, bounds: { top: 140, right: 8, bottom: 90, left: 8 } },
  ];
  for (const { bounds, ...viewport } of viewports) {
    for (const x of [0, viewport.viewportWidth / 2, viewport.viewportWidth]) {
      for (const y of [0, viewport.viewportHeight / 2, viewport.viewportHeight]) {
        assertInside(worldStableMenuPosition({ ...viewport, x, y }, bounds), viewport, bounds);
      }
    }
  }
});

test("landscape production frame uses available height beside the selected object", () => {
  const selection = { x: 420, y: 210, viewportWidth: 844, viewportHeight: 390 };
  const bounds = { top: 140, right: 8, bottom: 90, left: 8 };
  const position = worldStableMenuPosition(selection, bounds);
  assert.equal(position.height, 160);
  assert.ok(["right", "left"].includes(position.side));
  assert.ok(selection.x < position.x || selection.x > position.x + position.width);
  assertInside(position, selection, bounds);
});

test("stable frame follows camera movement and recomputes only the viewport-dependent size", () => {
  const bounds = { top: 120, right: 8, bottom: 110, left: 8 };
  const selection = { x: 600, y: 600, viewportWidth: 1440, viewportHeight: 1000 };
  const before = worldStableMenuPosition(selection, bounds);
  const panned = worldStableMenuPosition({ ...selection, x: 630, y: 625 }, bounds);
  assert.equal(panned.side, before.side);
  assert.equal(panned.x - before.x, 30);
  assert.equal(panned.y - before.y, 25);
  assert.equal(panned.width, before.width);
  assert.equal(panned.height, before.height);

  const phone = { ...selection, x: 160, y: 340, viewportWidth: 320, viewportHeight: 568 };
  const resized = worldStableMenuPosition(phone, bounds);
  assert.equal(resized.width, 304);
  assert.ok(resized.height < before.height);
  assertInside(resized, phone, bounds);
});
