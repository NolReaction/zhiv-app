import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { layoutForestSpeech, drawForestSpeech, FOREST_SPEECH_FONT } = await vite.ssrLoadModule("/features/world/characters/social/forest-speech-painter.ts");
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
    assert.ok(box.width <= 174 && box.lines.length <= 2);
    assert.ok(box.lines.every(line => measure(line) <= box.width - 20));
    assert.equal(box.label, "Шишколап");
  }
});

test("long words and messages are bounded, whitespace normalizes, short phrases remain compact", () => {
  const viewport = { width: 200, height: 320 };
  const long = layoutForestSpeech({ ...base, text: "Сверхдлинноесловобезпробелов".repeat(18) }, viewport, measure);
  assert.equal(long.lines.length, 2);
  assert.ok(long.lines[1].endsWith("…"));
  assert.ok(long.lines.every(line => measure(line) <= long.width - 20));
  const short = layoutForestSpeech({ ...base, text: "  Ну\n\tчто,   отдых?  " }, viewport, measure);
  assert.deepEqual(short.lines, ["Ну что, отдых?"]);
  assert.ok(short.width < long.width);
  assert.equal(layoutForestSpeech({ ...base, text: " \n " }, viewport, measure), null);
});

test("default bubble sits above and to the right, with a lower-left tail pointing toward its speaker", () => {
  const viewport = { width: 760, height: 420 }, anchor = { x: 310, y: 240 };
  const box = layoutForestSpeech({ ...base, text: "Ну что, передохнём?", anchor }, viewport, measure);
  assert.match(FOREST_SPEECH_FONT, /^14px "Zhiv Residents"/);
  assert.ok(box.x > anchor.x, "body belongs beside the head, not centered on top");
  assert.ok(box.y + box.height < anchor.y, "body cannot cover the face");
  assert.ok(box.tail.x < box.x + box.width / 2);
  assert.ok(Math.abs(box.tail.tipX - anchor.x) <= 1);
  assert.ok(box.tail.tipY < anchor.y);
  assert.equal(box.tail.side, "bottom");
  assert.ok(box.height <= 60, "even a two-line reply stays compact");
});

test("right-edge bubbles flip left, while narrow circular viewports keep both body and tail within the safe frame", () => {
  const anchor = { x: 712, y: 240 }, viewport = { width: 760, height: 420 };
  const flipped = layoutForestSpeech({ ...base, anchor }, viewport, measure);
  assert.ok(flipped.x + flipped.width < anchor.x);
  assert.ok(flipped.tail.x > flipped.x + flipped.width / 2);
  assert.ok(Math.abs(flipped.tail.tipX - anchor.x) <= 1);
  for (const size of [240, 320, 420]) {
    const insets = { top: size * .15, right: size * .15, bottom: size * .15, left: size * .15 };
    const box = layoutForestSpeech({ ...base, text: "День для добрых дел.", anchor: { x: size / 2, y: size / 2 } },
      { width: size, height: size, insets }, measure);
    assert.ok(box);
    for (const x of [box.x, box.x + box.width]) for (const y of [box.y, box.y + box.height]) {
      assert.ok(Math.hypot(x - size / 2, y - size / 2) < size / 2);
    }
    assert.ok(box.y + box.height < size / 2, "clamping into a circle keeps the face clear");
    assert.ok(Math.hypot(box.tail.tipX - size / 2, box.tail.tipY - size / 2) < size / 2);
  }
});

test("circular view wraps a complete short reply into the available space to the right of the head", () => {
  const anchor = { x: 160, y: 170 };
  const viewport = { width: 320, height: 320, insets: { top: 48, bottom: 48, left: 30, right: 30 } };
  const text = "Слышишь? Лес шуршит.";
  const box = layoutForestSpeech({ ...base, text, anchor }, viewport, measure);
  assert.ok(box.x > anchor.x);
  assert.ok(box.x + box.width <= 282);
  assert.ok(box.y + box.height < anchor.y);
  assert.equal(box.lines.length, 2);
  assert.equal(box.lines.join(" "), text, "preferring the right side cannot shorten the line");
  assert.ok(box.tail.x < box.x + box.width / 2);
  const long = "Лапки на месте. Настроение тоже.";
  const fallback = layoutForestSpeech({ ...base, text: long, anchor }, viewport, measure);
  assert.ok(fallback.x <= anchor.x, "a phrase that needs more room retains the wider fallback");
  assert.equal(fallback.lines.join(" "), long, "do not sacrifice readable words for a strict side placement");
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
  const calls = [], stack = [], paintAlpha = [];
  const props = ["font", "globalAlpha", "fillStyle", "strokeStyle", "lineWidth", "shadowColor", "shadowBlur", "shadowOffsetX", "shadowOffsetY", "textAlign", "textBaseline"];
  const ctx = Object.fromEntries(props.map(prop => [prop, "original"]));
  ctx.globalAlpha = .6;
  const state = () => Object.fromEntries(props.map(prop => [prop, ctx[prop]]));
  ctx.save = () => stack.push(state()); ctx.restore = () => Object.assign(ctx, stack.pop());
  ctx.measureText = text => ({ width: measure(text) });
  for (const name of ["beginPath", "moveTo", "lineTo", "quadraticCurveTo", "closePath", "fill", "stroke", "fillText"]) {
    ctx[name] = (...args) => { calls.push([name, ...args]); if (name === "fill") paintAlpha.push(ctx.globalAlpha); };
  }
  return { ctx, calls, state, stack, paintAlpha };
}

test("painting is read-only, restores context and displays only one line's bubble even with competing frames", () => {
  for (const night of [false, true]) for (const reducedMotion of [false, true]) {
    const { ctx, calls, state, stack, paintAlpha } = context(), before = state();
    const frames = Object.freeze([Object.freeze({ ...base, anchor: Object.freeze({ ...base.anchor }) }),
      Object.freeze({ ...base, id: "other", speaker: "plesk", text: "До встречи у воды." })]);
    const snapshot = JSON.stringify(frames);
    const box = drawForestSpeech(ctx, frames, { width: 320, height: 320, night, reducedMotion });
    assert.equal(box.id, base.id);
    assert.deepEqual(calls.filter(call => call[0] === "fillText").map(call => call[1]), [box.label, ...box.lines]);
    assert.equal(calls.filter(call => call[0] === "fill").length, 1);
    assert.deepEqual(paintAlpha, [1], "active parchment stays opaque despite inherited world alpha");
    assert.deepEqual(state(), before);
    assert.equal(stack.length, 0);
    assert.equal(JSON.stringify(frames), snapshot);
  }
  const hidden = context();
  drawForestSpeech(hidden.ctx, [{ ...base, elapsed: 5 }], { width: 320, height: 320 });
  assert.equal(hidden.calls.length, 0);
});
