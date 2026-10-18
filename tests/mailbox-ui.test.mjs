import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, cacheDir: `/tmp/zhiv-mailbox-ui-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { MailLetter, MailboxPanel } = await vite.ssrLoadModule("/features/mailbox/mailbox-dialog.tsx");
const { mailMessageSchema } = await vite.ssrLoadModule("/features/mailbox/model.ts");
const letter = patch => mailMessageSchema.parse({ id: "00000000-0000-4000-8000-000000000001", type: "balance_correction",
  title: "<img src=x onerror=alert(1)>", body: "<script>alert(1)</script>\n" + "long".repeat(100),
  createdAt: "2026-10-18T12:00:00Z", readAt: null, notify: false,
  attachments: { coins: -100, pearls: -2.5, gameItems: ["test"], achievements: ["test"] }, ...patch });
test("the real letter renders plaintext, signed applied corrections and every receipt category without a claim action", () => {
  const html = renderToStaticMarkup(createElement(MailLetter, { message: letter(), reading: false, readError: null, available: true, onRetry() {} }));
  assert.ok(html.includes("&lt;img")); assert.ok(html.includes("&lt;script&gt;")); assert.doesNotMatch(html, /<script|<img|dangerouslySetInnerHTML|Забрать/);
  assert.match(html, /-100 монет/); assert.match(html, /-2,5 жемчуга/); assert.doesNotMatch(html, /\+-/);
  assert.match(html, /Изменения уже применены/); assert.match(html, /игровые предметы/); assert.match(html, /достижения/);
});
test("an empty real mailbox presents an honest server-loading or empty state without fabricated admin letters", () => {
  const html = renderToStaticMarkup(createElement(MailboxPanel, { mailbox: { messages: [], selected: null, opened: true,
    available: true, loading: false, loadingMore: false, loaded: true, error: null, nextCursor: null } }));
  assert.match(html, /Пока тихо/); assert.doesNotMatch(html, /Уважаемый|Подарок от команды|Письмо команды/);
});
test("mail dialog keeps long text inside its scroll area and unread animation respects reduced motion", async () => {
  const [css, hud] = await Promise.all([readFile(new URL("../features/mailbox/mailbox.module.css", import.meta.url), "utf8"),
    readFile(new URL("../features/world/world-map-hud.module.css", import.meta.url), "utf8")]);
  assert.match(css, /\.letterBody[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere/s);
  assert.match(css, /max-height: min\(760px, calc\(100dvh - 32px\)\)/);
  assert.match(hud, /prefers-reduced-motion: reduce[^}]*data-mail-unread[^}]*animation: none/s);
});
