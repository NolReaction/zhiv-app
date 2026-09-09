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
const { houseAtlasCell, HOUSE_ART, HOUSE_LAMP } = await vite.ssrLoadModule("/lib/mochlik/house-details.ts");
const { journeyFraction, journeyLeg } = await vite.ssrLoadModule("/features/world/journey-progress.tsx");

test("five complete house frames retain one doorway and lantern coordinate system", () => {
  const cells = Array.from({ length: 5 }, (_, index) => houseAtlasCell(index + 1));
  assert.equal(new Set(cells.map(cell => `${cell.x}:${cell.y}`)).size, 5);
  for (const cell of cells) {
    assert.ok(cell.x + cell.width <= 1536 && cell.y + cell.height <= 1024);
    assert.equal(cell.width, 512); assert.equal(cell.height, 512);
  }
  for (const point of [{ x: 181, y: 104 }, HOUSE_LAMP]) {
    assert.ok(point.x > HOUSE_ART.x && point.x < HOUSE_ART.x + HOUSE_ART.width);
    assert.ok(point.y > HOUSE_ART.y && point.y < HOUSE_ART.y + HOUSE_ART.height);
  }
});

test("travel progress derives from absolute journey time and remains bounded after return", () => {
  const start = Date.parse("2026-09-08T12:00:00Z"), journey = { startedAt: new Date(start).toISOString(), finishesAt: new Date(start + 60000).toISOString() };
  assert.equal(journeyFraction(journey, start - 10000), 0);
  assert.equal(journeyFraction(journey, start + 30000), .5);
  assert.equal(journeyFraction(journey, start + 60000), 1);
  assert.equal(journeyFraction(journey, start + 86400000), 1);
});

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

test("journey spends half its time walking to the destination and half returning", () => {
  const start = Date.parse("2026-09-08T12:00:00Z");
  const journey = { startedAt: new Date(start).toISOString(), finishesAt: new Date(start + 60000).toISOString() };
  const at = seconds => journeyLeg(journey, start + seconds * 1000);
  assert.deepEqual(at(0), { progress: 0, returning: false, position: 0 });
  assert.equal(at(15).position, .5); assert.equal(at(15).returning, false);
  assert.equal(at(30).position, 1); assert.equal(at(30).returning, true);
  assert.equal(at(45).position, .5); assert.equal(at(45).returning, true);
  assert.equal(at(60).position, 0); assert.equal(at(120).position, 0);
});
