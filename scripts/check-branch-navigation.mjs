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


import "/app/globals.css";



createRoot(document.getElementById("root")).render(React.createElement(BranchPage));
`;
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-economy-layout-"));
let server, browser;
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

  const page = await browser.newPage({ viewport:{width:1280,height:900}, reducedMotion:"reduce" });
  const requests = [], errors = [];
  page.on("request", request => requests.push(request.url()));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByLabel("Найти ингредиент").waitFor();
  assert.equal(await page.locator("[data-node-id], [data-balance-item], [data-scenario]").count(), 0);
  assert(!requests.some(url => /\/features\/progression\/(?:ui\/(?:analysis|world)|domain\/economy-scenarios|data\/progression-scenarios)/.test(url)), "Catalog must not load unopened analysis/world/report modules");
  const results={};
  const measure=()=>page.evaluate(()=>({dom:document.querySelectorAll("*").length,world:document.querySelectorAll("[data-node-id]").length,balance:document.querySelectorAll("[data-balance-item]").length,items:document.querySelectorAll("[data-item-id]").length,scenarios:document.querySelectorAll("[data-scenario]").length,htmlBytes:document.documentElement.outerHTML.length,overflow:document.documentElement.scrollWidth>innerWidth}));
  for(const [key,label,wait] of [["catalog","Каталог","[data-item-id]"],["development","Развитие","[aria-label=\"Уровень дома для развития\"]"],["rewards","Награды","#economy-pearls"],["analysis","Анализ","[data-production-node]"],["world","Карта связей","[data-node-id]"]]){
    await page.getByRole("tab",{name:label,exact:true}).click();
    await page.locator(wait).first().waitFor();
    results[key]=await measure();
    if(process.env.BRANCH_SCREENSHOT_DIR){await mkdir(process.env.BRANCH_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.BRANCH_SCREENSHOT_DIR,`${key}-1280.png`)});}
  }
  results.wheel=await page.evaluate(async()=>{const e=document.querySelector('[aria-label^="Карта развития."]'); const start=performance.now();for(let i=0;i<12;i++){ e.dispatchEvent(new WheelEvent("wheel",{deltaY:10,cancelable:true,bubbles:true}));await new Promise(requestAnimationFrame);}return performance.now()-start;});
  await page.setViewportSize({width:320,height:740});
  for (const [key,label,wait] of [["catalog","Каталог","[data-item-id]"],["development","Развитие","[aria-label=\"Уровень дома для развития\"]"],["rewards","Награды","#economy-pearls"],["analysis","Анализ","[data-production-node]"],["world","Карта связей","[data-node-id]"]]) {
    await page.getByRole("tab",{name:label,exact:true}).click(); await page.locator(wait).first().waitFor();
    results[key+"320"]=await measure(); if(process.env.BRANCH_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.BRANCH_SCREENSHOT_DIR,`${key}-320.png`)});
  }
  for (const value of Object.values(results)) if (typeof value === "object") assert.equal(value.overflow, false);
  await page.getByRole("tab",{name:"Карта связей",exact:true}).focus();
  await page.keyboard.press("Home"); await page.getByLabel("Найти ингредиент").waitFor();
  assert.equal(await page.getByRole("tab",{name:"Каталог",exact:true}).evaluate(node=>document.activeElement===node),true);
  await page.getByLabel("Найти ингредиент").fill("балка");
  assert.equal(await page.locator("[data-item-id]").count(),1);
  await page.getByLabel("Количество готовых предметов").fill("7");
  await page.getByRole("tab",{name:"Награды",exact:true}).click(); await page.locator("#economy-pearls").waitFor();
  await page.getByRole("tab",{name:"Каталог",exact:true}).click();
  assert.equal(await page.getByLabel("Найти ингредиент").inputValue(),"балка", "Catalog filters survive section unmount");
  assert.equal(await page.getByLabel("Количество готовых предметов").inputValue(),"7", "Calculator quantities survive section unmount");
  await page.getByRole("tab",{name:"Развитие",exact:true}).click();
  await page.getByLabel("Уровень дома для развития").selectOption("4");
  await page.locator("[data-unlock-item=blackberries]").click();
  await page.locator('[data-economy-item="blackberries"]').waitFor();
  await page.waitForFunction(() => document.activeElement === document.getElementById("economy-item-details"));
  assert.equal(new URL(page.url()).hash,"#catalog/blackberries");
  await page.getByRole("tab",{name:"Развитие",exact:true}).click();
  assert.equal(await page.getByLabel("Уровень дома для развития").inputValue(),"4");
  assert(!requests.some(url => url.includes("/branch/reports")), "Report fetch must wait for the report tab");
  let reportRequests=0;
  const reportFixture=await readFile(join(root,"features/progression/data/progression-scenarios.json"),"utf8");
  await page.route("**/branch/reports", route => {reportRequests++;return route.fulfill({status:reportRequests===1?403:200,contentType:"application/json",body:reportRequests===1?'{}':reportFixture});});
  await page.getByRole("tab",{name:"Анализ",exact:true}).click();
  await page.getByRole("tab",{name:"Вылазки",exact:true}).click();
  const rod = page.getByLabel("Удочка для расчёта");
  const rodValue = await rod.locator("option").last().getAttribute("value");
  await rod.selectOption(rodValue);
  await page.getByRole("tab",{name:"Баланс",exact:true}).click(); await page.locator("[data-balance-item]").first().waitFor();
  await page.getByRole("tab",{name:"Вылазки",exact:true}).click();
  assert.equal(await page.getByLabel("Удочка для расчёта").inputValue(),rodValue,"Fishing selection survives tool unmount");
  await page.getByRole("tab",{name:"Прохождение",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"Доступ к отчёту закрыт"}).waitFor();
  await page.getByRole("button",{name:"Повторить",exact:true}).click();
  await page.locator("[data-scenario-state]").waitFor();
  assert.equal(reportRequests,2);
  assert(!requests.some(url => url.includes("progression-scenarios.json")), "Internal report JSON must never be a client asset");
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify(results));
  console.log("Branch navigation: all five sections at 320/1280, keyboard, persistent filters, cross-reference focus, lazy modules and protected report retry passed.");
} finally { await browser?.close();await server?.close();await rm(cacheDir,{recursive:true,force:true}); }
