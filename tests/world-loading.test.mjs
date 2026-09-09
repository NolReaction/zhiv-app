import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

test('map readiness waits for the character, aborted loading releases its scene, failed images retry',async()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));
 const vite=await createServer({appType:'custom',configFile:false,root,resolve:{alias:{'@':root}},server:{middlewareMode:true,hmr:false}});
 const {createMapEngine}=await vite.ssrLoadModule('/features/world/map-engine.ts');
 const {loadHabitatImage,HabitatAssetError}=await vite.ssrLoadModule('/lib/mochlik/assets.ts');await vite.close();
 const original=new Map(),pending=[],timers=new Map(),frames=new Map();let id=0,observed=0;
 const install=(name,value)=>{original.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,writable:true,configurable:true})};
 const pixels=(w,h)=>{const data=new Uint8ClampedArray(w*h*4).fill(255);data[0]=data[1]=data[2]=0;return {data}};
 const ctx=new Proxy({getImageData:(_x,_y,w,h)=>pixels(w,h),createImageData:pixels,createRadialGradient:()=>({addColorStop(){}}),createLinearGradient:()=>({addColorStop(){}})}, {get:(object,key)=>key in object?object[key]:()=>{}});
 const canvas=()=>({width:256,height:256,clientWidth:393,clientHeight:740,getContext:()=>ctx,addEventListener(){},removeEventListener(){},hasPointerCapture(){return false}});
 install('Image',class {naturalWidth=1254;naturalHeight=1254;set src(path){pending.push({path,image:this})}});
 install('document',{hidden:false,createElement:canvas,addEventListener(){},removeEventListener(){}});install('window',{});
 install('setTimeout',(fn,ms)=>{timers.set(++id,{fn,ms});return id});install('clearTimeout',key=>timers.delete(key));
 install('requestAnimationFrame',fn=>{frames.set(++id,fn);return id});install('cancelAnimationFrame',key=>frames.delete(key));
 for(const type of ['ResizeObserver','IntersectionObserver'])install(type,class{observe(){observed++}disconnect(){observed--}});
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const finish=path=>{const at=pending.findIndex(item=>item.path===path);assert.ok(at>=0,path);pending.splice(at,1)[0].image.onload?.()};
 try{
  const options={paused:false,reducedMotion:false,lampOn:false,dusk:false,presenceKey:'cancel-map'};
  const abort=new AbortController();let ready=false;
  const first=createMapEngine(canvas(),options,()=>{},[],abort.signal).then(v=>{ready=true;return v});
  const cancelled=assert.rejects(first,error=>error.name==='AbortError');
  finish('/world/forest-expanded.webp');finish('/world/forest-world.webp');await flush();
  finish('/world/house-details.webp');finish('/world/buildings-v1.webp');await flush();
  assert.equal(ready,false);assert.equal(observed,1);assert.equal(frames.size,0);
  abort.abort();await cancelled;assert.equal(observed,0);
  finish('/mochlik-pixel/forest.webp');await flush();assert.equal(frames.size,0);assert.equal(timers.size,0);
  const engine=await createMapEngine(canvas(),options,()=>{},[]);assert.equal(observed,3);engine.dispose();await flush();
  assert.equal(observed,0);assert.equal(frames.size,0);assert.equal(timers.size,0);
  const stalled=loadHabitatImage('/qa-timeout.webp');const failed=assert.rejects(stalled,error=>error instanceof HabitatAssetError&&error.timedOut);
  const timer=[...timers.values()].find(value=>value.ms===15000);assert.ok(timer);timer.fn();await failed;
  const old=pending.shift().image;assert.equal(old.onload,null);
  const retry=loadHabitatImage('/qa-timeout.webp');finish('/qa-timeout.webp');await retry;assert.equal(timers.size,0);
 } finally {for(const [name,descriptor]of original){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name]}}
});
