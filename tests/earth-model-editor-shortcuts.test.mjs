import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { classifyEarthModelEditorShortcut: classify, isEarthModelEditorTextTarget: textTarget,
  earthModelEditorShortcutPatch: patch } = await vite.ssrLoadModule("/features/earth/dev/earth-model-editor-shortcuts.ts");
const placement = { id: "eiffel-tower", longitude: 2.29444, latitude: 48.85826, heightMeters: 330,
  headingDegrees: 45, elevationMeters: 0, exclusionRadiusMeters: 110, excludeBuildings: true };
const event = (code, options = {}) => ({ code, key: code, ...options });
const node = (tagName, options = {}) => ({ tagName, parentElement: null, getAttribute: () => null, ...options });

test("undo and redo use physical keys with Ctrl/Cmd, including Russian layouts", () => {
  for (const modifier of ["ctrlKey", "metaKey"]) {
    assert.deepEqual(classify(event("KeyZ", { key: "я", [modifier]: true })), { type: "undo" });
    assert.deepEqual(classify(event("KeyZ", { key: "Я", [modifier]: true, shiftKey: true })), { type: "redo" });
    assert.deepEqual(classify(event("KeyY", { key: "н", [modifier]: true })), { type: "redo" });
  }
  assert.deepEqual(classify({ key: "z", ctrlKey: true }), { type: "undo" });
  assert.deepEqual(classify({ key: "я", metaKey: true }), { type: "undo" });
  assert.deepEqual(classify({ key: "Y", ctrlKey: true }), { type: "redo" });
  assert.deepEqual(classify(event("KeyY", { key: "z", ctrlKey: true })), { type: "redo" }, "physical codes take priority on layouts that swap Y/Z");
  assert.deepEqual(classify({ code: "Unidentified", key: "z", ctrlKey: true }), { type: "undo" });
  assert.equal(classify(event("KeyZ")), null);
});

test("text widgets and editable ancestors retain native shortcuts, including native undo", () => {
  const editable = node("DIV", { getAttribute: name => name === "contenteditable" ? "" : null });
  const targets = [node("INPUT"), node("textarea"), node("SELECT"), node("DIV", { isContentEditable: true }),
    node("INPUT", { type: "number" }), node("INPUT", { type: "date" }), node("INPUT", { type: "text" }),
    editable, node("SPAN", { parentElement: editable }),
    { parentElement: node("TEXTAREA") }, node("OPTION", { parentElement: node("SELECT") })];
  for (const target of targets) {
    assert.equal(textTarget(target), true);
    assert.equal(classify(event("KeyZ", { ctrlKey: true, target })), null);
    assert.equal(classify(event("ArrowRight", { target })), null);
    assert.equal(classify(event("Equal", { shiftKey: true, target })), null);
  }
  for (const target of [null, undefined, 4, "input", node("BUTTON"), node("CANVAS")]) assert.equal(textTarget(target), false);
});

test("focused sliders and non-text controls allow immediate model undo while retaining their native arrows", () => {
  for (const type of ["range", "checkbox", "radio", "button", "submit", "reset", "file", "color"]) {
    const target = node("INPUT", { type });
    assert.equal(textTarget(target), false);
    assert.deepEqual(classify(event("KeyZ", { ctrlKey: true, target })), { type: "undo" });
    assert.deepEqual(classify(event("KeyZ", { metaKey: true, shiftKey: true, target })), { type: "redo" });
    assert.deepEqual(classify(event("KeyY", { ctrlKey: true, target })), { type: "redo" });
    for (const code of ["ArrowRight", "ArrowUp", "KeyF", "Equal", "BracketLeft"]) assert.equal(classify(event(code, { target })), null);
  }
  const attributeRange = node("INPUT", { getAttribute: name => name === "type" ? "range" : null });
  assert.deepEqual(classify(event("KeyZ", { ctrlKey: true, target: attributeRange })), { type: "undo" });
  const editable = node("DIV", { isContentEditable: true });
  assert.equal(classify(event("KeyZ", { ctrlKey: true, target: node("INPUT", { type: "range", parentElement: editable }) })), null);
});

test("noneditable islands and malformed ancestry do not require global DOM classes", () => {
  const outer = node("DIV", { isContentEditable: true });
  const island = node("DIV", { getAttribute: () => "false", parentElement: outer });
  assert.equal(textTarget(node("SPAN", { parentElement: island })), false);
  assert.equal(textTarget(node("INPUT", { parentElement: island })), true);
  const cycle = node("DIV"); cycle.parentElement = cycle;
  assert.equal(textTarget(cycle), false);
});

test("composition, consumed keys and unsupported modifier combinations are ignored", () => {
  for (const options of [{ defaultPrevented: true }, { isComposing: true }, { altKey: true }, { altKey: true, ctrlKey: true }]) {
    assert.equal(classify(event("KeyZ", { ctrlKey: true, ...options })), null);
    assert.equal(classify(event("ArrowUp", options)), null);
  }
  for (const code of ["KeyF", "ArrowLeft", "BracketRight", "Equal"]) {
    assert.equal(classify(event(code, { ctrlKey: true })), null);
    assert.equal(classify(event(code, { metaKey: true })), null);
  }
  assert.equal(classify(event("KeyR")), null);
});

