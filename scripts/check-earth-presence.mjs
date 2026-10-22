// Browser effect-order regression. Native GPS/HTTP are controlled; React,
// hooks, preference storage, transport validation and controller are real.
import assert from "node:assert/strict";
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
const entry = "virtual:earth-presence-browser.tsx";
const source = `
import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useEarthSharing} from '/features/earth/use-earth-sharing.ts';
import {useEarthPresence} from '/features/earth/use-earth-presence.ts';
const owner='ABCD-EFGH-JKMN',circle='11111111-1111-4111-8111-111111111111';
const iso=()=>new Date().toISOString();
let hidden=false;
Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
const watches=[],uploads=[],stops=[],resumes=[];
Object.defineProperty(navigator,'geolocation',{configurable:true,value:{
 watchPosition(success,failure,options){watches.push({success,failure,options,active:true});return watches.length-1;},
 clearWatch(id){if(watches[id])watches[id].active=false;}
}});
let server={ownerPublicId:owner,mode:'OFF',revision:0,precision:'PRECISE',recipientCircleIds:[],frozenCircleIds:[],sharingUntil:null,publicationEpoch:null,serverTime:iso()};
let holdResume=false,releaseResume=null;
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const fetchOriginal=window.fetch;
window.fetch=async(url,init={})=>{
 if(!String(url).startsWith('/api/v1/earth/'))return fetchOriginal(url,init);
 const body=init.body?JSON.parse(init.body):null;
 if(url.endsWith('/people'))return reply({ownerPublicId:owner,people:[],serverTime:iso()});
 if(url.endsWith('/sharing/resume')){
  resumes.push(body);
  if(body.expectedRevision!==server.revision)return reply({code:'EARTH_REVISION_CONFLICT',message:'revision conflict'},409);
  server={...server,mode:'SHARING',revision:server.revision+1,publicationEpoch:crypto.randomUUID(),serverTime:iso()};
  const value={...server};
  if(holdResume){holdResume=false;await new Promise(resolve=>{releaseResume=resolve;});releaseResume=null;}
  return reply(value);
 }
 if(url.endsWith('/location')){
  if(init.method==='DELETE'){stops.push(body);if(server.publicationEpoch===body.publicationEpoch)server={...server,publicationEpoch:null};return reply({ownerPublicId:owner,serverTime:iso()});}
  if(server.publicationEpoch!==body.publicationEpoch)return reply({code:'EARTH_PUBLICATION_CONFLICT',message:'publication conflict'},409);
  uploads.push(body);return reply({ownerPublicId:owner,acceptedAt:iso(),expiresAt:new Date(Date.now()+86400000).toISOString(),serverTime:iso()});
 }
 if(init.method==='PUT'){
  if(body.mode==='SHARING')server={...server,mode:'SHARING',revision:server.revision+1,recipientCircleIds:body.recipientCircleIds,publicationEpoch:crypto.randomUUID(),serverTime:iso()};
  else server={...server,mode:body.mode,revision:server.revision+1,publicationEpoch:null,recipientCircleIds:body.mode==='OFF'?[]:server.recipientCircleIds,serverTime:iso()};
  return reply(server);
 }
 return reply({...server,publicationEpoch:null,serverTime:iso()});
};
window.qa={watches,uploads,stops,resumes,hide(value){hidden=value;document.dispatchEvent(new Event('visibilitychange'));},
 fix(){const w=watches.at(-1);w.success({coords:{latitude:55.75,longitude:37.62,accuracy:12},timestamp:Date.now()});},
 deny(){watches.at(-1).failure({code:1});},hold(){holdResume=true;},release(){releaseResume?.();},waiting:()=>!!releaseResume};
function App(){
 const [mapVisible,setMapVisible]=useState(true);
 const sharing=useEarthSharing({ownerPublicId:owner,visible:true,publicationVisible:true,isOnline:true});
 const location=useEarthPresence({ownerPublicId:owner,enabled:true,mapVisible,sharing});
 useEffect(()=>{window.qa.sharing=sharing;window.qa.location=location;window.qa.setMapVisible=setMapVisible;
 window.qa.snapshot={mapVisible,publishing:sharing.publishing,generation:sharing.publicationGeneration,revision:sharing.settings?.revision,
 mode:sharing.settings?.mode,status:location.status,error:sharing.publicationError};});
 return <main><p>{location.status}</p><button onClick={()=>sharing.share({recipientCircleIds:[circle],precision:'PRECISE',durationMinutes:null})}>Grant</button>
 <button onClick={()=>sharing.resume()}>Resume</button><button onClick={()=>location.locate()}>Find me</button></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const cacheDir = await mkdtemp(join(tmpdir(), "zhiv-earth-presence-browser-"));
let server, browser;
const errors = [];
try {
  server = await createServer({ root, cacheDir, appType: "custom", configFile: false, resolve: { alias: { "@": root } },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "zod"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    plugins: [{ name: "earth-presence-browser", enforce: "pre",
      resolveId(id) { if (id === entry) return `\0${id}`; },
      load(id) { if (id === `\0${entry}`) return ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText; },
      configureServer(vite) { vite.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end(`<!doctype html><html><div id="root"></div><script type="module" src="/@id/__x00__${entry}"></script></html>`);
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.qa?.snapshot?.mode === "OFF" && window.qa.snapshot.status === "requesting");
  await page.getByRole("button", { name: "Grant", exact: true }).click();
  await page.waitForFunction(() => window.qa.snapshot.publishing && window.qa.snapshot.generation === 1);
  await page.evaluate(() => window.qa.fix());
  await page.waitForFunction(() => window.qa.uploads.length === 1 && window.qa.snapshot.status === "active");
  const first = await page.evaluate(() => ({ count: window.qa.watches.length, epoch: window.qa.uploads[0].publicationEpoch }));
  await page.evaluate(() => window.qa.setMapVisible(false));
  await page.waitForFunction(() => !window.qa.snapshot.mapVisible);
  assert.equal(await page.evaluate(() => window.qa.watches.length), first.count);
  assert.equal(await page.evaluate(() => window.qa.watches.filter(w => w.active).length), 1);
  assert.equal(await page.evaluate(() => window.qa.stops.length), 0);
  await page.evaluate(() => window.qa.hide(true));
  await page.waitForFunction(() => !window.qa.snapshot.publishing && window.qa.watches.every(w => !w.active));
  await page.evaluate(() => window.qa.hide(false));
  await page.waitForFunction(() => window.qa.snapshot.publishing && window.qa.snapshot.generation === 2 && window.qa.snapshot.status === "requesting");
  await page.evaluate(() => window.qa.fix());
  await page.waitForFunction(() => window.qa.uploads.length === 2);
  assert.notEqual(await page.evaluate(() => window.qa.uploads[1].publicationEpoch), first.epoch);

  await page.evaluate(() => window.qa.sharing.stopPublishing());
  await page.waitForFunction(() => !window.qa.snapshot.publishing);
  await page.evaluate(() => { window.qa.setMapVisible(true); window.qa.hold(); });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.waitForFunction(() => window.qa.waiting());
  await page.getByRole("button", { name: "Find me", exact: true }).click();
  await page.waitForFunction(() => window.qa.snapshot.status === "requesting");
  const beforeDenial = await page.evaluate(() => {
    window.qa.staleLookup = window.qa.location.locateForPublication;
    const count = window.qa.watches.length; window.qa.deny(); window.qa.staleLookup(); return count;
  });
  await page.waitForFunction(() => window.qa.snapshot.status === "denied" && !window.qa.snapshot.publishing);
  assert.equal(await page.evaluate(() => localStorage.getItem("zhiv.earth-location.v1:ABCD-EFGH-JKMN")), "ready");
  await page.evaluate(() => window.qa.release());
  await page.waitForFunction(() => !window.qa.waiting());
  await page.evaluate(() => window.qa.sharing.refresh());
  await page.waitForFunction(() => window.qa.snapshot.revision === 3);
  assert.equal(await page.evaluate(() => window.qa.watches.length), beforeDenial);
  assert.equal(await page.evaluate(() => window.qa.uploads.length), 2);
  assert.equal(await page.evaluate(() => window.qa.snapshot.publishing), false);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.waitForFunction(() => window.qa.snapshot.publishing && window.qa.snapshot.status === "requesting");
  assert.equal(await page.evaluate(() => window.qa.watches.length), beforeDenial + 1);
  await page.evaluate(() => window.qa.fix());
  await page.waitForFunction(() => window.qa.uploads.length === 3);
  assert.deepEqual(errors, []);
  console.log("PASS real Chromium/React: grant→publish, map→game single watch, background→fresh epoch, native denial during held resume ACK, READY fences stale effect, explicit recovery; no page errors");
} finally { await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true }); }
