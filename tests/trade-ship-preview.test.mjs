import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { default: TradeShipPage, metadata } = await vite.ssrLoadModule("/app/prototype/trade-ship/page.tsx");
const { TradeShipPreview } = await vite.ssrLoadModule("/features/world/dev/trade-ship-preview.tsx");
const { advanceTradeShipPreviewClock, tradeShipPreviewLayout, TRADE_SHIP_MAP_CROP, TRADE_SHIP_PREVIEW_BERTH } =
  await vite.ssrLoadModule("/features/world/dev/trade-ship-preview-model.ts");

test("ship workshop is available only in development and stays out of search indexing", () => {
  const saved = process.env.NODE_ENV;
  try {
    for (const mode of ["production", "test", "preview", undefined]) {
      if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
      assert.throws(() => TradeShipPage(), error => error.digest === "NEXT_HTTP_ERROR_FALLBACK;404", String(mode));
    }
    process.env.NODE_ENV = "development";
    assert.equal(TradeShipPage().type, TradeShipPreview);
    assert.deepEqual(metadata.robots, { index: false, follow: false });
  } finally { if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved; }
});

test("preview clock freezes on pause, hidden tab and reduced motion without catching up later", () => {
  const active = { playing: true, visible: true, reducedMotion: false };
  for (const overrides of [{ playing: false }, { visible: false }, { reducedMotion: true }])
    assert.equal(advanceTradeShipPreviewClock(12, 30, { ...active, ...overrides }), 12);
  for (const delta of [-2, 0, NaN, Infinity]) assert.equal(advanceTradeShipPreviewClock(12, delta, active), 12);
  assert.equal(advanceTradeShipPreviewClock(12, 1 / 60, active), 12 + 1 / 60);
  assert.equal(advanceTradeShipPreviewClock(12, 30, active), 12.05);
  assert.equal(advanceTradeShipPreviewClock(NaN, .01, active), .01);
});

test("close-up keeps the whole illustration inside narrow and wide canvases", () => {
  for (const [width, height] of [[298, 330], [760, 500], [1300, 740]]) {
    const { ship } = tradeShipPreviewLayout(width, height, "detail");
    assert.ok(ship.x >= 0 && ship.y >= 0);
    assert.ok(ship.x + ship.width <= width);
    assert.ok(ship.y + ship.width * 500 / 800 <= height);
  }
});

test("map placement is independent of canvas resolution and uses one southern crop", () => {
  for (const [width, height] of [[298, 330], [1000, 600]]) {
    const layout = tradeShipPreviewLayout(width, height, "map");
    assert.deepEqual(layout.ship, TRADE_SHIP_PREVIEW_BERTH);
    assert.ok(layout.x >= 0 && layout.y >= 0 && layout.scale > 0);
    assert.ok(layout.x + TRADE_SHIP_MAP_CROP.width * layout.scale <= width + 1e-7);
    assert.ok(layout.y + TRADE_SHIP_MAP_CROP.height * layout.scale <= height + 1e-7);
    assert.ok(layout.ship.x >= TRADE_SHIP_MAP_CROP.x);
    assert.ok(layout.ship.x + layout.ship.width <= TRADE_SHIP_MAP_CROP.x + TRADE_SHIP_MAP_CROP.width);
  }
});

test("the initial workshop exposes labelled controls and a real transparent PNG export action", () => {
  const html = renderToStaticMarkup(createElement(TradeShipPreview));
  assert.match(html, /Пароход из кода/);
  assert.match(html, /Предпросмотр парохода/);
  assert.match(html, /Крупно/); assert.match(html, /На карте/);
  assert.match(html, /Калитка/); assert.match(html, /Трап/); assert.match(html, /Грузовые ящики/);
  assert.match(html, /Пустая палуба/); assert.match(html, /Скачать PNG/);
  assert.match(html, /role="img"/);
  assert.equal((html.match(/type="range"/g) ?? []).length, 2);
  for (const id of ["trade-ship-gate", "trade-ship-ramp", "trade-ship-cargo"]) {
    assert.ok(html.includes(`for="${id}"`), `explicit label remains attached to ${id}, not its nested output`);
    assert.ok(html.includes(`id="${id}"`));
  }
});
