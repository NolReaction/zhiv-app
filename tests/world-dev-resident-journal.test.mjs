import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldDevResidentJournal } = await vite.ssrLoadModule("/features/world/dev/world-dev-resident-journal.tsx");
const { EMPTY_RESIDENT_JOURNAL } = await vite.ssrLoadModule("/features/world/dev/resident-incident-journal.ts");
const { downloadResidentIncidentReport } = await vite.ssrLoadModule("/features/world/dev/resident-incident-download.ts");
function controls(patch = {}) {
  const calls = [], elements = [];
  const props = { journal: EMPTY_RESIDENT_JOURNAL, actor: "lopukh", available: false, notice: "", manualJSON: null,
    onRecord: value => calls.push(["record", value]), onClear: () => calls.push("clear"), onDownload: () => calls.push("download"), onCopy: () => calls.push("copy"), ...patch };
  const element = WorldDevResidentJournal(props);
  const visit = child => { if (isValidElement(child)) { elements.push(child); Children.forEach(child.props.children, visit); } }; visit(element);
  return { calls, elements, html: renderToStaticMarkup(element) };
}
test("journal rendering never starts recording or transfers a file; all actions are explicit and unavailable exports are disabled", () => {
  const view = controls(); assert.deepEqual(view.calls, []); assert.match(view.html, /60 активных секунд/); assert.match(view.html, /120 событий/);
  const record = view.elements.find(item => item.props["data-journal-record"] !== undefined);
  assert.equal(record.props["aria-pressed"], false); record.props.onClick(); assert.deepEqual(view.calls, [["record", true]]);
  for (const flag of ["data-journal-download", "data-journal-copy", "data-journal-clear"]) assert.equal(view.elements.find(item => item.props[flag] !== undefined).props.disabled, true);
  const active = controls({ journal: { ...EMPTY_RESIDENT_JOURNAL, recording: true }, available: true });
  active.elements.find(item => item.props["data-journal-record"] !== undefined).props.onClick();
  active.elements.find(item => item.props["data-journal-download"] !== undefined).props.onClick();
  active.elements.find(item => item.props["data-journal-copy"] !== undefined).props.onClick();
  assert.deepEqual(active.calls, [["record", false], "download", "copy"]);
});
test("the visible chronological tail belongs to the selected resident and inferred cancellation is labelled as uncertain", () => {
  const events = Array.from({ length: 18 }, (_, index) => ({ id: index + 1, at: index, actor: "lopukh", kind: index === 17 ? "interruption" : "change", inferred: index === 17,
    changes: [{ field: "target", before: `old-${index}`, after: `place-${index}` }] }));
  events.push({ id: 19, at: 18, actor: "plesk", kind: "change", inferred: false, changes: [{ field: "target", before: null, after: "other-resident-private-marker" }] });
  const view = controls({ available: true, journal: { ...EMPTY_RESIDENT_JOURNAL, capture: 2, elapsed: 18, source: "rehearsal", events } });
  assert.equal(view.elements.filter(item => item.type === "li").length, 12);
  assert.ok(!view.html.includes("place-0")); assert.ok(view.html.includes("place-17")); assert.ok(!view.html.includes("other-resident-private-marker"));
  assert.match(view.html, /Возможное прерывание/); assert.match(view.html, /точная причина не подтверждена/); assert.match(view.html, /копия мира/);
});
test("manual-copy fallback remains selectable without executing HTML or an automatic clipboard action", () => {
  const json = '{"example":"<script>alert(1)</script>"}', view = controls({ available: true, manualJSON: json, notice: "Скопируйте вручную" });
  const textarea = view.elements.find(item => item.type === "textarea"); assert.equal(textarea.props.readOnly, true); assert.equal(textarea.props.value, json);
  let selected = 0; textarea.props.onFocus({ currentTarget: { select() { selected++; } } }); assert.equal(selected, 1);
  assert.deepEqual(view.calls, []); assert.ok(!view.html.includes("<script>")); assert.match(view.html, /JSON для ручного копирования/);
});
test("local JSON downloads remove links and release object URLs on success and failure", () => {
  for (const fail of [false, true]) {
    const calls = [], cleanup = [], link = { href: "", download: "", click() { calls.push("click"); if (fail) throw new Error("blocked"); }, remove() { calls.push("remove"); } };
    const host = { blob: value => { calls.push(["blob", value]); return {}; }, createUrl: () => "blob:local-only", revokeUrl: value => calls.push(["revoke", value]),
      link: () => link, attach: value => { assert.equal(value, link); calls.push("attach"); }, later: callback => cleanup.push(callback) };
    const result = downloadResidentIncidentReport({ filename: "zhiv-residents-capture-1.json", json: "{}" }, host);
    assert.equal(result, !fail); assert.equal(link.download, "zhiv-residents-capture-1.json"); assert.ok(calls.includes("remove")); assert.equal(cleanup.length, 1);
    assert.ok(!calls.some(call => Array.isArray(call) && call[0] === "revoke")); cleanup[0](); assert.deepEqual(calls.at(-1), ["revoke", "blob:local-only"]);
  }
  assert.equal(downloadResidentIncidentReport({ filename: "../../private-account.json", json: "{}" }, { blob() { assert.fail("invalid filename must not reach the host"); } }), false);
});
