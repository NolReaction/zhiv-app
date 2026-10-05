import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root=fileURLToPath(new URL("..",import.meta.url));
const vite=await createServer({root,configFile:false,logLevel:"silent",resolve:{alias:{"@":root}},server:{middlewareMode:true,hmr:false,ws:false}});
after(()=>vite.close());
const load=path=>vite.ssrLoadModule(`/features/world/${path}.ts`);
const { TILED_WORLD }=await load("presentation");
const { previewWorldScene,initialPreviewLevels }=await load("tiled/preview-state");
const { connectForestSession }=await load("forest-session");
const { advanceForestDirector }=await load("forest-director");
const { syncForestJourneyTravel,forestJourneyWalking,forestJourneyActorAway,forestJourneyFishingFrame }=await load("forest-journey-travel");
const { forestJourneyMiningFrame,MINING_PORTAL_SECONDS }=await load("forest-mining");
const { drawForestMiningWork }=await load("forest-mining-painter");
const { forestJobFishingPlan,forestJobFishingFrame,forestJobFishingCleanup }=await load("forest-job-fishing");
const { canTraverse,isWalkable }=await load("navigation");
const world=previewWorldScene(TILED_WORLD,initialPreviewLevels(TILED_WORLD));
const start=1_000_000;
const job=(routeId,seconds=3600,rewards={stone:8,ore:4})=>({id:`real-${routeId}`,routeId,rewards,
  startedAt:new Date(start).toISOString(),finishesAt:new Date(start+seconds*1000).toISOString()});
const create=()=>connectForestSession(undefined,world,"world",start,0,()=>{},{persistence:false,sync:false});
function step(state,j,now) {
  const before={...state.clearing.position};
  syncForestJourneyTravel(state,world,j,now,false);
  const walking=forestJourneyWalking(state),away=forestJourneyActorAway(state,j,now);
  advanceForestDirector(state,.05,{autoLife:false,blocked:true,explicitTravel:walking,actorAway:away,
    homeAvailable:true,dusk:0,rain:0,butterflies:"off",fireflies:"off"});
  assert.ok(Math.hypot(state.clearing.position.x-before.x,state.clearing.position.y-before.y)<1,
    "the real feet use the bounded walker, including the portal transition");
  if(!state.clearing.activeInteraction) assert.ok(canTraverse(state.clearing.navigation,before,state.clearing.position));
}

test("a confirmed fishing plan displays exactly its saved species quantities across the entire server job",()=>{
  const j=job("shore",2700,{fish:3,fish_mooncarp:1,ore:9});
  j.fishing={rodId:"river_rod",fishId:"fish_mooncarp"};
  const original=structuredClone(j),plan=forestJobFishingPlan(j),seen=[];
  let previous="";
  for(let age=0;age<=3600;age+=.1) {
    const frame=forestJobFishingFrame(plan,age,0);
    if(frame.action==="catch" && previous!=="catch") seen.push(frame.species);
    previous=frame.action;
    if(age<600) assert.ok(!["bite","reel","catch","pack"].includes(frame.action),"no decorative catch every few seconds while waiting for the first server slot");
  }
  assert.deepEqual(seen.sort(),["fish","fish","fish","fish_mooncarp"].sort());
  assert.deepEqual(j,original);
  assert.equal(forestJobFishingFrame(plan,2700,0).basketFilled,true);
  assert.ok(!["catch","pack"].includes(forestJobFishingFrame(plan,1_000_000,0).action),"a finished job never repeats fish");
});

test("legacy rewards, absent rewards and ten-fish long jobs never borrow an unearned metadata species",()=>{
  for(const rewards of [undefined,{}, {ore:4}]) {
    const j=job("shore");j.rewards=rewards;j.fishing={rodId:"reed_rod",fishId:"fish_shark"};
    const plan=forestJobFishingPlan(j);
    for(const age of [0,20,300,1800,3599,10000]) {
      const f=forestJobFishingFrame(plan,age,0);
      assert.equal(f.carryingFish,false);assert.equal(f.basketFilled,false);
      assert.ok(!["catch","pack"].includes(f.action));assert.equal(f.species,"fish");
    }
  }
  const plan=forestJobFishingPlan(job("shore_camp",8*3600,{fish:9,fish_shark:1}));
  assert.equal(plan.catches.length,10);
  assert.equal(plan.catches.filter(slot=>slot.species==="fish_shark").length,1);
  assert.ok(plan.catches[0].at>2800);assert.ok(plan.catches.at(-1).at<8*3600);
});

