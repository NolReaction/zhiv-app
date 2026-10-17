import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { browser } from "./helpers/new-map-scene.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const stand = await vite.ssrLoadModule("/features/world/dev/resident-animation-stand.ts");
const { WorldDevAnimationStand } = await vite.ssrLoadModule("/features/world/dev/world-dev-animation-stand.tsx");
test("stand clock discards pause/background time and steps precisely across loop ends", () => {
  for (const frame of [0, 1.5, 31]) {
    assert.equal(stand.advanceResidentStand(frame, 3600, 1, true, false), frame);
    assert.equal(stand.advanceResidentStand(frame, 3600, 1, false, true), frame);
    for (const invalid of [NaN, Infinity, -1, 0]) assert.equal(stand.advanceResidentStand(frame, invalid, 1, false, false), frame);
  }
  assert.equal(stand.stepResidentStand(0, -1), 31); assert.equal(stand.stepResidentStand(31, 1), 0);
  assert.equal(stand.advanceResidentStand(4, .1, .25, false, false), 4.2);
  assert.equal(stand.advanceResidentStand(4, 100, 1, false, false), 4.8, "a resumed rAF cannot fast-forward the stand");
});
test("every resident renders all four actual raster directions at enlarged source-pixel resolution", () => {
  const env = browser();
  try {
    assert.deepEqual(Object.keys(stand.RESIDENT_STAND_ACTIONS), ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"]);
    for (const [actor, actions] of Object.entries(stand.RESIDENT_STAND_ACTIONS)) for (const action of actions) for (const direction of stand.RESIDENT_STAND_DIRECTIONS) {
      const canvas = stand.residentStandSprite(actor, action, direction, 12);
      assert.equal(canvas.width, 48); assert.equal(canvas.height, 48);
    }
  } finally { env.restore(); }
});
test("stand starts paused and exposes keyboard-accessible directions, slow speed and frame stepping", () => {
  const html = renderToStaticMarkup(createElement(WorldDevAnimationStand));
  assert.match(html, /Стенд анимаций/); assert.match(html, /Воспроизвести/);
  for (const direction of ["Спереди", "Сзади", "Слева", "Справа"]) assert.ok(html.includes(direction));
  assert.match(html, /aria-label="Предыдущий кадр"/); assert.match(html, /aria-label="Следующий кадр"/);
  assert.match(html, /value="0.25"/); assert.match(html, /Кадр 1\/32/); assert.match(html, /width="192" height="48"/);
});
