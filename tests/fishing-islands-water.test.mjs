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

test("one large lake crop fills every viewport without repeated seams, gaps or offscreen pixel work",()=>{
  const waterDraws=[], gradient={addColorStop(){}};
  const context=new Proxy({globalAlpha:1},{get(target,key){
    if(key in target)return target[key];
    if(key==="createLinearGradient"||key==="createRadialGradient")return()=>gradient;
    if(key==="drawImage")return(...args)=>waterDraws.push(args);
    return()=>{};
  }});
  const image={naturalWidth:1024,naturalHeight:1024};
  for(const [width,height]of dimensions)for(const time of [0,.2,1,17.4,800.2,1e6]){
    waterDraws.length=0;paintFishingLandscape(context,width,height,time,image);
    assert.equal(waterDraws.length,1,"a single full-viewport blit has no pattern repeat or overlapping bands");
    const [source,sx,sy,sw,sh,dx,dy,dw,dh]=waterDraws[0];
    assert.equal(source,image,"the cached decoded master is the direct source");
    assert.ok([sx,sy,sw,sh,dx,dy,dw,dh].every(Number.isFinite));
    assert.ok(sx>=0&&sy>=0&&sw>0&&sh>0&&sx+sw<=1024&&sy+sh<=1024);
    assert.deepEqual([dx,dy,dw,dh],[0,0,width,height]);
    assert.ok(Math.abs(sw/sh-width/height)<1e-8,"cover cropping preserves the artwork aspect without stretching ripples");
  }
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
