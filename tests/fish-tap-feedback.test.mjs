import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), cacheDir = await mkdtemp(join(tmpdir(), "zhiv-fish-tap-feedback-"));
const hookId = "virtual:fish-tap-feedback-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "fish-tap-feedback-hooks", enforce: "pre",
    resolveId(id) { if (id === hookId) return `\0${id}`; },
    load(id) { if (id === `\0${hookId}`) return `
      let slots = [], cursor = 0, effects = [];
      export function reset() { slots = []; cursor = 0; effects = []; }
      export function render() { cursor = 0; effects = []; }
      export function flush() { for (const effect of effects) effect(); }
      export function useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; }
      export function useState(initial) { const slot = useRef(initial); return [slot.current, value => { slot.current = typeof value === 'function' ? value(slot.current) : value; }]; }
      export function useEffect(effect, dependencies) {
        const previous = useRef(null);
        if (!previous.current || dependencies.some((value, i) => !Object.is(value, previous.current.dependencies[i]))) {
          const old = previous.current; const next = { dependencies, cleanup: null }; previous.current = next;
          effects.push(() => { old?.cleanup?.(); next.cleanup = effect(); });
        }
      }
    `; },
    transform(source, id) { if (id.endsWith("/ui/fishing/fish-tap-feedback.tsx")) return source.replace('from "react";', `from "${hookId}";`); },
  }] });
after(async () => { await vite.close(); await rm(cacheDir, { recursive: true, force: true }); });
const hooks = await vite.ssrLoadModule(hookId);
const { useFishTapFeedback, FishTapFeedbackArt, FishTapFeedbackQuantity, FISH_TAP_FEEDBACK_MS } = await vite.ssrLoadModule("/features/economy/ui/fishing/fish-tap-feedback.tsx");
function Feedback(scope = "owner:fish_epic") { hooks.render(); const value = useFishTapFeedback(scope); hooks.flush(); return value; }
const event = (sequence, kind = "added") => ({ itemId: "fish_mirror_koi", sequence, kind, quantity: 2 });

test("feedback only appears for explicit events, retriggers every tap and hides on another owner or surface", () => {
  hooks.reset(); let value = Feedback(); assert.equal(value.feedback, null);
  value.show("fish_mirror_koi", "added", 1); value = Feedback(); assert.equal(value.feedback.sequence, 1);
  value.show("fish_mirror_koi", "added", 2); value = Feedback(); assert.equal(value.feedback.sequence, 2); assert.equal(value.feedback.quantity, 2);
  assert.equal(Feedback("OTHER:fish_epic").feedback, null); assert.equal(Feedback("owner:fish_common").feedback, null);
  value.clear(); assert.equal(Feedback().feedback, null);
});

test("expiry clears only its own event and an older timeout cannot erase a newer tap", () => {
  const previousTimeout = globalThis.setTimeout, previousClear = globalThis.clearTimeout, tasks = [];
  globalThis.setTimeout = (callback, milliseconds) => { tasks.push({ callback, milliseconds, cleared: false }); return tasks.length; };
  globalThis.clearTimeout = id => { if (tasks[id - 1]) tasks[id - 1].cleared = true; };
  try {
    hooks.reset(); let value = Feedback(); value.show("fish_mirror_koi", "added", 1); value = Feedback();
    assert.equal(tasks[0].milliseconds, FISH_TAP_FEEDBACK_MS);
    value.show("fish_mirror_koi", "limit", 1); value = Feedback(); assert.equal(tasks[0].cleared, true);
    tasks[0].callback(); assert.equal(Feedback().feedback.sequence, 2);
    tasks[1].callback(); assert.equal(Feedback().feedback, null);
  } finally { globalThis.setTimeout = previousTimeout; globalThis.clearTimeout = previousClear; }
});

test("added and bounded feedback have distinct truthful labels without changing the item artwork", () => {
  const icon = createElement("svg", { "data-test-fish": "actual-species" });
  const added = FishTapFeedbackArt({ feedback: event(1), itemId: "fish_mirror_koi", children: icon });
  const limited = FishTapFeedbackArt({ feedback: event(2, "limit"), itemId: "fish_mirror_koi", children: icon });
  assert.equal(added.props.children[0], icon); assert.equal(limited.props.children[0], icon);
  const positive = renderToStaticMarkup(added), cap = renderToStaticMarkup(limited);
  assert.match(positive, /data-fish-tap-badge="added"[^>]*>\+1/); assert.match(cap, /data-fish-tap-badge="limit"[^>]*>Лимит/); assert.doesNotMatch(cap, /\+1/);
  assert.equal(added.props["data-flash"], "odd"); assert.equal(limited.props["data-flash"], "even");
  const other = renderToStaticMarkup(createElement(FishTapFeedbackArt, { feedback: event(3), itemId: "fish_sturgeon" }, icon));
  assert.doesNotMatch(other, /data-fish-tap-badge|\+1|Лимит/);
});

test("quantity pulses preserve the exact input element across new taps and expiry", () => {
  const input = createElement("input", { value: "2", readOnly: true });
  const first = FishTapFeedbackQuantity({ feedback: event(1), itemId: "fish_mirror_koi", children: input });
  const second = FishTapFeedbackQuantity({ feedback: event(2), itemId: "fish_mirror_koi", children: input });
  const expired = FishTapFeedbackQuantity({ feedback: null, itemId: "fish_mirror_koi", children: input });
  for (const value of [first, second, expired]) assert.equal(value.props.children[0], input);
  assert.notEqual(first.props.children[1].key, second.props.children[1].key);
  assert.equal(expired.props.children[1], null);
  const html = renderToStaticMarkup(first); assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /Добавлена одна рыба\. Выбрано: 2\./);
});

test("shared feedback uses absolute overlays and explicitly removes all motion for reduced-motion users", async () => {
  const css = await readFile(new URL("../features/economy/ui/fishing/fish-tap-feedback.module.css", import.meta.url), "utf8");
  assert.match(css, /\.badge\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.quantityPulse\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none;\s*transform:\s*none/);
});
