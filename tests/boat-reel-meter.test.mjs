import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "reel-meter-controller-probe", enforce: "pre", transform(source, id) {
    if (id.endsWith("/features/economy/ui/boat/use-boat-reel-controller.ts")) return "export function useBoatReelController(){return globalThis.__reelMeterController}";
  } }],
});
after(() => { delete globalThis.__reelMeterController; return vite.close(); });
const { BoatReelMeter, boatReelMeterGeometry } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-meter.tsx");
const { BoatReelGame } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-reel-game.tsx");
const at = Date.parse("2026-11-04T09:00:00Z");
const challenge = { id: "meter-challenge", rulesVersion: 3, resistance: "surging", fishRarity: "legendary", seed: 17,
  tickMs: 50, maxTicks: 600, zoneWidth: 3200, difficulty: 3, biteAt: new Date(at).toISOString(),
  startedAt: new Date(at - 6000).toISOString(), expiresAt: new Date(at + 114000).toISOString() };
function renderGame(overrides = {}, props = {}) {
  globalThis.__reelMeterController = {
    challenge, reel: { tick: 40, bar: 5000, fish: 5200, progress: 4600, velocity: 160, status: "active" },
    playing: true, held: true, ready: true, expired: false, waitingForConfirmation: false, status: "Рыба на крючке",
    castStage: "bite", holdButton: { current: null },
    togglePlay() { assert.fail("Rendering must not start input"); }, changeHeld() { assert.fail("Rendering must not hold input"); },
    submit() { assert.fail("Rendering must not submit a catch"); }, ...overrides,
  };
  return renderToStaticMarkup(createElement(BoatReelGame, { owner: "owner", voyageId: "voyage", challenge, now: at,
    disabled: false, onSubmit() { assert.fail("Rendering must not submit"); }, ...props }));
}

test("vertical meter clips the same catchable interval as domain membership at both limits", () => {
  for (const bar of [0, 800, 1600, 5000, 8400, 9600, 10000]) for (const fish of [0, 1000, 1600, 5000, 8400, 9000, 10000]) {
    const geometry = boatReelMeterGeometry({ bar, fish, zoneWidth: 3200 });
    assert.equal(geometry.inZone, Math.abs(fish - bar) <= 1600);
    const top = Math.max(0, geometry.centerTop - geometry.height / 2), bottom = Math.min(100, geometry.centerTop + geometry.height / 2);
    const paintedMembership = geometry.targetTop >= top && geometry.targetTop <= bottom;
    assert.equal(paintedMembership, geometry.inZone, `bar=${bar},fish=${fish}`);
    assert.ok(top >= 0 && bottom <= 100);
  }
  assert.deepEqual(boatReelMeterGeometry({ bar: 5000, fish: 6000, zoneWidth: 3200 }),
    { bar: 5000, fish: 6000, centerTop: 50, height: 32, targetTop: 40, inZone: true });
});

test("invalid presentation numbers stay bounded without shifting valid target or introducing NaN", () => {
  const geometry = boatReelMeterGeometry({ bar: NaN, fish: Infinity, zoneWidth: -300 });
  assert.ok(Object.values(geometry).every(value => typeof value !== "number" || Number.isFinite(value)));
  const html = renderToStaticMarkup(createElement(BoatReelMeter, { reel: { bar: -200, fish: 12000, zoneWidth: 3200 }, held: false }));
  assert.match(html, /data-reel-zone/); assert.match(html, /data-reel-target/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("anonymous meter renders exact separate target and zone coordinates and no catch identity", () => {
  const html = renderToStaticMarkup(createElement(BoatReelMeter, { reel: { bar: 4000, fish: 7000, zoneWidth: 3200,
    fishId: "fish_mooncarp", fishRarity: "legendary", weightGrams: 2400, seed: 12345 }, held: true }));
  assert.match(html, /data-boat-reel-meter/); assert.match(html, /data-in-zone="false"/);
  assert.match(html, /data-reel-zone="true" style="transform:translateY\(60%\)"/);
  assert.match(html, /data-reel-target="true" style="transform:translateY\(30%\)"/);
  assert.match(html, /Рыба вне зоны/);
  assert.doesNotMatch(html, /mooncarp|legendary|2400|12345|<img|fishRarity|weightGrams/);
});

test("active reel uses the dedicated anonymous meter and truthful progress without rarity or profile headings", () => {
  const html = renderGame();
  assert.match(html, /Рыба на крючке/); assert.match(html, /data-boat-reel-meter/);
  assert.match(html, /<progress[^>]+value="4600"/); assert.match(html, /data-fishing-action="hold"[^>]+aria-pressed="true"/);
  assert.match(html, /data-fishing-action="pause"/); assert.match(html, /Готовится к рывку|Рывок/);
  assert.doesNotMatch(html, /Легендар|Рыба делает рывки|Ровная тяга|fishRarity|legendary|mooncarp/);
});

test("cast and soaking wait for the real bite before showing the meter or strike controls", () => {
  for (const castStage of ["casting", "soaking"]) {
    const html = renderGame({ playing: false, held: false, castStage, reel: { tick: 0, bar: 5000, fish: 5000, progress: 2500, velocity: 0, status: "active" } });
    assert.doesNotMatch(html, /data-boat-reel-meter|data-fishing-action="hold"|data-fishing-action="play"/);
    assert.match(html, /Поплавок летит|Снасть в воде/);
  }
});

test("paused and suspended reels preserve the exact meter while disabling input until resumed", () => {
  const paused = renderGame({ playing: false, paused: true, held: false });
  assert.match(paused, /data-paused="true"/); assert.match(paused, /data-fishing-action="play"/); assert.match(paused, /Продолжить/);
  assert.match(paused, /Держите метку рыбы в зелёной зоне/);
  const suspended = renderGame({}, { suspended: true });
  assert.match(suspended, /data-fishing-action="hold"[^>]+disabled=""/);
  assert.match(suspended, /data-fishing-action="pause"[^>]+disabled=""/);
});

test("a local success remains anonymous until the server confirms it, and expiry removes the meter", () => {
  const caught = renderGame({ playing: false, held: false, status: "Рыба у борта!", reel: { tick: 250, bar: 5000, fish: 5000, progress: 10000, velocity: 0, status: "caught" } });
  assert.match(caught, /data-boat-reel-meter/); assert.match(caught, /поднимает рыбу на борт/); assert.doesNotMatch(caught, /data-fishing-action="submit"/);
  assert.doesNotMatch(caught, /fish_mooncarp|Легендарная|Улов подтверждён/);
  const pending = renderGame({ playing: false, waitingForConfirmation: true, status: "Проверяем результат" });
  assert.match(pending, /Рыба появится на борту после подтверждения/); assert.doesNotMatch(pending, /data-fishing-action="submit"/);
  const expired = renderGame({ playing: false, expired: true, status: "Рыба ушла" });
  assert.doesNotMatch(expired, /data-boat-reel-meter|data-fishing-action="hold"|data-fishing-action="submit"/);
});
