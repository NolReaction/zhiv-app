import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { useWorldPortal } = await vite.ssrLoadModule("/features/world/use-world-portal.ts");

const trigger = { getBoundingClientRect: () => ({ left: 20, top: 80, width: 200, height: 200 }) };
function withWindow(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    innerWidth: 390, innerHeight: 844,
    // History entry creation can fail in an embedded browser. The ready handoff
    // must work independently of history/popstate, which has separate coverage.
    history: { state: null, pushState() { throw new Error("History unavailable"); } },
  } });
  try { run(); } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
}

test("opening a portal keeps the circle until scene readiness and resets readiness on every entry", () => withWindow(() => {
  const observed = [];
  let step = 0;
  function Probe() {
    const portal = useWorldPortal("PLAYER");
    observed.push({ open: portal.open, ready: portal.sceneReady });
    // Render-phase updates exercise the real hook's state transitions without
    // mounting a canvas or advancing fake loading timers.
    switch (step++) {
      case 0: portal.enter(trigger, null); break;
      case 1: portal.reportSceneReady(); break;
      case 2: portal.close(); break;
      case 3: portal.enter(trigger, null); break;
    }
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.deepEqual(observed, [
    { open: false, ready: false },
    { open: true, ready: false },
    { open: true, ready: true },
    { open: false, ready: false },
    { open: true, ready: false },
  ]);
}));

test("an account change cannot reuse readiness from the previous player's loaded map", () => withWindow(() => {
  const observed = [];
  let step = 0;
  function Probe() {
    const [owner, setOwner] = useState("FIRST");
    const portal = useWorldPortal(owner);
    observed.push({ owner, open: portal.open, ready: portal.sceneReady });
    switch (step++) {
      case 0: portal.enter(trigger, null); break;
      case 1: portal.reportSceneReady(); break;
      case 2: setOwner("SECOND"); break;
      case 3: portal.enter(trigger, null); break;
    }
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.deepEqual(observed.slice(-2), [
    { owner: "SECOND", open: false, ready: false },
    { owner: "SECOND", open: true, ready: false },
  ]);
}));
