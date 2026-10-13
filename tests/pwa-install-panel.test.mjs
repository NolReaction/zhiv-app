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
const [platformCode, panelCode, controllerCode] = await Promise.all([
  compile("../features/pwa/install-platform.ts"), compile("../features/pwa/install-panel.tsx"), compile("../features/pwa/install-controller.ts"),
]);
const platformContext = { exports: {}, URLSearchParams };
vm.runInNewContext(platformCode, platformContext, { filename: "install-platform.ts" });
const platform = platformContext.exports;

function harness(patch = {}) {
  const frame = { slots: [], cursor: 0, pending: [] }, copied = [], focuses = [];
  const document = { body: { isConnected: true }, activeElement: null };
  document.activeElement = document.body;
  const installation = { ready: true, standalone: false, installedHere: false, canInstall: false, busy: false, secure: true, outcome: "idle",
    device: { platform: "android", browser: "chrome", embedded: false }, install: async () => {}, ...patch };
  const hooks = {
    useState(initial) {
      const index = frame.cursor++;
      if (!(index in frame.slots)) frame.slots[index] = initial;
      return [frame.slots[index], value => { frame.slots[index] = typeof value === "function" ? value(frame.slots[index]) : value; }];
    },
    useRef(initial) { const index = frame.cursor++; return frame.slots[index] ??= { current: initial }; },
    useId: () => "panel-test",
    useEffect(callback, dependencies) {
      const index = frame.cursor++, previous = frame.slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        frame.slots[index] = dependencies; frame.pending.push(callback);
      }
    },
  };
  const context = {
    exports: {}, document, window: { location: { origin: "https://im-alive.ru", pathname: "/site", search: "?auth=private", hash: "#/invite/private" } },
    require(id) {
      if (id === "react") return hooks;
      if (id === "react/jsx-runtime") return jsxRuntime;
      if (id === "next/link") return { default: props => createElement("a", props) };
      if (id === "lucide-react") return new Proxy({}, { get: (_, icon) => props => createElement("svg", { ...props, "data-icon": icon }) });
      if (id === "./install-platform") return platform;
      if (id === "./install-provider") return { usePwaInstall: () => installation };
      if (id === "@/lib/identity-sharing") return { copyText: async text => { copied.push(text); return true; } };
      if (id === "./install.module.css") return { default: new Proxy({}, { get: (_, key) => key }) };
      assert.fail(`Unexpected dependency: ${id}`);
    },
  };
  vm.runInNewContext(panelCode, context, { filename: "install-panel.tsx" });
  function evaluate(node) {
    if (!isValidElement(node)) return node;
    if (typeof node.type === "function") return evaluate(node.type(node.props));
    return createElement(node.type, node.props, ...Children.toArray(node.props.children).map(evaluate));
  }
  function visit(node, nodes, hidden = false) {
    if (!isValidElement(node)) return;
    nodes.push(node);
    if (node.props.ref && typeof node.props.ref === "object") {
      const element = node.props.ref.current ?? { open: false };
      Object.assign(element, { isConnected: true, hidden, type: node.type,
        focus() { assert.equal(element.hidden, false, "focus must never land in closed installation details"); focuses.push(node.type); document.activeElement = element; } });
      node.props.ref.current = element;
    }
    Children.forEach(node.props.children, child => visit(child, nodes,
      hidden || node.type === "details" && !node.props.open && child?.type !== "summary"));
  }
  return {
    installation, document, focuses, copied,
    render() {
      frame.cursor = 0;
      const tree = evaluate(createElement(context.exports.InstallPanelContent, { installation })), nodes = [];
      visit(tree, nodes);
      while (frame.pending.length) frame.pending.shift()();
      return { html: renderToStaticMarkup(tree), nodes,
        select: nodes.find(node => node.type === "select"),
        guide: nodes.find(node => node.props["data-install-guide"]),
        button(text) { return nodes.find(node => node.type === "button" && renderToStaticMarkup(node).includes(text)); },
      };
    },
  };
}

