import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { dataFreshnessMessage } = await vite.ssrLoadModule("/lib/data-freshness.ts");
const { DataFreshness } = await vite.ssrLoadModule("/components/data-freshness.tsx");
const { ApiError } = await vite.ssrLoadModule("/lib/check-in-api.ts");
after(() => vite.close());

const nowMs = Date.parse("2026-09-07T12:00:00Z");
const snapshot = { updatedAt: nowMs - 20_000, nowMs, isOnline: true, failed: false, loading: false };

test("failed refresh retains the snapshot time and never reports it as fresh", () => {
  assert.match(dataFreshnessMessage({ ...snapshot, failed: true }), /Не удалось обновить · данные от/);
  assert.match(dataFreshnessMessage({ ...snapshot, isOnline: false }), /Нет интернета · данные от/);
  assert.equal(dataFreshnessMessage({ ...snapshot, updatedAt: null, failed: true }), "Не удалось загрузить данные");
});

test("stale snapshots prompt refresh even if no error was received", () => {
  assert.equal(dataFreshnessMessage(snapshot), "Обновлено только что");
  assert.equal(dataFreshnessMessage({ ...snapshot, updatedAt: nowMs - 60_000 }), "Обновлено минуту назад");
  assert.match(dataFreshnessMessage({ ...snapshot, updatedAt: nowMs - 120_000 }), /обновите список/);
});

test("refresh status stays visible with a disabled action while offline", () => {
  const html = renderToStaticMarkup(React.createElement(DataFreshness, { ...snapshot, isOnline: false, onRefresh: async () => {} }));
  assert.match(html, /role="status"/);
  assert.match(html, /Нет интернета/);
  assert.match(html, /button[^>]*disabled=""/);
});

test("backend correlation is displayed only for server failures and a valid ID", () => {
  const id = "e24e38a3-125d-40b7-b244-f5a6b0732489";
  assert.match(new ApiError("Сбой", 500, undefined, id).message, new RegExp(id));
  assert.equal(new ApiError("Неверный код", 400, undefined, id).message, "Неверный код");
  assert.equal(new ApiError("Сбой", 500, undefined, "unsafe\nvalue").requestId, undefined);
});
