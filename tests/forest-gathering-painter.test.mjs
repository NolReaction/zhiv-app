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
const {forestGatheringCarryPoint,forestGatheringArms}=await vite.ssrLoadModule("/features/world/activities/journeys/forest-gathering-rig.ts");
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

test("a carried basket uses one short arm on its own side and leaves the opposite hand free",()=>{
  for(const direction of ["front","back","left","right"])for(const step of [0,1,2,3])for(const still of [false,true]) {
    const frame={...makeFrame(0),tool:"basket",action:"walk",pose:"walk",direction,frame:step,crouch:0,lean:0,held:true};
    frame.basket={...frame.basket,...forestGatheringCarryPoint(frame,frame.size,still)};
    const before=structuredClone(frame),arms=forestGatheringArms(frame,still),side=direction==="left"||direction==="back"?-1:1;
    assert.equal(Math.sign(frame.basket.x-frame.x),side,"the prop follows the facing instead of staying on the opposite side");
    assert.deepEqual(arms.holding.hand,{x:frame.basket.x,y:frame.basket.y-frame.basket.size*12/14});
    for(const arm of [arms.holding,arms.free]) {
      const points=[arm.shoulder,arm.elbow,arm.hand],sign=Math.sign(arm.shoulder.x-frame.x);
      assert.ok(points.every(point=>Math.sign(point.x-frame.x)===sign),"no arm crosses the middle of the chest");
      assert.ok(Math.hypot(arm.elbow.x-arm.shoulder.x,arm.elbow.y-arm.shoulder.y)+Math.hypot(arm.hand.x-arm.elbow.x,arm.hand.y-arm.elbow.y)<frame.size*.32,"a paw cannot stretch across the whole body");
    }
    assert.notEqual(Math.sign(arms.free.hand.x-frame.x),side);
    assert.deepEqual(frame,before,"posing cannot move the shared basket or simulation feet");
  }
});

test("basket arm layers keep the far arm behind clothing and the holding paw above its handle",()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"document");
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement(){return {width:48,height:48,getContext:()=>context().ctx};}}});
  try {
    for(const direction of ["front","back","left","right"]) {
      const frame={...makeFrame(0),tool:"basket",action:"walk",pose:"walk",direction,frame:1,crouch:0,lean:0,held:true};
      frame.basket={...frame.basket,...forestGatheringCarryPoint(frame,frame.size)};
      const draw=context(),before=structuredClone(frame);
      drawForestGatheringHero(draw.ctx,frame,{palette:"berest_birch_moss",head:"berest_trail_hat",neck:"berest_lantern_scarf"});
      const body=draw.calls.findIndex(call=>call.method==="drawImage"),strokes=draw.calls.flatMap((call,index)=>call.method==="stroke"?[index]:[]);
      const baskets=draw.calls.flatMap((call,index)=>call.method==="fillRect"&&JSON.stringify(call.args)==="[-7,-8,14,7]"?[index]:[]);
      const paw=draw.calls.findLastIndex(call=>call.method==="ellipse"&&call.args[2]===frame.size*.026);
      assert.equal(baskets.length,1,"the actual garden basket paints once");
      assert.ok(strokes[0]<body,"free arm belongs behind the body and its clothes");
      assert.equal(baskets[0]<body,direction==="back");
      assert.ok(paw>baskets[0],"paw overlaps the painted handle");
      assert.equal(paw<body,direction==="back","a rear paw cannot float through the spine");
      assert.deepEqual(frame,before);assert.equal(draw.ctx.globalAlpha,.37);assert.equal(draw.ctx.fillStyle,"before");
    }
  } finally {if(previous)Object.defineProperty(globalThis,"document",previous);else delete globalThis.document;}
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