test("manual browser selection survives detection updates and reset restores auto recommendation", () => {
  const h = harness();
  let view = h.render(); assert.equal(view.guide.props["data-install-guide"], "android-chrome");
  view.select.props.onChange({ target: { value: "ios" } }); view = h.render();
  assert.match(view.html, /Выбрано вами/); assert.equal(view.guide.props["data-install-guide"], "ios");
  h.installation.device = { platform: "windows", browser: "edge", embedded: false };
  h.installation.canInstall = true; view = h.render();
  assert.equal(view.select.props.value, "ios", "provider events never overwrite a deliberate selection");
  assert.equal(view.button("Установить приложение"), undefined, "manual device choice must never launch the current browser's install prompt");
  assert.doesNotMatch(view.html, /Установить через меню браузера/, "chosen manual guide remains expanded");
  assert.match(view.html, /data-icon="Smartphone"/);
  h.installation.canInstall = false; view = h.render();
  assert.equal(view.guide.props["data-install-guide"], "ios");
  view.button("Вернуть автоопределение").props.onClick(); view = h.render();
  assert.equal(view.guide.props["data-install-guide"], "desktop-edge");
  assert.doesNotMatch(view.html, /Выбрано вами|Вернуть автоопределение/);
});

test("choosing a second device hides current native installation until returning to auto mode", () => {
  const h = harness({ canInstall: true, device: { platform: "windows", browser: "chrome", embedded: false } });
  let view = h.render(); assert.ok(view.button("Установить приложение"));
  view.select.props.onChange({ target: { value: "ios" } }); view = h.render();
  assert.equal(view.button("Установить приложение"), undefined);
  assert.equal(view.guide.props["data-install-guide"], "ios"); assert.match(view.html, /Три шага в Safari/);
  assert.doesNotMatch(view.html, /Установить через меню браузера/);
  h.installation.installedHere = true; h.installation.outcome = "accepted"; view = h.render();
  assert.doesNotMatch(view.html, /Приложение добавлено/, "a desktop install is not presented as an iPhone completion");
  assert.doesNotMatch(view.html, /Установить через меню браузера/);
  h.installation.installedHere = false; h.installation.outcome = "idle";
  view.button("Вернуть автоопределение").props.onClick(); view = h.render();
  assert.ok(view.button("Установить приложение"));
});

test("consumed native prompts restore focus to visible instructions or completion status", async () => {
  for (const outcome of ["dismissed", "error", "accepted"]) {
    const h = harness({ canInstall: true });
    h.installation.install = async () => { h.installation.busy = true; h.installation.canInstall = false; };
    let view = h.render(); view.button("Установить приложение").props.onClick(); h.render();
    h.installation.busy = false; h.installation.outcome = outcome;
    h.document.activeElement = h.document.body;
    view = h.render();
    assert.deepEqual(h.focuses, [outcome === "accepted" ? "div" : "h3"]);
    assert.equal(view.button("Установить приложение"), undefined, "one-use native trigger is gone after its result");
    assert.match(view.html, outcome === "accepted" ? /Запрос принят/ : /через (?:его )?меню/);
  }
});

test("prompt completion respects a user's newer focus and copies only the clean application URL", async () => {
  const h = harness({ canInstall: true });
  h.installation.install = async () => { h.installation.busy = true; h.installation.canInstall = false; };
  let view = h.render(); view.button("Установить приложение").props.onClick(); h.render();
  const focused = { isConnected: true }; h.document.activeElement = focused;
  h.installation.busy = false; h.installation.outcome = "dismissed"; view = h.render();
  assert.deepEqual(h.focuses, []); assert.equal(h.document.activeElement, focused);
  view.button("Скопировать адрес сайта").props.onClick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.copied, ["https://im-alive.ru/"]);
  view = h.render(); assert.match(view.html, /Адрес скопирован/);
});

test("browser adapter reads only default brand/platform hints and tolerates privacy blocks", () => {
  let highEntropyRequests = 0;
  const navigator = { userAgent: "Mozilla/5.0 Chrome/150 Safari/537", platform: "Win32", maxTouchPoints: 0,
    userAgentData: { platform: "Windows", brands: [{ brand: "Microsoft Edge", version: "150" }],
      getHighEntropyValues() { highEntropyRequests++; throw new Error("must not request"); } } };
  const context = { exports: {}, navigator,
    window: { location: { pathname: "/site", search: "", hash: "" }, isSecureContext: true },
    require(id) { assert.equal(id, "./install-platform"); return platform; } };
  vm.runInNewContext(controllerCode, context, { filename: "install-controller.ts" });
  const adapter = context.exports.browserInstallEnvironment();
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.read().clientHints)), { platform: "Windows", brands: [{ brand: "Microsoft Edge" }] });
  assert.equal(highEntropyRequests, 0);
  Object.defineProperty(navigator.userAgentData, "brands", { get() { throw new Error("privacy blocked"); } });
  assert.doesNotThrow(() => adapter.read()); assert.equal(adapter.read().clientHints, undefined);
  assert.equal(highEntropyRequests, 0);
});
