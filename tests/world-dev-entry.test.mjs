import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldDevEntry } = await vite.ssrLoadModule("/features/world/dev/world-dev-entry.tsx");
const { createWorldDevPanelLoader } = await vite.ssrLoadModule("/features/world/dev/world-dev-panel-loader.ts");
const { WorldDevPanelBoundary } = await vite.ssrLoadModule("/features/world/dev/world-dev-panel-boundary.tsx");
const { requestWorldLightingStudioHandoff, takeWorldLightingStudioHandoff } = await vite.ssrLoadModule("/features/world/dev/world-lighting-studio-session.ts");
afterEach(() => takeWorldLightingStudioHandoff());
function loader() { const gate = createWorldDevPanelLoader(); gate.mount(); return gate; }

test("entering either game view shows a lazy functional DEV launcher without importing cheats or diagnostics", () => {
  let imports = 0;
  for (const worldView of [false, true]) {
    const props = { world: {}, worldView, loadPanel: () => { imports++; throw new Error("must load only on click"); } };
    const html = renderToStaticMarkup(createElement(WorldDevEntry, props));
    assert.match(html, /aria-label="Студия"/); assert.match(html, /Панель разработчика/);
    assert.doesNotMatch(html, /Мастерская DEV|Читы хозяйства/);
    assert.equal(renderToStaticMarkup(createElement(WorldDevEntry, { ...props, active: false })), "");
  }
  assert.equal(imports, 0);
});

test("one click loads DEV; repeated clicks cannot duplicate a pending import", async () => {
  const gate = loader(); let finish, imports = 0;
  const load = () => { imports++; return new Promise(resolve => { finish = resolve; }); };
  const pending = gate.open(load, false); assert.equal(gate.getSnapshot().pending, true);
  await gate.open(load, true); assert.equal(imports, 1); assert.equal(gate.getSnapshot().initialLightingStudio, false);
  const Panel = () => null; finish({ default: Panel }); await pending;
  assert.equal(gate.getSnapshot().Panel, Panel); assert.equal(gate.getSnapshot().pending, false);
  assert.equal(gate.getSnapshot().initialLightingStudio, false);
});

test("a rejected module factory stays inside DEV and is not repeatedly imported", async () => {
  const gate = loader(), failure = new Error("Module economy/model factory is not available"); let imports = 0;
  const reports = [], warn = console.warn; console.warn = (...args) => reports.push(args);
  try {
    const load = async () => { imports++; throw failure; };
    await assert.doesNotReject(gate.open(load, false));
    assert.equal(gate.getSnapshot().failed, true); assert.equal(gate.getSnapshot().pending, false);
    assert.equal(gate.getSnapshot().Panel, null); assert.equal(reports[0][1], failure);
    gate.closeNotice(); assert.equal(gate.getSnapshot().noticeOpen, false);
    await gate.open(load, false); assert.equal(gate.getSnapshot().noticeOpen, true); assert.equal(imports, 1);
  } finally { console.warn = warn; }
});

test("late import completion or failure cannot update an unmounted gate", async () => {
  for (const fails of [false, true]) {
    const gate = loader(); let finish, updates = 0;
    gate.subscribe(() => updates++);
    const pending = gate.open(() => new Promise((resolve, reject) => { finish = fails ? reject : resolve; }), false);
    gate.unmount(); const count = updates;
    finish(fails ? new Error("stale import") : { default: () => null }); await pending;
    assert.equal(updates, count);
  }
});

test("the direct studio launcher starts the same lazy panel in Studio mode", async () => {
  const gate = loader(), Panel = () => null; let imports = 0;
  await gate.open(async () => { imports++; return { default: Panel }; }, true);
  assert.equal(gate.getSnapshot().Panel, Panel); assert.equal(gate.getSnapshot().initialLightingStudio, true);
  assert.equal(imports, 1);
});

test("a home-to-map handoff belongs only to the active world entry and is consumed once", async () => {
  requestWorldLightingStudioHandoff();
  const home = loader(), inactive = loader(), world = loader();
  const forbidden = () => { assert.fail("Only the active world entry may claim the handoff"); };
  home.claimHandoff(forbidden, false); inactive.claimHandoff(forbidden, true, false);
  const Panel = () => null; let imports = 0;
  await world.claimHandoff(async () => { imports++; return { default: Panel }; }, true);
  assert.equal(imports, 1); assert.equal(world.getSnapshot().Panel, Panel); assert.equal(world.getSnapshot().initialLightingStudio, true);
  assert.equal(takeWorldLightingStudioHandoff(), false);
  loader().claimHandoff(forbidden, true);
});

test("effect cleanup and remount retain the same pending and loaded loader state during Strict Mode or Fast Refresh", async () => {
  const gate = loader(); let finish;
  const pending = gate.open(() => new Promise(resolve => { finish = resolve; }), true);
  const waiting = gate.getSnapshot(); gate.unmount(); gate.mount(); assert.equal(gate.getSnapshot(), waiting);
  const Panel = () => null; finish({ default: Panel }); await pending;
  const loaded = gate.getSnapshot(); gate.unmount(); gate.mount();
  assert.equal(gate.getSnapshot(), loaded); assert.equal(loaded.Panel, Panel); assert.equal(loaded.initialLightingStudio, true);
});

test("render failure isolation has no lazy-panel ownership or loader state", () => {
  const reports = [], boundary = new WorldDevPanelBoundary({ children: "game diagnostic", onError: error => reports.push(error) });
  assert.equal(boundary.render(), "game diagnostic");
  const failure = new Error("DEV render failed"); boundary.state = WorldDevPanelBoundary.getDerivedStateFromError(failure); boundary.componentDidCatch(failure);
  assert.equal(boundary.render(), null); assert.deepEqual(reports, [failure]); assert.deepEqual(boundary.state, { failed: true });
});
