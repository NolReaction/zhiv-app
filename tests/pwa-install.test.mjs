import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { detectInstallDevice, suggestedInstallGuide, installDeviceLabel, installGuideForDevice, hasApplicationEntryLink, INSTALL_GUIDES } = await vite.ssrLoadModule("/features/pwa/install-platform.ts");
const { PwaInstallController, INSTALL_DISMISSED_KEY, INITIAL_INSTALL_SNAPSHOT } = await vite.ssrLoadModule("/features/pwa/install-controller.ts");
const { PwaInstallProvider } = await vite.ssrLoadModule("/features/pwa/install-provider.tsx");
const { InstallationGate } = await vite.ssrLoadModule("/features/pwa/installation-gate.tsx");
const { InstallPanel, InstallPanelContent } = await vite.ssrLoadModule("/features/pwa/install-panel.tsx");

function harness(patch = {}) {
  const events = new EventTarget();
  const media = new Map();
  const storage = new Map();
  const source = { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Safari/537.36", platform: "Linux armv8l", maxTouchPoints: 5,
    standalone: false, secure: true, pathname: "/", search: "", hash: "", ...patch };
  const adapter = {
    events,
    media(query) {
      if (!media.has(query)) {
        const target = new EventTarget();
        media.set(query, { matches: false, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), target });
      }
      return media.get(query);
    },
    read: () => source,
    storage: () => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }),
  };
  const controller = new PwaInstallController(adapter);
  return { controller, adapter, events, media, storage, source,
    display(mode, matches) { const query = media.get(`(display-mode: ${mode})`); query.matches = matches; query.target.dispatchEvent(new Event("change")); },
    offer(outcome = "accepted", fail = false) {
      let calls = 0;
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.prompt = () => { calls++; return fail ? Promise.reject(new Error("blocked")) : Promise.resolve(); };
      event.userChoice = Promise.resolve({ outcome });
      events.dispatchEvent(event);
      return { event, calls: () => calls };
    },
  };
}

test("device help distinguishes iPad desktop mode and browsers that include Chrome in their UA", () => {
  const cases = [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1 Version/26 Safari/605.1", "MacIntel", 5, "ios", "safari", "ios"],
    ["Mozilla/5.0 (iPhone) AppleWebKit/605 CriOS/140 Mobile Safari/604", "iPhone", 5, "ios", "chrome", "ios"],
    ["Mozilla/5.0 (iPhone) AppleWebKit/605 EdgiOS/140 Mobile Safari/604", "iPhone", 5, "ios", "edge", "ios"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/140 SamsungBrowser/28 Safari/537", "Linux", 5, "android", "samsung", "android-samsung"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/140 YaBrowser/26 Safari/537", "Linux", 5, "android", "yandex", "android-yandex"],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari/537 Edg/140", "Win32", 0, "windows", "edge", "desktop-edge"],
    ["Mozilla/5.0 (Windows NT 10.0) Firefox/150", "Win32", 0, "windows", "firefox", "windows-firefox"],
    ["Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/26 Safari/605", "MacIntel", 0, "mac", "safari", "mac-safari"],
    ["Mozilla/5.0 (Linux; Android 14) Chrome/140 OPR/88 Safari/537", "Linux", 5, "android", "other", "other"],
  ];
  for (const [userAgent, platform, maxTouchPoints, expectedPlatform, browser, guide] of cases) {
    const detected = detectInstallDevice({ userAgent, platform, maxTouchPoints });
    assert.equal(detected.platform, expectedPlatform, userAgent);
    assert.equal(detected.browser, browser, userAgent);
    assert.equal(suggestedInstallGuide(detected), guide);
  }
  assert.equal(detectInstallDevice({ userAgent: "Mozilla/5.0 (Linux; Android 14; wv) Chrome/140", platform: "Linux", maxTouchPoints: 5 }).embedded, true);
});

