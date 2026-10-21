import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  cacheDir: `/tmp/zhiv-earth-navigation-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { AppNavigation, appViews } = await vite.ssrLoadModule("/features/app/navigation.tsx");
const { APP_ONBOARDING_STEPS, observeAppOnboarding, startAppOnboarding } = await vite.ssrLoadModule("/features/app/onboarding/app-onboarding-model.ts");

function navigation(active, invitations = 0) {
  const calls = [], nodes = [];
  const tree = AppNavigation({ active, invitations, onSelect: view => calls.push(view) });
  function walk(child) {
    if (!isValidElement(child)) return;
    nodes.push(child);
    Children.forEach(child.props.children, walk);
  }
  walk(tree);
  return { calls, tree, nodes, buttons: nodes.filter(node => node.type === "button"), markup: renderToStaticMarkup(tree) };
}

test("the map is a fourth reachable main section between people and profile", () => {
  const view = navigation("earth");
  assert.deepEqual(appViews, ["check-in", "people", "earth", "profile"]);
  assert.deepEqual(view.buttons.map(button => button.props["data-app-onboarding"]), ["nav-check-in", "nav-people", "nav-earth", "nav-profile"]);
  assert.deepEqual(view.buttons.map(button => Children.toArray(button.props.children).at(-1).props.children), ["Я живой", "Люди", "Карта", "Профиль"]);
  assert.equal(view.tree.props["aria-label"], "Основные разделы");
  assert.match(view.markup, /lucide-(?:globe-2|earth)/);
  assert.deepEqual(view.calls, [], "rendering a map entry must not navigate or request geolocation");
});

test("each active section has exactly one current button and every click selects its actual section", () => {
  for (const active of appViews) {
    const view = navigation(active);
    const current = view.buttons.filter(button => button.props["aria-current"] === "page");
    assert.equal(current.length, 1);
    assert.equal(current[0].props["data-app-onboarding"], `nav-${active}`);
    assert.equal(view.tree.props["data-active-view"], active);
    for (const button of view.buttons) {
      assert.equal(button.props.type, "button");
      assert.equal(button.props.disabled, undefined);
      button.props.onClick();
    }
    assert.deepEqual(view.calls, appViews);
  }
});

test("friend invitation badges remain on people when the map is active", () => {
  const view = navigation("earth", 12);
  for (const button of view.buttons) {
    const html = renderToStaticMarkup(button);
    if (button.props["data-app-onboarding"] === "nav-people") assert.match(html, /<i>9<\/i>/);
    else assert.doesNotMatch(html, /<i>/);
  }
  assert.doesNotMatch(navigation("earth", 0).markup, /<i>/);
});

test("opening the map cannot complete an existing onboarding exercise", () => {
  assert.deepEqual(APP_ONBOARDING_STEPS, ["check-in", "calendar", "people", "profile", "world"]);
  const evidence = { activeView: "earth", lastCheckInAt: null, nextAllowedAt: null,
    nowMs: Date.parse("2026-10-18T12:00:00Z"), unconfirmed: false, isSending: false, calendarOpen: false, worldOpen: false };
  for (const stepId of APP_ONBOARDING_STEPS) {
    const progress = { ...startAppOnboarding(null), stepId };
    assert.equal(observeAppOnboarding(progress, evidence), progress);
  }
});
