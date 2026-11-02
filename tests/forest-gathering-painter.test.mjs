import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root=fileURLToPath(new URL("..",import.meta.url));
const vite=await createServer({root,configFile:false,logLevel:"silent",resolve:{alias:{"@":root}},server:{middlewareMode:true,hmr:false,ws:false}});
after(()=>vite.close());
const {coastalGatheringGesture,coastalGatheringStow,GATHERING_PACK_SECONDS,FORAGING_BASKET_CYCLE}=await vite.ssrLoadModule("/features/world/activities/journeys/forest-gathering.ts");
const {drawForestGatheringBasket,drawForestGatheringHero,forestGatheringBounds}=await vite.ssrLoadModule("/features/world/activities/journeys/forest-gathering-painter.ts");
const {drawForestGardenBasket,drawForestGardenProps,forestGardenVisualFrame}=await vite.ssrLoadModule("/features/world/activities/garden/forest-garden-painter.ts");
const {forestGatheringBasketVisual,resizeForestGatheringFrame}=await vite.ssrLoadModule("/features/world/activities/journeys/forest-gathering-rig.ts");
const {drawGroundedHero}=await vite.ssrLoadModule("/features/world/scene/grounding.ts");
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
  const source=coastalGatheringGesture(8.5,1),start=coastalGatheringStow(source,0),end=coastalGatheringStow(source,GATHERING_PACK_SECONDS);
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

function basketFrame(phase="carry",elapsed=0,ground={x:101,y:128.25}) {
  return {...makeFrame(0),tool:"basket",action:phase==="carry"?"walk":"look",pose:phase==="carry"?"carry":"idle",
    direction:"front",crouch:0,lean:0,held:phase==="carry",basket:{x:120,y:122.5,size:14,berries:4},
    basketActivity:{phase,elapsed,ground:{...ground}}};
}
function gardenCarry(frame,still=false) {
  const {x,y,size}=frame,ground=frame.basketActivity.ground;
  return forestGardenVisualFrame({bushes:[],basket:{...frame.basket,position:ground,homePosition:ground,capacity:12},
    routine:{kind:"harvest-berries",phase:"approach-bush",elapsed:0,carryingBasket:true}},
  {x,y,size},{pose:"walk",direction:frame.direction,frame:still?0:frame.frame},still);
}

test("every carrying facing and step uses the berry garden's two shoulders and real handle contacts",()=>{
  for(const direction of ["front","back","left","right"])for(const step of [0,1,2,3])for(const still of [false,true]) {
    const frame={...basketFrame(),direction,frame:step},before=structuredClone(frame);
    const visual=forestGatheringBasketVisual(frame,still),garden=gardenCarry(frame,still);
    assert.equal(visual.pose,garden.pose);assert.equal(visual.direction,garden.direction);assert.equal(visual.frame,garden.frame);
    assert.deepEqual(visual.arms,garden.arms,"journey cannot drift from the established berry shoulders, elbows and paws");
    for(const key of ["x","y","size","berries","behind","grounded"])
      assert.equal(visual.basket[key],garden.basket[key],`both activities retain the same basket ${key}`);
    assert.equal(visual.arms.length,2);
    for(const [index,arm] of visual.arms.entries()) {
      assert.ok(Math.hypot(arm.hand.x-(visual.basket.x+(index?1:-1)*visual.basket.size*.23),
        arm.hand.y-(visual.basket.y-visual.basket.size*12/14))<1e-9,"both paws contact the actual handle");
      assert.ok(Math.hypot(arm.elbow.x-arm.shoulder.x,arm.elbow.y-arm.shoulder.y)+Math.hypot(arm.hand.x-arm.elbow.x,arm.hand.y-arm.elbow.y)<frame.size*.32,"a paw cannot stretch across the whole body");
    }
    assert.deepEqual(frame,before,"posing cannot move the shared basket or simulation feet");
  }
});

test("journey carrying paints the existing garden arms, clothing and one basket without extra arm strokes",()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"document");
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement(){return {width:48,height:48,getContext:()=>context().ctx};}}});
  try {
    for(const direction of ["front","back","left","right"])for(const still of [false,true]) {
      const frame={...basketFrame(),direction,frame:1},draw=context(),reference=context(),before=structuredClone(frame);
      const appearance={palette:"berest_birch_moss",head:"berest_trail_hat",neck:"berest_lantern_scarf"};
      drawForestGatheringHero(draw.ctx,frame,appearance,still);
      const garden=gardenCarry(frame,still);
      drawForestGardenProps(reference.ctx,garden,"behind",true);
      drawGroundedHero(reference.ctx,{x:frame.x,y:frame.y,size:frame.size,pose:garden.pose,direction:garden.direction,
        frame:garden.frame,appearance,shadow:true,rig:garden.rig});
      drawForestGardenProps(reference.ctx,garden,"front",true);
      const paints=calls=>calls.filter(call=>!["save","restore"].includes(call.method));
      assert.deepEqual(paints(draw.calls),paints(reference.calls),"the journey uses the same actual canvas drawing as berry carry");
      const body=draw.calls.findIndex(call=>call.method==="drawImage");
      const baskets=draw.calls.flatMap((call,index)=>call.method==="fillRect"&&JSON.stringify(call.args)==="[-7,-8,14,7]"?[index]:[]);
      const paws=draw.calls.flatMap((call,index)=>call.method==="fillRect"&&call.fill==="#d8bf83"
        &&Math.abs(call.args[2]-5*frame.size/48)<1e-9&&Math.abs(call.args[3]-4*frame.size/48)<1e-9?[index]:[]);
      assert.equal(baskets.length,1,"the actual garden basket paints once");
      assert.equal(draw.calls.filter(call=>call.method==="stroke").length,0,"the old rounded arm overlay is gone");
      assert.equal(paws.length,2,"exactly two garden paws, with native sprite arms hidden by the rig");
      assert.equal(baskets[0]<body,direction==="back");
      for(const paw of paws) {
        assert.ok(paw>baskets[0],"both paws overlap the painted handle");
        assert.equal(paw<body,direction==="back","a rear paw cannot float through the spine");
      }
      assert.deepEqual(frame,before);assert.equal(draw.ctx.globalAlpha,.37);assert.equal(draw.ctx.fillStyle,"before");
    }
    for(const side of [-1,1])for(const item of ["twig","fiber","stone"]) {
      const clock=FORAGING_BASKET_CYCLE;
      const frame={...basketFrame("collect",clock.pickStart+clock.pickSeconds*(.8-1e-7),{x:120+side*19,y:131.75}),item};
      const finding=forestGatheringBasketVisual(frame).pickedBerry,draw=context();
      drawForestGatheringHero(draw.ctx,frame);
      assert.ok(draw.calls.some(call=>call.method==="translate"&&Math.hypot(call.args[0]-finding.x,call.args[1]-finding.y)<1e-9),
        `${item} is painted at the shared transfer hand all the way to the opening`);
      assert.equal(draw.calls.filter(call=>call.method==="stroke").length,item==="twig"?1:item==="fiber"?3:0,
        "only the carried finding may use strokes; paws remain the garden pixel rig");
    }
  } finally {if(previous)Object.defineProperty(globalThis,"document",previous);else delete globalThis.document;}
});

