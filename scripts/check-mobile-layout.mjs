// Browser geometry gate using the real mobile CSS pipeline, dock and location controls.
// Device insets are injected as by native bridges; this does not emulate iOS/Android permission UI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const requires = [createRequire(import.meta.url), ...[process.env.PLAYWRIGHT_NODE_MODULES, process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]
  .filter(Boolean).map(path => createRequire(join(path, "package.json")))];
let chromium;
for (const require of requires) { try { ({ chromium } = require("playwright")); break; } catch { /* Try the managed runtime. */ } }
if (!chromium) throw new Error("Install Playwright to run the mobile layout gate.");
const candidates = [process.env.BROWSER_EXECUTABLE_PATH, chromium.executablePath(),
  ...(process.env.PATH ?? "").split(delimiter).flatMap(path => ["chromium", "chromium-browser", "google-chrome"].map(name => join(path, name)))].filter(Boolean);
let executablePath;
for (const path of candidates) { try { await access(path); executablePath = path; break; } catch { /* Try the next browser. */ } }
if (!executablePath) throw new Error("Install Playwright Chromium or set BROWSER_EXECUTABLE_PATH.");
const baselineRef = process.env.MOBILE_LAYOUT_BASELINE_REF;
const baseline = new Map(baselineRef ? ["apps/mobile/src/style.css", "features/app/app-shell.module.css"].map(path =>
  [join(root, path), execFileSync("git", ["show", `${baselineRef}:${path}`], { cwd: root, encoding: "utf8" })]) : []);
