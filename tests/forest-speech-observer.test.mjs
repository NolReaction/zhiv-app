import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { connectForestSession } = await vite.ssrLoadModule("/features/world/forest-session.ts");
const { createForestSocial } = await vite.ssrLoadModule("/features/world/forest-social.ts");
const { forestObservationFrame, getForestObservation, publishForestObservation, subscribeForestObservation } =
  await vite.ssrLoadModule("/features/world/forest-observer.ts");
const { ForestSpeechBubble, ResidentSpeech, ForestSpeechAnnouncements } = await vite.ssrLoadModule("/features/world/forest-speech.tsx");
const { TILED_WORLD } = await vite.ssrLoadModule("/features/world/presentation.ts");
const connect = key => connectForestSession(key, TILED_WORLD, "circle", 0, 0, () => {}, { persistence: false });

test("speech publications are detached semantic events rather than an animation clock", async () => {
  const key = "speech-observer", session = connect(key);
  session.state.social = createForestSocial(key);
  let calls = 0;
  const unsubscribe = subscribeForestObservation(key, () => calls++);
  try {
    publishForestObservation(key, session.state, { now: 0 }); await Promise.resolve();
    assert.equal(calls, 1);
    const line = { id: "first", speaker: "builder", text: "Дом будет тёплым!", elapsed: 0, duration: 4 };
    session.state.social.current = line;
    publishForestObservation(key, session.state, { now: 1 }); await Promise.resolve();
    assert.equal(calls, 2, "the first line bypasses the ordinary observation throttle");
    const observation = getForestObservation(key), speech = observation.speech;
    assert.deepEqual(speech, { id: "first", speaker: "builder", text: "Дом будет тёплым!" });
    assert.ok(Object.isFrozen(speech));
    for (let frame = 2; frame < 100; frame++) {
      line.elapsed = frame / 30;
      publishForestObservation(key, session.state, { now: frame });
    }
    await Promise.resolve();
    assert.equal(calls, 2); assert.equal(getForestObservation(key), observation);
    line.text = "Изменение состояния не меняет старую реплику";
    assert.equal(speech.text, "Дом будет тёплым!");
    session.state.social.current = { ...line, id: "second", speaker: "mochlik", text: "И с большим окном?", elapsed: 0 };
    publishForestObservation(key, session.state, { now: 100 }); await Promise.resolve();
    assert.equal(calls, 3); assert.equal(getForestObservation(key).speech.speaker, "mochlik");
    session.state.social.current = null;
    publishForestObservation(key, session.state, { now: 101 }); await Promise.resolve();
    assert.equal(calls, 4); assert.equal(getForestObservation(key).speech, undefined);
  } finally { unsubscribe(); session.release(); }
});

test("older fixtures and accounts without a line cannot invent or inherit speech", () => {
  const a = connect("speech-a"), b = connect("speech-b");
  try {
    a.state.social = createForestSocial("a");
    a.state.social.current = { id: "a-line", speaker: "plesk", text: "Река сегодня тихая.", elapsed: 0, duration: 4 };
    publishForestObservation("speech-a", a.state, { now: 0 });
    const legacy = { ...b.state }; delete legacy.social;
    assert.equal(forestObservationFrame(legacy).speech, undefined);
    publishForestObservation("speech-b", legacy, { now: 0 });
    assert.equal(getForestObservation("speech-b").speech, undefined);
    assert.equal(getForestObservation("speech-a").speech.text, "Река сегодня тихая.");
    assert.equal(renderToStaticMarkup(createElement(ResidentSpeech, { owner: "speech-a", speaker: "plesk" })), "",
      "SSR cannot expose a scene from a different request");
  } finally { a.release(); b.release(); }
});

test("the short reply is readable, polite, safely escaped and adds no controls", () => {
  const speech = { id: "view", speaker: "builder", text: "Держу <молоток>, а не кнопку." };
  const html = renderToStaticMarkup(createElement(ForestSpeechBubble, { speech }));
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /Шишколап: /);
  assert.match(html, /Держу &lt;молоток&gt;, а не кнопку\./);
  assert.doesNotMatch(html, /<button|tabindex|<молоток>/);
  const announcement = renderToStaticMarkup(createElement(ForestSpeechAnnouncements, { owner: "nobody" }));
  assert.match(announcement, /aria-live="polite"/);
  assert.doesNotMatch(announcement, /Мохлик:|Плёска:|Шишколап:/);
});
