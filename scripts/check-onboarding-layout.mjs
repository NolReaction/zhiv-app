// Real main-course hooks and coach: account hydration, explicit replay, pause/skip and keyboard focus.
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import ts from "typescript";
const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "package.json") : import.meta.url);
const { chromium } = runtime("playwright");
let executablePath = process.env.BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
try { await access(executablePath); } catch { executablePath = "/tmp/chromium"; }
const entry = "virtual:onboarding-layout.tsx";
const source = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {GuideCoach} from '/features/onboarding/guide-coach.tsx';
import {useWorldOnboarding} from '/features/world/state/use-world-onboarding.ts';
const owner='0000-0000-0001';
function App(){const guide=useWorldOnboarding(owner);
window.__guide=()=>({loaded:guide.loaded,open:guide.open,paused:guide.isPaused,progress:guide.progress});
return <><button onClick={guide.replay}>Повторить вручную</button><button onClick={guide.resume}>Продолжить вручную</button>
<GuideCoach open={guide.open} flow='world' stepId={guide.progress?.status==='started'?'profile':'welcome'}
welcome={!guide.progress} title='Привет! Это наш лес' text='Посадим ягоды, познакомимся с соседями и заглянем в мастерскую.'
notice='Справка с поиском — под кнопкой i. Скрытое обучение можно продолжить: мой уровень → «?» → «Продолжить обучение».'
exitHelp='Вернуться можно через профиль Мохлика (кнопка уровня) → «?» → «Продолжить обучение» или «Повторить обучение».'
pose='greet' progress={guide.progress?.status==='started'?{current:1,total:9}:undefined}
primary={guide.progress?undefined:{label:'Давай попробуем',onClick:guide.start}}
onPause={guide.pause} onSkip={guide.skip}/></>;}
createRoot(document.getElementById('root')).render(<App/>);
`;
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-onboarding-layout-"));
let server, browser;
const errors = [];
try {
  server = await createServer({ root, cacheDir, appType: "custom", configFile: false, resolve: { alias: { "@": root } },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react", "zod"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    plugins: [{ name: "onboarding-layout-fixture", enforce: "pre", resolveId(id) { if (id === entry) return `\0${id}`; },
      load(id) { if (id === `\0${entry}`) return ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next(); response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/@id/__x00__${entry}"></script></html>`);
      }); },
    }],
  }); await server.listen();
  browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process"] });
  const page = await browser.newPage({ viewport: { width: 320, height: 850 }, hasTouch: true });
  page.on("pageerror", error => errors.push(error.message));
  let remote = null; const writes = [];
  await page.route("**/api/v1/onboarding**", async route => {
    if (route.request().method() === "POST") {
      const command = route.request().postDataJSON(); writes.push(command);
      remote = remote === "completed" || command.status === "completed" ? "completed" : command.status;
    }
    await route.fulfill({ json: { ownerPublicId: "0000-0000-0001", app: null, world: remote } });
  });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(server.resolvedUrls.local[0]); await page.evaluate(() => localStorage.clear()); remote = null;
    await page.reload(); await page.getByRole("button", { name: "Давай попробуем" }).waitFor();
    const coach = page.locator('[data-guide-coach="world"]');
    const checkBounds = async () => {
      const geometry = await coach.evaluate(element => { const box=element.getBoundingClientRect();return {left:box.left,right:box.right,bottom:box.bottom,width:innerWidth,height:innerHeight,scroll:element.scrollWidth,client:element.clientWidth}; });
      assert.ok(geometry.left >= -1 && geometry.right <= geometry.width + 1 && geometry.bottom <= geometry.height + 1, `${width}: coach outside viewport`);
      assert.ok(geometry.scroll <= geometry.client + 1, `${width}: horizontal overflow`);
    };
    await checkBounds(); assert.equal(await coach.getByText(/Справка с поиском/).isVisible(), true);
    if (width === 320) await page.screenshot({ path: "/tmp/zhiv-onboarding-welcome-320.png" });
    await page.getByRole("button", { name: "Давай попробуем" }).tap();
    await page.getByRole("button", { name: "Свернуть обучение, сохранив шаг" }).tap();
    await page.getByRole("group", { name: "Приостановить обучение?" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Продолжить обучение");
    await checkBounds(); if (width === 320) await page.screenshot({ path: "/tmp/zhiv-onboarding-exit-320.png" }); await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("group", { name: "Приостановить обучение?" }).count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-guide-pause")), "true");
    await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Скрыть, сохранив шаг" }).tap();
    assert.equal(await coach.count(), 0); assert.equal(await page.evaluate(() => window.__guide().progress.stepId), "profile");
    await page.reload(); await page.waitForFunction(() => window.__guide?.().loaded); assert.equal(await coach.count(), 0);
    await page.getByRole("button", { name: "Продолжить вручную" }).tap();
    await page.getByRole("button", { name: "Подробнее и действия обучения" }).tap();
    await page.getByRole("button", { name: "Пропустить обучение", exact: true }).tap();
    await page.getByRole("button", { name: "Да, пропустить курс" }).tap();
    await page.waitForFunction(() => window.__guide?.().progress?.status === "skipped");
    await page.waitForTimeout(50); assert.equal(writes.at(-1)?.status, "skipped");
    // Simulate another browser with no local guide storage and server completion.
    remote = "completed"; await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.waitForFunction(() => window.__guide?.().loaded); assert.equal(await coach.count(), 0);
    await page.getByRole("button", { name: "Повторить вручную" }).tap(); await coach.waitFor();
    await page.reload(); await coach.waitFor(); assert.equal(await page.evaluate(() => window.__guide().progress.status), "started");
  }
  assert.deepEqual(errors, []);
  console.log("PASS onboarding account hydration, manual replay/reload, pause/skip confirmation, keyboard focus and layouts320/390/1280; zero browser errors");
} finally { await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true }); }
