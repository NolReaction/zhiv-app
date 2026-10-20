import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthSharingPanel, sharingSummary } = await vite.ssrLoadModule("/features/earth/earth-sharing-panel.tsx");
const settings = { ownerPublicId: "0000-0000-0001", mode: "OFF", revision: 0, precision: "APPROXIMATE", recipientCircleIds: [],
  sharingUntil: null, publicationEpoch: null, serverTime: "2026-10-18T20:00:00Z" };
const calls = [];
const sharing = { settings, pendingGhost: false, publishing: false, saving: false, loading: false, error: null,
  refresh: () => calls.push("refresh") };
const people = { people: [{ circleId: "friend-one", user: { publicId: "0000-0000-0002", displayName: "<script>Лена</script>" } }] };
const props = { sharing, people, peopleLoading: false, online: true, onShare: () => calls.push("share"), onGhost: () => calls.push("ghost"), onOff() {} };

test("location consent defaults to no recipients, approximate precision and one hour; rendering starts nothing", () => {
  const html = renderToStaticMarkup(createElement(EarthSharingPanel, props));
  assert.match(html, /Только я/);
  assert.match(html, /<input(?=[^>]*value="APPROXIMATE")(?=[^>]*checked)[^>]*>/);
  assert.match(html, /value="60" selected/);
  assert.match(html, /type="submit" disabled/);
  assert.match(html, /&lt;script&gt;Лена&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.deepEqual(calls, []);
});

test("saved access does not claim an active GPS or silently resume publication", () => {
  const value = { ...sharing, settings: { ...settings, mode: "SHARING", revision: 1, recipientCircleIds: ["friend-one"] } };
  const html = renderToStaticMarkup(createElement(EarthSharingPanel, { ...props, sharing: value }));
  assert.match(html, /Обновление на паузе/);
  assert.match(html, /Для возобновления подтвердите настройки/);
  assert.deepEqual(calls, []);
});

test("offline ghost preserves the last point and does not promise an acknowledged server freeze", () => {
  const value = { ...sharing, pendingGhost: true, pendingPrivacyMode: "GHOST", settings: { ...settings, mode: "GHOST" } };
  const html = renderToStaticMarkup(createElement(EarthSharingPanel, { ...props, sharing: value, online: false }));
  const ghostButton = html.match(/<button[^>]*>[^<]*(?:<svg[\s\S]*?<\/svg>)?Включить режим призрака<\/button>/)?.[0];
  assert.ok(ghostButton);
  assert.doesNotMatch(ghostButton, /disabled/);
  assert.match(html, /на сервере ещё не подтверждён/);
  assert.match(html, /максимум на 24 часа/);
  assert.match(html, /Без уведомлений и статуса призрака/);
  assert.match(html, /время её обновления/);
  assert.equal(sharingSummary(value), "Останавливаем передачу…");
});

test("offline OFF distinguishes unconfirmed deletion from freezing a marker", () => {
  const value = { ...sharing, pendingGhost: true, pendingPrivacyMode: "OFF", settings: { ...settings, mode: "OFF" } };
  const html = renderToStaticMarkup(createElement(EarthSharingPanel, { ...props, sharing: value, online: false }));
  assert.match(html, /Удаление точки и доступа на сервере ещё не подтверждено/);
  assert.match(html, /до 24 часов после обновления/);
  assert.doesNotMatch(html, /Режим призрака на сервере ещё не подтверждён/);
});
