// Source-only regression for bounded food previews, named fish and public find odds.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "package.json") : import.meta.url);
const { chromium } = require("playwright"), entry = "virtual:economy-v14-layout";
const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { economyCatalog, economyFishingSchema } from "/features/economy/domain/model.ts";
import { fishClassInventory } from "/features/economy/domain/fishing.ts";
import { WorldProductionCard } from "/features/economy/ui/production/world-production-card.tsx";
import { WorldMealBoost } from "/features/economy/ui/food/world-meal-boost.tsx";
import { ExpeditionRouteDetails } from "/features/economy/ui/expeditions/world-expeditions-menu.tsx";
import "/app/globals.css";
const catalog = structuredClone(economyCatalog), mode = new URLSearchParams(location.search).get("mode"), now = Date.now();
const stock = Object.fromEntries(catalog.fishing.fish.map(fish => [fish.itemId, 5]));
const state = { ownerPublicId: "LAYOUT", revision: 1, serverTime: new Date(now).toISOString(), catalog,
 inventory: { ...Object.fromEntries(catalog.items.filter(item => !catalog.fishing.fish.some(fish => fish.itemId === item.id)).map(item => [item.id, 5])), ...fishClassInventory(stock, catalog.fishing) },
 wallet: { coins: 100000, pearls: 2000 }, buildings: Object.fromEntries(catalog.buildings.map(building => [building.id, Math.max(...building.levels.map(level => level.level))])),
 progression: { routes: {}, recipes: Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, 100])) },
 fishing: economyFishingSchema.parse({ stock }), jobs: [], storage: { capacity: 500, used: 200, available: 300, reserved: 0, overflow: 0 },
 food: mode === "meal" ? { heroMeal: "grilled_fish", builderMeal: null, heroMealEffect: { speedBps: 2500, remainingWorkSeconds: 300, totalWorkSeconds: 1800 } } : { heroMeal: null, builderMeal: null },
};
window.__commands=[];
const economy = { snapshot: state, snapshotConfirmed: true, now, busy: false, uncertain: false, error: null, retryAt: 0,
 act(...args) { window.__commands.push(args); return true; }, refresh() {}, retry() {} };
const h = React.createElement;
const content = mode === "fish" ? h(WorldProductionCard, { economy, recipe: catalog.recipes.find(recipe => recipe.fishInput?.exactSpecies) })
 : mode === "route" ? h(ExpeditionRouteDetails, { economy, state, route: catalog.explorations.find(route => route.id === "forest"), exploring: false, onOpenPantry() {} })
 : h(WorldMealBoost, { economy, consumer: "hero", seconds: 600, onNavigateStation() {} });
createRoot(document.getElementById("root")).render(h("main", { style: { maxWidth: 390, padding: 16, margin: "30px auto", color: "#344236", background: "#f4eedc", borderRadius: 16 } }, content));
`;
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-v14-layout-"));
let server, browser, cases = 0;
const errors = [];
try {
  server = await createServer({ configFile: false, appType: "custom", root, cacheDir, resolve: { alias: { "@": root } },
    define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime", "lucide-react", "zod", "radix-ui"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false, watch: { ignored: ["**/.next/**", "**/dist/**", "**/.sites-runtime/**"] } },
    plugins: [{ name: "v14-layout", enforce: "pre", resolveId(id) { if (id === entry) return `\0${id}`; }, load(id) { if (id === `\0${entry}`) return source; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => { if (!request.url.startsWith("/?mode=")) return next();
        response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>globalThis.process={env:{NODE_ENV:"development"},browser:true};</script></head><body style="margin:0;background:#d8dfd0"><div id="root"></div><script type="module" src="/@id/__x00__virtual:economy-v14-layout"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [320, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    for (const mode of ["fish", "meal", "picker", "route"]) {
      await page.goto(`${server.resolvedUrls.local[0]}?mode=${mode}`);
      await page.locator("main").waitFor();
      if (mode === "fish") {
        await page.locator("[data-recipe]").click(); await page.locator("[data-fish-selection]").waitFor();
        assert.equal(await page.locator("[data-fish-required-species]").count(), 1);
        assert.equal(await page.locator("[data-fish-choice]").count(), 1);
        assert(await page.locator("[data-fish-confirm]").isEnabled());
      } else if (mode === "meal") {
        assert.match(await page.locator("[data-meal-work-remaining]").innerText(), /Осталось 5 мин из 30 мин/);
        assert.equal(await page.getByRole("button", { name: /Убрать остаток/ }).count(), 1);
      } else if (mode === "picker") {
        await page.getByRole("button", { name: "Еда: ускорить вылазку", exact: true }).click();
        await page.locator("[data-boost-meal=grilled_fish] button").click();
        assert(await page.locator("[data-meal-work-budget]").isVisible());
        assert(await page.locator("[data-meal-confirm]").isEnabled());
      } else {
        assert(await page.locator("[data-expedition-find-odds]").isVisible());
        assert.match(await page.locator("[data-expedition-find-odds]").innerText(), /Результат станет известен после получения/);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `${mode} overflow at ${width}`);
      if (process.env.ECONOMY_SCREENSHOT_DIR) { await mkdir(process.env.ECONOMY_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.ECONOMY_SCREENSHOT_DIR, `${mode}-${width}.png`) }); }
      assert.deepEqual(await page.evaluate(() => window.__commands), [], "Reading and choosing never spends");
      if (mode === "fish" || mode === "picker") { await page.keyboard.press("Escape"); assert.equal(await page.locator(mode === "fish" ? "[data-fish-selection]" : "[data-meal-picker]").count(), 0); }
      cases++;
    }
  }
  assert.deepEqual(errors, []);
  console.log(`Economy v14 UI: ${cases} scenarios passed at 320/1024px; named fish, frozen meal budget, bounded preview, public chance findings, Escape and zero accidental commands verified.`);
} finally { await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true }); }
