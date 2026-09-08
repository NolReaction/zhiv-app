import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { Children } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { default: WorldPortal } = await vite.ssrLoadModule("/features/world/world-portal.tsx");
const { DialogPortal } = await vite.ssrLoadModule("/components/ui/dialog.tsx");

test("the fullscreen forest mounts raw modal content without centered-dialog geometry", () => {
  const origin = { "--portal-x": "180px", "--portal-y": "350px", "--portal-radius": "150px" };
  const dialog = WorldPortal({ open: true, origin });
  const portal = Children.toArray(dialog.props.children).find(child => child.type === DialogPortal);
  assert.ok(portal, "fullscreen content must be portaled outside the app layout");
  const content = Children.toArray(portal.props.children).find(child => child.type === DialogPrimitive.Content);
  assert.ok(content, "do not reintroduce DialogContent: its translate utilities survive CSS optimization");
  assert.equal(content.props["data-slot"], "dialog-content");
  assert.equal(content.props.style, origin);
  assert.doesNotMatch(content.props.className, /translate-|top-\[50%\]|left-\[50%\]|animate-in|zoom-in/);
  assert.equal(typeof content.props.onOpenAutoFocus, "function");
  assert.equal(typeof content.props.onCloseAutoFocus, "function");
});

test("account-owned sibling dialogs have distinct keys and remount on account changes", async () => {
  const source = await readFile(new URL("../components/check-in-app.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("check-in-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const dialogs = new Set(["CheckInCalendar", "GameLeaderboardDialog", "WorldPortal"]);
  const expressions = new Map();
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && dialogs.has(node.tagName.getText(tree))) {
      const key = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.text === "key");
      assert.ok(key?.initializer && ts.isJsxExpression(key.initializer) && key.initializer.expression);
      expressions.set(node.tagName.getText(tree), key.initializer.expression.getText(tree));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(expressions.size, dialogs.size);
  const keysFor = publicId => [...expressions.values()].map(expression => vm.runInNewContext(expression, { me: { user: { publicId } } }));
  const first = keysFor("0CR4-WEMX-KEG1"), second = keysFor("ANOTHER-ACCOUNT");
  assert.equal(new Set(first).size, dialogs.size, "calendar and world must coexist without duplicate React keys");
  first.forEach((key, index) => assert.notEqual(key, second[index], "account changes must reset each modal"));
});
