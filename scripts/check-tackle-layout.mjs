// Real Chromium gate for scrollable fishing equipment cards and nested popovers.
// Requires Playwright and Chromium (or BROWSER_EXECUTABLE_PATH).
// TACKLE_LAYOUT_BASELINE_REF=<git-ref> proves the same checks against older CSS.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const localRequire = createRequire(import.meta.url);
const runtimeRequire = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? createRequire(join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "package.json")) : null;
const baselineRef = process.env.TACKLE_LAYOUT_BASELINE_REF;
const cssPath = "features/economy/ui/fishing/world-tackle-picker.module.css";
const baselineCss = baselineRef ? execFileSync("git", ["show", `${baselineRef}:${cssPath}`], { cwd: root, encoding: "utf8" }) : null;
const exists = async path => { try { await access(path); return true; } catch { return false; } };
function dependency(name) {
  for (const require of [localRequire, runtimeRequire].filter(Boolean)) {
    try { return require(name); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  throw new Error(`${name} is required for this browser gate. Install it locally, or set CODEX_PRIMARY_RUNTIME_NODE_MODULES to an installation containing it.`);
}
async function chromiumOptions(chromium) {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? process.env.BROWSER_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const candidates = configured ? [configured] : [chromium.executablePath(),
    ...(process.env.PATH ?? "").split(delimiter).flatMap(directory => ["chromium", "chromium-browser", "google-chrome"].map(name => join(directory, name))),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/tmp/chromium"];
  const executablePath = (await Promise.all(candidates.map(exists))).findIndex(Boolean);
  if (executablePath < 0) throw new Error("Chromium is missing. Install Playwright Chromium, or set BROWSER_EXECUTABLE_PATH to an existing browser executable.");
  const selected = candidates[executablePath];
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  return { headless: true, executablePath: selected, args };
}

const entryId = "virtual:tackle-layout";
const entrySource = `
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "/components/ui/dialog.tsx";
import { WorldTacklePicker } from "/features/economy/ui/fishing/world-tackle-picker.tsx";
import { economyCatalog, economyFishingSchema } from "/features/economy/domain/model.ts";
import { newEconomyState } from "/features/economy/domain/rules.ts";
import styles from "/features/world/world.module.css";
import "/app/globals.css";
const h = React.createElement, now = Date.parse("2026-10-23T12:00:00Z");
const mount = createRoot(document.getElementById("root"));
function snapshot() {
  const catalog = structuredClone(economyCatalog);
  return { ...newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 5, workshopLevel: 5 }),
    ownerPublicId: "TACKLE_LAYOUT", revision: 7, serverTime: new Date(now).toISOString(), catalog,
    wallet: { coins: 1e6, pearls: 1000 }, inventory: Object.fromEntries(catalog.fishing.baits.map(bait => [bait.itemId, 5])),
    buildings: { home: 5, warehouse: 5, workshop: 5 },
    fishing: { ...economyFishingSchema.parse({}), ownedRods: catalog.fishing.rods.map(rod => rod.id), equippedRodId: "reed_rod",
      ownedHooks: catalog.fishing.hooks.map(hook => hook.id), equippedHookId: "bare_hook", equippedBaitId: null,
      catches: Object.fromEntries(catalog.fishing.fish.map(fish => [fish.itemId, 1])) },
    storage: { capacity: 500, used: 0, reserved: 0, available: 500, overflow: 0 } };
}
function Fixture({ position, token }) {
  const [state, setState] = useState(snapshot), [worldOpen, setWorldOpen] = useState(true);
  const economy = { snapshot: state, snapshotConfirmed: true, now, busy: false, uncertain: false, retryAt: 0, error: null, act() { return true; } };
  useEffect(() => { window.__tackleReady = token; }, [token]);
  return h(Dialog, { open: worldOpen, onOpenChange: setWorldOpen }, h(DialogPortal, null,
    h(DialogOverlay), h(DialogPrimitive.Content, { className: styles.portal, "data-slot": "dialog-content", "data-tackle-world": true },
      h(DialogTitle, { className: styles.sr }, "Игровой мир"), h(DialogDescription, { className: styles.sr }, "Подготовка к рыбалке"),
      h("main", { className: styles.world, style: { background: "#284435" } },
        h("section", { style: { position: "absolute", left: "50%", transform: "translateX(-50%)", ...(position === "bottom" ? { bottom: 30 } : { top: 30 }),
          maxWidth: 460, width: "calc(100% - 32px)", padding: 12, background: "#e6d9b7", color: "#394d3e", borderRadius: 16 } },
          h(WorldTacklePicker, { state, economy, disabled: false, onChoose(kind, id) {
            window.__tackleCommands.push([kind, id]);
            setState(previous => ({ ...previous, revision: previous.revision + 1,
              fishing: { ...previous.fishing, [kind === "rod" ? "equippedRodId" : kind === "hook" ? "equippedHookId" : "equippedBaitId"]: id === "none" ? null : id } }));
            return true;
          } }))))));
}
window.__mountTackle = options => { window.__tackleCommands = []; mount.render(h(Fixture, { ...options, key: options.token })); };
window.__tackleBooted = true;
`;

const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-tackle-layout-"));
let server, browser, token = 0, cases = 0;
const errors = [];
try {
  const { chromium } = dependency("playwright");
  server = await createServer({ configFile: false, appType: "custom", root, cacheDir,
    resolve: { alias: { "@": root } }, define: { "process.env.NODE_ENV": JSON.stringify("development") },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime", "radix-ui", "lucide-react", "zod", "clsx", "tailwind-merge", "class-variance-authority"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false, watch: { ignored: ["**/.next/**", "**/dist/**", "**/.sites-runtime/**"] } },
    plugins: [{ name: "tackle-layout-fixture", enforce: "pre",
      resolveId(id) { if (id === entryId) return `\0${id}`; },
      load(id) { if (id === `\0${entryId}`) return entrySource; if (baselineCss && id === join(root, cssPath)) return baselineCss; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:tackle-layout"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch(await chromiumOptions(chromium));
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.__tackleBooted);
  const sizes = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1024, height: 600 }, { width: 1280, height: 900 }];
  for (const size of sizes) for (const position of ["bottom", "top"]) for (const kind of ["rod", "hook", "bait"]) {
    const label = `${kind}/${position}/${size.width}x${size.height}`;
    await page.setViewportSize(size);
    const nextToken = ++token;
    await page.evaluate(options => window.__mountTackle(options), { position, token: nextToken });
    await page.waitForFunction(value => window.__tackleReady === value, nextToken);
    const trigger = page.locator(`[data-tackle-slot="${kind}"]`);
    await trigger.click();
    const popup = page.locator(`[data-tackle-picker="${kind}"]`);
    await popup.waitFor();
    await page.waitForFunction(kind => {
      const panel = document.querySelector(`[data-tackle-picker="${kind}"]`);
      return panel && panel.parentElement.style.transform && !panel.parentElement.style.transform.includes("-200%");
    }, kind);
    await popup.locator("[data-tackle-picker-close]").click({ trial: true });
    const geometry = await popup.evaluate(panel => {
      const rect = element => { const { x, y, right, bottom, width, height } = element.getBoundingClientRect(); return { x, y, right, bottom, width, height }; };
      const rows = [...panel.querySelectorAll("[data-tackle-option]")], list = rows[0].parentElement;
      return { panel: rect(panel), heading: rect(panel.querySelector("header")), note: rect(panel.lastElementChild), list: rect(list),
        listScrollHeight: list.scrollHeight, listHeight: list.clientHeight, bodyWidth: document.documentElement.scrollWidth,
        rows: rows.map(row => ({ id: row.dataset.tackleOption, box: rect(row), children: [...row.querySelectorAll("strong, small, [data-tackle-odds], [data-species-focus]")].map(rect) })) };
    });
    const { panel, heading, note, list } = geometry;
    assert.ok(panel.x >= 11 && panel.y >= 11 && panel.right <= size.width - 11 && panel.bottom <= size.height - 11, `${label}: popup leaves viewport: ${JSON.stringify(panel)}`);
    assert.ok(geometry.bodyWidth <= size.width, `${label}: popup causes horizontal page scrolling`);
    assert.ok(list.y >= heading.bottom - 1 && list.bottom <= note.y + 1 && note.bottom <= panel.bottom, `${label}: list overlaps heading/footer`);
    for (const row of geometry.rows) for (const child of row.children) {
      assert.ok(child.y >= row.box.y + 7 && child.bottom <= row.box.bottom - 7 && child.x >= row.box.x && child.right <= row.box.right,
        `${label}/${row.id}: row content escapes its card: ${JSON.stringify({ row: row.box, child })}`);
    }
    if (kind === "rod") assert.ok(geometry.listScrollHeight > geometry.listHeight, `${label}: long equipment list must scroll independently`);
    const last = popup.locator("[data-tackle-option]").last();
    await last.scrollIntoViewIfNeeded();
    const afterScroll = await popup.evaluate(panel => ({ heading: panel.querySelector("header").getBoundingClientRect().y, note: panel.lastElementChild.getBoundingClientRect().y }));
    assert.ok(Math.abs(afterScroll.heading - heading.y) <= 1 && Math.abs(afterScroll.note - note.y) <= 1, `${label}: scrolling moves fixed heading/footer`);
    const screenshotDirectory = process.env.TACKLE_LAYOUT_SCREENSHOT_DIR;
    if (screenshotDirectory && position === "bottom" && kind === "rod" && [320, 1280].includes(size.width)) {
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: join(screenshotDirectory, `rod-${size.width}.png`) });
    }
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true, `${label}: Escape must restore trigger focus`);
    assert.equal(await page.locator("[data-tackle-world]").count(), 1, `${label}: Escape must leave the world open`);
    assert.deepEqual(await page.evaluate(() => window.__tackleCommands), [], `${label}: viewing and scrolling cannot equip gear`);
    await trigger.click();
    await popup.waitFor();
    await page.keyboard.press("Tab");
    assert.equal(await popup.locator("[data-tackle-picker-close]").evaluate(element => element === document.activeElement), true, `${label}: keyboard focus starts at close control`);
    const candidate = popup.locator('[data-tackle-option]:not(:disabled):not([data-selected="true"])').first();
    const id = await candidate.getAttribute("data-tackle-option");
    await candidate.click();
    await popup.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__tackleCommands), [[kind, id]], `${label}: one selection must equip exactly once`);
    assert.equal(await page.locator("[data-tackle-world]").count(), 1, `${label}: choosing gear must leave the world open`);
    cases++;
  }
  assert.deepEqual(errors, [], "The actual picker must run without browser errors");
  console.log(JSON.stringify({ browser: await browser.version(), baselineRef: baselineRef ?? null, geometryCases: cases, widths: sizes.map(size => size.width), browserErrors: errors.length }));
} finally {
  await browser?.close();
  await server?.close();
  await rm(cacheDir, { recursive: true, force: true });
}
