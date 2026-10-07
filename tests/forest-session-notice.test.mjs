import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { ForestSessionNotice, ForestSessionNoticeContent } = await vite.ssrLoadModule("/features/world/forest-session-notice.tsx");
const sync = { mode: "other-device", revision: 7, serverSavedAt: 1000, canTakeOver: true };
function inspect(props = {}) {
  const calls = [];
  const tree = ForestSessionNoticeContent({ sync, onTakeOver: () => calls.push("takeover"), ...props });
  const elements = [];
  function visit(element) {
    if (!isValidElement(element)) return;
    elements.push(element); Children.forEach(element.props.children, visit);
  }
  visit(tree);
  return { tree, elements, calls };
}
const continueButton = view => view.elements.find(element => element.type === "button" && Children.toArray(element.props.children).includes("Продолжить здесь"));

test("only a confirmed competing writer opens the pause notice", () => {
  assert.equal(inspect().tree.props.open, true);
  for (const mode of ["loading", "synced", "saving", "offline", "error", "disabled"]) {
    const view = inspect({ sync: { ...sync, mode, canTakeOver: false } });
    assert.equal(view.tree.props.open, false, mode);
    assert.equal(continueButton(view).props.disabled, true);
    continueButton(view).props.onClick(); assert.deepEqual(view.calls, []);
  }
  assert.equal(inspect({ sync: undefined }).tree.props.open, false);
});

test("continuing explicitly requests takeover without silently doing it while rendering", () => {
  const view = inspect();
  assert.deepEqual(view.calls, []);
  assert.equal(continueButton(view).props.disabled, false);
  continueButton(view).props.onClick(); assert.deepEqual(view.calls, ["takeover"]);
  const unavailable = inspect({ sync: { ...sync, canTakeOver: false } });
  continueButton(unavailable).props.onClick(); assert.deepEqual(unavailable.calls, []);
  assert.equal(inspect({ sync: { ...sync, mode: "synced", canTakeOver: false } }).tree.props.open, false);
});

test("keyboard and outside clicks keep the reason visible while leaving the map is explicit", () => {
  let prevented = 0, exited = 0;
  const view = inspect({ onExit: () => exited++ });
  const content = view.elements.find(element => element.props["data-forest-session-notice"] === true);
  content.props.onEscapeKeyDown({ preventDefault: () => prevented++ });
  content.props.onInteractOutside({ preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  view.elements.find(element => element.type === "button" && element.props.children === "На главный экран").props.onClick();
  assert.equal(exited, 1); assert.deepEqual(view.calls, []);
});

test("account switches remount the notice and its saved focus target", () => {
  const first = ForestSessionNotice({ presenceKey: "zhiv:mochlik:presence:first" });
  const second = ForestSessionNotice({ presenceKey: "zhiv:mochlik:presence:second" });
  assert.notEqual(first.key, second.key);
  assert.equal(second.props.presenceKey, "zhiv:mochlik:presence:second");
});