test("only an already hooked scheduled fish finishes catch/pack on interruption",()=>{
  const plan=forestJobFishingPlan(job("shore",2700,{fish:4})),at=plan.catches[0].at;
  assert.equal(forestJobFishingCleanup(plan,20),undefined);
  assert.equal(forestJobFishingCleanup(plan,at-6.9),undefined,"early reel has no fish on the hook yet");
  for(const age of [at-5,at-3,at-1]) assert.equal(forestJobFishingCleanup(plan,age),at);
  assert.equal(forestJobFishingCleanup(plan,2700),undefined);
});

test("reload and repeated cameras sample a scheduled catch without starting another local cycle",()=>{
  const session=create(),s=session.state,j=job("shore",2700,{fish:4});
  try {
    syncForestJourneyTravel(s,world,j,start+1800_000,false);
    const before=forestJourneyFishingFrame(s,world),travel=s.journeyTravel;
    for(let n=0;n<10;n++) syncForestJourneyTravel(s,world,j,start+1800_000,false);
    assert.strictEqual(s.journeyTravel,travel);assert.deepEqual(forestJourneyFishingFrame(s,world),before);
    assert.equal(before.action,"fish","a fresh camera restores the current waiting slot rather than replaying an old catch");
    s.director.elapsed+=500;
    assert.deepEqual(forestJourneyFishingFrame(s,world),before,"cosmetic acceleration cannot manufacture server-time fish");
    syncForestJourneyTravel(s,world,j,start+1805_000,false);
    assert.equal(forestJourneyFishingFrame(s,world).action,"fish");
    const still=forestJourneyFishingFrame(s,world,true);
    assert.equal(still.action,"fish");assert.equal(still.frame,0);
  }finally{session.release()}
});

test("the actual authored mine uses safe outdoor feet, enters its own portal and hides only inside",()=>{
  const session=create(),s=session.state,j=job("cave"),original=structuredClone(TILED_WORLD);
  try {
    syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
    assert.equal(s.journeyTravel.phase,"leaving");assert.equal(forestJourneyActorAway(s,j,start),false);
    assert.equal(forestJourneyFishingFrame(s,world),null,"a miner never acquires a fishing rod");
    const q=world.sites.find(site=>site.id==="quarry");
    assert.deepEqual(s.journeyTravel.mining.entry,q.entry);
    assert.deepEqual(s.journeyTravel.mining.doorway,q.doorway);
    assert.equal(isWalkable(s.clearing.navigation,s.journeyTravel.shore),true);
    assert.equal(isWalkable(s.clearing.navigation,q.doorway),false,"the authored rock has not become walkable");
    let now=start;
    for(let n=0;n<2400 && s.journeyTravel.phase!=="entering";n++){now+=50;step(s,j,now)}
    assert.equal(s.journeyTravel.phase,"entering");
    const feet={...s.clearing.position},first=forestJourneyMiningFrame(s,world);
    s.director.elapsed=s.journeyTravel.mining.phaseAt+MINING_PORTAL_SECONDS*.7;
    const middle=forestJourneyMiningFrame(s,world);
    assert.ok(middle.y<first.y);assert.ok(middle.opacity>0 && middle.opacity<1);
    assert.deepEqual(s.clearing.position,feet,"the visual doorway crossing never writes feet inside collision");
    s.director.elapsed+=MINING_PORTAL_SECONDS;
    syncForestJourneyTravel(s,world,j,now+3000,false);
    assert.equal(s.journeyTravel.phase,"working");assert.equal(forestJourneyActorAway(s,j,now),true);
    assert.equal(forestJourneyMiningFrame(s,world).opacity,0);
    assert.equal(forestJourneyMiningFrame(s,world).working,true);
    syncForestJourneyTravel(s,world,j,start+3600_000,false);
    assert.equal(s.journeyTravel.phase,"exiting");assert.equal(forestJourneyActorAway(s,j,start+3600_000),false);
    s.director.elapsed+=MINING_PORTAL_SECONDS;
    syncForestJourneyTravel(s,world,j,start+3600_000,false);
    assert.equal(s.journeyTravel.phase,"returning");
    for(let n=0;n<2400 && s.journeyTravel;n++) step(s,j,start+3600_000+n*50);
    assert.equal(s.journeyTravel,undefined);assert.deepEqual(s.clearing.position,world.actor.spawn);
    assert.deepEqual(TILED_WORLD,original);
  }finally{session.release()}
});

test("mine cancellation reverses the visible portal continuously and does not restart on retry",()=>{
  const session=create(),s=session.state,j=job("deep_cave");
  try {
    syncForestJourneyTravel(s,world,j,start+60_000,false);
    assert.equal(s.journeyTravel.phase,"working","reloading an ongoing mine job restores its interior");
    syncForestJourneyTravel(s,world,null,start+61_000,false,[j.id]);
    assert.equal(s.journeyTravel.phase,"exiting");
    const at=s.journeyTravel.mining.phaseAt,feet={...s.clearing.position};
    s.director.elapsed=at+.6;
    const midway=forestJourneyMiningFrame(s,world);
    syncForestJourneyTravel(s,world,null,start+62_000,false,[j.id]);
    assert.equal(s.journeyTravel.mining.phaseAt,at);assert.deepEqual(forestJourneyMiningFrame(s,world),midway);
    assert.deepEqual(s.clearing.position,feet);assert.equal(Boolean(s.journeyTravel.carryingFish),false);
  }finally{session.release()}
});

