import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const { TransientNotice, notify } = await vite.ssrLoadModule("/components/app-notifications.tsx");
after(() => vite.close());

test("transient errors create no element in a page grid or form during render", () => {
  const html = renderToStaticMarkup(React.createElement(TransientNotice, { message: "Не удалось сохранить", kind: "error" }));
  assert.equal(html, "");
});

test("repeated copy feedback creates a new notice even when its text has not changed", () => {
  const first = notify("ID скопирован", "success");
  const second = notify("ID скопирован", "success");
  assert.notEqual(first, second);
});