test("findings pass between two paws and reach the actual left or right basket opening before disappearing",()=>{
  const {pickStart,pickSeconds}=FORAGING_BASKET_CYCLE;
  for(const side of [-1,1])for(const offsetY of [-1.75,1.75]) {
    const ground={x:120+side*19,y:130+offsetY},at=phase=>forestGatheringBasketVisual(basketFrame("collect",pickStart+phase*pickSeconds,ground));
    const rim={x:ground.x,y:ground.y-14*8/14};
    let last;
    for(let step=30;step<80;step++) {
      const visual=at(step/100),finding=visual.pickedBerry;
      assert.ok(finding,"the finding stays visible until its paw reaches the opening");
      assert.ok(visual.arms.some(arm=>Math.hypot(arm.hand.x-finding.x,arm.hand.y-finding.y)<1e-9),"one actual hand owns the finding");
      assert.deepEqual({x:visual.basket.x,y:visual.basket.y},ground,"handling a find never drags the parked basket");
      if(last)assert.ok(Math.hypot(finding.x-last.x,finding.y-last.y)<2,"no jump between the two paws");
      last=finding;
    }
    const arrived=at(.8-1e-7);
    assert.ok(Math.hypot(arrived.pickedBerry.x-rim.x,arrived.pickedBerry.y-rim.y)<1e-6,"the final visible point is inside this basket, not a hard-coded side");
    assert.equal(at(.8+1e-7).pickedBerry,null);
  }
});

test("resizing only the hero keeps the basket's world size and parked support",()=>{
  for(const side of [-1,1])for(const phase of ["carry","collect"]) {
    const frame=basketFrame(phase,phase==="collect"?2:0,{x:120+side*19,y:131.75}),before=structuredClone(frame);
    const resized=resizeForestGatheringFrame(frame,75),visual=forestGatheringBasketVisual(resized);
    assert.equal(resized.size,75);assert.equal(resized.basket.size,14);assert.equal(visual.basket.size,14);
    if(phase==="collect")assert.deepEqual({x:visual.basket.x,y:visual.basket.y},frame.basketActivity.ground);
    else assert.deepEqual({x:visual.basket.x,y:visual.basket.y},{x:frame.x,y:frame.y-75*.15});
    assert.equal(visual.arms.length,2);assert.deepEqual(frame,before);
  }
});

test("a half-size DEV hero rests instead of stretching to an unreachable full-size basket",()=>{
  const {pickStart,pickSeconds}=FORAGING_BASKET_CYCLE;
  for(const side of [-1,1]) {
    const ground={x:120+side*19,y:128.25};
    const resting=forestGatheringBasketVisual(resizeForestGatheringFrame(
      {...basketFrame("collect",pickStart-.1,ground),size:36},18));
    for(const phase of [0,.3,.5,.7,.8-1e-7,.9]) {
      const frame={...basketFrame("collect",pickStart+phase*pickSeconds,ground),size:36},before=structuredClone(frame);
      const small=forestGatheringBasketVisual(resizeForestGatheringFrame(frame,18));
      assert.equal(small.pickedBerry,null,"an unreachable transfer never starts with a finding that must disappear in midair");
      assert.deepEqual(small.arms,resting.arms,"both paws remain at rest through the skipped cosmetic pick");
      for(const arm of small.arms)assert.ok(Math.hypot(arm.elbow.x-arm.shoulder.x,arm.elbow.y-arm.shoulder.y)
        +Math.hypot(arm.hand.x-arm.elbow.x,arm.hand.y-arm.elbow.y)<small.actor.size*.2,"the small hero keeps short arms");
      assert.deepEqual({x:small.basket.x,y:small.basket.y},ground,"the guard cannot move the actual parked basket");
      assert.equal(small.basket.size,14);assert.equal(small.basket.grounded,true);
      if(phase>=.3&&phase<.8)assert.ok(forestGatheringBasketVisual(frame).pickedBerry,
        "the ordinary 36-unit hero still completes this same reachable pick");
      assert.deepEqual(frame,before,"DEV resizing leaves the original activity frame unchanged");
    }
  }
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
