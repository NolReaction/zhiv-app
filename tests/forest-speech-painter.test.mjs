import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { layoutForestSpeech, drawForestSpeech } = await vite.ssrLoadModule("/features/world/forest-speech-painter.ts");
const measure = text => Array.from(text).reduce((width, char) => width + (char === " " ? 3.5 : 7), 0);
const base = { id: "greeting", speaker: "builder", text: "Доски ровные. Можно и о жизни поговорить!",
  elapsed: 1, duration: 5, anchor: { x: 160, y: 150 } };

test("small parchment bubbles wrap Cyrillic inside narrow and wide screen insets", () => {
  for (const width of [128, 240, 320, 760, 1280]) for (const x of [0, width / 2, width]) {
    const viewport = { width, height: 320, insets: { top: 36, bottom: 28 } };
    const box = layoutForestSpeech({ ...base, anchor: { x, y: 180 } }, viewport, measure);
    assert.ok(box);
    assert.ok(box.x >= 8 && box.x + box.width <= width - 8);
    assert.ok(box.y >= 44 && box.y + box.height <= 284);
    assert.ok(box.width <= 198 && box.lines.length <= 3);
    assert.ok(box.lines.every(line => measure(line) <= box.width - 24));
    assert.equal(box.label, "Шишколап");
  }
});

test("long words and messages are bounded, whitespace normalizes, short phrases remain compact", () => {
  const viewport = { width: 200, height: 320 };
  const long = layoutForestSpeech({ ...base, text: "Сверхдлинноесловобезпробелов".repeat(18) }, viewport, measure);
  assert.equal(long.lines.length, 3);
  assert.ok(long.lines[2].endsWith("…"));
  assert.ok(long.lines.every(line => measure(line) <= long.width - 24));
  const short = layoutForestSpeech({ ...base, text: "  Ну\n\tчто,   отдых?  " }, viewport, measure);
  assert.deepEqual(short.lines, ["Ну что, отдых?"]);
  assert.ok(short.width < long.width);
  assert.equal(layoutForestSpeech({ ...base, text: " \n " }, viewport, measure), null);
});

test("bubble points toward a visible resident and switches below heads near the top", () => {
  const viewport = { width: 320, height: 240 };
  const above = layoutForestSpeech({ ...base, anchor: { x: 220, y: 200 } }, viewport, measure);
  const below = layoutForestSpeech({ ...base, anchor: { x: 220, y: 12 } }, viewport, measure);
  assert.equal(above.tail.side, "bottom");
  assert.ok(above.y + above.height < 200);
  assert.equal(below.tail.side, "top");
  assert.ok(below.y > 12);
  assert.ok(below.tail.tipY < below.y);
  for (const anchor of [{ x: -1, y: 100 }, { x: 321, y: 100 }, { x: 100, y: -1 }, { x: 100, y: 241 }]) {
    assert.equal(layoutForestSpeech({ ...base, anchor }, viewport, measure), null, "offscreen speakers never pin text to the edge");
  }
});

test("entrance rises gently, departure fades, reduced motion stays fixed for the whole line", () => {
  const viewport = { width: 320, height: 320 };
  const first = layoutForestSpeech({ ...base, elapsed: 0 }, viewport, measure);
  const arriving = layoutForestSpeech({ ...base, elapsed: .12 }, viewport, measure);
  const settled = layoutForestSpeech(base, viewport, measure);
  const leaving = layoutForestSpeech({ ...base, elapsed: 4.9 }, viewport, measure);
  assert.equal(first.opacity, 0);
  assert.ok(arriving.opacity > 0 && arriving.opacity < 1);
  assert.equal(settled.opacity, 1);
  assert.ok(first.y - settled.y <= 4.01 && first.y > arriving.y && arriving.y > settled.y);
  assert.ok(leaving.opacity < 1 && leaving.opacity > 0);
  for (const elapsed of [0, .1, 2, 4.99]) {
    const still = layoutForestSpeech({ ...base, elapsed }, { ...viewport, reducedMotion: true }, measure);
    assert.equal(still.opacity, 1);
    assert.equal(still.y, settled.y);
  }
  assert.equal(layoutForestSpeech({ ...base, elapsed: 5 }, viewport, measure), null);
});

test("invalid clocks and small viewports cannot produce impossible bubble geometry", () => {
  const viewport = { width: 320, height: 320 };
  for (const changed of [{ duration: 0 }, { duration: Infinity }, { elapsed: NaN }, { elapsed: -1 }, { anchor: { x: NaN, y: 10 } }]) {
    assert.equal(layoutForestSpeech({ ...base, ...changed }, viewport, measure), null);
  }
  assert.equal(layoutForestSpeech({ ...base, anchor: { x: 10, y: 10 } }, { width: 90, height: 320 }, measure), null);
  assert.equal(layoutForestSpeech({ ...base, anchor: { x: 10, y: 10 } }, { width: 320, height: 40 }, measure), null);
  assert.equal(layoutForestSpeech(base, { ...viewport, insets: { left: 160, right: 160 } }, measure), null);
});

function context() {
  const calls = [], stack = [];
  const props = ["font", "globalAlpha", "fillStyle", "strokeStyle", "lineWidth", "shadowColor", "shadowBlur", "shadowOffsetX", "shadowOffsetY", "textAlign", "textBaseline"];
  const ctx = Object.fromEntries(props.map(prop => [prop, "original"]));
  ctx.globalAlpha = .6;
  const state = () => Object.fromEntries(props.map(prop => [prop, ctx[prop]]));
  ctx.save = () => stack.push(state()); ctx.restore = () => Object.assign(ctx, stack.pop());
  ctx.measureText = text => ({ width: measure(text) });
  for (const name of ["beginPath", "moveTo", "lineTo", "quadraticCurveTo", "closePath", "fill", "stroke", "fillText"]) {
    ctx[name] = (...args) => calls.push([name, ...args]);
  }
  return { ctx, calls, state, stack };
}

test("painting is read-only, restores context and displays only one line's bubble even with competing frames", () => {
  for (const night of [false, true]) for (const reducedMotion of [false, true]) {
    const { ctx, calls, state, stack } = context(), before = state();
    const frames = Object.freeze([Object.freeze({ ...base, anchor: Object.freeze({ ...base.anchor }) }),
      Object.freeze({ ...base, id: "other", speaker: "plesk", text: "До встречи у воды." })]);
    const snapshot = JSON.stringify(frames);
    const box = drawForestSpeech(ctx, frames, { width: 320, height: 320, night, reducedMotion });
    assert.equal(box.id, base.id);
    assert.deepEqual(calls.filter(call => call[0] === "fillText").map(call => call[1]), [box.label, ...box.lines]);
    assert.equal(calls.filter(call => call[0] === "fill").length, 1);
    assert.deepEqual(state(), before);
    assert.equal(stack.length, 0);
    assert.equal(JSON.stringify(frames), snapshot);
  }
  const hidden = context();
  drawForestSpeech(hidden.ctx, [{ ...base, elapsed: 5 }], { width: 320, height: 320 });
  assert.equal(hidden.calls.length, 0);
});
