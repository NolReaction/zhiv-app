import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root=fileURLToPath(new URL("..",import.meta.url));
const vite=await createServer({root,configFile:false,logLevel:"silent",resolve:{alias:{"@":root}},server:{middlewareMode:true,hmr:false,ws:false}});
after(()=>vite.close());
const {coastalGatheringGesture,gatheringStow,GATHERING_PACK_SECONDS}=await vite.ssrLoadModule("/features/world/activities/journeys/forest-gathering.ts");
const {drawForestGatheringBasket,drawForestGatheringHero,forestGatheringBounds}=await vite.ssrLoadModule("/features/world/activities/journeys/forest-gathering-painter.ts");
const {drawForestGardenBasket}=await vite.ssrLoadModule("/features/world/activities/garden/forest-garden-painter.ts");
const makeFrame=(age,seed=0)=>({...coastalGatheringGesture(age,seed),x:120,y:130,size:50,pose:"idle",frame:0,held:false,filled:false,basket:{x:138,y:130,size:14,berries:4}});
function context(){
  const calls=[],stack=[],target={globalAlpha:.37,fillStyle:"before",imageSmoothingEnabled:true};
  const ctx=new Proxy(target,{get:(object,key)=>key in object?object[key]:(...args)=>{
    assert.ok(args.every(arg=>typeof arg!=="number"||Number.isFinite(arg)),`${String(key)} must use finite coordinates`);
    calls.push({method:key,args,fill:object.fillStyle,alpha:object.globalAlpha});
    if(key==="save")stack.push({...object});if(key==="restore")Object.assign(object,stack.pop());
  },set:(object,key,value)=>{object[key]=value;return true;}});
  return {ctx,calls};
}

test("coastal work plants the shovel before lifting soil and includes a long quiet pause",()=>{
  for(const seed of [0,1]){
    const planted=coastalGatheringGesture(7,seed),lifted=coastalGatheringGesture(13,seed),rest=coastalGatheringGesture(22,seed);
    assert.equal(planted.tool,"shovel");assert.equal(planted.shovel.soil,0);assert.ok(planted.shovel.blade.y>=0);
    assert.equal(lifted.shovel.soil,1);assert.ok(lifted.shovel.blade.y<-.15);
    assert.equal(rest.action,"rest");assert.equal(rest.shovel.soil,0);assert.equal(rest.crouch,0);
    assert.deepEqual(rest.shovel,coastalGatheringGesture(27,seed).shovel);
    assert.deepEqual(coastalGatheringGesture(7,seed,true),coastalGatheringGesture(1007,seed,true));
    for(const at of [4,7,10,13,15,18,28]){
      const a=coastalGatheringGesture(at-.00001,seed),b=coastalGatheringGesture(at+.00001,seed);
      for(const key of ["handle","blade"])assert.ok(Math.hypot(a.shovel[key].x-b.shovel[key].x,a.shovel[key].y-b.shovel[key].y)<.00001,`${at}: no tool jump`);
    }
  }
});

test("cancelling coastal work settles the current tool and body without creating a basket",()=>{
  const source=coastalGatheringGesture(8.5,1),start=gatheringStow(source,0),end=gatheringStow(source,GATHERING_PACK_SECONDS);
  assert.deepEqual(start.shovel,source.shovel);assert.equal(start.crouch,source.crouch);assert.equal(start.lean,source.lean);
  assert.equal(end.tool,"shovel");assert.equal(end.shovel.soil,0);assert.equal(end.crouch,0);assert.equal(end.lean,0);
  const draw=context();drawForestGatheringBasket(draw.ctx,makeFrame(10));assert.deepEqual(draw.calls,[]);
});

test("woodland basket keeps the actual garden weave, handle, scale and preserved berries",()=>{
  const frame={...makeFrame(0),tool:"basket",direction:"right"},supplies=context(),garden=context();
  drawForestGatheringBasket(supplies.ctx,frame);
  drawForestGardenBasket(garden.ctx,{...frame.basket,grounded:true,behind:false});
  assert.deepEqual(supplies.calls,garden.calls,"a supply assignment paints the same physical prop rather than a second basket design");
});

test("shovel painter supports both facing directions, pauses and carrying without mutating its frame",()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"document");
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement(){return {width:48,height:48,getContext:()=>context().ctx};}}});
  try{
  for(const seed of [0,1])for(const age of [0,6,9,12,14,17,22])for(const direction of ["left","right","back","front"]){
    const frame={...makeFrame(age,seed),direction},before=structuredClone(frame),draw=context();
    drawForestGatheringHero(draw.ctx,frame,undefined,false);assert.deepEqual(frame,before);
    assert.equal(draw.ctx.globalAlpha,.37);assert.equal(draw.ctx.fillStyle,"before");
    assert.ok(draw.calls.some(call=>call.fill==="#536e68"),"the metal shovel is visible");
    const bounds=forestGatheringBounds(frame),blade={x:frame.x+frame.size*frame.shovel.blade.x,y:frame.y+frame.size*frame.shovel.blade.y};
    assert.ok(blade.x>=bounds.x&&blade.x<=bounds.x+bounds.width&&blade.y<=bounds.y+bounds.height);
  }
  const frame={...makeFrame(12),action:"walk",pose:"walk",held:true},draw=context();
  drawForestGatheringHero(draw.ctx,frame,undefined,true);assert.equal(draw.ctx.globalAlpha,.37);
  assert.ok(!draw.calls.some(call=>call.method==="translate"&&call.args[0]===frame.basket.x&&call.args[1]===frame.basket.y));
  }finally{if(previous)Object.defineProperty(globalThis,"document",previous);else delete globalThis.document;}
});
