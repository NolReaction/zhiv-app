// Real pointer/layout regression: a mail notice must work above an open game dialog.
// Optional MAILBOX_LAYOUT_BASELINE_REF reruns this against the previous styles.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, "package.json") : import.meta.url);
const { chromium } = runtime("playwright");
let executablePath = process.env.BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
try { await access(executablePath); } catch { executablePath = "/tmp/chromium"; }
const args = ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process"];
const baseline = process.env.MAILBOX_LAYOUT_BASELINE_REF;
const baselineFiles = ["features/mailbox/mailbox.module.css", "components/app-notifications.tsx"];
const originals = new Map(baseline ? baselineFiles.map(path => [join(root, path), execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root, encoding: "utf8" })]) : []);
const entry = "virtual:mailbox-layout.tsx";
const source = `
import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from 'radix-ui';
import { AppNotifications } from '/components/app-notifications.tsx';
import { MailboxNotifications } from '/features/mailbox/mailbox-notifications.tsx';
import { MailboxDialog } from '/features/mailbox/mailbox-dialog.tsx';
import { createMailboxSession } from '/features/mailbox/session.ts';
import styles from '/features/world/world.module.css';
const owner='7K3P-2Q9M-W8ZR', id='00000000-0000-4000-8000-000000000001', time='2026-10-22T12:00:00Z';
const session=createMailboxSession(owner,{list:async()=>({ownerPublicId:owner, unreadCount:1, nextCursor:null, serverTime:time,
 messages:[{id,type:'admin_notice',title:'Письмо для проверки',body:'Текст письма',createdAt:time,readAt:null,notify:true,attachments:null}],
 latestUnreadNotification:{id,createdAt:time}}),read:async()=>({ownerPublicId:owner,id,readAt:time,unreadCount:0,serverTime:time})});
session.activate();
window.__mailNotice=()=>session.refresh();
window.__mailOpened=()=>session.getSnapshot().opened;
function App(){const view=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
 const mailbox={...view,...session,isOnline:true};
 return <><AppNotifications/><Dialog.Root open><Dialog.Portal>
 <Dialog.Overlay data-slot='dialog-overlay' className={styles.sheetScrim}/>
 <Dialog.Content data-slot='dialog-content' className={styles.sheet} aria-describedby={undefined}>
 <Dialog.Title>Игровое окно</Dialog.Title><button>Действие в игре</button></Dialog.Content>
 </Dialog.Portal></Dialog.Root><MailboxNotifications mailbox={mailbox}/><MailboxDialog mailbox={mailbox}/></>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-mailbox-layout-"));
let server, browser;
const errors = [];
try {
  server = await createServer({ root, cacheDir, appType: "custom", configFile: false, resolve: { alias: { "@": root } },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "radix-ui", "lucide-react", "next-themes", "sonner", "class-variance-authority", "clsx", "tailwind-merge", "zod"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    plugins: [{ name: "mailbox-layout-fixture", enforce: "pre",
      resolveId(id) { if (id === entry) return `\0${id}`; },
      load(id) { if (id === `\0${entry}`) return ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText; return originals.get(id); },
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/@id/__x00__${entry}"></script></html>`);
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath, args });
  const page = await browser.newPage({ viewport: { width: 320, height: 900 }, hasTouch: true });
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(server.resolvedUrls.local[0]);
    try { await page.getByRole("heading", { name: "Игровое окно" }).waitFor({ timeout: 10000 }); }
    catch (error) { console.error((await page.content()).slice(0, 3500)); throw error; }
    assert.equal(await page.evaluate(() => document.body.style.pointerEvents), "none", "real Radix modal blocks background pointer input");
    await page.evaluate(() => window.__mailNotice());
    const button = page.getByRole("button", { name: "Открыть почту", exact: true });
    await button.waitFor();
    assert.equal(await button.evaluate(element => getComputedStyle(element).pointerEvents), "auto", `${width}: mail action inherits a modal pointer lock`);
    await button.tap({ timeout: 3000 });
    assert.equal(await page.evaluate(() => window.__mailOpened()), true, `${width}: first tap must open mail`);
    const dialog = page.getByRole("dialog", { name: /^Почта/ });
    await dialog.waitFor();
    const geometry = await dialog.evaluate(element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, width: innerWidth,
        topmost: element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
    });
    assert.ok(geometry.left >= -1 && geometry.right <= geometry.width + 1, `${width}: mailbox overflows the viewport`);
    assert.equal(geometry.topmost, true, `${width}: existing game dialog covers the mailbox`);
    await page.getByRole("button", { name: /Письмо для проверки/ }).tap();
    await page.getByRole("heading", { name: "Письмо для проверки" }).waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor();
    await page.getByRole("button", { name: "Закрыть почту", exact: true }).tap();
    assert.equal(await page.evaluate(() => window.__mailOpened()), false);
  }
  assert.deepEqual(errors, []);
  console.log("PASS mailbox first-tap/modal stacking, letter navigation and close at 320/390/1280px; no browser errors");
} finally { await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true }); }
