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
const { advanceTradeShipPreviewClock, tradeShipPreviewLayout, TRADE_SHIP_MAP_CROP, TRADE_SHIP_VOYAGE_CROP, TRADE_SHIP_PREVIEW_BERTH,
  tradeShipPreviewMapSource, commandTradeShipPreview, sampleTradeShipPreviewLeg, tradeShipPreviewLegProgress } =
  await vite.ssrLoadModule("/features/world/dev/trade-ship-preview-model.ts");

const { advanceTradeShipMotion, createTradeShipMotion, sampleTradeShipMotion, TRADE_SHIP_VOYAGE, TRADE_SHIP_GANGWAY } =
  await vite.ssrLoadModule("/features/world/objects/trade-ship/trade-ship-motion.ts");

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

test("the PNG workshop waits for its ship asset and exposes only real voyage controls", () => {
  const html = renderToStaticMarkup(createElement(TradeShipPreview));
  assert.match(html, /Торговый пароход/);
  assert.match(html, /PNG · пробный рейс/);
  assert.match(html, /Загружаем корабль/);
  assert.match(html, /Предпросмотр парохода/);
  assert.match(html, /Крупно/); assert.match(html, /На карте/); assert.match(html, /Рейс/);
  assert.match(html, /Приплыть/); assert.match(html, /Отойти/); assert.match(html, /В порт/);
  assert.match(html, /Скачать PNG/);
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  for (const action of ["Приплыть", "Отойти", "В порт", "Скачать PNG"]) {
    const button = buttons.find(match => match[2].includes(action));
    assert.ok(button?.[1].includes('disabled=""'), `${action} cannot run before the image loads`);
  }
  for (const id of ["trade-ship-gate", "trade-ship-ramp", "trade-ship-cargo"]) assert.ok(!html.includes(`id="${id}"`));
  assert.match(html, /role="img"/);
  assert.equal((html.match(/type="range"/g) ?? []).length, 1);
  for (const id of ["trade-ship-voyage"]) {
    assert.ok(html.includes(`for="${id}"`), `explicit label remains attached to ${id}, not its nested output`);
    assert.ok(html.includes(`id="${id}"`));
  }
});


test("voyage canvas includes open sea while map sampling stays inside the actual image", () => {
  for (const [width, height] of [[298, 330], [1000, 600]]) {
    const layout = tradeShipPreviewLayout(width, height, "voyage");
    const crop = TRADE_SHIP_VOYAGE_CROP, source = tradeShipPreviewMapSource("voyage");
    assert.ok(crop.y + crop.height > crop.worldSize);
    assert.ok(source.x >= 0 && source.y >= 0 && source.width > 0 && source.height > 0);
    assert.ok(source.x + source.width <= crop.worldSize);
    assert.ok(source.y + source.height <= crop.worldSize);
    assert.ok(layout.x >= 0 && layout.y >= 0);
    assert.ok(layout.x + crop.width * layout.scale <= width + 1e-7);
    assert.ok(layout.y + crop.height * layout.scale <= height + 1e-7);
  }
  assert.deepEqual(tradeShipPreviewMapSource("map"), { x: 640, y: 1020, width: 420, height: 234 });
});

test("map and voyage aspect ratios put their crop at the visible canvas boundary", () => {
  for (const mode of ["map", "voyage"]) {
    const crop = mode === "map" ? TRADE_SHIP_MAP_CROP : TRADE_SHIP_VOYAGE_CROP;
    for (const width of [298, 933]) {
      const height = width * crop.height / crop.width;
      const layout = tradeShipPreviewLayout(width, height, mode);
      assert.ok(Math.abs(layout.x) < 1e-7 && Math.abs(layout.y) < 1e-7);
      assert.ok(Math.abs(crop.width * layout.scale - width) < 1e-7);
      assert.ok(Math.abs(crop.height * layout.scale - height) < 1e-7);
    }
  }
  assert.equal(TRADE_SHIP_VOYAGE_CROP.x + TRADE_SHIP_VOYAGE_CROP.width, TRADE_SHIP_VOYAGE_CROP.worldSize);
});

