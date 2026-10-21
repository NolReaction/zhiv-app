// Real Chromium geometry/interaction gate; deliberately separate from SSR tests.
// node scripts/check-construction-layout.mjs
// CONSTRUCTION_LAYOUT_BASELINE_REF=<git-ref> reruns the same gate with that dialog CSS.
// Requires Playwright plus an installed Chromium (or BROWSER_EXECUTABLE_PATH).
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
const baselineRef = process.env.CONSTRUCTION_LAYOUT_BASELINE_REF;
const cssPath = "features/economy/ui/construction/world-upgrade-dialog.module.css";
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
  let args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (selected === "/tmp/chromium") {
    // A serverless Chromium needs its own launch flags. Resolve the helper from
    // local/runtime dependencies or an explicitly supplied NODE_PATH.
    const helper = dependency("@sparticuz/chromium");
    args = (helper.default ?? helper).args;
  }
  return { headless: true, executablePath: selected, args };
}

const entryId = "virtual:construction-layout";
const entrySource = `
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorldUpgradeDialog } from "/features/economy/ui/construction/world-upgrade-dialog.tsx";
import { WorldObjectMenu } from "/features/economy/ui/stations/world-object-menu.tsx";
import { worldPlaceForStation } from "/features/economy/ui/shared/world-stations.ts";
import { economyCatalog } from "/features/economy/domain/model.ts";
import { economyStorage } from "/features/economy/domain/rules.ts";
import "/app/globals.css";
const now = Date.parse("2026-10-03T12:00:00Z"), mount = createRoot(document.getElementById("root"));
const meal = economyCatalog.food.meals.find(entry => entry.builderSpeedBps > 0);
if (!meal) throw new Error("The catalog must provide builder food for the saved-meal regression.");
window.__constructionBuildings = economyCatalog.buildings.map(entry => entry.id);
window.__constructionCommands = [];
function Fixture({ stationId, scenario, viaMenu, token }) {
  const [closed, setClosed] = useState(false);
  const building = economyCatalog.buildings.find(entry => entry.id === stationId);
  const current = stationId === "home" || stationId === "warehouse" ? 1 : 0;
  const target = building.levels.find(entry => entry.level === current + 1);
  if (!target) throw new Error("Missing construction target: " + stationId);
  const job = { id: "layout-" + stationId, kind: "construction", targetId: stationId, recipeId: null, targetLevel: target.level,
    startedAt: new Date(now - 60_000).toISOString(), finishesAt: new Date(now + (scenario === "ready" ? -1000 : 600_000)).toISOString(),
    rewards: {}, cost: target.cost, catalogVersion: economyCatalog.version,
    ...(scenario === "meal-saved" ? { meal: { itemId: meal.itemId, consumer: "builder", speedBps: meal.builderSpeedBps } } : {}) };
  const state = { ownerPublicId: "LAYOUT_FIXTURE", revision: 1, serverTime: new Date(now).toISOString(),
    wallet: { coins: 1_000_000, pearls: 100_000 }, inventory: Object.fromEntries(economyCatalog.items.map(entry => [entry.id, 100])),
    buildings: { ...Object.fromEntries(economyCatalog.buildings.map(entry => [entry.id, entry.levels.at(-1).level])), [stationId]: current },
    jobs: scenario.startsWith("prebuild") ? [] : [job], completedExplorations: 0,
    food: { heroMeal: null, builderMeal: scenario === "prebuild-saved" ? meal.itemId : null },
    migration: { version: 1, coinsGranted: 0, woodGranted: 0, stoneGranted: 0 }, catalog: economyCatalog };
  state.storage = economyStorage(state);
  const economy = { snapshot: state, snapshotConfirmed: true, market: null, marketError: null, busy: false, uncertain: false,
    error: null, notice: "", now, retryAt: 0, completedConstructions: [],
    act(...args) { window.__constructionCommands.push(args); }, actMarket() {}, refresh() {}, refreshMarket() {}, retry() {} };
  useEffect(() => { window.__constructionReady = token; }, [token]);
  if (closed) return React.createElement("p", null, "Closed");
  const shared = { economy, isOnline: true, onClose() { setClosed(true); } };
  return viaMenu ? React.createElement(WorldObjectMenu, { ...shared, initialStationId: stationId,
    selection: { place: worldPlaceForStation(stationId), objectId: stationId + ".position", x: innerWidth / 2, y: innerHeight / 2,
      viewportWidth: innerWidth, viewportHeight: innerHeight } })
    : React.createElement(WorldUpgradeDialog, { ...shared, stationId });
}
window.__mountConstruction = options => { window.__constructionCommands = []; mount.render(React.createElement(Fixture, { ...options, key: options.token })); };
`;

