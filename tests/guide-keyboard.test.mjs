import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { pauseFocusedGuide } = await vite.ssrLoadModule("/features/onboarding/guide-keyboard.ts");

test("Escape activates only the focused guide's pause action, including a section lesson", () => {
  let paused = 0;
  const pause = { disabled: false, click() { paused++; } };
  const guide = { querySelector(selector) { return selector === "button[data-guide-pause]" ? pause : null; } };
  const focused = { closest(selector) { return selector === "[data-guide-coach]" ? guide : null; } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: focused } });
    assert.equal(pauseFocusedGuide(), true, "the surrounding dialog should consume Escape");
    assert.equal(paused, 1, "invoke the flow's real action once rather than modifying world-course state");
    document.activeElement = { closest: () => null };
    assert.equal(pauseFocusedGuide(), false, "focus elsewhere must preserve ordinary dialog dismissal");
    assert.equal(paused, 1, "an unfocused guide is not paused as a side effect");
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  }
});

test("absent or unavailable pause controls do not swallow Escape", () => {
  assert.equal(pauseFocusedGuide(null), false);
  assert.equal(pauseFocusedGuide({ closest: () => ({ querySelector: () => null }) }), false);
  const disabled = { disabled: true, click() { assert.fail("a disabled pause action must not run"); } };
  assert.equal(pauseFocusedGuide({ closest: () => ({ querySelector: () => disabled }) }), false);
});
