// Real Chromium gate for resident tabs, reputation and reviewed weekly contracts.
// The fixture runs actual components and domain selectors without a dist build.
// Requires Playwright and Chromium (or BROWSER_EXECUTABLE_PATH).
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const localRequire = createRequire(import.meta.url);
const runtimeRequire = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? createRequire(join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "package.json")) : null;
const exists = async path => { try { await access(path, constants.X_OK); const info = await stat(path); return info.isFile() && info.size > 0; } catch { return false; } };
function dependency(name) {
  for (const require of [localRequire, runtimeRequire].filter(Boolean)) {
    try { return require(name); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  }
  throw new Error(`${name} is required. Install it locally, or set CODEX_PRIMARY_RUNTIME_NODE_MODULES.`);
}
async function chromiumOptions(chromium) {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? process.env.BROWSER_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const candidates = configured ? [configured] : [chromium.executablePath(),
    ...(process.env.PATH ?? "").split(delimiter).flatMap(directory => ["chromium", "chromium-browser", "google-chrome"].map(name => join(directory, name))),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(tmpdir(), "zhiv-browser-qa/bin/chromium"), "/tmp/chromium"];
  const index = (await Promise.all(candidates.map(exists))).findIndex(Boolean);
  if (index < 0) throw new Error("Chromium is missing. Set BROWSER_EXECUTABLE_PATH to an existing browser executable.");
  return { headless: true, executablePath: candidates[index], args: ["--no-sandbox", "--disable-dev-shm-usage"] };
}

const entryId = "virtual:trade-relations-layout";
const entrySource = `
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorldOrderJournal } from "/features/economy/ui/orders/world-order-journal.tsx";
import { economyCatalog, economyFishingSchema, economyTradeRelationsSchema } from "/features/economy/domain/model.ts";
import { newEconomyState } from "/features/economy/domain/rules.ts";
import { acceptWeeklyOrder, weeklyOrderBoard } from "/features/economy/domain/trade-relations.ts";
import "/app/globals.css";
const h = React.createElement, initialNow = Date.parse("2026-10-23T17:00:00Z");
const residents = ["builder", "lopukh", "kamneshmyg", "plesk", "leaftail"];
const mount = createRoot(document.getElementById("root"));
function snapshot(tutorialOnly) {
  const catalog = structuredClone(economyCatalog);
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 5, workshopLevel: 5 });
  const buildings = Object.fromEntries(catalog.buildings.map(building => [building.id, building.levels.at(-1)?.level ?? 0]));
  const stages = Object.fromEntries((catalog.stageOrders ?? []).map(stage => [stage.homeLevel, { step: stage.orders.length, completed: true,
    terms: null, availableAt: null, intervalSeconds: null, completionRewards: null }]));
  const fishing = economyFishingSchema.parse({ ownedRods: catalog.fishing.rods.map(rod => rod.id), equippedRodId: catalog.fishing.rods.at(-1).id,
    ownedHooks: catalog.fishing.hooks.map(hook => hook.id), equippedHookId: catalog.fishing.hooks.at(-1).id, catches: {}, stock: {} });
  return { ...state, ownerPublicId: "ABCD-EFGH-JKMN", revision: 7, serverTime: new Date(initialNow).toISOString(), catalog, buildings, fishing,
    progression: { ...state.progression, recipes: Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, 1])),
      routes: Object.fromEntries(catalog.explorations.map(route => [route.id, 1])) },
    wallet: { coins: 1000000, pearls: 1000 }, inventory: tutorialOnly ? { ...catalog.onboarding.residentOrder.items } : {},
    tutorialOrder: { version: 3, step: 0, ingredientsClaimed: tutorialOnly, completed: !tutorialOnly, firstHarvestPrepared: true, terms: null },
    stageOrders: { version: 1, stages },
    tradeRelations: economyTradeRelationsSchema.parse({ reputation: { builder: 350, lopukh: 100, kamneshmyg: 800, plesk: 1600, leaftail: 350 },
      activity: Object.fromEntries(residents.map(id => [id, { pointsBps: 10000, updatedAt: new Date(initialNow).toISOString() }])),
      dailyCycle: Math.floor(initialNow / 86400000), dailyOrderXp: { builder: 17 } }),
    storage: { capacity: 1000, used: tutorialOnly ? 1 : 0, reserved: 0, available: 1000, overflow: 0 } };
}
function Fixture({ token, tutorialOnly, introduced }) {
  const [state, setState] = useState(() => snapshot(tutorialOnly)), [now, setNow] = useState(initialNow);
  useEffect(() => {
    window.__tradeReady = token; window.__tradeRevision = state.revision;
    window.__tradeMutate = kind => setState(previous => ({ ...previous, revision: previous.revision + 1,
      ...(kind === "owner" ? { ownerPublicId: "PQRS-TVWX-YZ12", tradeRelations: economyTradeRelationsSchema.parse({}) } : {}) }));
    window.__tradeAdvance = seconds => setNow(value => value + seconds * 1000);
  }, [token, state.revision]);
  const economy = { snapshot: state, snapshotConfirmed: true, now, retryAt: 0, busy: false, uncertain: false, error: null, notice: "",
    directActionsAvailable: true, pendingProductionCount: 0, retry() {}, act(action, targetId, quantity, totalPrice) {
      window.__tradeCommands.push({ action, targetId, quantity, totalPrice, owner: state.ownerPublicId, revision: state.revision });
      if (action !== "accept_weekly_order") return false;
      const choice = weeklyOrderBoard(state, now, state.catalog).offers.find(candidate => candidate.id === targetId);
      if (!choice) return false;
      const next = structuredClone(state); acceptWeeklyOrder(next, choice, now, next.catalog); next.revision++;
      setState(next); return true;
    } };
  return h("main", { "data-trade-fixture": true, style: { margin: "0 auto", maxWidth: 980, width: "100%", padding: 10, boxSizing: "border-box", background: "#ece4c9" } },
    h(WorldOrderJournal, { economy, tutorialOnly, introducedResidents: introduced ?? residents }));
}
window.__mountTrade = options => { window.__tradeCommands = []; mount.render(h(Fixture, { ...options, key: options.token })); };
window.__tradeBooted = true;
`;

const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-trade-relations-layout-"));
let server, browser, token = 0, cases = 0;
const errors = [];
try {
  const { chromium } = dependency("playwright");
  server = await createServer({ configFile: false, appType: "custom", root, cacheDir,
    resolve: { alias: { "@": root } }, define: { "process.env.NODE_ENV": JSON.stringify("development") },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime", "radix-ui", "lucide-react", "zod", "clsx", "tailwind-merge", "class-variance-authority"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false, watch: { ignored: ["**/.next/**", "**/dist/**", "**/.sites-runtime/**"] } },
    plugins: [{ name: "trade-relations-layout-fixture", enforce: "pre",
      resolveId(id) { if (id === entryId) return `\0${id}`; },
      load(id) { if (id === `\0${entryId}`) return entrySource; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Торговые отношения: проверка</title></head><body style="margin:0;background:#354c3d"><div id="root"></div><script type="module" src="/@id/__x00__virtual:trade-relations-layout"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch(await chromiumOptions(chromium));
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.__tradeBooted);
  async function mount(options = {}) {
    const nextToken = ++token;
    await page.evaluate(value => window.__mountTrade(value), { ...options, token: nextToken });
    await page.waitForFunction(value => window.__tradeReady === value, nextToken);
  }
  async function screenshot(name) {
    const directory = process.env.TRADE_RELATIONS_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, name), fullPage: false });
  }
  const sizes = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1024, height: 768 }];
  const residents = ["builder", "lopukh", "kamneshmyg", "plesk", "leaftail"];
  for (const size of sizes) {
    await page.setViewportSize(size); await mount();
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshot(`initial-${size.width}.png`);
    const label = `${size.width}x${size.height}`;
    const tabs = page.locator('[data-order-resident-tabs] [role="tab"]');
    assert.equal(await tabs.count(), 6, `${label}: All and five residents stay available`);
    const geometry = await tabs.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(), photo = element.firstElementChild.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, height: box.height, photoWidth: photo.width, photoHeight: photo.height };
    }));
    const strip = await page.locator('[data-order-resident-tabs]').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    assert.ok(strip.scrollWidth <= strip.clientWidth + 1, `${label}: all six tabs fit without horizontal scrolling`);
    assert.ok(Math.abs(geometry[0].left - strip.left) <= 1 && Math.abs(geometry.at(-1).right - strip.right) <= 1,
      `${label}: character tabs fill the entire row`);
    for (const box of geometry) {
      assert.ok(box.width >= 44 && box.height >= 44, `${label}: portrait tabs need usable touch targets`);
      assert.ok(Math.abs(box.width - geometry[0].width) <= 1, `${label}: all tabs share the row evenly`);
      assert.ok(box.photoWidth >= (size.width >= 620 ? 72 : size.width >= 390 ? 40 : 34), `${label}: portraits use the available column width`);
      assert.ok(box.photoWidth <= box.width - 4 && box.photoHeight <= box.height - 12, `${label}: portraits stay inside their tabs`);
    }
    assert.equal(await page.locator('[data-order-journal] details').count(), 0, `${label}: journal has no instruction disclosures`);
    const colors = new Set();
    for (const resident of residents) {
      await page.locator(`[data-order-filter="${resident}"]`).click();
      await page.locator(`[data-order-relations="${resident}"]`).waitFor();
      assert.equal(await page.locator(`[data-order-filter="${resident}"]`).getAttribute("aria-selected"), "true");
      const snapshot = await page.locator("[data-order-journal]").evaluate(element => ({
        width: document.documentElement.scrollWidth, customer: element.dataset.orderCustomer,
        accent: getComputedStyle(element).getPropertyValue("--resident-accent").trim(),
        panel: element.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
        selected: element.querySelector('[role="tab"][aria-selected="true"]')?.id,
      }));
      assert.equal(snapshot.customer, resident, `${label}/${resident}: heading follows selected tab`);
      assert.ok(snapshot.width <= size.width, `${label}/${resident}: page must not scroll horizontally`);
      assert.equal(snapshot.panel, snapshot.selected, `${label}/${resident}: accessible panel follows its tab`);
      colors.add(snapshot.accent);
      assert.equal(await page.locator("[data-order-daily-reputation]").count(), 1, `${label}/${resident}: daily reputation allowance is visible`);
      if (resident === "builder") await screenshot(`profile-${size.width}.png`);
      cases++;
    }
    assert.equal(colors.size, 5, `${label}: residents have distinct themes`);
    assert.deepEqual(await page.evaluate(() => window.__tradeCommands), [], `${label}: browsing cannot send commands`);
    const all = page.locator('[data-order-filter="all"]');
    await all.click();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.locator('[data-order-filter="builder"]').click();
    const profileTop = await page.locator('[data-order-relations="builder"]').evaluate(element => element.getBoundingClientRect().top);
    assert.ok(profileTop >= -1 && profileTop < size.height - 80,
      `${label}: switching from a long All list must reveal the resident profile, got top=${profileTop}`);
    await all.click(); await all.focus(); await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator('[data-order-filter="builder"]').getAttribute("aria-selected"), "true", `${label}: arrow navigation selects next resident`);
    await page.keyboard.press("End");
    assert.equal(await page.locator('[data-order-filter="leaftail"]').getAttribute("aria-selected"), "true");
    await page.keyboard.press("Home"); assert.equal(await all.getAttribute("aria-selected"), "true");
    await page.locator("[data-weekly-choice]").first().locator("button").click();
    const review = page.locator("[data-weekly-review]"); await review.waitFor();
    assert.equal(await review.locator("ol > li").count(), 3, `${label}: all three stages can be reviewed`);
    assert.deepEqual(await page.evaluate(() => window.__tradeCommands), [], `${label}: reviewing does not accept the contract`);
    const revision = await page.evaluate(() => window.__tradeRevision);
    await page.evaluate(() => window.__tradeMutate("revision"));
    await page.waitForFunction(value => window.__tradeRevision > value, revision);
    const accept = review.getByRole("button", { name: "Взять поручение на 7 дней" });
    assert.equal(await accept.isDisabled(), true, `${label}: a changed revision needs a fresh review`);
    await accept.evaluate(button => button.click());
    assert.deepEqual(await page.evaluate(() => window.__tradeCommands), [], `${label}: stale review cannot submit`);
    await review.getByRole("button", { name: "К выбору поручения" }).click();
    await page.locator("[data-weekly-choice]").first().locator("button").click();
    await review.getByRole("button", { name: "Взять поручение на 7 дней" }).click();
    await page.locator('[data-weekly-order="true"]').waitFor();
    const commands = await page.evaluate(() => window.__tradeCommands);
    assert.equal(commands.length, 1, `${label}: accepted contract sends exactly one command`);
    assert.equal(commands[0].action, "accept_weekly_order");
    assert.equal(commands[0].quantity, 1); assert.equal(commands[0].totalPrice, 0);
    assert.equal(await page.locator("[data-weekly-choice]").count(), 0, `${label}: only one weekly contract is active`);
    cases++;
    await screenshot(`orders-${size.width}.png`);
    await mount();
    await page.locator("[data-weekly-choice]").first().locator("button").click();
    await page.evaluate(() => window.__tradeMutate("owner"));
    await page.locator("[data-weekly-review]").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.__tradeCommands), [], `${label}: switching owner cannot accept a previous review`);
    cases++;
    await mount({ introduced: ["builder", "plesk"] });
    assert.equal(await page.locator('[data-order-resident-tabs] [role="tab"]:disabled').count(), 3);
    const lockedText = await page.locator("[data-order-journal]").innerText();
    assert.doesNotMatch(lockedText, /Лопоух|Камнешмыг|Листохвост/, `${label}: unknown resident names cannot leak in All`);
    await page.locator('[data-order-filter="all"]').focus(); await page.keyboard.press("End");
    assert.equal(await page.locator('[data-order-filter="plesk"]').getAttribute("aria-selected"), "true", `${label}: keyboard navigation skips locked residents`);
    await mount({ tutorialOnly: true, introduced: ["builder", "plesk"] });
    assert.equal(await page.locator("[data-order-resident-tabs], [data-weekly-chooser], [data-order-relations]").count(), 0, `${label}: the tutorial stays focused on its one request`);
    assert.equal(await page.locator("[data-tutorial-order]").count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__tradeCommands), []);
    cases++;
  }
  assert.deepEqual(errors, [], "The actual journal must run without browser errors");
  console.log(JSON.stringify({ browser: await browser.version(), cases, widths: sizes.map(size => size.width), browserErrors: errors.length }));
} finally {
  await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true });
}
