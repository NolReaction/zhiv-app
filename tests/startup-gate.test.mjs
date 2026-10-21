import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:startup-gate-hooks", audioId = "virtual:startup-gate-audio";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "startup-gate-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId || id === audioId) return `\0${id}`; },
    load(id) {
      if (id === `\0${audioId}`) return 'const ready={settled:true,revealReady:true};export const useStartupAudio=()=>ready;';
      if (id === `\0${hooksId}`) return `
        export {createContext,useContext} from 'react';
        let current,cursor;
        const slot=create=>{const index=cursor++;return current.slots[index]??=create();};
        export function begin(state){current=state;cursor=0;state.dirty=false;}
        export const useRef=value=>slot(()=>({current:value}));
        export function useState(initial){const owner=current,state=slot(()=>({value:typeof initial==='function'?initial():initial}));
          return[state.value,value=>{const next=typeof value==='function'?value(state.value):value;if(!Object.is(next,state.value)){state.value=next;owner.dirty=true;}}];}
        export function useMemo(create,deps){const state=slot(()=>({deps:null,value:null}));if(!state.deps||deps.some((value,index)=>!Object.is(value,state.deps[index]))){state.deps=deps;state.value=create();}return state.value;}
        export const useCallback=(callback,deps)=>useMemo(()=>callback,deps);
        export function useEffect(callback,deps){const state=slot(()=>({deps:null,cleanup:null}));if(!state.deps||deps.some((value,index)=>!Object.is(value,state.deps[index]))){state.deps=deps;current.pending.push(()=>{state.cleanup?.();state.cleanup=callback();});}}
        export function flush(state){for(const callback of state.pending.splice(0))callback();}
        export function dispose(state){for(const value of state.slots)value.cleanup?.();}
      `;
    },
    transform(source,id) {
      if (!id.endsWith("/features/startup/app-startup.tsx")) return;
      return source.replace('from "react";',`from "${hooksId}";`).replace('from "./use-startup-audio";',`from "${audioId}";`);
    },
  }] });
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { AppStartup } = await vite.ssrLoadModule("/features/startup/app-startup.tsx");
const { StartupSplash } = await vite.ssrLoadModule("/features/startup/startup-splash.tsx");
const pending = {ready:false,progress:84,message:"Пробуждаем лес",detail:null,retryAvailable:false};
const ready = {...pending,ready:true,progress:100,message:"Лес вас заждался"};

function fixture(t) {
  t.mock.timers.enable({apis:["setTimeout"]});
  const globals = new Map(["document","window","requestAnimationFrame","cancelAnimationFrame"].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const document = Object.assign(new EventTarget(),{hidden:false,body:{style:{overflow:"auto"}}});
  const media = Object.assign(new EventTarget(),{matches:true});
  const window = {matchMedia:()=>media};
  for(const [name,value] of Object.entries({document,window,requestAnimationFrame:callback=>setTimeout(callback,16),cancelAnimationFrame:id=>clearTimeout(id)}))
    Object.defineProperty(globalThis,name,{value,configurable:true});
  const state = {slots:[],pending:[],dirty:false};
  let tree;
  const render = () => {
    for(let pass=0;pass<15;pass++) {
      hooks.begin(state);tree=AppStartup({children:"home"});hooks.flush(state);
      if(!state.dirty)return tree;
    }
    throw Error("startup gate did not settle");
  };
  render();
  const value=()=>tree.props.value;
  const splash=()=>tree.props.children.find(node=>node?.type===StartupSplash);
  const report=(presentation,sessionKey=null)=>{value().report(presentation,()=>{},sessionKey);render();};
  const advance=ms=>{t.mock.timers.tick(ms);render();};
  const finish=()=>{advance(180);advance(20);advance(180);advance(20);};
  return {value,splash,report,advance,finish,document,render,
    logo(){splash().props.onLogoReady();render();},
    dispose(){hooks.dispose(state);for(const[name,descriptor]of globals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}};
}

test("sign-in after the first logo re-arms the gate until the real scene reports ready",t=>{
  const f=fixture(t);
  try{
    f.logo();f.report(ready);f.finish();assert.equal(f.value().active,false,"the signed-out form can open");
    f.report(pending,"owner:1");assert.equal(f.value().active,true);assert.ok(f.splash());
    f.finish();assert.equal(f.value().active,true,"elapsed logo time is never scene readiness");
    f.report({...pending,detail:"Не удалось загрузить рисунки",retryAvailable:true},"owner:1");
    assert.equal(f.splash().props.retryAvailable,true);assert.equal(f.value().active,true);
    f.report(ready,"owner:1");f.finish();assert.equal(f.value().active,false);
    f.report({...pending,message:"Ждём подключения"},"owner:1");f.finish();
    assert.equal(f.value().active,false,"ordinary gameplay failures cannot reopen a completed entry");
  }finally{f.dispose();}
});

test("new transport sessions and same-owner recovery cannot borrow a previous scene's completion",t=>{
  const f=fixture(t);
  try{
    f.logo();f.report(ready,"owner:1");f.finish();assert.equal(f.value().active,false);
    f.report(pending,"owner:2");f.finish();assert.equal(f.value().active,true);
    f.report(ready,"owner:2");f.finish();assert.equal(f.value().active,false);
    f.report(ready,null);f.report(pending,"owner:2");f.finish();assert.equal(f.value().active,true);
    f.report(ready,"owner:2");f.finish();assert.equal(f.value().active,false);
  }finally{f.dispose();}
});

test("AFK and a fully prepared simple view stay usable; unfinished resume waits behind the logo",t=>{
  const f=fixture(t);
  try{
    f.logo();f.report(ready,null);f.finish();assert.equal(f.value().active,false,"AFK gate does not wait for assets");
    f.report(pending,"owner:1");f.finish();assert.equal(f.value().active,true,"fresh resume still prepares the circle");
    f.report(ready,"owner:1");f.finish();assert.equal(f.value().active,false);
    f.report(ready,null);f.report(ready,"owner:1");f.finish();assert.equal(f.value().active,false,"already prepared return has no new delay");
    f.report(ready,"simple:1");f.finish();assert.equal(f.value().active,false);
  }finally{f.dispose();}
});

test("hidden readiness cannot reveal content and disposal restores body scrolling",t=>{
  const f=fixture(t);
  try{
    f.logo();f.report(pending,"owner:1");f.finish();
    f.document.hidden=true;f.document.dispatchEvent(new Event("visibilitychange"));f.render();
    f.report(ready,"owner:1");f.finish();assert.equal(f.value().active,true);
    assert.equal(f.document.body.style.overflow,"hidden");
    f.document.hidden=false;f.document.dispatchEvent(new Event("visibilitychange"));f.render();f.finish();
    assert.equal(f.value().active,false);assert.equal(f.document.body.style.overflow,"auto");
  }finally{f.dispose();}
});