test("preview commands cannot restart or reverse a moving ship and reset is explicit", () => {
  const docked = createTradeShipMotion();
  const arriving = commandTradeShipPreview(docked, "arrive");
  assert.equal(arriving.phase, "arriving");
  for (const command of ["arrive", "depart"]) assert.equal(commandTradeShipPreview(arriving, command), arriving);
  const departed = sampleTradeShipMotion("departing", TRADE_SHIP_VOYAGE.departureDuration);
  assert.equal(commandTradeShipPreview(departed, "depart"), departed);
  assert.equal(commandTradeShipPreview(departed, "arrive").phase, "arriving");
  const departing = commandTradeShipPreview(docked, "depart");
  assert.equal(departing.phase, "retracting");
  assert.equal(commandTradeShipPreview(departing, "arrive"), departing);
  const reset = commandTradeShipPreview(departing, "dock");
  assert.equal(reset.phase, "docked"); assert.equal(reset.speed, 0);
  assert.deepEqual(reset.berth, departing.berth);
  assert.equal(reset.gangway, 1);
  for (const state of [arriving, sampleTradeShipMotion("deploying", 1), departing, sampleTradeShipMotion("departing", 1)]) {
    for (const command of ["arrive", "depart"]) assert.equal(commandTradeShipPreview(state, command), state,
      `${command} cannot interrupt ${state.phase}`);
  }
});

test("full-leg scrubbing includes bridge deployment/retraction and holds terminal progress at 100 percent", () => {
  const berth = TRADE_SHIP_PREVIEW_BERTH;
  const arrivalDuration = TRADE_SHIP_VOYAGE.arrivalDuration + TRADE_SHIP_GANGWAY.deployDuration;
  const departureDuration = TRADE_SHIP_GANGWAY.retractDuration + TRADE_SHIP_VOYAGE.departureDuration;
  for (const leg of ["arriving", "departing"]) {
    const duration = leg === "arriving" ? arrivalDuration : departureDuration;
    let state = sampleTradeShipPreviewLeg(leg, 0, berth), previous = 0;
    for (let n = 1; n <= 1000; n++) {
      state = advanceTradeShipMotion(state, duration / 1000);
      const progress = tradeShipPreviewLegProgress(state, leg);
      assert.ok(progress >= previous - 1e-10, `${leg} cannot jump backwards when a phase ends`);
      previous = progress;
      const sampled = sampleTradeShipPreviewLeg(leg, n / 1000, berth);
      for (const key of ["x", "y", "gangway", "heading"]) assert.ok(Math.abs(state[key] - sampled[key]) < 1e-7);
    }
    assert.equal(previous, 1);
    assert.equal(state.phase, leg === "arriving" ? "docked" : "departed");
    assert.equal(tradeShipPreviewLegProgress(advanceTradeShipMotion(state, 20), leg), 1);
  }
  const deploying = sampleTradeShipPreviewLeg("arriving",
    (TRADE_SHIP_VOYAGE.arrivalDuration + TRADE_SHIP_GANGWAY.deployDuration / 2) / arrivalDuration, berth);
  assert.equal(deploying.phase, "deploying"); assert.ok(Math.abs(deploying.gangway - .5) < 1e-8);
  const retracting = sampleTradeShipPreviewLeg("departing", TRADE_SHIP_GANGWAY.retractDuration / 2 / departureDuration, berth);
  assert.equal(retracting.phase, "retracting"); assert.ok(Math.abs(retracting.gangway - .5) < 1e-8);
  assert.equal(sampleTradeShipPreviewLeg("arriving", 1, berth).gangway, 1);
  assert.equal(sampleTradeShipPreviewLeg("departing", 1, berth).gangway, 0);
  assert.equal(tradeShipPreviewLegProgress(createTradeShipMotion(), "arriving"), 1);
});
