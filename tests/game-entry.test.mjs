import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { Children, createElement, isValidElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const compile = async filename => ts.transpileModule(await readFile(new URL(filename, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const [entryCode, gateCode] = await Promise.all([
  compile("../features/app/game-entry.tsx"), compile("../features/pwa/installation-gate.tsx"),
]);
const flushPromises = () => new Promise(resolve => setImmediate(resolve));

function harness(snapshot = {}) {
  let resolveImport, rejectImport;
  const imported = new Promise((resolve, reject) => { resolveImport = resolve; rejectImport = reject; });
  const calls = { imports: 0, gameRenders: 0, stateWrites: 0, reloads: 0, preloads: [], runtime: [] };
  const installation = { ready: true, standalone: false, browserAllowed: false, ...snapshot,
    allowBrowser() { installation.browserAllowed = true; } };
  const location = { pathname: "/", search: "?auth=verified", hash: "#/invite/retained", reload() { calls.reloads++; } };
  const frames = new Map(), pending = [], animationFrames = new Map(), timers = new Map();
  let active, frameId = 0, timerId = 0, now = 0;
  const setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  const clearTimeout = id => timers.delete(id);
  const hooks = {
    useState(initial) {
      const frame = active, index = frame.cursor++;
      if (!(index in frame.slots)) frame.slots[index] = typeof initial === "function" ? initial() : initial;
      return [frame.slots[index], value => {
        calls.stateWrites++;
        frame.slots[index] = typeof value === "function" ? value(frame.slots[index]) : value;
      }];
    },
    useRef(initial) {
      const frame = active, index = frame.cursor++;
      return frame.slots[index] ??= { current: initial };
    },
    useEffect(callback, dependencies) {
      const frame = active, index = frame.cursor++, previous = frame.slots[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        frame.slots[index] = dependencies;
        pending.push(() => { frame.cleanups.get(index)?.(); frame.cleanups.set(index, callback()); });
      }
    },
  };
  function AppShell() { calls.gameRenders++; return createElement("section", { "data-game": true }, "Game is ready"); }
  function runtime(name) { return () => { calls.runtime.push(name); return null; }; }
  let gate;
  function load(code, filename) {
    const context = {
      exports: {}, window: { location, setTimeout, clearTimeout },
      document: { body: null, activeElement: null, querySelector() { return null; } },
      requestAnimationFrame(callback) { animationFrames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame(id) { animationFrames.delete(id); },
      require(id) {
        if (id === "react") return hooks;
        if (id === "react/jsx-runtime") return jsxRuntime;
        if (id === "react-dom") return { preload: (...args) => calls.preloads.push(args) };
        if (id === "./app-shell") { calls.imports++; return imported; }
        if (id === "@/features/pwa/installation-gate") return gate;
        if (id === "./install-provider") return { usePwaInstall: () => installation };
        if (id === "./install-panel") return { InstallPanel: () => createElement("section", { "data-install-panel": true }, "Installation instructions") };
        if (id === "@/components/mobile-gesture-guard") return { MobileGestureGuard: runtime("gestures") };
        if (id === "@/components/service-worker-registration") return { ServiceWorkerShellWarmup: runtime("shell-warmup") };
        if (id === "@/features/updates/app-lifecycle-view") return { AppLifecycle: runtime("lifecycle") };
        if (id === "@/features/world/runtime-art.json") return { default: { homePreview: "/world/home.webp" } };
        if (id === "@/lib/brand-assets") return { BRAND_LOGO_SRC: "/brand/logo.webp" };
        if (id === "lucide-react") return new Proxy({}, { get: (_, icon) => props => createElement("svg", { ...props, "data-icon": icon }) });
        if (id.endsWith(".module.css")) return new Proxy({}, { get: (_, key) => key });
        assert.fail(`Unexpected dependency: ${id}`);
      },
    };
    vm.runInNewContext(code, context, { filename });
    return context.exports;
  }
  gate = load(gateCode, "installation-gate.tsx");
  const entry = load(entryCode, "game-entry.tsx");

  // The entry contains one instance of each component. Execute their real
  // JSX/handlers, with an independent hook frame and cleanup per component.
  function evaluate(node) {
    if (!isValidElement(node)) return node;
    if (typeof node.type === "function") {
      let frame = frames.get(node.type);
      if (!frame) { frame = { slots: [], cursor: 0, cleanups: new Map() }; frames.set(node.type, frame); }
      const previous = active; active = frame; frame.cursor = 0;
      const result = node.type(node.props); active = previous;
      return evaluate(result);
    }
    return createElement(node.type, node.props, ...Children.toArray(node.props.children).map(evaluate));
  }
  function nodes(tree) {
    const result = [];
    function visit(node) { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } }
    visit(tree); return result;
  }
  return {
    calls, installation, location, timers,
    advance(milliseconds) { now += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    resolve() { resolveImport({ AppShell }); },
    reject() { rejectImport(new TypeError("Failed to fetch dynamically imported module")); },
    render(component = "GameLoader", effects = true) {
      const tree = evaluate(createElement(entry[component]));
      if (effects) while (pending.length) pending.shift()();
      return { html: renderToStaticMarkup(tree), nodes: nodes(tree) };
    },
    unmount() {
      for (const frame of frames.values()) for (const cleanup of frame.cleanups.values()) cleanup?.();
      frames.clear(); pending.length = 0;
    },
  };
}

test("game shell loads only after the loader mounts and renders only after a successful import", async () => {
  const h = harness();
  let view = h.render("GameLoader", false);
  assert.equal(h.calls.imports, 0, "SSR/render alone does not request the game chunk");
  assert.equal(h.calls.gameRenders, 0);
  assert.match(view.html, /aria-busy="true"/); assert.match(view.html, /Загружаем полянку/);
  assert.equal(view.nodes.some(node => node.type === "button"), false);
  h.render(); await flushPromises();
  assert.equal(h.calls.imports, 1); assert.equal(h.calls.gameRenders, 0);
  h.render(); await flushPromises();
  assert.equal(h.calls.imports, 1, "rerenders must not start duplicate imports");
  h.resolve(); await flushPromises();
  assert.equal(h.calls.gameRenders, 0, "resolving a module is not mounting its component");
  view = h.render(); assert.equal(h.calls.gameRenders, 1);
  assert.match(view.html, /data-game="true"/); assert.doesNotMatch(view.html, /Загружаем|aria-busy/);
  assert.equal(h.timers.size, 0, "successful import clears the recovery delay");
  h.unmount();
});

test("failed import ends the loading state and retry reloads the current auth/invitation URL", async () => {
  const h = harness(), originalUrl = { pathname: h.location.pathname, search: h.location.search, hash: h.location.hash };
  h.render(); await flushPromises(); h.reject(); await flushPromises();
  const view = h.render();
  assert.match(view.html, /Не удалось загрузить приложение/);
  assert.match(view.html, /aria-busy="false"/);
  assert.match(view.html, /Ваш прогресс остаётся в аккаунте/);
  assert.doesNotMatch(view.html, /Загружаем полянку/);
  assert.equal(h.calls.gameRenders, 0); assert.equal(h.calls.imports, 1);
  assert.equal(h.timers.size, 0, "rejected import clears the recovery delay");
  const retry = view.nodes.find(node => node.type === "button");
  assert.ok(retry); assert.match(renderToStaticMarkup(retry), /Повторить загрузку/);
  assert.equal(retry.props.disabled, undefined); retry.props.onClick();
  assert.equal(h.calls.reloads, 1);
  assert.deepEqual({ pathname: h.location.pathname, search: h.location.search, hash: h.location.hash }, originalUrl);
  assert.ok(view.nodes.some(node => node.type === "a" && node.props.href === "/site"));
  h.unmount();
});

test("late import success, rejection and queued timeout cannot update an unmounted loader", async () => {
  for (const finish of ["resolve", "reject"]) {
    const h = harness(); h.render(); await flushPromises();
    assert.equal(h.calls.imports, 1);
    const queued = [...h.timers.values()].map(timer => timer.callback);
    h.unmount(); assert.equal(h.timers.size, 0);
    for (const callback of queued) callback();
    h[finish](); await flushPromises();
    assert.equal(h.calls.stateWrites, 0, finish);
    assert.equal(h.calls.gameRenders, 0, finish);
    assert.equal(h.calls.reloads, 0, finish);
  }
});

test("a stalled game import offers recovery after 30 seconds and still accepts a late success", async () => {
  const h = harness(), originalUrl = { pathname: h.location.pathname, search: h.location.search, hash: h.location.hash };
  h.render(); await flushPromises();
  h.advance(29_999);
  assert.equal(h.render().nodes.some(node => node.type === "button"), false);
  h.advance(1);
  let view = h.render();
  assert.match(view.html, /Загрузка занимает больше времени/);
  assert.match(view.html, /aria-busy="false"/, "recovery actions are announced without waiting on a stalled request");
  const retry = view.nodes.find(node => node.type === "button");
  assert.ok(retry, "silence must reveal a reload action");
  assert.ok(view.nodes.some(node => node.type === "a" && node.props.href === "/site"), "the visitor can leave the stalled loader");
  retry.props.onClick(); assert.equal(h.calls.reloads, 1);
  assert.deepEqual({ pathname: h.location.pathname, search: h.location.search, hash: h.location.hash }, originalUrl);
  assert.equal(h.calls.imports, 1, "the timeout does not request another chunk");
  h.resolve(); await flushPromises(); view = h.render();
  assert.match(view.html, /data-game="true"/, "a slow successful response still opens the game");
  assert.doesNotMatch(view.html, /Загрузка занимает|Повторить загрузку/);
  assert.equal(h.timers.size, 0); h.unmount();
});

test("parent installation gate blocks game imports, art preloads and runtime effects until browser continuation", async () => {
  const h = harness({ ready: false });
  let view = h.render("GameEntry"); await flushPromises();
  assert.match(view.html, /Открываем «Я живой»/);
  assert.equal(h.calls.imports, 0); assert.deepEqual(h.calls.preloads, []); assert.deepEqual(h.calls.runtime, []);
  h.installation.ready = true;
  view = h.render("GameEntry"); await flushPromises();
  assert.match(view.html, /data-installation-gate/); assert.match(view.html, /data-install-panel/);
  assert.equal(h.calls.imports, 0); assert.deepEqual(h.calls.preloads, []); assert.deepEqual(h.calls.runtime, []);
  const proceed = view.nodes.find(node => node.type === "button" && renderToStaticMarkup(node).includes("Продолжить в браузере"));
  assert.ok(proceed); proceed.props.onClick();
  view = h.render("GameEntry"); await flushPromises();
  assert.doesNotMatch(view.html, /data-installation-gate/); assert.match(view.html, /Загружаем полянку/);
  assert.equal(h.calls.imports, 1);
  assert.deepEqual(h.calls.runtime, ["gestures", "shell-warmup", "lifecycle"]);
  assert.equal(h.calls.preloads[0][0], "/world/home.webp");
  assert.equal(h.calls.gameRenders, 0);
  h.resolve(); await flushPromises(); view = h.render("GameEntry");
  assert.match(view.html, /Game is ready/); assert.equal(h.calls.gameRenders, 1);
  h.unmount();
});

test("standalone application passes the same gate and retains import failure recovery", async () => {
  const h = harness({ standalone: true });
  let view = h.render("GameEntry"); await flushPromises();
  assert.equal(h.calls.imports, 1); assert.doesNotMatch(view.html, /data-installation-gate/);
  h.reject(); await flushPromises(); view = h.render("GameEntry");
  assert.match(view.html, /Не удалось загрузить приложение/);
  const retry = view.nodes.find(node => node.type === "button"); assert.ok(retry);
  retry.props.onClick(); assert.equal(h.calls.reloads, 1);
  h.unmount();
});