test("mine work marks are bounded and static in reduced motion",()=>{
  const calls=[],ctx=new Proxy({globalAlpha:1},{get:(target,key)=>key in target ? target[key] : (...args)=>calls.push([key,...args]),
    set:(target,key,value)=>{target[key]=value;return true}});
  const frame={x:655,y:258,size:50,working:true,doorway:{x:631,y:229},workCue:{x:631,y:128},elapsed:3};
  drawForestMiningWork(ctx,frame,true);const first=structuredClone(calls);calls.length=0;
  ctx.globalAlpha=1;drawForestMiningWork(ctx,{...frame,elapsed:10000},true);
  assert.deepEqual(calls,first,"the same two static tools do not flicker or float when reduced motion is on");
  assert.equal(calls.filter(([method])=>method==="translate").length,2);
  calls.length=0;drawForestMiningWork(ctx,{...frame,working:false},false);assert.deepEqual(calls,[]);
});

test("finished and cancelled hidden mine jobs reveal safe static feet in reduced motion",()=>{
  for(const cancelled of [false,true]) {
    const session=create(),s=session.state,j=job("cave");
    try {
      syncForestJourneyTravel(s,world,j,start+60_000,true);
      const feet={...s.clearing.position};assert.equal(s.journeyTravel.phase,"working");
      const now=cancelled ? start+61_000 : start+3600_000;
      syncForestJourneyTravel(s,world,j,now,true,cancelled ? [j.id] : []);
      assert.equal(s.journeyTravel.phase,"returning");assert.equal(forestJourneyActorAway(s,j,now),false);
      const frame=forestJourneyMiningFrame(s,world,true);
      assert.equal(frame.opacity,1);assert.equal(frame.working,false);assert.deepEqual({x:frame.x,y:frame.y},feet);
      for(let n=0;n<3;n++)syncForestJourneyTravel(s,world,j,now,true,cancelled ? [j.id] : []);
      assert.deepEqual(s.clearing.position,feet);assert.equal(s.journeyTravel.phase,"returning");
    }finally{session.release()}
  }
});

test("a cancelled mine receipt cannot send a returned hero back inside before the next server snapshot",()=>{
  const session=create(),s=session.state,j=job("cave");
  try {
    syncForestJourneyTravel(s,world,j,start+60_000,false);
    syncForestJourneyTravel(s,world,j,start+61_000,false,[j.id]);
    for(let n=0;n<2400 && s.journeyTravel?.mining;n++) step(s,j,start+61_000+n*50);
    assert.deepEqual(s.clearing.position,world.actor.spawn);
    assert.equal(s.journeyTravel.cancelled,true);
    assert.equal(forestJourneyMiningFrame(s,world),null,"normal wardrobe returns after the actual road home");
    for(let n=0;n<4;n++) {
      syncForestJourneyTravel(s,world,j,start+180_000,false,[j.id]);
      assert.equal(forestJourneyActorAway(s,j,start+180_000),false);
      assert.deepEqual(s.clearing.position,world.actor.spawn);
      assert.equal(s.journeyTravel.mining,undefined);
    }
    syncForestJourneyTravel(s,world,null,start+181_000,false,[j.id]);
    assert.equal(s.journeyTravel,undefined);
  }finally{session.release()}
});

test("a fresh mine job on the first camera visibly leaves base instead of being mistaken for a restored interior",()=>{
  const session=create(),s=session.state,j=job("cave");
  try {
    const feet={...s.clearing.position};
    syncForestJourneyTravel(s,world,j,start+1000,false);
    assert.equal(s.journeyTravel.phase,"leaving");assert.deepEqual(s.clearing.position,feet);
    assert.equal(forestJourneyActorAway(s,j,start+1000),false);
    const travel=s.journeyTravel;
    for(let n=0;n<5;n++)syncForestJourneyTravel(s,world,j,start+1000,false);
    assert.strictEqual(s.journeyTravel,travel);assert.deepEqual(s.clearing.position,feet);
    for(let n=0;n<2400 && s.journeyTravel.phase!=="working";n++)step(s,j,start+1000+n*50);
    assert.equal(s.journeyTravel.phase,"working");
  }finally{session.release()}
});

