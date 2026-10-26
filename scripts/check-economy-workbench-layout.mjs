// Source-only browser check; does not rebuild or read dist/.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const require = createRequire(runtime ? join(runtime, "package.json") : import.meta.url);
const { chromium } = require("playwright");
const entry = "virtual:economy-workbench-layout";
const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { BranchPage } from "/features/progression/branch-page.tsx";
import { buildEconomyAnalysis } from "/features/progression/economy-analysis.ts";
import { progressionScenarioReport, scenarioReportState } from "/features/progression/economy-scenarios.ts";
import "/app/globals.css";
window.__economyAnalysis = buildEconomyAnalysis();
window.__scenarioReport = { state: scenarioReportState(progressionScenarioReport), report: progressionScenarioReport };
window.location.hash = "economy-analysis";
createRoot(document.getElementById("root")).render(React.createElement(BranchPage));
`;
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-economy-layout-"));
let server, browser, cases = 0;
const errors = [];
try {
  server = await createServer({ configFile: false, appType: "custom", root, cacheDir,
    resolve: { alias: { "@": root } }, define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime", "lucide-react", "zod", "next/link"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false, watch: { ignored: ["**/.next/**", "**/dist/**", "**/.sites-runtime/**"] } },
    plugins: [{ name: "economy-workbench-fixture", enforce: "pre",
      resolveId(id) { if (id === entry) return `\0${id}`; },
      load(id) { if (id === `\0${entry}`) return source; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка экономики</title><script>globalThis.process={env:{NODE_ENV:"development"},browser:true};</script></head><body style="margin:0"><div id="root"></div><script type="module" src="/@id/__x00__virtual:economy-workbench-layout"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ acceptDownloads: true, reducedMotion: "reduce" });
  page.on("pageerror", error => { errors.push(error.message); console.error("Browser exception:", error.stack); });
  async function screenshot(name) {
    if (!process.env.ECONOMY_SCREENSHOT_DIR) return;
    await mkdir(process.env.ECONOMY_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.ECONOMY_SCREENSHOT_DIR, name), fullPage: false });
  }
  async function noOverflow(label) {
    const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
      panel: document.querySelector('[aria-label="Ингредиенты и расчёты экономики"]').clientWidth,
      scroll: document.querySelector('[aria-label="Ингредиенты и расчёты экономики"]').scrollWidth }));
    assert(size.document <= size.viewport + 1, `${label}: document overflow`);
    assert(size.scroll <= size.panel + 1, `${label}: economy panel overflow`);
  }
  for (const width of [320, 1024]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole("tab", { name: "Цепочки", exact: true }).waitFor();
    await page.locator("#economy-analysis").scrollIntoViewIfNeeded();
    await screenshot(`chains-${width}.png`);
    await noOverflow(`${width}/initial`);
    const stats = await page.evaluate(() => ({ items: window.__economyAnalysis.items.length, nodes: window.__economyAnalysis.graph.nodes.length,
      selected: window.__economyAnalysis.items.find(item => item.id === "packed_berries")?.id ?? "dried_berries" }));
    await page.getByLabel("Товар на производственной схеме").selectOption(stats.selected);
    assert(await page.locator(`[data-production-node="item:${stats.selected}"]`).count() > 0);
    const focusedNodes = await page.locator("[data-production-node]").count();
    await page.getByLabel("Показать применения", { exact: true }).check();
    assert(await page.locator("[data-production-node]").count() >= focusedNodes);
    await page.getByLabel("Показать применения", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Весь каталог", exact: true }).click();
    assert.equal(await page.locator("[data-production-node]").count(), stats.nodes);
    await noOverflow(`${width}/all-graph`);
    await page.getByRole("button", { name: "Цепочка товара", exact: true }).click();
    await page.getByLabel("Товар на производственной схеме").selectOption("field_kit");
    const graphViewport = page.locator("[data-production-graph]");
    await graphViewport.scrollIntoViewIfNeeded();
    const beforePan = await graphViewport.evaluate(node => node.scrollLeft);
    const bounds = await graphViewport.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 10);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + 10, { steps: 5 });
    await page.mouse.up();
    assert(await graphViewport.evaluate(node => node.scrollLeft) < beforePan, "Complex graph can be panned with pointer");
    await noOverflow(`${width}/complex-graph`);
    await screenshot(`complex-chain-${width}.png`);
    cases++;

    await page.getByRole("tab", { name: "Баланс", exact: true }).click();
    assert.equal(await page.locator("[data-balance-item]").count(), stats.items);
    await page.getByLabel("Поиск в таблице баланса").fill("малина");
    assert.equal(await page.locator("[data-balance-item]").count(), 1);
    assert.equal(await page.locator("[data-balance-item]").getAttribute("data-balance-item"), "berries");
    await noOverflow(`${width}/balance`);
    await screenshot(`balance-${width}.png`);
    const [csvDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV всех товаров", exact: true }).click()]);
    const csv = await readFile(await csvDownload.path(), "utf8");
    assert.equal(csv.trim().split(/\r?\n/).length, stats.items + 1, "Export includes full catalog despite search");
    assert(csv.startsWith("\uFEFF"), "CSV has UTF-8 BOM");
    assert(csv.includes("Малина") && csv.includes("Сушёные ягоды"), "Cyrillic catalog names survive native download");
    const [jsonDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "JSON всей схемы", exact: true }).click()]);
    const json = JSON.parse(await readFile(await jsonDownload.path(), "utf8"));
    assert.equal(json.analysis.items.length, stats.items); assert.equal(json.analysis.graph.nodes.length, stats.nodes);
    const jarSource = json.analysis.sources.find(source => source.rewards.ceramic_jar);
    assert.equal(jarSource.cost.items.clay, 2);
    assert(json.analysis.graph.edges.some(edge => edge.from === "item:clay" && edge.to === jarSource.id && edge.quantity === 2), "Downloaded graph preserves material amounts");
    cases++;

    await page.getByRole("tab", { name: "Вылазки", exact: true }).click();
    await page.getByLabel("Удочка для расчёта").selectOption("reed_rod");
    assert(await page.locator("[data-analysis-route]").count() > 0);
    assert(await page.getByRole("region", { name: "Шансы видов рыб", exact: true }).isVisible());
    await noOverflow(`${width}/expeditions`); await screenshot(`expeditions-${width}.png`);
    cases++;

    await page.getByRole("tab", { name: "Вылазки", exact: true }).focus();
    await page.keyboard.press("End");
    assert.equal(await page.getByRole("tab", { name: "Прохождение", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("tab", { name: "Прохождение", exact: true }).evaluate(node => document.activeElement === node), true);
    const scenarios = await page.evaluate(() => window.__scenarioReport);
    if (["validated", "review"].includes(scenarios.state)) {
      assert.equal(await page.locator("[data-scenario]").count(), scenarios.report.scenarios.length);
      await page.getByLabel("Бюджет в сценариях").selectOption("free");
      assert.equal(await page.locator("[data-scenario]").count(), scenarios.report.scenarios.filter(row => row.externalPearls === 0).length);
      const [scenariosCsvDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV прогонов", exact: true }).click()]);
      const scenarioCsv = await readFile(await scenariosCsvDownload.path(), "utf8");
      assert.equal(scenarioCsv.trim().split(/\r?\n/).length, scenarios.report.scenarios.length + 1, "Scenario export includes all funding modes despite filter");
      const [scenariosJsonDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "JSON прогонов", exact: true }).click()]);
      assert.deepEqual(JSON.parse(await readFile(await scenariosJsonDownload.path(), "utf8")), scenarios.report);
      await page.getByLabel("Цель в сценариях").selectOption("full");
      assert.equal(await page.locator("[data-scenario]").count(), scenarios.report.scenarios.filter(row => row.goal === "full" && row.externalPearls === 0).length);
      await page.getByLabel("Бюджет в сценариях").selectOption("external");
      assert.equal(await page.locator("[data-scenario]").count(), scenarios.report.scenarios.filter(row => row.goal === "full" && row.externalPearls > 0).length);
      if (!scenarios.report.scenarios.some(row => row.goal === "full" && row.externalPearls > 0)) assert(await page.getByText("Нет прогонов с выбранной целью и бюджетом.").isVisible());
      await page.getByLabel("Цель в сценариях").selectOption("all");
      await page.getByLabel("Бюджет в сценариях").selectOption("all");
      await page.locator("[data-scenario]").last().getByRole("button").click();
      assert(await page.getByRole("region", { name: "Подробности прохождения", exact: true }).evaluate(node => node === document.activeElement));
      await page.getByRole("region", { name: "Сравнение прохождений, горизонтальная прокрутка", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
    } else {
      assert.equal(await page.locator("[data-scenario]").count(), 0, "Unpublished or stale evidence is hidden");
    }
    await noOverflow(`${width}/scenarios`); await screenshot(`scenarios-${width}.png`);
    cases++;

    await page.getByRole("tab", { name: "План", exact: true }).click();
    const initialLaunches = await page.locator("[data-plan-launches]").textContent();
    await page.getByLabel("Добавить запас", { exact: true }).selectOption("dried_berries");
    await page.getByRole("button", { name: "Добавить запас в список", exact: true }).click();
    assert.notEqual(await page.locator("[data-plan-launches]").textContent(), initialLaunches, "Available finished product removes its production chain");
    assert.equal(await page.locator("[data-plan-launches]").textContent(), "0");
    await page.getByRole("button", { name: "Удалить запас: Сушёные ягоды", exact: true }).click();
    assert.equal(await page.locator("[data-plan-launches]").textContent(), initialLaunches);
    await page.getByLabel("Места производства для плана").selectOption("3");
    await page.getByLabel("Добавить цель", { exact: true }).selectOption("ceramic_jar");
    await page.getByRole("button", { name: "Добавить цель в список", exact: true }).click();
    await page.getByLabel("Хозяйство для плана").selectOption("1");
    assert.equal(await page.locator("[data-plan-elapsed]").textContent(), "Не определено");
    await page.getByLabel("Хозяйство для плана").selectOption("0");
    assert.notEqual(await page.locator("[data-plan-elapsed]").textContent(), "Не определено");
    await noOverflow(`${width}/plan`); await screenshot(`plan-${width}.png`);
    const [planDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "JSON плана", exact: true }).click()]);
    const plan = JSON.parse(await readFile(await planDownload.path(), "utf8"));
    assert.deepEqual(plan.plan.targets, { ceramic_jar: 1, dried_berries: 1 });
    assert.equal(plan.plan.complete, true); assert(plan.plan.operations.length > 0);
    assert(plan.plan.operations.some(operation => operation.inputs.clay === 2), "Downloaded plan preserves ingredient quantities");
    cases++;
  }
  assert.deepEqual(errors, [], "No browser exceptions");
  console.log(`Economy workbench browser: ${cases} scenarios passed at 320/1024px; native CSV and JSON downloads verified; 0 page errors.`);
} finally {
  await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true });
}
