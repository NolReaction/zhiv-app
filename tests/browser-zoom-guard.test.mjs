import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { installBrowserZoomGuard } = await vite.ssrLoadModule("/lib/browser-zoom-guard.ts");
const { MobileGestureGuard } = await vite.ssrLoadModule("/components/mobile-gesture-guard.tsx");

function documentTarget() {
  const target = new EventTarget(), listeners = [];
  return {
    listeners,
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
      target.addEventListener(type, handler, options);
    },
    removeEventListener(type, handler, options) {
      const index = listeners.findIndex(entry => entry.type === type && entry.handler === handler && entry.options.capture === options.capture);
      assert.notEqual(index, -1, "unmount removes the installed capture handler");
      listeners.splice(index, 1);
      target.removeEventListener(type, handler, options);
    },
    dispatch(type, count, cancelable = true) {
      const event = new Event(type, { cancelable, bubbles: true });
      if (count !== undefined) Object.defineProperty(event, "touches", { value: Array.from({ length: count }, (_, identifier) => ({ identifier })) });
      target.dispatchEvent(event);
      return event;
    },
  };
}

test("document capture cancels Safari gesture defaults without swallowing portal handlers", () => {
  const doc = documentTarget(), dispose = installBrowserZoomGuard(doc), observed = [];
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    doc.addEventListener(type, event => observed.push({ type: event.type, canceled: event.defaultPrevented }), { capture: false });
    const event = doc.dispatch(type);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.cancelBubble, false, "the dialog's own handlers still receive the event");
  }
  assert.deepEqual(observed, ["gesturestart", "gesturechange", "gestureend"].map(type => ({ type, canceled: true })));
  for (const listener of doc.listeners.filter(entry => entry.options.capture)) {
    assert.equal(listener.options.passive, false, "document touch listeners must opt out of Safari's passive default");
  }
  dispose();
});

test("one-finger scrolling, taps, focus and pointer-based map controls keep their defaults", () => {
  const doc = documentTarget(), dispose = installBrowserZoomGuard(doc);
  for (const [type, touches] of [["touchstart", 1], ["touchmove", 1], ["touchend", 0], ["click"], ["focusin"], ["pointerdown"], ["pointermove"], ["pointerup"], ["wheel"], ["keydown"]]) {
    const event = doc.dispatch(type, touches);
    assert.equal(event.defaultPrevented, false, `${type} remains usable`);
    assert.equal(event.cancelBubble, false);
  }
  dispose();
});

test("a two-finger pinch stays canceled through partial release, then scrolling resumes", () => {
  const doc = documentTarget(), dispose = installBrowserZoomGuard(doc);
  assert.equal(doc.dispatch("touchstart", 1).defaultPrevented, false);
  for (const [type, touches] of [["touchstart", 2], ["touchmove", 2], ["touchend", 1], ["touchmove", 1], ["touchend", 0]]) {
    assert.equal(doc.dispatch(type, touches).defaultPrevented, true, `${type}/${touches} cannot complete a browser pinch`);
  }
  assert.equal(doc.dispatch("touchstart", 1).defaultPrevented, false);
  assert.equal(doc.dispatch("touchmove", 1).defaultPrevented, false);
  assert.equal(doc.dispatch("touchend", 0).defaultPrevented, false);
  dispose();
});

test("missed starts and canceled touches do not leave the document locked", () => {
  const doc = documentTarget(), dispose = installBrowserZoomGuard(doc);
  assert.equal(doc.dispatch("touchmove", 2).defaultPrevented, true);
  doc.dispatch("touchcancel", 0);
  assert.equal(doc.dispatch("touchmove", 1).defaultPrevented, false);
  doc.dispatch("touchmove", 2);
  assert.equal(doc.dispatch("touchstart", 1).defaultPrevented, false, "a fresh sequence clears a stale pinch");
  assert.equal(doc.dispatch("touchmove", 1).defaultPrevented, false);
  for (const type of ["gesturestart", "gesturechange", "gestureend", "touchmove"]) {
    const event = doc.dispatch(type, 2, false);
    assert.equal(event.defaultPrevented, false, "already committed noncancelable events are not reported as canceled");
  }
  dispose();
});

test("unmount and remount replace listeners without accumulating guards", () => {
  const doc = documentTarget(), first = installBrowserZoomGuard(doc);
  const count = doc.listeners.length;
  assert.ok(count > 0);
  first();
  assert.equal(doc.listeners.length, 0);
  assert.equal(doc.dispatch("gesturechange").defaultPrevented, false);
  assert.equal(doc.dispatch("touchmove", 2).defaultPrevented, false);
  const second = installBrowserZoomGuard(doc);
  assert.equal(doc.listeners.length, count);
  assert.equal(doc.dispatch("touchmove", 2).defaultPrevented, true);
  second();
  assert.equal(doc.listeners.length, 0);
});

test("SSR guard renders no layout element and mobile CSS protects nested scroll areas and fields", async () => {
  assert.equal(renderToStaticMarkup(createElement(MobileGestureGuard)), "");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /:where\(body \*\)\s*\{\s*touch-action:\s*pan-x pan-y;/);
  assert.match(css, /@media \(max-width: 700px\), \(hover: none\) and \(pointer: coarse\)[\s\S]*textarea,\s*select,[\s\S]*font-size:\s*max\(16px, 1em\) !important;/);
  const mapCss = await readFile(new URL("../features/world/world.module.css", import.meta.url), "utf8");
  assert.match(mapCss, /\.scene > canvas\s*\{[^}]*touch-action: none;/);
  assert.match(mapCss, /\.mapAnchors button\s*\{\s*touch-action: none;/);
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<body>\s*<MobileGestureGuard\s*\/>/);
});