test("a miner elsewhere on the map walks back to base for tools before taking the safe quarry road",()=>{
  const session=create(),s=session.state,j=job("cave");
  try {
    const elsewhere=world.destinations.find(point=>point.id==="fishing").position;
    s.clearing.position={...elsewhere};
    syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
    assert.equal(s.journeyTravel.mining.prepared,false);
    assert.deepEqual(s.clearing.requestedPoint,s.clearing.home);
    assert.equal(forestJourneyMiningFrame(s,world),null,"tools stay at base until picked up");
    let n=0;
    for(;n<2400 && !s.journeyTravel.mining.prepared;n++)step(s,j,start+n*50);
    assert.equal(s.journeyTravel.mining.prepared,true);assert.deepEqual(s.clearing.position,s.clearing.home);
    for(;n<4800 && s.journeyTravel.phase!=="working";n++)step(s,j,start+n*50);
    assert.equal(s.journeyTravel.phase,"working");
  }finally{session.release()}
});

test("an expedition replacing mine production first exits and returns without teleporting or losing its new job",()=>{
  const session=create(),s=session.state,mine=job("quarry_work"),shore=job("shore",3600,{fish:4});
  mine.id="production:quarry-1";
  try {
    syncForestJourneyTravel(s,world,mine,start+60_000,false);
    assert.equal(s.journeyTravel.phase,"working");const feet={...s.clearing.position};
    syncForestJourneyTravel(s,world,shore,start+61_000,false);
    assert.equal(s.journeyTravel.phase,"exiting");assert.equal(s.journeyTravel.jobId,mine.id);
    assert.deepEqual(s.clearing.position,feet);assert.equal(forestJourneyActorAway(s,shore,start+61_000),false);
    let returned=false;
    for(let n=0;n<4800 && s.journeyTravel?.phase!=="fishing";n++){
      step(s,shore,start+61_000+n*50);
      if(!s.journeyTravel) { returned=true;assert.deepEqual(s.clearing.position,s.clearing.home); }
    }
    assert.equal(returned,true);assert.equal(s.journeyTravel.jobId,shore.id);assert.equal(s.journeyTravel.phase,"fishing");
  }finally{session.release()}
});


test("quarry work cannot cut off a visible fishing catch or hide its return after the expedition is removed",()=>{
  const session=create(),s=session.state,shore=job("shore",2700,{fish:4}),mine=job("quarry_work");
  mine.id="production:waiting-quarry";
  try {
    syncForestJourneyTravel(s,world,shore,start+60_000,false);
    const age=forestJobFishingPlan(shore).catches[0].at-1;
    syncForestJourneyTravel(s,world,shore,start+age*1000,false);
    const before=forestJourneyFishingFrame(s,world),feet={...s.clearing.position};
    assert.equal(before.action,"pack");
    syncForestJourneyTravel(s,world,mine,start+age*1000,false,[shore.id]);
    assert.equal(s.journeyTravel.jobId,shore.id);assert.ok(s.journeyTravel.ending);
    assert.deepEqual(forestJourneyFishingFrame(s,world),before);assert.deepEqual(s.clearing.position,feet);
    assert.equal(forestJourneyActorAway(s,mine,start+age*1000),false);
    let returned=false;
    for(let n=0;n<4800 && s.journeyTravel?.jobId!==mine.id;n++) {
      step(s,mine,start+age*1000+n*50);
      if(s.journeyTravel?.phase==="returning") assert.equal(forestJourneyActorAway(s,mine,start+age*1000+n*50),false);
      if(!s.journeyTravel) { returned=true;assert.deepEqual(s.clearing.position,s.clearing.home); }
    }
    assert.equal(returned,true);assert.equal(s.journeyTravel.jobId,mine.id);assert.equal(s.journeyTravel.phase,"leaving");
    assert.ok(Math.hypot(s.clearing.position.x-s.clearing.home.x,s.clearing.position.y-s.clearing.home.y)<1,
      "the new mine road begins with one bounded step from base");
  }finally{session.release()}
});


test("reduced motion replaces a finished mine worker with the new static assignment without waiting for a frozen return",()=>{
  for(const route of ["shore","cave"]) {
    const session=create(),s=session.state,mine=job("quarry_work"),next=job(route);
    mine.id="production:old";next.id="new-assignment";
    try {
      syncForestJourneyTravel(s,world,mine,start+60_000,true);
      assert.equal(s.journeyTravel.phase,"working");
      syncForestJourneyTravel(s,world,next,start+61_000,true);
      assert.equal(s.journeyTravel.jobId,next.id);
      assert.equal(s.journeyTravel.phase,route==="shore" ? "fishing" : "working");
      const feet={...s.clearing.position};
      for(let n=0;n<5;n++)syncForestJourneyTravel(s,world,next,start+62_000,true);
      assert.deepEqual(s.clearing.position,feet);
    }finally{session.release()}
  }
});
