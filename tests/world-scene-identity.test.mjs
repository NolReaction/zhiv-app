import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldScene } = await vite.ssrLoadModule("/features/world/scene/world-scene.tsx");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");

function scene(owner) {
  let tree;
  function Probe() {
    tree = WorldScene({ state: newWorldState(), gifts: [], timeZone: "UTC", now: Date.parse("2026-10-06T12:00:00Z"),
      owner, bestStreakDays: 0, wakeSignal: 0, onPlace() {}, topHud: { current: null }, bottomHud: { current: null } });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return tree;
}

function assertSiblingKeys(element) {
  if (!isValidElement(element)) return;
  const keys = new Set();
  Children.forEach(element.props.children, child => {
    if (!isValidElement(child)) return;
    if (child.key !== null) {
      assert.ok(!keys.has(child.key), `duplicate sibling key ${child.key} inside ${String(element.type)}`);
      keys.add(child.key);
    }
    assertSiblingKeys(child);
  });
}

function accountKeys(tree) {
  const keys = {};
  Children.forEach(tree.props.children, child => {
    if (isValidElement(child) && ["ForestSpeechAnnouncements", "MapFeedback"].includes(child.type.name)) keys[child.type.name] = child.key;
  });
  assert.equal(Object.keys(keys).length, 2, "speech and gameplay overlays are both present");
  return keys;
}

test("scene siblings have distinct identities while account-owned overlays still reset together", () => {
  const first = scene("0CR4-WEMX-KEG1"), again = scene("0CR4-WEMX-KEG1"), other = scene("OTHER-PLAYER");
  for (const tree of [first, again, other]) assertSiblingKeys(tree);
  const initial = accountKeys(first), repeated = accountKeys(again), changed = accountKeys(other);
  assert.deepEqual(initial, repeated, "ordinary rerenders keep both existing overlays");
  for (const name of Object.keys(initial)) {
    assert.notEqual(initial[name], null, `${name} requires an account-owned identity`);
    assert.notEqual(initial[name], changed[name], `${name} must not retain another account's state`);
  }
});
