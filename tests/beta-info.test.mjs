import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { BetaInfo, ReleaseNotesList, unreadReleaseLabel } = await vite.ssrLoadModule("/features/check-in/beta-info.tsx");
const releases = [
  { id: "new", version: "0.6.4", date: "2026-09-24", title: "Новые возможности", changes: ["Первое улучшение", "Второе улучшение"] },
  { id: "old", version: "0.6.3", date: "2026-09-23", title: "Живой лес", changes: ["Предыдущее улучшение"] },
];

test("release headers expose unread state and only the selected entry is expanded", () => {
  const markup = renderToStaticMarkup(createElement(ReleaseNotesList, { releases, unreadIds: ["old"], expandedId: "new", onToggle() {} }));
  assert.match(markup, /aria-label="История обновлений" tabindex="0"/);
  assert.equal((markup.match(/aria-expanded="true"/g) ?? []).length, 1);
  assert.equal((markup.match(/aria-expanded="false"/g) ?? []).length, 1);
  assert.equal((markup.match(/role="region"/g) ?? []).length, 1);
  const controlled = /aria-controls="([^"]+)"/.exec(markup)?.[1];
  assert.ok(controlled && markup.includes(`id="${controlled}" role="region"`));
  assert.match(markup, /<time dateTime="2026-09-24">24 сентября 2026/);
  assert.match(markup, /Первое улучшение/);
  assert.doesNotMatch(markup, /Предыдущее улучшение/);
  assert.equal((markup.match(/>Новое</g) ?? []).length, 1);
  const collapsed = renderToStaticMarkup(createElement(ReleaseNotesList, { releases, unreadIds: [], expandedId: null, onToggle() {} }));
  assert.doesNotMatch(collapsed, /role="region"|aria-expanded="true"|>Новое</);
});

test("release notification labels keep the exact unread count with Russian endings", () => {
  assert.equal(unreadReleaseLabel(0), "Beta-тест и обновления");
  for (const count of [1, 21, 101]) assert.equal(unreadReleaseLabel(count), `Beta-тест и обновления: ${count} непрочитанное обновление`);
  for (const count of [2, 4, 22, 104]) assert.equal(unreadReleaseLabel(count), `Beta-тест и обновления: ${count} непрочитанных обновления`);
  for (const count of [5, 11, 12, 14, 111, 114]) assert.equal(unreadReleaseLabel(count), `Beta-тест и обновления: ${count} непрочитанных обновлений`);
  assert.notEqual(BetaInfo({ ownerPublicId: "first" }).key, BetaInfo({ ownerPublicId: "second" }).key, "changing account resets the open dialog and its selection");
});

test("opening news reads one entry, expanding another reads it, closing never reads the whole feed", async () => {
  const source = await readFile(new URL("../features/check-in/beta-info.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("beta-info.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handlers = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && ["changeOpen", "toggleRelease"].includes(node.name?.text)) handlers.push(node.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(handlers.length, 2);
  const readIds = [];
  const state = {
    releases, expandedId: null, open: false, checks: 0,
    setOpen(open) { state.open = open; },
    setExpandedId(id) { state.expandedId = id; },
    markRead(id) { readIds.push(id); },
    refresh() { state.checks++; },
  };
  const code = ts.transpileModule(handlers.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { changeOpen, toggleRelease } = vm.runInNewContext(`${code}\n({changeOpen, toggleRelease})`, state);
  changeOpen(true);
  assert.equal(state.open, true);
  assert.equal(state.expandedId, "new");
  assert.deepEqual(readIds, ["new"]);
  assert.equal(state.checks, 1);
  toggleRelease("new");
  assert.equal(state.expandedId, null);
  assert.deepEqual(readIds, ["new"], "collapsing does not consume another notification");
  toggleRelease("old");
  assert.equal(state.expandedId, "old");
  assert.deepEqual(readIds, ["new", "old"]);
  state.releases = [{ ...releases[0], id: "incoming" }, ...releases];
  changeOpen(false);
  assert.deepEqual(readIds, ["new", "old"], "a newly arrived entry stays unread when the dialog closes");
  changeOpen(true);
  assert.equal(state.expandedId, "incoming");
  assert.deepEqual(readIds, ["new", "old", "incoming"]);
});
