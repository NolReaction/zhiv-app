import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { Children, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog as DialogPrimitive } from "radix-ui";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(() => vite.close());
const { default: WorldPortal } = await vite.ssrLoadModule("/features/world/world-portal.tsx");
const { DialogPortal } = await vite.ssrLoadModule("/components/ui/dialog.tsx");
const { journeyFraction, journeyLeg } = await vite.ssrLoadModule("/features/world/journey-progress.tsx");

const { journeyTimeline, sceneJourney } = await vite.ssrLoadModule("/features/world/journey-timeline.ts");
const { fishingFrame, fishingPosition, FISHING_PATH, FISHING_BOBBER, FISHING_FOREGROUND } = await vite.ssrLoadModule("/features/world/fishing-journey.ts");
const { FOREST_MAP } = await vite.ssrLoadModule("/features/world/map-manifest.ts");
const { pointInPolygon } = await vite.ssrLoadModule("/features/world/map-layout.ts");
const { resourceCountAt } = await vite.ssrLoadModule("/features/world/world-balances.tsx");
const { CheckInReceipt } = await vite.ssrLoadModule("/features/check-in/check-in-receipt.tsx");

const { BOAT_WRECK } = await vite.ssrLoadModule("/features/world/boat-wreck.ts");

const { fishingTackle } = await vite.ssrLoadModule("/features/world/fishing-tackle.ts");

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
  const source = await readFile(new URL("../features/check-in/check-in-app.tsx", import.meta.url), "utf8");
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



test("fishing includes preparation, walking, fishing and return for all four durations", () => {
  const start = Date.parse("2026-09-10T12:00:00Z");
  for (const minutes of [5, 15, 30, 60]) {
    const duration = minutes * 60000;
    const trip = { id: "saved-trip", routeId: `fishing_${minutes}`, startedAt: new Date(start).toISOString(), finishesAt: new Date(start + duration).toISOString() };
    const at = elapsed => fishingFrame(trip, start + elapsed);
    assert.equal(at(10000).walking, false);
    assert.equal(at(30000).walking, true);
    assert.equal(at(44999).phase, "outbound");
    assert.equal(at(45000).phase, "fishing");
    assert.equal(at(duration - 45001).phase, "fishing");
    assert.equal(at(duration - 45000).phase, "returning");
    assert.equal(at(duration).phase, "home");
    for (const elapsed of [-1000, 0, 15000, 45000, duration - 45000, duration, duration + 60000]) {
      const frame = at(elapsed);
      assert.ok(frame.position >= 0 && frame.position <= 1);
      const restored = JSON.parse(JSON.stringify(trip));
      assert.deepEqual(fishingFrame(restored, start + elapsed), frame, "remounts use the same saved timestamps");
      const still = fishingFrame(restored, start + elapsed, true);
      assert.equal(still.x, frame.x); assert.equal(still.y, frame.y);
      assert.equal(still.frame, 0); assert.equal(still.bob, 0); assert.equal(still.catchProgress, 0); assert.equal(still.casting, false);
    }
    for (const edge of [15000, 45000, duration - 45000, duration]) {
      const before = at(edge - 1), after = at(edge);
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < .025, "phase changes never jump along the map");
    }
    assert.deepEqual({ x: at(duration).x, y: at(duration).y }, FOREST_MAP.clearing.spawn);
    assert.equal(journeyTimeline(trip, start + duration).remaining, 0);
  }
});

test("fishing route stays on land and casts beside the bank, clear of the wreck", () => {
  for (let step = 0; step <= 1000; step++) assert.equal(pointInPolygon(fishingPosition(step / 1000), FOREST_MAP.water.hitArea), false);
  assert.deepEqual(FISHING_PATH[0], FOREST_MAP.clearing.spawn);
  assert.equal(pointInPolygon(FISHING_BOBBER, FOREST_MAP.water.hitArea), true);
  const bank = FISHING_PATH.at(-1), boat = BOAT_WRECK.bounds;
  assert.ok(bank.x - 24 > boat.x + boat.width, "the character fits beside the boat");
  const done = { id: "done", routeId: "fishing_5", finishesAt: "2026-09-10T12:05:00Z" };
  const active = { id: "active", routeId: "fishing_60", finishesAt: "2026-09-10T13:00:00Z" };
  assert.equal(sceneJourney({ journeys: [done, active] }, Date.parse("2026-09-10T12:20:00Z")), active);
});

