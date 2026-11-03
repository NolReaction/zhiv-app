import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ root, configFile: false, appType: "custom", resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
after(() => vite.close());
const { fishingIslandLayout, paintFishingIslands } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-islands.ts");
const { paintFishingLandscape } = await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-background.ts");
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const clock = hour => ({ now: Date.parse("2026-11-04T00:00:00Z") + hour * 3600000, timeZone: "UTC" });
const dimensions = [[1600,900], [1000,2164], [1800,856], [390,844], [820,390]];

test("voyage scenery is stable, varied and entirely outside active controls and HUD", () => {
  const seen = new Set();
  for (const [width,height] of dimensions) {
    const blocked = [{x:0,y:0,width:width*.3,height:height*.18},
      {x:width*.3,y:height*.28,width:width*.56,height:height*.34},
      {x:width*.25,y:height*.75,width:width*.5,height:height*.25}];
    for(let voyage=0;voyage<40;voyage++) {
      const key=`voyage-${voyage}`, layout=fishingIslandLayout(width,height,key,blocked);
      assert.equal(fishingIslandLayout(width,height,key,blocked), layout, "same inputs reuse cached layout");
      assert.ok(layout.length>=1 && layout.length<=3);
      seen.add(JSON.stringify(layout));
      for(const island of layout){
        assert.ok(Object.isFrozen(island));
        assert.ok(island.x>=0 && island.y>=0 && island.x+island.width<=width && island.y+island.height<=height);
        for(const bounds of [...blocked,...layout.filter(other=>other!==island)])assert.equal(overlaps(island,bounds),false);
      }
      assert.ok(Object.isFrozen(layout));
    }
  }
  assert.ok(seen.size>100);
  assert.deepEqual(fishingIslandLayout(1600,900,"full",[{x:0,y:0,width:1600,height:900}]),[]);
  for(const value of [NaN,Infinity,0,-1])assert.deepEqual(fishingIslandLayout(value,900,"invalid"),[]);
});

test("island painting is bounded and frozen-clock deterministic, with civil day/evening/night palettes",()=>{
  const draw=(hour,time)=>{
    const calls=[], ctx=new Proxy({globalAlpha:1},{get(target,key){
      if(key in target)return target[key];
      return(...args)=>calls.push([key,...args]);
    },set(target,key,value){target[key]=value;calls.push(["set",key,value]);return true;}});
    paintFishingIslands(ctx,1600,900,time,"voyage-one",clock(hour));
    return calls;
  };
  for(const hour of [6.5,12,18.5,23]){
    const first=draw(hour,0);assert.deepEqual(first,draw(hour,0));
    assert.ok(first.length>10 && first.length<2800);
    assert.ok(first.flat().every(value=>typeof value!=="number"||Number.isFinite(value)));
  }
  assert.notDeepEqual(draw(12,0),draw(18.5,0));
  assert.notDeepEqual(draw(18.5,0),draw(23,0));
});

test("water uses native mirror pixels and paints every destination rectangle once with integral source sampling",()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,"document"),created=[],mirrorDraws=[],waterDraws=[];
  const gradient={addColorStop(){}};
  const context=new Proxy({globalAlpha:1},{get(target,key){
    if(key in target)return target[key];
    if(key==="createLinearGradient"||key==="createRadialGradient")return()=>gradient;
    if(key==="drawImage")return(...args)=>waterDraws.push(args);
    return()=>{};
  }});
  const mirror=new Proxy({},{get(target,key){
    if(key in target)return target[key];
    if(key==="drawImage")return(...args)=>mirrorDraws.push(args);
    return()=>{};
  }});
  Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement(){const canvas={getContext:()=>mirror};created.push(canvas);return canvas;}}});
  try{
    const image={};paintFishingLandscape(context,1600,900,0,image);
    assert.equal(created[0].width,512);assert.equal(created[0].height,384);
    assert.equal(mirror.imageSmoothingEnabled,false);
    assert.equal(mirrorDraws.length,4);
    assert.ok(mirrorDraws.every(args=>args[3]===256&&args[4]===192),"no 1.5× intermediate upscale");
    for(const time of [0,.2,1,17.4,800.2]){
      waterDraws.length=0;paintFishingLandscape(context,1600,900,time,image);
      const draws=waterDraws.filter(args=>args.length===9);
      assert.ok(draws.length<40,"whole native tile blits replace dozens of fractional overlapping strips");
      let area=0;
      for(const [,sx,sy,sw,sh,dx,dy,dw,dh]of draws){
        for(const value of [sx,sy,sw,sh,dx,dy,dw,dh])assert.ok(Number.isInteger(value));
        assert.equal(sw,dw);assert.equal(sh,dh);assert.ok(sw>0&&sh>0);
        assert.ok(sx>=0&&sy>=0&&sx+sw<=512&&sy+sh<=384);
        assert.ok(dx>=0&&dy>=0&&dx+dw<=1600&&dy+dh<=900);
        area+=dw*dh;
      }
      assert.equal(area,1600*900,"no overpainting, fractional overlap or blank bands");
      assert.equal(created.length,1);
    }
  }finally{if(previous)Object.defineProperty(globalThis,"document",previous);else delete globalThis.document;}
});

test("islets remain present beside the actual hull and complete control corridor at common viewport sizes",async()=>{
  const {fishingSceneGeometry,fishingSceneSceneryExclusions}=await vite.ssrLoadModule("/features/economy/ui/boat/scene/fishing-scene-painter.ts");
  const visual={elapsed:3,castElapsed:3,stageElapsed:3,still:false};
  for(const [width,height]of [[1280,720],[1920,1080],[390,844],[820,390]])for(let voyage=0;voyage<20;voyage++){
    const frame={stage:"reeling",held:true,castKey:"cast",sceneKey:`voyage-${voyage}`,boat:{repaired:true,upgrades:[]},reel:{bar:5000,fish:5500,progress:4000,zoneWidth:3000}};
    const geometry=fishingSceneGeometry(width,height,frame,visual),exclusions=fishingSceneSceneryExclusions(geometry);
    const layout=fishingIslandLayout(geometry.width,geometry.height,frame.sceneKey,exclusions.islands);
    assert.ok(layout.length>=1,`${width}x${height} ${frame.sceneKey} retains some visible riverbank`);
    for(const island of layout)for(const bound of exclusions.islands)assert.equal(overlaps(island,bound),false);
  }
});
