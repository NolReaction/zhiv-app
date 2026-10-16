import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent",
  cacheDir: `/tmp/zhiv-studio-keyboard-${process.pid}`, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { createWorldStudioKeyboard, worldStudioKey } = await vite.ssrLoadModule("/features/world/dev/world-studio-keyboard.ts");

function rig() {
  const calls = [], state = { enabled: true, previewDraft: true, tool: "select", selectedId: "ground" };
  const store = { getSnapshot: () => state, isGesturing: () => false,
    commitGesture: () => calls.push("commit"), cancelGesture: () => calls.push("cancel"),
    undo: () => calls.push("undo"), redo: () => calls.push("redo"), saveDraft: () => calls.push("draft"),
    setTool: tool => { state.tool = tool; calls.push(`tool:${tool}`); }, duplicateSelected: () => calls.push("duplicate") };
  const keyboard = createWorldStudioKeyboard({ store, ui: command => calls.push(`ui:${command.action}`),
    map: request => { calls.push(`map:${request.phase}:${request.input.key}`); request.handled = request.phase === "down"; }, close: () => calls.push("close") });
  return { keyboard, calls, state, store };
}
const key = (overrides = {}) => ({ key: "z", code: "KeyZ", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: null, ...overrides });
function field(tagName, type = "text", calls = []) {
  const control = { tagName, getAttribute: name => name === "type" ? type : null, hasAttribute: () => false,
    isContentEditable: false, matches: () => false, blur: () => calls.push("blur") };
  control.closest = () => control; return control;
}

test("undo and redo use physical keys for Latin and Cyrillic events anywhere in the active studio", () => {
  for (const layout of ["z", "я"]) {
    const { keyboard, calls } = rig();
    assert.equal(keyboard.down(key({ key: layout, ctrlKey: true })), true);
    assert.deepEqual(calls, [`commit`, `map:cancel:${layout}`, "cancel", "undo"]);
  }
  for (const overrides of [{ metaKey: true, shiftKey: true }, { key: "н", code: "KeyY", ctrlKey: true }]) {
    const { keyboard, calls } = rig(); keyboard.down(key(overrides)); assert.equal(calls.at(-1), "redo");
  }
});

test("text and numeric entry retain native undo, while range and select controls undo scene changes", () => {
  for (const [tag, type] of [["INPUT", "text"], ["INPUT", "number"], ["TEXTAREA", "text"]]) {
    const { keyboard, calls } = rig();
    assert.equal(keyboard.down(key({ ctrlKey: true, target: field(tag, type) })), false); assert.deepEqual(calls, []);
  }
  for (const [tag, type] of [["INPUT", "range"], ["SELECT", "text"]]) {
    const { keyboard, calls } = rig();
    assert.equal(keyboard.down(key({ ctrlKey: true, target: field(tag, type) })), true); assert.equal(calls.at(-1), "undo");
  }
});

test("save finishes focused input before requesting a browser draft and project write", () => {
  const { keyboard, calls } = rig();
  assert.equal(keyboard.down(key({ key: "ы", code: "KeyS", ctrlKey: true, target: field("INPUT", "text", calls) })), true);
  assert.deepEqual(calls, ["blur", "commit", "draft", "ui:save"]);
});

test("shortcuts never mutate a saved comparison, a disabled studio, or composing text", () => {
  const { keyboard, calls, state } = rig(); state.previewDraft = false;
  assert.equal(keyboard.down(key({ ctrlKey: true })), true); assert.deepEqual(calls, []);
  assert.equal(keyboard.down(key({ code: "KeyD", key: "в", ctrlKey: true })), true); assert.deepEqual(calls, []);
  state.enabled = false;
  assert.equal(keyboard.down(key({ code: "KeyS", ctrlKey: true })), false); assert.deepEqual(calls, []);
  state.enabled = true;
  assert.equal(keyboard.down(key({ ctrlKey: true, isComposing: true })), false); assert.deepEqual(calls, []);
});

test("plain physical letters reach the map without lowercasing navigation keys", () => {
  const { keyboard, calls } = rig();
  keyboard.down(key({ key: "п", code: "KeyG" })); assert.deepEqual(calls, ["map:down:g"]);
  calls.length = 0; keyboard.down(key({ key: "ArrowRight", code: "ArrowRight" }));
  assert.deepEqual(calls, ["map:down:ArrowRight"]);
  assert.equal(worldStudioKey({ key: "я", code: "KeyZ" }), "z");
});

test("selection, rename, duplication and help are scoped away from text editing", () => {
  for (const [overrides, action] of [[{ code: "KeyA", key: "ф", ctrlKey: true }, "ui:select-all"],
    [{ code: "F2", key: "F2" }, "ui:rename"], [{ code: "Slash", key: ",", shiftKey: true }, "ui:help"],
    [{ code: "KeyH", key: "р", ctrlKey: true, shiftKey: true }, "ui:history"]]) {
    const { keyboard, calls } = rig(); assert.equal(keyboard.down(key(overrides)), true); assert.equal(calls.at(-1), action);
  }
  const { keyboard, calls } = rig();
  assert.equal(keyboard.down(key({ code: "KeyD", ctrlKey: true })), true); assert.equal(calls.at(-1), "duplicate");
  calls.length = 0;
  assert.equal(keyboard.down(key({ code: "KeyD", ctrlKey: true, target: field("INPUT") })), false); assert.deepEqual(calls, []);
});

test("escape cancels field entry or an active operation before it closes the studio", () => {
  const { keyboard, calls, state, store } = rig();
  keyboard.down(key({ key: "Escape", code: "Escape", target: field("INPUT", "number") }));
  assert.deepEqual(calls, ["ui:cancel-input"]);
  calls.length = 0; state.tool = "light"; keyboard.down(key({ key: "Escape", code: "Escape" }));
  assert.deepEqual(calls, ["map:cancel:Escape", "cancel", "tool:select"]);
  calls.length = 0; store.isGesturing = () => true; keyboard.down(key({ key: "Escape", code: "Escape" }));
  assert.deepEqual(calls, ["map:cancel:Escape", "cancel"]);
  calls.length = 0; store.isGesturing = () => false; keyboard.down(key({ key: "Escape", code: "Escape" }));
  assert.deepEqual(calls, ["close"]);
});

test("space release and window blur reset map interaction even after focus moves", () => {
  const { keyboard, calls } = rig();
  keyboard.up(key({ key: " ", code: "Space", target: field("INPUT") }));
  keyboard.blur(key({ key: "", code: "" }));
  assert.deepEqual(calls, ["map:up: ", "map:cancel:", "cancel"]);
});

test("tools and focus still work while the map mounts asynchronously", () => {
  const { calls, store } = rig();
  const keyboard = createWorldStudioKeyboard({ store, ui() {}, map() {}, close() {}, focus: () => calls.push("focus") });
  assert.equal(keyboard.down(key({ key: "п", code: "KeyG" })), true);
  assert.equal(store.getSnapshot().tool, "move");
  assert.equal(keyboard.down(key({ key: "а", code: "KeyF" })), true);
  assert.equal(calls.at(-1), "focus");
});


test("keyword search uses physical Ctrl/Cmd+K in either layout and can be reopened from text entry", () => {
  for (const overrides of [{ key: "k", ctrlKey: true }, { key: "л", metaKey: true }, { key: "л", ctrlKey: true, target: field("INPUT", "search") }]) {
    const { keyboard, calls } = rig();
    assert.equal(keyboard.down(key({ code: "KeyK", ...overrides })), true);
    assert.deepEqual(calls, ["ui:search"]);
  }
});
