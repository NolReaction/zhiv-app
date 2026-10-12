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
const { isWorldPortalReturn } = await vite.ssrLoadModule("/features/world/world-portal-history.ts");

const trigger = { getBoundingClientRect: () => ({ left: 20, top: 80, width: 200, height: 200 }) };
function withWindow(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    innerWidth: 390, innerHeight: 844,
    location: { href: "https://game.example/" },
    // History entry creation can fail in an embedded browser. The ready handoff
    // must work independently of history/popstate, which has separate coverage.
    history: { state: null, pushState() { throw new Error("History unavailable"); } },
  } });
  try { run(); } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
}

test("notification can open the world before the map button is mounted", () => withWindow(() => {
  let entered = false;
  const observed = [];
  function Probe() {
    const portal = useWorldPortal("PLAYER");
    observed.push({ open: portal.open, origin: portal.origin });
    if (!entered) { entered = true; portal.enter(null, null); }
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(observed.at(-1).open, true);
  assert.equal(observed.at(-1).origin["--portal-x"], "195px");
  assert.equal(observed.at(-1).origin["--portal-y"], "422px");
}));

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

test("portal consumes only its own same-page return and leaves real navigation to the router", () => {
  const url = "https://game.example/";
  const open = { entry: "PLAYER:123", backPending: false, openedUrl: url, returnMarker: undefined };
  assert.equal(isWorldPortalReturn(open, url, undefined), true, "native Back closes the portal without restoring the route");
  assert.equal(isWorldPortalReturn({ ...open, entry: null, backPending: true }, url, undefined), true,
    "the exit button waits for its same-page history step after closing React state");
  assert.equal(isWorldPortalReturn({ ...open, entry: null, backPending: true, returnMarker: null }, url, null), true,
    "a remembered null predecessor is still an owned return after the button clears its entry");
  assert.equal(isWorldPortalReturn(open, url, "PLAYER:123"), false, "the active entry is not a return");
  assert.equal(isWorldPortalReturn(open, url, "FOREIGN:456"), false, "another drawer's history marker does not belong to this portal");
  assert.equal(isWorldPortalReturn(open, `${url}other`, undefined), false, "Back to a different route still reaches Next");
  assert.equal(isWorldPortalReturn(open, `${url}?view=other`, undefined), false);
  assert.equal(isWorldPortalReturn(open, `${url}#section`, undefined), false);
  assert.equal(isWorldPortalReturn({ ...open, entry: null }, url, undefined), false, "unowned Back/Forward is never intercepted");
  assert.equal(isWorldPortalReturn({ ...open, openedUrl: null }, url, undefined), false, "failed history setup never intercepts navigation");
  assert.equal(isWorldPortalReturn({ ...open, returnMarker: "PREVIOUS:789" }, url, "PREVIOUS:789"), true,
    "an explicitly remembered predecessor is a valid return target");
});

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