const entry = "virtual:mobile-layout";
const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { AppNavigation } from "/features/app/navigation.tsx";
import { ProfileLocationSettingsContent } from "/features/account/profile-location-settings.tsx";
import { updateBackgroundLocationChoice } from "/features/earth/native-publisher.ts";
import { configureClientPlatform } from "/lib/client-platform.ts";
import shell from "/features/app/app-shell.module.css";
import profile from "/features/account/profile-view.module.css";
import earth from "/features/earth/earth-view.module.css";
import "/app/globals.css";
import "/apps/mobile/src/style.css";
const h = React.createElement, mount = createRoot(document.getElementById("root"));
configureClientPlatform({ kind: "ios", appVersion: "layout" });
updateBackgroundLocationChoice({ available: true, enabled: false, busy: false, error: null });
window.mountMobile = (view) => {
  history.replaceState(null, "", "#" + view);
  const map = h("section", { className: earth.view, "data-map": true },
    h("div", { className: earth.stage, style: { background: "radial-gradient(circle at 55% 40%, #618c6a, #0b252d 65%)" } }),
    h("header", { className: earth.header, "data-map-header": true }, h("strong", { className: earth.brand }, "Я живой · Земля"), h("button", { className: earth.worldButton }, "Моя полянка")),
    h("div", { className: earth.bottomOverlay }, h("button", { className: earth.sharingButton }, "Геопозиция")));
  const content = h("section", { className: profile.view, "data-profile": true },
    h("header", { className: profile.heading }, h("h1", null, "Профиль")),
    h("div", { className: profile.columns },
      ...Array.from({ length: 3 }, (_, i) => h("article", { className: profile.profileCard, key: i, style: { padding: 24, minHeight: 180 } }, h("h2", null, ["Дима 🐘", "Игровой прогресс", "Вход и безопасность"][i]), h("p", null, "Мохлик · Настройки приложения"))),
      h("div", { "data-last-card": true }, h(ProfileLocationSettingsContent, { enabled: true, onEnabledChange() {}, location: { position: null, status: "idle", error: null }, onLocate() {}, onStop() {} }))));
  mount.render(h("main", { className: shell.shell, "data-active-view": view },
    h("header", { className: shell.header, "data-shell-header": true }, h("p", { className: shell.wordmark }, "Я ЖИВОЙ"), h("strong", null, "Дима 🐘")),
    h("div", { className: shell.viewTransition, key: view }, view === "earth" ? map : content),
    h("footer", { className: shell.footer }, h(AppNavigation, { active: view, onSelect: window.mountMobile, invitations: 0 }))));
};
window.mountMobile(location.hash.slice(1) || "profile");
window.mobileLayoutReady = true;
`;
const cacheDir = await mkdtemp(join(tmpdir(), "mochlik-mobile-layout-"));
let server, browser, page, lastGeometry, cases = 0;
const errors = [];
try {
  const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, join(root, "apps/mobile/vite.config.ts"));
  server = await createServer({ ...loaded.config, configFile: false, appType: "custom", root, cacheDir,
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-dev-runtime", "radix-ui", "lucide-react", "zod", "clsx", "tailwind-merge", "class-variance-authority"] },
    plugins: [{ name: "mobile-layout-fixture", enforce: "pre",
      resolveId(id) { if (id === entry) return `\0${id}`; },
      load(id) { if (id === `\0${entry}`) return source; return baseline.get(id); },
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html lang="ru" data-native-app="ios"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:mobile-layout"></script></body></html>');
      }); },
    }],
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false, watch: { ignored: ["**/.next/**", "**/dist/**"] } },
  });
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]); await page.waitForFunction(() => window.mobileLayoutReady);
  const devices = [
    { name: "small", width: 320, height: 568, top: 20, bottom: 0, side: 0 },
    { name: "iphone", width: 440, height: 956, top: 62, bottom: 34, side: 0 },
    { name: "landscape", width: 956, height: 440, top: 0, bottom: 21, side: 62 },
    { name: "android-edge", width: 393, height: 852, top: 28, bottom: 24, side: 0, core: true },
    { name: "android-inset", width: 393, height: 800, top: 0, bottom: 0, side: 0, core: true },
  ];
  for (const device of devices) {
    await page.setViewportSize({ width: device.width, height: device.height });
    // The core CSS value may intentionally be zero despite a stale raw inset,
    // for example when the native view already applies padding or an IME opens.
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {
      top: device.name === "android-inset" ? 28 : device.top,
      bottom: device.name === "android-inset" ? 24 : device.bottom, left: device.side, right: device.side,
    } });
    await page.evaluate(device => {
      document.documentElement.dataset.nativeApp = device.core ? "android" : "ios";
      for (const [side, value] of Object.entries({ top: device.top, bottom: device.bottom, left: device.side, right: device.side })) {
        const style = document.documentElement.style;
        style.setProperty("--native-safe-area-" + side, (device.name === "android-inset" ? side === "top" ? 28 : side === "bottom" ? 24 : 0 : value) + "px");
        if (device.core) style.setProperty("--safe-area-inset-" + side, value + "px"); else style.removeProperty("--safe-area-inset-" + side);
      }
    }, device);
    for (const view of ["profile", "earth"]) {
      await page.evaluate(view => window.mountMobile(view), view);
      await page.locator(`main[data-active-view="${view}"]`).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(view => {
        const box = selector => { const { x, y, right, bottom, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, right, bottom, width, height }; };
        return { content: box(view === "earth" ? "[data-map]" : "[data-profile]"), header: box(view === "earth" ? "[data-map-header]" : "[data-shell-header]"),
          nav: box("nav"), bodyWidth: document.documentElement.scrollWidth, mask: getComputedStyle(document.body, "::before").content };
      }, view);
      const label = `${device.name}/${view}`;
      lastGeometry = { label, ...geometry };
      assert.ok(["none", "normal"].includes(geometry.mask), `${label}: opaque system-bar cover remains`);
      assert.ok(Math.abs(geometry.content.bottom - device.height) <= 1, `${label}: content is clipped before bottom safe area: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.header.y >= device.top && geometry.header.x >= device.side && geometry.header.right <= device.width - device.side + 1, `${label}: controls enter a cutout`);
      assert.ok(geometry.nav.bottom <= device.height - device.bottom - 5 && geometry.nav.x >= device.side && geometry.nav.right <= device.width - device.side, `${label}: dock enters a safe area`);
      assert.ok(geometry.bodyWidth <= device.width, `${label}: horizontal overflow`);
      if (view === "earth") assert.equal(geometry.content.y, 0, `${label}: map must paint under status bar`);
      if (device.name === "android-inset") assert.equal(geometry.header.y, view === "earth" ? 10 : 24, `${label}: native padding was counted twice`);
      if (view === "profile") {
        await page.locator("[data-profile]").evaluate(element => { element.scrollTop = element.scrollHeight; });
        const last = await page.locator("[data-last-card]").boundingBox();
        assert.ok(last.y + last.height <= geometry.nav.y, `${label}: trailing settings are hidden under the dock`);
        await page.getByRole("switch", { name: /Обновлять в фоне/ }).click({ trial: true });
      }
      if (process.env.MOBILE_LAYOUT_SCREENSHOT_DIR && ["iphone", "landscape"].includes(device.name)) {
        await mkdir(process.env.MOBILE_LAYOUT_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.MOBILE_LAYOUT_SCREENSHOT_DIR, `${device.name}-${view}.png`) });
      }
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: await browser.version(), geometryCases: cases, baselineRef: baselineRef ?? null, browserErrors: errors.length }));
} catch (error) {
  console.error(JSON.stringify({ completedCases: cases, browserErrors: errors, lastGeometry }));
  if (page && process.env.MOBILE_LAYOUT_SCREENSHOT_DIR) {
    await mkdir(process.env.MOBILE_LAYOUT_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.MOBILE_LAYOUT_SCREENSHOT_DIR, "failure.png") }).catch(() => {});
  }
  throw error;
} finally { await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true }); }