test("map-space arrows move one metre or ten with Shift, independently of camera bearing", () => {
  const expected = [
    ["ArrowLeft", -1, 0], ["ArrowRight", 1, 0], ["ArrowUp", 0, 1], ["ArrowDown", 0, -1],
  ];
  for (const [code, eastMeters, northMeters] of expected) {
    assert.deepEqual(classify(event(code)), { type: "move", eastMeters, northMeters });
    assert.deepEqual(classify(event(code, { shiftKey: true })), { type: "move", eastMeters: eastMeters * 10, northMeters: northMeters * 10 });
    assert.deepEqual(classify({ key: code }), { type: "move", eastMeters, northMeters });
  }
});

test("focus, rotation and scale accept physical and logical keys, including numpad", () => {
  assert.deepEqual(classify(event("KeyF", { key: "а" })), { type: "focus" });
  assert.deepEqual(classify({ key: "F" }), { type: "focus" });
  for (const [code, key, sign] of [["BracketLeft", "х", -1], ["BracketRight", "ъ", 1]]) {
    assert.deepEqual(classify(event(code, { key })), { type: "rotate", degrees: sign });
    assert.deepEqual(classify(event(code, { key, shiftKey: true })), { type: "rotate", degrees: sign * 15 });
  }
  assert.deepEqual(classify({ key: "[" }), { type: "rotate", degrees: -1 });
  assert.deepEqual(classify({ key: "}", shiftKey: true }), { type: "rotate", degrees: 15 });
  for (const [code, sign] of [["Minus", -1], ["Equal", 1], ["NumpadSubtract", -1], ["NumpadAdd", 1]]) {
    assert.deepEqual(classify(event(code)), { type: "resize", percentDelta: sign });
    assert.deepEqual(classify(event(code, { shiftKey: true })), { type: "resize", percentDelta: sign * 10 });
  }
  assert.deepEqual(classify({ key: "+" }), { type: "resize", percentDelta: 1 });
  assert.deepEqual(classify({ key: "_", shiftKey: true }), { type: "resize", percentDelta: -10 });
});

function distance(a, b) {
  const rad = Math.PI / 180;
  const delta = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2
    + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, delta)));
}

test("move patches preserve metre distance across latitudes, clamp the pole boundary and wrap the date line", () => {
  for (const latitude of [-80, 0, 48.85826, 80]) {
    for (const [eastMeters, northMeters] of [[1, 0], [-10, 0], [0, 1], [0, -10]]) {
      const before = { ...placement, latitude };
      const result = patch(before, { type: "move", eastMeters, northMeters }, 330);
      assert.deepEqual(Object.keys(result).sort(), ["latitude", "longitude"]);
      assert.ok(Math.abs(distance(before, { ...before, ...result }) - Math.hypot(eastMeters, northMeters)) < .00001);
    }
  }
  const crossing = patch({ ...placement, longitude: 179.999999 }, { type: "move", eastMeters: 10, northMeters: 0 }, 330);
  assert.ok(crossing.longitude >= -180 && crossing.longitude < -179.99);
  const nearPole = patch({ ...placement, latitude: 84.999999 }, { type: "move", eastMeters: 0, northMeters: 10 }, 330);
  assert.equal(nearPole.latitude, 85);
  assert.equal(patch({ ...placement, latitude: 85 }, { type: "move", eastMeters: 0, northMeters: 1 }, 330), null);
});

test("rotation normalizes negative and full-circle headings without mutating the placement", () => {
  const before = structuredClone(placement);
  assert.deepEqual(patch({ ...placement, headingDegrees: 0 }, { type: "rotate", degrees: -1 }, 330), { headingDegrees: 359 });
  assert.deepEqual(patch({ ...placement, headingDegrees: 359 }, { type: "rotate", degrees: 15 }, 330), { headingDegrees: 14 });
  assert.equal(patch(placement, { type: "rotate", degrees: 360 }, 330), null);
  assert.deepEqual(placement, before);
});

test("scale steps are catalog-relative percentage points and respect the supported height range", () => {
  const doubled = { ...placement, heightMeters: 660 };
  assert.deepEqual(patch(doubled, { type: "resize", percentDelta: 1 }, 330), { heightMeters: 663.3 });
  assert.deepEqual(patch(doubled, { type: "resize", percentDelta: 10 }, 330), { heightMeters: 693 });
  assert.deepEqual(patch(doubled, { type: "resize", percentDelta: -10 }, 330), { heightMeters: 627 });
  assert.deepEqual(patch({ ...placement, heightMeters: 995 }, { type: "resize", percentDelta: 10 }, 330), { heightMeters: 1000 });
  assert.deepEqual(patch({ ...placement, heightMeters: 2 }, { type: "resize", percentDelta: -1 }, 330), { heightMeters: 1 });
  assert.equal(patch({ ...placement, heightMeters: 1 }, { type: "resize", percentDelta: -1 }, 330), null);
  assert.equal(patch({ ...placement, heightMeters: 1000 }, { type: "resize", percentDelta: 1 }, 330), null);
});

test("non-placement actions and malformed numeric operations cannot create an invalid patch", () => {
  for (const type of ["undo", "redo", "focus"]) assert.equal(patch(placement, { type }, 330), null);
  for (const baseHeight of [0, -1, NaN, Infinity]) assert.equal(patch(placement, { type: "resize", percentDelta: 1 }, baseHeight), null);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(patch(placement, { type: "resize", percentDelta: value }, 330), null);
    assert.equal(patch(placement, { type: "rotate", degrees: value }, 330), null);
    assert.equal(patch(placement, { type: "move", eastMeters: value, northMeters: 1 }, 330), null);
  }
});
