// Source-only integration: actual Leaftail tab, keyboard confirmation, gates and narrow layout.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "package.json") : import.meta.url);
const { chromium } = require("playwright"), entry = "virtual:relic-exchange-layout";
const source = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { economyCatalog, economyFishingSchema } from "/features/economy/domain/model.ts";
import { WorldLeaftailMarket } from "/features/economy/ui/market/world-leaftail-market.tsx";
import "/app/globals.css";
const now = Date.now(), state = { ownerPublicId: "LAYOUT", revision: 1, serverTime: new Date(now).toISOString(), catalog: structuredClone(economyCatalog),
 inventory: { ancient_core: 1, moon_crystal: 4, living_resin: 0 }, wallet: { coins: 50000, pearls: 0 }, buildings: { home: 4, warehouse: 5 },
 progression: { routes: {}, recipes: {} }, fishing: economyFishingSchema.parse({}), jobs: [], wardrobe: [],
 storage: { capacity: 500, used: 5, available: 495, reserved: 0, overflow: 0 }, food: { heroMeal: null, builderMeal: null } };
window.__commands = [];
function Preview() {
 const [snapshot, setSnapshot] = useState(state), [controls, setControls] = useState({ isOnline: true, busy: false, uncertain: false, notice: null });
 window.__snapshot = snapshot; window.__patch = patch => setSnapshot(current => ({ ...current, ...patch }));
 window.__controls = patch => setControls(current => ({ ...current, ...patch }));
 const economy = { snapshot, snapshotConfirmed: true, now, ...controls, retryAt: 0, directActionsAvailable: true, pendingProductionCount: 0,
  act(...args) { window.__commands.push(args); return true; }, refresh() {}, retry() {} };
 return React.createElement("main", { style: { maxWidth: 620, padding: 12, margin: "20px auto", color: "#344236", background: "#f4eedc", borderRadius: 16 } },
  React.createElement(WorldLeaftailMarket, { economy, isOnline: controls.isOnline, introduced: true }));
}
createRoot(document.getElementById("root")).render(React.createElement(Preview));
`;
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-relic-layout-"));
let server, browser;
const errors = [];
try {
  server = await createServer({ configFile: false, appType: "custom", root, cacheDir, resolve: { alias: { "@": root } },
    define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-dev-runtime", "lucide-react", "zod", "radix-ui"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false, watch: { ignored: ["**/.next/**", "**/dist/**", "**/.sites-runtime/**"] } },
    plugins: [{ name: "relic-layout", enforce: "pre", resolveId(id) { if (id === entry) return `\0${id}`; }, load(id) { if (id === `\0${entry}`) return source; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => { if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"><script>globalThis.process={env:{NODE_ENV:"development"},browser:true};</script></head><body style="margin:0;background:#d8dfd0"><div id="root"></div><script type="module" src="/@id/__x00__virtual:relic-exchange-layout"></script></body></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [320, 1024]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole("tab", { name: "Реликвии", exact: true }).focus(); await page.keyboard.press("Enter");
    const exchange = page.getByRole("region", { name: "Обмен реликвий", exact: true }); await exchange.waitFor();
    assert.equal(await page.getByLabel("Отдать из кладовой").inputValue(), "moon_crystal");
    await page.getByLabel("Получить", { exact: true }).focus(); await page.keyboard.press("End"); await page.keyboard.press("Tab");
    assert.equal(await page.getByLabel("Получить", { exact: true }).inputValue(), "living_resin");
    assert.equal(await page.locator("[data-relic-review]").evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter"); await page.locator("[data-relic-confirmation]").waitFor();
    assert.equal(await page.getByRole("heading", { name: "Подтвердить обмен?", exact: true }).evaluate(node => node === document.activeElement), true);
    assert.match(await exchange.innerText(), /50\s000 → 30\s000/); assert.deepEqual(await page.evaluate(() => window.__commands), []);
    await page.keyboard.press("Escape"); await page.locator("[data-relic-review]").waitFor();
    assert.equal(await page.locator("[data-relic-review]").evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter"); await page.locator("[data-relic-confirmation]").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Confirmation overflow at ${width}px`);
    if (process.env.ECONOMY_SCREENSHOT_DIR) { await mkdir(process.env.ECONOMY_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.ECONOMY_SCREENSHOT_DIR, `relic-confirm-${width}.png`) }); }
    await page.keyboard.press("Tab"); assert.equal(await exchange.getByRole("button", { name: "Назад", exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Tab"); assert.equal(await page.locator("[data-relic-confirm]").evaluate(node => node === document.activeElement), true);
    await page.keyboard.press("Enter"); await page.locator("[data-relic-review]").waitFor();
    assert.deepEqual(await page.evaluate(() => window.__commands), [["exchange_leaftail_relic", "moon_crystal:living_resin", 1, 20000]]);
    assert.deepEqual(await page.evaluate(() => ({ wallet: window.__snapshot.wallet, inventory: window.__snapshot.inventory })),
      { wallet: { coins: 50000, pearls: 0 }, inventory: { ancient_core: 1, moon_crystal: 4, living_resin: 0 } }, "Client never invents successful settlement");
    await page.evaluate(() => { window.__patch({ revision: 2, wallet: { coins: 30000, pearls: 0 }, inventory: { ancient_core: 1, moon_crystal: 2, living_resin: 1 } }); window.__controls({ notice: "Реликвии обменены. Находка отправлена в кладовую" }); });
    await exchange.getByRole("status").filter({ hasText: "Реликвии обменены" }).waitFor();
    await page.locator("[data-relic-review]").click(); await page.evaluate(() => window.__patch({ revision: 3 }));
    await exchange.getByRole("status").filter({ hasText: "Запасы обновились" }).waitFor(); assert.equal(await page.locator("[data-relic-confirm]").isDisabled(), true);
    await page.keyboard.press("Escape"); await page.evaluate(() => window.__patch({ buildings: { home: 3, warehouse: 5 } }));
    await exchange.getByText("Доступно с дома 4.", { exact: true }).waitFor(); assert.equal(await page.locator("[data-relic-review]").isDisabled(), true);
    await page.evaluate(() => window.__patch({ buildings: { home: 4, warehouse: 5 }, inventory: { moon_crystal: 1 }, wallet: { coins: 30000, pearls: 0 } }));
    await exchange.getByRole("status").filter({ hasText: "Сейчас 1" }).waitFor(); assert.equal(await page.locator("[data-relic-review]").isDisabled(), true);
    await page.evaluate(() => window.__patch({ inventory: { moon_crystal: 2 }, wallet: { coins: 19999, pearls: 0 } }));
    await exchange.getByRole("status").filter({ hasText: "Не хватает 1 монет" }).waitFor(); assert.equal(await page.locator("[data-relic-review]").isDisabled(), true);
    await page.evaluate(() => { window.__patch({ wallet: { coins: 30000, pearls: 0 } }); window.__controls({ isOnline: false }); });
    await exchange.getByRole("status").filter({ hasText: "Для обмена нужно соединение" }).waitFor(); assert.equal(await page.locator("[data-relic-review]").isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `Stock/gate overflow at ${width}px`);
    assert.equal(await page.evaluate(() => window.__commands.length), 1, "No additional commands from previews, rejected quotes or gates");
  }
  assert.deepEqual(errors, []);
  console.log("Relic exchange UI: actual Leaftail tab at 320/1024px, keyboard selectors/confirmation/Escape, exact single command, server-only settlement, stale quote, home/stock/coin/offline gates and no overflow passed.");
} finally { await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true }); }