test("low-entropy hints refine reduced UA without treating shared Chromium as Chrome", () => {
  const basic = { userAgent: "Mozilla/5.0 Chrome/150 Safari/537", platform: "", maxTouchPoints: 0 };
  for (const brands of [
    [{ brand: "Not A;Brand" }, { brand: "Chromium" }, { brand: "Microsoft Edge" }],
    [{ brand: "Microsoft Edge" }, { brand: "Chromium" }, { brand: "Not A;Brand" }],
  ]) {
    const device = detectInstallDevice({ ...basic, clientHints: { platform: "Windows", brands } });
    assert.deepEqual(device, { platform: "windows", browser: "edge", embedded: false });
    assert.equal(installDeviceLabel(device), "Edge · Windows");
    assert.equal(suggestedInstallGuide(device), "desktop-edge");
  }
  const android = detectInstallDevice({ ...basic, clientHints: { platform: "Android", brands: [{ brand: "Google Chrome" }] } });
  assert.equal(android.platform, "android"); assert.equal(suggestedInstallGuide(android), "android-chrome");
  const yandex = detectInstallDevice({ ...basic, userAgent: basic.userAgent + " YaBrowser/26", clientHints: { platform: "Android", brands: [{ brand: "Google Chrome" }] } });
  assert.equal(yandex.browser, "yandex", "specific browser UA takes precedence over generic Chrome hint");
  const brave = detectInstallDevice({ ...basic, clientHints: { platform: "macOS", brands: [{ brand: "Chromium" }, { brand: "Brave" }] } });
  assert.equal(brave.browser, "other"); assert.equal(suggestedInstallGuide(brave), "other");
  const chromium = detectInstallDevice({ ...basic, userAgent: "Unknown", clientHints: { brands: [{ brand: "Chromium" }, { brand: "Not A;Brand" }] } });
  assert.equal(chromium.browser, "other", "a shared engine does not identify the browser");
  const ipad = detectInstallDevice({ ...basic, userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/26 Safari/605", platform: "MacIntel", maxTouchPoints: 5, clientHints: { platform: "macOS" } });
  assert.equal(ipad.platform, "ios", "desktop-mode iPad keeps its mobile installation path");
});

test("automatic iOS guides name the active menu and embedded browsers ask to open externally", () => {
  const ios = { platform: "ios", browser: "safari", embedded: false };
  const safari = installGuideForDevice(ios), chrome = installGuideForDevice({ ...ios, browser: "chrome" });
  assert.match(safari.title, /Safari/); assert.match(chrome.title, /Chrome/);
  assert.match(chrome.steps[0], /справа от адресной строки Chrome/);
  assert.doesNotMatch(chrome.steps.join(" "), /Safari/, "only one browser's menus in the main path");
  assert.match(installGuideForDevice({ ...ios, browser: "edge" }).title, /Safari/, "unverified iOS menu falls back to a supported browser");
  for (const userAgent of [
    "Mozilla/5.0 (iPhone) AppleWebKit/605 Mobile/15E148",
    "Mozilla/5.0 (iPhone) AppleWebKit/605 Mobile Safari/605 GSA/400",
    "Mozilla/5.0 (Linux; Android 14; wv) Chrome/150 Safari/537",
  ]) {
    const device = detectInstallDevice({ userAgent, platform: "", maxTouchPoints: 5 });
    assert.equal(device.embedded, true, userAgent);
    assert.equal(installDeviceLabel(device), "Встроенный браузер");
  }
});

test("native installation requires an offered capability, a click, and consumes every event once", async () => {
  const h = harness(); h.controller.start();
  assert.equal(h.controller.snapshot().canInstall, false);
  await h.controller.install();
  const offered = h.offer();
  assert.equal(offered.event.defaultPrevented, true);
  assert.equal(offered.calls(), 0, "receiving the event does not show a browser prompt");
  const operation = h.controller.install();
  assert.equal(offered.calls(), 1, "prompt starts synchronously in the button handler");
  assert.equal(h.controller.snapshot().busy, true);
  await h.controller.install(); await operation;
  assert.equal(offered.calls(), 1);
  assert.equal(h.controller.snapshot().outcome, "accepted");
  assert.equal(h.controller.snapshot().standalone, false, "accepted installation is not an installed window");
  assert.equal(h.controller.snapshot().installedHere, false, "accepted is not appinstalled");
  h.events.dispatchEvent(offered.event); await h.controller.install();
  assert.equal(offered.calls(), 1, "the same one-use event cannot be revived");
  h.events.dispatchEvent(new Event("appinstalled"));
  assert.equal(h.controller.snapshot().installedHere, true);
  assert.equal(h.controller.snapshot().standalone, false);
  h.display("standalone", true);
  assert.equal(h.controller.snapshot().standalone, true);
  h.controller.stop();
});

test("cancel, prompt failure, blocked storage and unmount leave a usable manual route", async () => {
  for (const [outcome, fail, expected] of [["dismissed", false, "dismissed"], ["accepted", true, "error"]]) {
    const h = harness(); h.controller.start(); h.offer(outcome, fail);
    await assert.doesNotReject(h.controller.install());
    assert.equal(h.controller.snapshot().outcome, expected);
    assert.equal(h.controller.snapshot().busy, false);
    assert.equal(h.controller.snapshot().canInstall, false);
    h.adapter.storage = () => { throw new Error("storage blocked"); };
    assert.doesNotThrow(h.controller.allowBrowser);
    assert.equal(h.controller.snapshot().browserAllowed, true);
    h.controller.stop();
  }
  const h = harness(); h.controller.start();
  let finish;
  const event = new Event("beforeinstallprompt", { cancelable: true });
  event.prompt = () => Promise.resolve(); event.userChoice = new Promise(resolve => { finish = resolve; });
  h.events.dispatchEvent(event);
  const operation = h.controller.install(); h.controller.stop();
  const stopped = h.controller.snapshot();
  finish({ outcome: "accepted" }); await operation;
  assert.equal(h.controller.snapshot(), stopped, "late completions cannot mutate a stopped provider");
  h.offer(); h.events.dispatchEvent(new Event("appinstalled"));
  assert.equal(h.controller.snapshot(), stopped, "event handlers are removed on stop");
  h.controller.start();
  assert.equal(h.controller.snapshot().busy, false);
  assert.equal(h.controller.snapshot().canInstall, false);
  h.offer(); assert.equal(h.controller.snapshot().canInstall, true);
  h.controller.stop();
});

test("runtime mode is independent of UA and fullscreen, with iOS navigator fallback", () => {
  const h = harness(); h.controller.start();
  h.display("fullscreen", true); assert.equal(h.controller.snapshot().standalone, false);
  assert.equal(h.controller.snapshot().browserAllowed, false, "browser fullscreen cannot bypass the installation offer");
  h.display("fullscreen", false);
  h.display("minimal-ui", true); assert.equal(h.controller.snapshot().standalone, true);
  h.display("minimal-ui", false); assert.equal(h.controller.snapshot().standalone, false);
  assert.equal(h.controller.snapshot().browserAllowed, true, "once admitted, the game never remounts the offer on mode changes");
  h.display("window-controls-overlay", true); assert.equal(h.controller.snapshot().standalone, true);
  h.display("fullscreen", true); h.display("window-controls-overlay", false);
  assert.equal(h.controller.snapshot().standalone, true, "fullscreen preserves a previously confirmed app window");
  h.controller.stop();
  const ios = harness({ standalone: true }); ios.controller.start();
  assert.equal(ios.controller.snapshot().standalone, true);
  ios.offer(); assert.equal(ios.controller.snapshot().canInstall, false);
  ios.controller.stop();
  const http = harness({ secure: false }); http.controller.start(); http.offer();
  assert.equal(http.controller.snapshot().secure, false); assert.equal(http.controller.snapshot().canInstall, false);
  http.controller.stop();
});

test("auth, invitations, notification links and session dismissal bypass the root offer without rewriting URLs", () => {
  for (const input of [ { search: "?auth=account-proof" }, { search: "?notification=world&owner=test&section=production" }, { search: "?_appBuild=release" }, { hash: "#/invite/token" }, { hash: "#/recover/token" } ]) {
    const h = harness(input); h.controller.start();
    assert.equal(h.controller.snapshot().browserAllowed, true);
    assert.deepEqual({ search: h.source.search, hash: h.source.hash }, { search: input.search ?? "", hash: input.hash ?? "" });
    h.controller.stop();
  }
  assert.equal(hasApplicationEntryLink({ pathname: "/site", search: "", hash: "#install" }), false, "a marketing anchor must not silently dismiss the root offer");
  for (const input of [{ search: "?utm_source=vk" }, { search: "?fbclid=123" }, { search: "?source=pwa" }, { hash: "#install" }]) {
    const h = harness(input); h.controller.start();
    assert.equal(h.controller.snapshot().browserAllowed, false, "tracking parameters and presentation anchors are normal browser visits");
    h.controller.stop();
  }
  for (const [key, value] of [[INSTALL_DISMISSED_KEY, "1"], ["zhiv:account-action", "email"], ["zhiv.pending-direct-invite.v1", "token"]]) {
    const h = harness(); h.storage.set(key, value); h.controller.start();
    assert.equal(h.controller.snapshot().browserAllowed, true); h.controller.stop();
  }
  const h = harness(); h.controller.start(); h.controller.allowBrowser();
  assert.equal(h.storage.get(INSTALL_DISMISSED_KEY), "1");
  h.controller.stop();
});

test("SSR gate never executes game children and installation stays neutral before device detection", () => {
  let rendered = 0;
  function Game() { rendered++; return createElement("div", null, "private game"); }
  const html = renderToStaticMarkup(createElement(PwaInstallProvider, null, createElement(InstallationGate, null, createElement(Game))));
  assert.equal(rendered, 0); assert.doesNotMatch(html, /private game/); assert.match(html, /Открываем/);
  assert.match(html.replace(/<noscript>[\s\S]*?<\/noscript>/g, ""), /href="\/site"/, "failed hydration still leaves a working public-site link");
  const panel = renderToStaticMarkup(createElement(PwaInstallProvider, null, createElement(InstallPanel)));
  assert.match(panel, /data-install-pending/); assert.match(panel, /Подбираем способ установки/);
  assert.doesNotMatch(panel, /data-install-guide/);
  const closed = panel.match(/<details[^>]*data-install-correction[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(closed); assert.doesNotMatch(closed, /<details[^>]*\bopen\b/);
  assert.match(closed, /<select/); assert.match(panel, /<noscript>/);
  assert.doesNotMatch(panel.replace(closed, ""), /<select|<option/);
  assert.doesNotMatch(panel, /<button[^>]*>[^<]*Установить приложение/);
  assert.equal(Object.keys(INSTALL_GUIDES).length, 10);
});

test("hydrated help presents a single recommendation; native capability takes priority over UA", () => {
  const base = { ...INITIAL_INSTALL_SNAPSHOT, ready: true, install: async () => {}, allowBrowser: () => {} };
  const safari = renderToStaticMarkup(createElement(InstallPanelContent, { installation: { ...base, device: { platform: "ios", browser: "safari", embedded: false } } }));
  assert.match(safari, /Safari · iPhone \/ iPad/);
  assert.equal(safari.match(/data-install-guide=/g)?.length, 1);
  assert.equal(safari.match(/<ol/g)?.length, 1);
  const native = renderToStaticMarkup(createElement(InstallPanelContent, { installation: { ...base, canInstall: true, device: { platform: "unknown", browser: "other", embedded: true } } }));
  assert.match(native, /<button[^>]*>[\s\S]*?Установить приложение/);
  assert.match(native, /<details[^>]*><summary>Установить через меню браузера/);
  assert.doesNotMatch(native, /Сначала откройте внешний браузер/, "offered native API wins over uncertain UA heuristics");
  const embedded = renderToStaticMarkup(createElement(InstallPanelContent, { installation: { ...base, device: { platform: "ios", browser: "other", embedded: true } } }));
  assert.match(embedded, /Сначала откройте внешний браузер/);
  assert.doesNotMatch(embedded, /<ol/, "embedded viewers get one clear external-browser path");
});

test("standalone panel prioritizes the game and folds installation instructions for another device", () => {
  const installation = { ...INITIAL_INSTALL_SNAPSHOT, ready: true, standalone: true, install: async () => {}, allowBrowser: () => {} };
  const html = renderToStaticMarkup(createElement(InstallPanelContent, { installation }));
  assert.match(html, /Вы уже в приложении/);
  assert.match(html, /<a[^>]*href="\/"[^>]*>Вернуться на полянку/);
  assert.match(html, /<details[^>]*><summary>Установить на другом устройстве<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(html, /Установить приложение/);
  assert.ok(html.indexOf("Вернуться на полянку") < html.indexOf("<details"));
});
