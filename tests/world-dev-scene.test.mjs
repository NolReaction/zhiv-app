import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { WorldDevSceneControls, worldDevSceneUnavailable } = await vite.ssrLoadModule("/features/world/dev/world-dev-scene.tsx");
const { WORLD_DEV_DEFAULTS } = await vite.ssrLoadModule("/features/world/dev/world-dev-store.ts");

function controls(patch = {}) {
  const calls = [], elements = [];
  const props = { state: { ...WORLD_DEV_DEFAULTS, reducedMotion: "off" },
    choice: { actor: "lopukh", scenario: "conversation", target: "leaftail" }, feedback: null, prefersReducedMotion: false,
    onChange: choice => calls.push(choice), onStart: () => calls.push("start"), onStop: () => calls.push("stop"), ...patch };
  const result = WorldDevSceneControls(props);
  const walk = child => { if (isValidElement(child)) { elements.push(child); Children.forEach(child.props.children, walk); } };
  walk(result);
  return { props, calls, elements, markup: renderToStaticMarkup(result) };
}

test("resident scene controls are explicit, compact and cannot launch commands during selection or inspection", () => {
  const view = controls();
  assert.deepEqual(view.calls, []); assert.match(view.markup, /копии мира/); assert.match(view.markup, /role="status" aria-live="polite"/);
  const selectors = view.elements.filter(element => element.type === "select");
  assert.equal(selectors.length, 3);
  assert.deepEqual(Children.toArray(selectors[0].props.children).map(option => option.props.value), ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg", "leaftail"]);
  assert.equal(Children.toArray(selectors[2].props.children).some(option => option.props.value === "lopukh"), false);
  selectors[0].props.onChange({ target: { value: "plesk" } }); selectors[1].props.onChange({ target: { value: "walk" } });
  assert.deepEqual(view.calls, [{ actor: "plesk" }, { scenario: "walk" }]);
  const run = view.elements.find(element => element.props["data-scene-run"] !== undefined);
  assert.equal(run.props.disabled, false); run.props.onClick(); assert.equal(view.calls.at(-1), "start");
  const stop = view.elements.find(element => element.props["data-scene-stop"] !== undefined);
  assert.equal(stop.props.disabled, true);
});

test("actor scenes expose only implemented actions and explain motion or wildlife constraints", () => {
  const plesk = controls({ choice: { actor: "plesk", scenario: "plesk-home", target: "leaftail" } });
  const selector = plesk.elements.filter(element => element.type === "select")[1];
  const ids = Children.toArray(selector.props.children).map(option => option.props.value);
  assert.ok(ids.includes("plesk-home")); assert.ok(!ids.includes("carry")); assert.ok(!ids.includes("watch-birds"));
  assert.equal(plesk.elements.filter(element => element.type === "select").length, 2);
  const rabbit = { actor: "lopukh", scenario: "walk", target: "leaftail" };
  assert.match(worldDevSceneUnavailable({ ...WORLD_DEV_DEFAULTS, paused: true }, rabbit, false), /Продолжить/);
  assert.match(worldDevSceneUnavailable(WORLD_DEV_DEFAULTS, rabbit, true), /Меньше движения/);
  assert.equal(worldDevSceneUnavailable({ ...WORLD_DEV_DEFAULTS, reducedMotion: "off" }, rabbit, true), null);
  assert.match(worldDevSceneUnavailable({ ...WORLD_DEV_DEFAULTS, butterflies: "off" }, { ...rabbit, scenario: "butterfly" }, false), /Бабочки выключены/);
  assert.match(worldDevSceneUnavailable({ ...WORLD_DEV_DEFAULTS, timeOfDay: "night" }, { ...rabbit, scenario: "watch-birds" }, false), /дневной свет/);
});

test("the active rehearsal retains stop access and shows the actual adapter result", () => {
  const request = { id: 2, actor: "kamneshmyg", scenario: "work" };
  const view = controls({ state: { ...WORLD_DEV_DEFAULTS, scenePreview: request },
    feedback: { id: 2, phase: "running", message: "Идёт ко входу пещеры" } });
  assert.match(view.markup, /Камнешмыг/); assert.match(view.markup, /Идёт ко входу пещеры/);
  const stop = view.elements.find(element => element.props["data-scene-stop"] !== undefined);
  assert.equal(stop.props.disabled, false); stop.props.onClick(); assert.deepEqual(view.calls, ["stop"]);
  const blocked = controls({ feedback: { id: 2, phase: "blocked", message: "Рядом нет сидящей птицы" } });
  assert.match(blocked.markup, /Не началась/); assert.match(blocked.markup, /Рядом нет сидящей птицы/);
  for (const phase of ["complete", "blocked"]) {
    const finished = controls({ state: { ...WORLD_DEV_DEFAULTS, scenePreview: request }, feedback: { id: request.id, phase, message: "Проверено" } });
    const returnButton = finished.elements.find(element => element.props["data-scene-stop"] !== undefined);
    assert.equal(returnButton.props.disabled, false, "an isolated terminal scene still needs an explicit way back to the account");
    returnButton.props.onClick(); assert.deepEqual(finished.calls, ["stop"]); assert.match(finished.markup, /Вернуться в мир/);
  }
});