test("resource credit counts monotonically to the exact confirmed total", () => {
  for (const [from, target] of [[0, 1], [12, 36], [3, 50000]]) {
    const values = Array.from({ length: 101 }, (_, i) => resourceCountAt(from, target, i / 100));
    assert.equal(values[0], from); assert.equal(values.at(-1), target);
    values.forEach((value, i) => { assert.ok(Number.isInteger(value)); assert.ok(value <= target); if (i) assert.ok(value >= values[i - 1]); });
  }
  assert.equal(resourceCountAt(25, 7, 0), 7);
  assert.equal(resourceCountAt(25, 25, .5), 25);
});

test("ordinary tap syncing keeps the saved receipt calm and real errors remain visible", () => {
  const props = { lastCheckInAt: "2026-09-10T12:00:00Z", lastCheckInLabel: "Сегодня", timeZone: "UTC", isSending: false, unconfirmed: false, isOnline: true, onRetry() {} };
  const markup = status => renderToStaticMarkup(createElement(CheckInReceipt, { ...props, gameStatus: status }));
  for (const status of ["idle", "syncing"]) assert.match(markup(status), /data-state="saved"/);
  for (const status of ["error", "blocked"]) assert.match(markup(status), /data-state="pending"/);
  assert.doesNotMatch(markup("syncing"), /lucide-loader|animate-spin/);
});


test("the visible southeast passage never clips the character under the ground", () => {
  for (let step = 0; step <= 1000; step++) {
    const feet = fishingPosition(step / 1000);
    for (const x of [-8, 0, 8]) for (const y of [-34, -22, -8]) {
      assert.equal(FISHING_FOREGROUND.some(polygon => pointInPolygon({ x: feet.x + x, y: feet.y + y }, polygon)), false,
        `body remains visible at ${feet.x},${feet.y}`);
    }
  }
  assert.ok(FISHING_FOREGROUND.some(polygon => pointInPolygon({ x: 1020, y: 914 }, polygon)), "the actual foreground reeds retain their depth");
});

test("the rod stays in the leading hand and beside the face on both walking legs", () => {
  const start = Date.parse("2026-09-10T12:00:00Z");
  const journey = { id: "rod-test", routeId: "fishing_5", startedAt: new Date(start).toISOString(), finishesAt: new Date(start + 300000).toISOString() };
  for (const time of [16000, 16150, 16300, 16450, 45000, 45900, 46800, 72000, 110000, 260000, 260150, 260300, 260450]) {
    const state = fishingFrame(journey, start + time), rod = fishingTackle(state);
    assert.equal(rod.grip.x, state.x + rod.side * 12);
    assert.ok((rod.tip.x - rod.grip.x) * rod.side > 0, "carry tip never crosses the face toward the opposite shoulder");
    for (const [from, to] of [[rod.grip, rod.lower], [rod.lower, rod.upper], [rod.upper, rod.bend], [rod.bend, rod.tip]]) {
      for (let step = 0; step <= 30; step++) {
        const x = from.x + (to.x - from.x) * step / 30 - state.x;
        const y = from.y + (to.y - from.y) * step / 30 - state.y;
        assert.ok(!(Math.abs(x) < 13 && y > -39 && y < -22), "shaft cannot cover eyes or muzzle");
      }
    }
  }
  const first = fishingTackle(fishingFrame(journey, start + 60000, true));
  const later = fishingTackle(fishingFrame(journey, start + 120000, true));
  assert.deepEqual(first, later, "reduced motion keeps the waiting rod still");
});
