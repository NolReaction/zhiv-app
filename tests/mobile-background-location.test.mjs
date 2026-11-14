import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const empty = { active: false, backgroundEnabled: false, ownerPublicId: null, epoch: null, lastPublishedAt: null, error: null };
let stateListener, sessionListener, read = async () => empty;
const writes = [];
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
globalThis.__backgroundPorts = {
  location: {
    getState: () => read(),
    setBackgroundEnabled(options) { const pending = deferred(); writes.push({ ...pending, ...options }); return pending.promise; },
    async addListener(_event, listener) { stateListener = listener; return { async remove() {} }; },
  },
  bridge: { async addListener(_event, listener) { sessionListener = listener; return { async remove() {} }; } },
};
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "background-location-ports", enforce: "pre",
    resolveId(id, importer) {
      if (id === "virtual:background-capacitor") return "\0background-capacitor";
      if (id === "./native-bridge" && importer?.endsWith("native-location-publisher.ts")) return "\0background-bridge";
    },
    load(id) {
      if (id === "\0background-capacitor") return `export const Capacitor = { isNativePlatform: () => true, isPluginAvailable: () => true }; export const registerPlugin = () => globalThis.__backgroundPorts.location;`;
      if (id === "\0background-bridge") return `export const NativeBridge = globalThis.__backgroundPorts.bridge;`;
    },
    transform(source, id) {
      if (id.endsWith("/native-location-publisher.ts")) return source.replace('from "@capacitor/core"', 'from "virtual:background-capacitor"');
      if (id.endsWith("/background-location-control.tsx")) return source.replace('import { useId, useSyncExternalStore } from "react";',
        'import { useId } from "react"; const useSyncExternalStore = (_subscribe, snapshot) => snapshot();');
    },
  }],
});
const { installNativeLocationPublisher } = await vite.ssrLoadModule("/apps/mobile/src/native-location-publisher.ts");
const { backgroundLocationChoice } = await vite.ssrLoadModule("/features/earth/native-publisher.ts");
const { BackgroundLocationControl } = await vite.ssrLoadModule("/features/earth/background-location-control.tsx");
const { SharingSwitch } = await vite.ssrLoadModule("/components/sharing-switch.tsx");
await installNativeLocationPublisher();
beforeEach(async () => { writes.length = 0; read = async () => empty; sessionListener(); await settle(); });
after(async () => { await vite.close(); delete globalThis.__backgroundPorts; });

test("publication events cannot unlock a pending toggle or erase its actionable error", async () => {
  const pending = backgroundLocationChoice.setEnabled(true);
  assert.equal(backgroundLocationChoice.getSnapshot().busy, true);
  stateListener({ ...empty, active: true, lastPublishedAt: "2026-11-14T22:00:00Z" });
  assert.equal(backgroundLocationChoice.getSnapshot().busy, true);
  await backgroundLocationChoice.setEnabled(true); assert.equal(writes.length, 1);
  writes[0].reject(new Error("permission denied")); await pending;
  assert.equal(backgroundLocationChoice.getSnapshot().busy, false);
  const error = backgroundLocationChoice.getSnapshot().error; assert.ok(error);
  stateListener(empty); assert.equal(backgroundLocationChoice.getSnapshot().error, error);
});

test("account switch fences old toggle responses and out-of-order state reads", async () => {
  const pending = backgroundLocationChoice.setEnabled(true);
  const oldRead = deferred(); read = () => oldRead.promise; sessionListener();
  read = async () => empty; sessionListener(); await settle();
  writes[0].resolve({ ...empty, backgroundEnabled: true, ownerPublicId: "OLD" });
  oldRead.resolve({ ...empty, backgroundEnabled: true, ownerPublicId: "OLD" });
  await pending; await settle();
  assert.deepEqual(backgroundLocationChoice.getSnapshot(), { available: true, enabled: false, busy: false, error: null });
});

test("newer native state beats a stale initial read", async () => {
  const pending = deferred(); read = () => pending.promise; sessionListener();
  stateListener({ ...empty, backgroundEnabled: true });
  pending.resolve(empty); await settle();
  assert.equal(backgroundLocationChoice.getSnapshot().enabled, true);
});

test("both surfaces can turn background OFF even when the device master switch is OFF", async () => {
  stateListener({ ...empty, backgroundEnabled: true });
  let toggle;
  function Capture() {
    const tree = BackgroundLocationControl({ canEnable: false });
    const walk = node => { if (!isValidElement(node)) return; if (node.type === SharingSwitch) toggle = node; Children.forEach(node.props.children, walk); };
    walk(tree); return tree;
  }
  const markup = renderToStaticMarkup(createElement(Capture));
  assert.match(markup, /Обновлять в фоне/); assert.match(markup, /Получатели и срок доступа не меняются/);
  assert.equal(toggle.props.checked, true); assert.equal(toggle.props.disabled, false);
  toggle.props.onCheckedChange(false); assert.equal(writes[0].enabled, false);
  writes[0].resolve(empty); await settle();
  renderToStaticMarkup(createElement(Capture));
  assert.equal(toggle.props.disabled, true, "master OFF prevents enabling background but never prevents disabling");
});
