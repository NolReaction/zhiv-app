import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:mobile-update-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "mobile-update-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      export const effects=[];
      export const useEffect=callback=>effects.push(callback);
      export const useState=value=>[typeof value==='function'?value():value,()=>{}];
      export const useRef=value=>({current:value});
      export const useCallback=callback=>callback;
    `; },
    transform(source, id) {
      if (id.endsWith("/components/service-worker-registration.tsx") || id.endsWith("/features/startup/startup-splash.tsx"))
        return source.replace('from "react";', `from "${hooksId}";`);
    },
  }],
});
after(() => vite.close());
const { configureClientPlatform } = await vite.ssrLoadModule("/lib/client-platform.ts");
const { AppLifecycle } = await vite.ssrLoadModule("/features/updates/app-lifecycle-view.tsx");
const { ServiceWorkerRegistration, ServiceWorkerShellWarmup } = await vite.ssrLoadModule("/components/service-worker-registration.tsx");
const { StartupSplash } = await vite.ssrLoadModule("/features/startup/startup-splash.tsx");
const { isMobileAsset } = await vite.ssrLoadModule("/apps/mobile/bundled-assets.ts");
const { effects } = await vite.ssrLoadModule(hooksId);
afterEach(() => { configureClientPlatform(null); effects.length = 0; });
const platform = (kind, openDiagnostics = () => {}) => ({ kind, appVersion: "test", openDiagnostics });

test("native entry cannot start the browser version controller or touch service workers", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, get() { throw Error("native must not access browser SW"); } });
  try {
    for (const kind of ["ios", "android"]) {
      configureClientPlatform(platform(kind));
      assert.equal(AppLifecycle(), null);
      assert.equal(ServiceWorkerRegistration(), null);
      assert.equal(ServiceWorkerShellWarmup(), null);
      for (const effect of effects.splice(0)) assert.equal(effect(), undefined);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  }
});

test("browser entry keeps its updater and production service worker registration/warmup", async () => {
  configureClientPlatform(null);
  assert.ok(isValidElement(AppLifecycle()));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousEnv = process.env.NODE_ENV;
  const calls = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: {
    register: async (...args) => calls.push(["register", ...args]),
    ready: Promise.resolve({ active: { postMessage: message => calls.push(["message", message]) } }),
  } } });
  process.env.NODE_ENV = "production";
  try {
    ServiceWorkerRegistration(); ServiceWorkerShellWarmup();
    const cleanups = effects.splice(0).map(effect => effect());
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls, [
      ["register", "/sw.js", { scope: "/", updateViaCache: "none" }],
      ["message", { type: "zhiv:cache-shell" }],
    ]);
    for (const cleanup of cleanups) cleanup?.();
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous); else delete globalThis.navigator;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
});

test("failed native startup opens diagnostics without navigating to the absent web recovery document", () => {
  const props = { phase: "loading", progress: 20, message: "Ожидаем", retryAvailable: true, onRetry() {}, onLogoReady() {} };
  let opened = 0;
  for (const kind of ["ios", "android"]) {
    configureClientPlatform(platform(kind, () => opened++));
    const tree = StartupSplash(props);
    const markup = renderToStaticMarkup(tree);
    assert.doesNotMatch(markup, /recover\.html/);
    const nodes = [];
    const walk = node => { if (!isValidElement(node)) return; nodes.push(node); Children.forEach(node.props.children, walk); };
    walk(tree);
    const action = nodes.find(node => node.type === "button" && node.props.children === "Проверить устройство");
    assert.ok(action);
    action.props.onClick();
  }
  assert.equal(opened, 2);
  configureClientPlatform(null);
  assert.match(renderToStaticMarkup(StartupSplash(props)), /href="\/recover\.html"/);
});

test("native assets include installed release history but exclude web update and recovery programs", () => {
  assert.equal(isMobileAsset("updates.json"), true);
  for (const path of ["sw.js", "recover.html", "recover.js", "app-status.json", "site/index.html"])
    assert.equal(isMobileAsset(path), false, path);
});
