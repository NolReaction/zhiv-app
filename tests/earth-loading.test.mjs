import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { EarthLoading, formatEarthLoadingBytes } = await vite.ssrLoadModule("/features/earth/earth-loading.tsx");
const defaults = { stage: "resources", isOnline: true, storageStatus: "device" };
const render = props => renderToStaticMarkup(createElement(EarthLoading, { ...defaults, ...props }));

test("Earth preparation uses actual counts without inventing a total or percentage", () => {
  const html = render({ progress: { completed: 12, pending: 3, bytes: 2_621_440, cacheHits: 8 } });
  assert.match(html, /Готовим карту/);
  assert.match(html, /Готово <strong>12<\/strong>/);
  assert.match(html, /В работе <strong>3<\/strong>/);
  assert.match(html, /Получено 2,5 МБ/);
  assert.match(html, /Из сохранённого: 8/);
  assert.match(html, /aria-current="step"/);
  assert.doesNotMatch(html, /aria-valuenow|%|из 15|progressbar/);
  assert.doesNotMatch(render({}), /Готово <strong>|Получено 0/);
});

test("Earth reopening and storage claims reflect actual storage availability", () => {
  assert.match(render({ restoring: true }), /Открываем сохранённую карту/);
  assert.match(render({}), /Загруженные участки сохраняются на устройстве/);
  assert.match(render({}), /Браузер может освободить это место/);
  assert.match(render({ persistentGranted: true }), /Карта закреплена. Очистка данных браузера удалит её/);
  const unavailable = render({ storageStatus: "session", onPersist() {} });
  assert.match(unavailable, /Память устройства недоступна/);
  assert.doesNotMatch(unavailable, /Загруженные участки сохраняются|Закрепить на устройстве/);
  assert.match(render({ storageStatus: "checking" }), /Проверяем сохранённые данные/);
  assert.doesNotMatch(render({ persistentGranted: true, onPersist() {} }), /Закрепить на устройстве/);
});

test("Earth interrupted startup keeps received work visible and offers retry", () => {
  const calls = [];
  const props = { ...defaults, error: "Не загрузился участок <script>", progress: { completed: 4, pending: 0, failed: 1, bytes: 1_024, cacheHits: 2 },
    onRetry: () => calls.push("retry"), onPersist: () => calls.push("persist") };
  const html = render(props);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-busy="false"/);
  assert.match(html, /Не загрузился участок &lt;script&gt;/);
  assert.match(html, /Готово <strong>4/);
  assert.match(html, /Не загружено <strong>1/);
  assert.match(html, /Продолжить загрузку/);
  const buttons = [];
  function walk(node) {
    if (!isValidElement(node)) return;
    if (node.type === "button") buttons.push(node);
    Children.forEach(node.props.children, walk);
  }
  walk(EarthLoading(props));
  buttons.forEach(button => button.props.onClick());
  assert.deepEqual(calls, ["retry", "persist"]);
  const offline = render({ ...props, isOnline: false, error: null });
  assert.match(offline, /Подключитесь к интернету/);
  assert.match(offline, /aria-busy="true"/);
  const offlineSaved = render({ ...props, isOnline: false, restoring: true });
  assert.match(offlineSaved, /Открыть сохранённое/);
  assert.doesNotMatch(offlineSaved, /disabled=""/);
  assert.match(render({ isOnline: false, restoring: true }), /Читаем сохранённые данные/);
});

test("Earth byte labels remain finite and use measured size", () => {
  assert.equal(formatEarthLoadingBytes(-1), "0 Б");
  assert.equal(formatEarthLoadingBytes(Number.NaN), "0 Б");
  assert.equal(formatEarthLoadingBytes(Number.POSITIVE_INFINITY), "0 Б");
  assert.equal(formatEarthLoadingBytes(1_536), "1,5 КБ");
  assert.equal(formatEarthLoadingBytes(1_048_576), "1 МБ");
});
