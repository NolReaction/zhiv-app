import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldDevEntry } = await vite.ssrLoadModule("/features/world/dev/world-dev-entry.tsx");

function entry(loadPanel, props = {}) {
  const view = new WorldDevEntry({ world: {}, loadPanel, ...props });
  const updates = [];
  view.setState = patch => {
    const next = typeof patch === "function" ? patch(view.state, view.props) : patch;
    updates.push(next); view.state = { ...view.state, ...next };
  };
  view.componentDidMount();
  return { view, updates };
}

function elements(node) {
  if (!isValidElement(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}

test("entering either game view shows a DEV launcher without importing cheats or diagnostics", () => {
  let imports = 0;
  for (const worldView of [false, true]) {
    const { view } = entry(() => { imports++; throw new Error("must load only on click"); }, { worldView });
    assert.match(renderToStaticMarkup(view.render()), /Панель разработчика/);
    assert.doesNotMatch(renderToStaticMarkup(view.render()), /Мастерская DEV|Читы хозяйства/);
    assert.equal(view.state.Panel, null);
    view.props = { ...view.props, active: false };
    assert.equal(view.render(), null);
  }
  assert.equal(imports, 0);
});

test("one click loads and opens DEV with current props; repeated clicks cannot duplicate a pending import", async () => {
  let finish, imports = 0;
  const props = { world: { id: "current" }, economy: { id: "current" }, presenceKey: "player", worldView: true };
  const { view } = entry(() => { imports++; return new Promise(resolve => { finish = resolve; }); }, props);
  const first = view.open();
  assert.equal(view.state.pending, true);
  assert.equal(elements(view.render()).find(node => node.type === "button").props.disabled, true);
  await view.open(); assert.equal(imports, 1);
  const Panel = () => createElement("div", null, "loaded");
  finish({ default: Panel }); await first;
  const rendered = view.render();
  assert.equal(rendered.type, Panel);
  assert.equal(rendered.props.initiallyOpen, true);
  assert.equal(rendered.props.world, props.world);
  assert.equal(rendered.props.economy, props.economy);
  assert.equal(rendered.props.presenceKey, "player");
  view.props = { ...view.props, active: false };
  assert.equal(view.render().type, Panel, "hide via the child's active prop without unmounting its tab/scroll state");
  assert.equal(view.render().props.active, false);
  view.props = { ...view.props, active: true }; assert.equal(view.render().type, Panel);
  assert.equal(imports, 1, "view changes do not reimport or reset loaded diagnostics");
});

test("a rejected module factory stays inside DEV, without rethrowing, reloading or repeatedly importing", async () => {
  const failure = new Error("Module economy/model factory is not available");
  let imports = 0;
  const { view } = entry(async () => { imports++; throw failure; });
  const reports = [];
  view.componentDidCatch = error => reports.push(error);
  await assert.doesNotReject(view.open());
  assert.equal(view.state.failed, true); assert.equal(view.state.pending, false);
  assert.equal(view.state.Panel, null); assert.deepEqual(reports, [failure]);
  assert.match(renderToStaticMarkup(view.render()), /DEV не загрузился|role="alert"/);
  const close = elements(view.render()).find(node => node.props["aria-label"] === "Закрыть сообщение DEV");
  close.props.onClick();
  assert.doesNotMatch(renderToStaticMarkup(view.render()), /role="alert"/);
  await view.open();
  assert.match(renderToStaticMarkup(view.render()), /role="alert"/);
  assert.equal(imports, 1, "a rejected module is not retried in a loop");
});

test("late import completion or failure after logout cannot update an unmounted gate", async () => {
  for (const fails of [false, true]) {
    let finish;
    const { view, updates } = entry(() => new Promise((resolve, reject) => { finish = fails ? reject : resolve; }));
    const pending = view.open(); view.componentWillUnmount();
    const count = updates.length;
    finish(fails ? new Error("stale import") : { default: () => null });
    await pending;
    assert.equal(updates.length, count);
  }
});