const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-construction-layout-"));
let server, browser;
const errors = [];
let cases = 0, menuPaths = 0, interactions = 0;
try {
  const { chromium } = dependency("playwright");
  server = await createServer({ configFile: false, appType: "custom", root, cacheDir,
    resolve: { alias: { "@": root } }, define: { "process.env.NODE_ENV": JSON.stringify("development") },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, ws: false,
      watch: { ignored: ["**/.next/**", "**/dist/**", "**/.sites-runtime/**"] } },
    plugins: [{ name: "construction-layout-fixture", enforce: "pre",
      resolveId(id) { if (id === entryId) return `\0${id}`; },
      load(id) { if (id === `\0${entryId}`) return entrySource; if (baselineCss && id === join(root, cssPath)) return baselineCss; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/__x00__virtual:construction-layout"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch(await chromiumOptions(chromium));
  const page = await browser.newPage({ viewport: { width: 431, height: 844 }, reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => Array.isArray(window.__constructionBuildings));
  const buildings = await page.evaluate(() => window.__constructionBuildings);
  assert.equal(buildings.length, 10, "The regression matrix must cover every catalog building; update its expected size when buildings change.");
  let token = 0;
  async function mount(stationId, scenario, viaMenu = false) {
    const nextToken = ++token;
    await page.evaluate(options => window.__mountConstruction(options), { stationId, scenario, viaMenu, token: nextToken });
    await page.waitForFunction(value => window.__constructionReady === value, nextToken);
    const dialog = page.locator(`[data-upgrade-station="${stationId}"]`);
    if (viaMenu && stationId !== "home") {
      const progress = page.getByRole("button", { name: "Ход строительства", exact: true });
      if (await progress.count()) await progress.click();
      else await page.locator(`[data-guide-station-upgrade="${stationId}"]`).click();
      menuPaths++;
    }
    await dialog.waitFor({ state: "visible" });
    return dialog;
  }
  async function inspect(dialog, label, prebuild = false) {
    const result = await dialog.evaluate((panel, prebuild) => {
      const rect = element => { const { x, y, width, height, right, bottom } = element.getBoundingClientRect(); return { x, y, width, height, right, bottom }; };
      const work = panel.querySelector("[data-job-id]"), meal = panel.querySelector('[data-meal-boost="builder"]');
      const title = work?.querySelector("strong");
      const timer = prebuild ? panel.querySelector('[class*="durationWithMeal"] > [class*="duration"]') : work;
      return { panel: rect(panel), work: work && rect(work), meal: meal && rect(meal), timer: timer && rect(timer), title: title && rect(title),
        titleLineHeight: title && parseFloat(getComputedStyle(title).lineHeight), width: innerWidth, height: innerHeight,
        workOverflow: work && work.scrollWidth > work.clientWidth + 1,
        footer: prebuild && rect(panel.querySelector("footer")) };
    }, prebuild);
    const { panel, work, meal, timer, title } = result;
    assert.ok(panel.x >= -1 && panel.y >= -1 && panel.right <= result.width + 1 && panel.bottom <= result.height + 1,
      `${label}: dialog leaves viewport: ${JSON.stringify(result)}`);
    assert.ok(meal && timer, `${label}: construction timer and builder food must both render`);
    for (const [name, box] of [["meal", meal], ["timer", timer]]) assert.ok(box.x >= panel.x && box.right <= panel.right + 1,
      `${label}: ${name} leaves dialog: ${JSON.stringify(result)}`);
    if (!prebuild) {
      assert.ok(work.width >= panel.width * .7 && work.height <= 150 && !result.workOverflow,
        `${label}: timer card collapsed or overflowed: ${JSON.stringify(result)}`);
      assert.ok(title.width >= 80 && title.height <= result.titleLineHeight * 3 + 1,
        `${label}: construction title wraps into narrow fragments: ${JSON.stringify(result)}`);
      assert.ok(meal.y >= work.bottom - 1 && Math.abs(meal.width - work.width) <= 2,
        `${label}: food must follow the full-width timer card: ${JSON.stringify(result)}`);
    } else {
      const overlap = Math.min(meal.right, timer.right) - Math.max(meal.x, timer.x) > 1
        && Math.min(meal.bottom, timer.bottom) - Math.max(meal.y, timer.y) > 1;
      assert.ok(!overlap && result.footer.bottom <= panel.bottom + 1, `${label}: preparation footer overlaps or clips: ${JSON.stringify(result)}`);
    }
  }
  async function clickTarget(locator, label, minimum = 44) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    assert.ok(box && box.width >= minimum && box.height >= minimum, `${label}: expected a ${minimum}px pointer target, got ${JSON.stringify(box)}`);
    assert.equal(await locator.isEnabled(), true, `${label}: action is unexpectedly disabled`);
    assert.equal(await locator.evaluate(element => {
      const r = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true, `${label}: another element intercepts the pointer target`);
    await locator.click();
  }
  // Start immediately above the old 430px media-query boundary: this is the
  // original collapse, rather than an incidental failure in another control.
  for (const width of [431, 320, 390, 430, 520, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    for (const stationId of buildings) for (const scenario of ["active", "ready", "meal-saved"]) {
      const label = `${stationId}/${scenario}/${width}px`, dialog = await mount(stationId, scenario);
      await inspect(dialog, label);
      const screenshotDirectory = process.env.CONSTRUCTION_LAYOUT_SCREENSHOT_DIR;
      if (screenshotDirectory && (width === 431 && stationId === "workshop" && scenario === "active"
        || width === 390 && stationId === "garden" && scenario === "ready")) {
        await mkdir(screenshotDirectory, { recursive: true });
        await page.screenshot({ path: join(screenshotDirectory, `${stationId}-${scenario}-${width}.png`) });
      }
      assert.equal(await dialog.locator("[data-meal-applied]").count(), scenario === "meal-saved" ? 1 : 0, `${label}: saved meal state`);
      assert.deepEqual(await page.evaluate(() => window.__constructionCommands), [], `${label}: viewing progress must not send commands`);
      if (scenario === "ready") {
        assert.equal(await dialog.locator("[data-construction-speedup]").count(), 0, `${label}: ready work is free to claim`);
        await clickTarget(dialog.getByRole("button", { name: /^Завершить: Обустройство/ }), label);
        assert.deepEqual(await page.evaluate(() => window.__constructionCommands), [["claim_job", `layout-${stationId}`]], `${label}: normal claim command`);
      } else {
        await clickTarget(dialog.getByRole("button", { name: /^Завершить сейчас за/ }), label);
        assert.deepEqual(await page.evaluate(() => window.__constructionCommands), [], `${label}: opening a quote must not spend pearls`);
        const confirmation = dialog.getByRole("button", { name: /^Подтвердить завершение за/ });
        await clickTarget(confirmation, `${label}/confirm`, 36);
        const commands = await page.evaluate(() => window.__constructionCommands);
        assert.equal(commands.length, 1, `${label}: exactly one speedup command`);
        assert.deepEqual(commands[0].slice(0, 3), ["speedup_construction", `layout-${stationId}`, 1]);
        assert.ok(commands[0][3] > 0, `${label}: speedup must use the quoted price`);
      }
      cases++; interactions++;
    }
  }
  // Exercise the actual object-menu trigger as well as the direct portal mount.
  for (const width of [390, 431, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const stationId of buildings) {
      await inspect(await mount(stationId, "active", true), `${stationId}/object-menu/${width}px`);
      cases++;
    }
  }
  for (const width of [320, 431, 520, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const stationId of ["home", "garden", "bridge"]) for (const scenario of ["prebuild", "prebuild-saved"]) {
      await inspect(await mount(stationId, scenario), `${stationId}/${scenario}/${width}px`, true);
      cases++;
    }
  }
  assert.deepEqual(errors, [], "The real components must run without browser errors");
  console.log(JSON.stringify({ browser: await browser.version(), baselineRef: baselineRef ?? null, buildings: buildings.length,
    widths: [320, 390, 430, 431, 520, 1280], geometryCases: cases, objectMenuClicks: menuPaths, actionCases: interactions, browserErrors: errors.length }));
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
