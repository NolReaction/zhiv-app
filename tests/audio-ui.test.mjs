import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { attachAudioLifecycle, uiCueFromTarget, playUiCue } = await vite.ssrLoadModule("/features/audio/ui/audio-lifecycle.ts");
const { AudioSettingsControls } = await vite.ssrLoadModule("/features/audio/ui/audio-settings.tsx");
const { DEFAULT_AUDIO_SETTINGS } = await vite.ssrLoadModule("/features/audio/domain/settings.ts");

function controls(settings = DEFAULT_AUDIO_SETTINGS, state = "locked") {
  const calls = { changes: [], enables: 0, resumes: 0 };
  const tree = AudioSettingsControls({ id: "audio-test", diagnostics: { state, settings }, busy: false, feedback: "", onChange: patch => calls.changes.push(patch), onEnable: () => calls.enables++, onResume: () => calls.resumes++ });
  const nodes = [];
  function walk(element) { if (!isValidElement(element)) return; nodes.push(element); Children.forEach(element.props.children, walk); }
  walk(tree);
  return { calls, nodes, markup: renderToStaticMarkup(tree) };
}

test("sound settings expose labelled master and five category sliders without playing on render", () => {
  const view = controls();
  assert.equal(view.calls.enables, 0);
  assert.deepEqual(view.calls.changes, []);
  assert.match(view.markup, /role="switch" aria-checked="false" aria-label="Звуки игры"/);
  assert.equal((view.markup.match(/type="range"/g) ?? []).length, 6);
  for (const channel of ["master", "music", "ambience", "world", "characters", "ui"]) {
    assert.ok(view.markup.includes(`for="audio-test-${channel}"`));
    assert.ok(view.markup.includes(`id="audio-test-${channel}"`));
  }
  assert.doesNotMatch(view.markup, /pending|assets|AudioContext|Продолжить воспроизведение/);
  view.nodes.find(node => node.props.role === "switch").props.onClick();
  assert.equal(view.calls.enables, 1);
});

test("enabled switch mutes immediately and interrupted playback offers explicit resume", () => {
  const view = controls({ ...DEFAULT_AUDIO_SETTINGS, enabled: true }, "suspended");
  view.nodes.find(node => node.props.role === "switch").props.onClick();
  assert.deepEqual(view.calls.changes, [{ enabled: false }]);
  const resume = view.nodes.find(node => node.type === "button" && node.props.children === "Продолжить воспроизведение");
  resume.props.onClick();
  assert.equal(view.calls.resumes, 1);
  assert.equal(view.calls.enables, 0);
});

function eventSurface() {
  const handlers = new Map();
  return {
    hidden: false,
    addEventListener(type, handler) { const set = handlers.get(type) ?? new Set(); set.add(handler); handlers.set(type, set); },
    removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
    emit(type, event = {}) { handlers.get(type)?.forEach(handler => handler(event)); },
    count() { return [...handlers.values()].reduce((total, set) => total + set.size, 0); },
  };
}

test("lifecycle waits for a trusted gesture, preserves muted preference and detaches every handler", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "KeyboardEvent");
  class KeyboardEvent { constructor(key, isTrusted = true) { this.key = key; this.isTrusted = isTrusted; } }
  Object.defineProperty(globalThis, "KeyboardEvent", { value: KeyboardEvent, configurable: true });
  try {
    const page = eventSurface(), surface = eventSurface(), visibility = [];
    let enabled = false, unlocked = 0, state = "locked";
    const cleanup = attachAudioLifecycle({ setVisible: value => visibility.push(value), getSettings: () => ({ enabled }), getDiagnostics: () => ({ state }), unlock: () => { unlocked++; return Promise.resolve(true); } }, page, surface);
    assert.deepEqual(visibility, [true]);
    assert.equal(unlocked, 0);
    page.emit("pointerdown", { isTrusted: true });
    assert.equal(unlocked, 0, "ordinary interaction must not enable muted audio");
    enabled = true;
    page.emit("pointerdown", { isTrusted: false });
    page.emit("keydown", new KeyboardEvent("a"));
    assert.equal(unlocked, 0, "typing and synthetic events are not playback triggers");
    page.emit("keydown", new KeyboardEvent("Enter"));
    assert.equal(unlocked, 1);
    state = "running";
    page.emit("pointerdown", { isTrusted: true });
    assert.equal(unlocked, 1);
    page.hidden = true;
    page.emit("visibilitychange");
    state = "suspended";
    page.emit("pointerdown", { isTrusted: true });
    assert.equal(unlocked, 1);
    page.hidden = false;
    surface.emit("pageshow");
    assert.equal(unlocked, 1, "foregrounding never unlocks by itself");
    surface.emit("pagehide");
    cleanup();
    assert.deepEqual(visibility, [true, false, true, false, false]);
    assert.equal(page.count() + surface.count(), 0);
  } finally { if (saved) Object.defineProperty(globalThis, "KeyboardEvent", saved); else delete globalThis.KeyboardEvent; }
});

test("delegation only accepts opted-in enabled buttons, not inputs, invalid cues or disabled controls", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "Element");
  class Element {
    constructor({ cue = "ui.click", button = true, disabled = false, inert = false } = {}) { Object.assign(this, { dataset: { audioCue: cue }, button, disabled, inert }); }
    closest(selector) { return selector === "[inert]" ? (this.inert ? this : null) : this.button ? this : null; }
    matches() { return this.disabled; }
  }
  Object.defineProperty(globalThis, "Element", { value: Element, configurable: true });
  try {
    assert.equal(uiCueFromTarget(new Element()), "ui.click");
    for (const config of [{ button: false }, { disabled: true }, { inert: true }, { cue: "world.step" }, { cue: "" }]) assert.equal(uiCueFromTarget(new Element(config)), null);
    assert.equal(uiCueFromTarget(null), null);
    const calls = [];
    playUiCue({ play: event => calls.push(event) }, "ui.open");
    playUiCue({ play: event => calls.push(event) }, "ui.open");
    playUiCue({ play: event => calls.push(event) }, "world.step");
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id);
  } finally { if (saved) Object.defineProperty(globalThis, "Element", saved); else delete globalThis.Element; }
});
