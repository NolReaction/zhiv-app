import assert from "node:assert/strict";
import test from "node:test";
import { changeGarageHistory, finishGarageHistoryGesture, getGarageShortcut, redoGarageHistory, undoGarageHistory } from "../features/world/dev/boat-garage/garage-editor-shortcuts.mjs";

const key = (code, overrides = {}) => ({ code, key: code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  defaultPrevented: false, isComposing: false, target: null, ...overrides });
const history = scene => ({ past: [], scene, future: [] });

test("undo and redo use physical keys in either English or Russian layout", () => {
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(getGarageShortcut(key("KeyZ", { key: "я", ...modifier })), "undo");
    assert.equal(getGarageShortcut(key("KeyZ", { key: "Я", shiftKey: true, ...modifier })), "redo");
    assert.equal(getGarageShortcut(key("KeyY", { key: "н", ...modifier })), "redo");
    assert.equal(getGarageShortcut(key("KeyD", { key: "в", ...modifier })), "duplicate");
    assert.equal(getGarageShortcut(key("KeyS", { key: "ы", ...modifier })), "save");
  }
  assert.equal(getGarageShortcut(key("", { key: "z", ctrlKey: true })), "undo", "fallback for keyboards without code");
});

test("typing, composition, alt shortcuts and already handled events stay native", () => {
  for (const node of ["input", "textarea", "select", "contenteditable", "textbox"]) {
    const target = { closest: selector => selector.includes(node) ? {} : null };
    for (const code of ["KeyZ", "KeyD", "KeyS", "Delete", "ArrowLeft"]) assert.equal(getGarageShortcut(key(code, { ctrlKey: true, target })), null);
  }
  assert.equal(getGarageShortcut(key("KeyZ", { ctrlKey: true, isComposing: true })), null);
  assert.equal(getGarageShortcut(key("KeyZ", { ctrlKey: true, defaultPrevented: true })), null);
  assert.equal(getGarageShortcut(key("KeyZ", { ctrlKey: true, altKey: true })), null);
  assert.equal(getGarageShortcut(key("ArrowLeft", { ctrlKey: true })), null);
  assert.equal(getGarageShortcut(key("KeyR", { ctrlKey: true })), null, "browser reload is untouched");
});

test("toolbar focus permits commands but keeps arrow navigation and backspace away from scene edits", () => {
  const target = { closest: selector => selector.includes("button") ? {} : null };
  assert.equal(getGarageShortcut(key("KeyZ", { ctrlKey: true, target })), "undo");
  assert.equal(getGarageShortcut(key("KeyD", { ctrlKey: true, target })), "duplicate");
  assert.equal(getGarageShortcut(key("ArrowRight", { target })), null);
  assert.equal(getGarageShortcut(key("Backspace", { target })), null);
  assert.equal(getGarageShortcut(key("Escape", { target })), "escape");
});

test("scene nudging, deletion and physical tool keys are mapped without overriding browser modifiers", () => {
  for (const [code, expected] of [["KeyV", "move"], ["KeyH", "camera"], ["KeyP", "pivot"], ["KeyA", "socket"],
    ["Delete", "remove"], ["Backspace", "remove"], ["ArrowLeft", "left"], ["ArrowRight", "right"], ["ArrowUp", "up"], ["ArrowDown", "down"]]) {
    assert.equal(getGarageShortcut(key(code)), expected);
  }
  assert.equal(getGarageShortcut(key("ArrowRight", { shiftKey: true })), "right");
  assert.equal(getGarageShortcut(key("KeyA", { ctrlKey: true })), null);
});

test("pointermove updates form a single undo checkpoint, and undo-redo reproduces exact scene", () => {
  const original = { nodes: [{ id: "hull", x: 12, y: 8 }], camera: { x: 5 } };
  let state = history(original);
  for (let x = 13; x < 150; x++) state = changeGarageHistory(state, { ...original, nodes: [{ id: "hull", x, y: 8 }] }, false);
  state = finishGarageHistoryGesture(state, original);
  assert.equal(state.past.length, 1);
  const moved = state.scene;
  state = undoGarageHistory(state);
  assert.deepEqual(state.scene, original);
  state = redoGarageHistory(state);
  assert.deepEqual(state.scene, moved);
  assert.equal(state.past.length, 1);
});

test("holding an arrow key groups repeat nudges, and a new edit branches undo history", () => {
  let state = history({ x: 0 });
  state = changeGarageHistory(state, { x: 1 });
  for (let x = 2; x <= 10; x++) state = changeGarageHistory(state, { x }, false);
  assert.equal(state.past.length, 1);
  state = undoGarageHistory(state);
  assert.equal(state.scene.x, 0);
  assert.equal(state.future[0].x, 10);
  state = changeGarageHistory(state, { x: 7 });
  assert.deepEqual(state.future, []);
  assert.equal(redoGarageHistory(state), state);
});

test("no-op edits and clicks preserve redo and do not fill the bounded history", () => {
  const undo = undoGarageHistory(changeGarageHistory(history({ x: 0 }), { x: 1 }));
  assert.equal(changeGarageHistory(undo, { x: 0 }), undo);
  assert.equal(finishGarageHistoryGesture(undo, { x: 0 }), undo);
  let state = history({ x: 0 });
  for (let x = 1; x <= 150; x++) state = changeGarageHistory(state, { x });
  assert.equal(state.past.length, 100);
  for (let i = 0; i < 100; i++) state = undoGarageHistory(state);
  assert.equal(state.scene.x, 50);
  assert.equal(undoGarageHistory(state), state);
  for (let i = 0; i < 100; i++) state = redoGarageHistory(state);
  assert.equal(state.scene.x, 150);
  assert.equal(redoGarageHistory(state), state);
});
