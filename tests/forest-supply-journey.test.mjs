import assert from "node:assert/strict";
import test,{after} from "node:test";
import {fileURLToPath} from "node:url";
import {createServer} from "vite";

const root=fileURLToPath(new URL("..",import.meta.url));
const vite=await createServer({root,configFile:false,logLevel:"silent",resolve:{alias:{"@":root}},server:{middlewareMode:true,hmr:false,ws:false}});
after(()=>vite.close());
const load=path=>vite.ssrLoadModule(`/features/world/${path}.ts`);
const {TILED_WORLD}=await load("scene/presentation");
const {previewWorldScene,initialPreviewLevels}=await load("tiled/preview-state");
const {connectForestSession}=await load("state/forest-session");
const {captureForestMemory}=await load("state/memory/forest-memory");
const {advanceForestDirector}=await load("simulation/forest-director");
const {requestClearingSleep,advanceClearingActivity}=await load("simulation/clearing-activity");
const {syncForestJourneyTravel,forestJourneyWalking,forestJourneyActorAway,forestJourneyFishingFrame}=await load("activities/journeys/forest-journey-travel");
const {forestJourneyGatheringFrame}=await load("activities/journeys/forest-supply-journey");
const {forestGardenGroundBasket}=await load("activities/garden/forest-garden-painter");
const {gatheringGesture,isForestSupplyRoute}=await load("activities/journeys/forest-gathering");
const {canTraverse,isWalkable}=await load("navigation/navigation");
const {forestTrailDestination}=await load("navigation/forest-trails");
const world=previewWorldScene(TILED_WORLD,initialPreviewLevels(TILED_WORLD)),start=1_000_000;
const job=(routeId="forest")=>({id:`supply-${routeId}`,routeId,rewards:{wood:5,stone:3,fiber:4},startedAt:new Date(start).toISOString(),finishesAt:new Date(start+1800_000).toISOString()});
const create=(key,view="world",at=start)=>connectForestSession(key,world,view,at,0,()=>{},{persistence:false,sync:false});
function tick(s,j,now,{still=false,cancelled=[],dusk=0}={}) {
  const before={...s.clearing.position};
  syncForestJourneyTravel(s,world,j,now,still,cancelled);
  if(!still)advanceForestDirector(s,.05,{autoLife:false,blocked:true,explicitTravel:forestJourneyWalking(s),actorAway:forestJourneyActorAway(s,j,now),homeAvailable:true,dusk,rain:0,butterflies:"off",fireflies:"off"});
  assert.ok(Math.hypot(s.clearing.position.x-before.x,s.clearing.position.y-before.y)<1,"visible feet advance only through the bounded walker");
  if(!s.clearing.activeInteraction)assert.ok(canTraverse(s.clearing.navigation,before,s.clearing.position));
  const frame=forestJourneyGatheringFrame(s,world,still);
  if(frame)assert.deepEqual({x:frame.x,y:frame.y},s.clearing.position,"drawing and reservations share actual feet");
}
function walkUntil(s,j,now,predicate,options) {
  for(let n=0;n<3000&&!predicate();n++)tick(s,j,now+n*50,options);
  assert.ok(predicate(),`walk completes safely: ${s.journeyTravel?.phase}, ${s.clearing.behavior.reason}`);
}

test("only exact woodland exploration targets get a supply activity",()=>{
  for(const route of ["forest","old_woodland"])assert.equal(isForestSupplyRoute(route),true);
  for(const route of [undefined,"forest_camp","shore","shore_camp","cave","quarry_work","coastal_deposits","uplands","custom_forest"])assert.equal(isForestSupplyRoute(route),false);
});

test("confirmed supply jobs walk to the real woodland, gather visibly, return on the server deadline and await claim",()=>{
  for(const route of ["forest","old_woodland"]) {
    const session=create(),s=session.state,j=job(route),saved=structuredClone(j);
    try {
      syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
      assert.equal(s.journeyTravel.phase,"leaving");assert.equal(forestJourneyActorAway(s,j,start),false);
      assert.equal(forestJourneyFishingFrame(s,world),null);
      assert.deepEqual(s.journeyTravel.shore,forestTrailDestination(world,"foraging"));
      assert.equal(isWalkable(s.clearing.navigation,s.journeyTravel.shore),true);
      walkUntil(s,j,start,()=>s.journeyTravel.phase==="gathering",{dusk:1});
      const feet={...s.clearing.position},actions=new Set();
      for(const age of [0,6.2,11.2,14.2,17.2,21.2,26.2,41.2,58.2]) {
        s.director.elapsed=s.journeyTravel.gathering.phaseAt+age;
        const frame=forestJourneyGatheringFrame(s,world);actions.add(frame.action);
        assert.deepEqual(s.clearing.position,feet);assert.equal(forestJourneyActorAway(s,j,start+600_000),false);
        assert.equal(frame.basket.size,s.life.garden.basket.size);
        assert.equal(s.life.garden.basket.journeyOwner,j.id);
        if(!frame.held)assert.deepEqual({x:frame.basket.x,y:frame.basket.y},s.journeyTravel.gathering.groundBasket);
      }
      assert.ok(["look","search","pick","lift","pack","rest"].every(action=>actions.has(action)));
      s.director.elapsed+=100_000;syncForestJourneyTravel(s,world,j,start+600_000,false);
      assert.equal(s.journeyTravel.phase,"gathering","local animation cannot complete a real job");
      syncForestJourneyTravel(s,world,j,start+1800_000,false);
      assert.equal(s.journeyTravel.phase,"packing");assert.deepEqual(s.clearing.position,feet);
      s.director.elapsed+=1.21;syncForestJourneyTravel(s,world,j,start+1800_000,false);
      assert.equal(s.journeyTravel.phase,"returning");
      walkUntil(s,j,start+1800_000,()=>s.journeyTravel.phase==="ready");
      assert.deepEqual(s.clearing.position,world.actor.spawn);assert.equal(forestJourneyGatheringFrame(s,world),null);
      assert.equal(s.life.garden.basket.journeyOwner,undefined);assert.equal(s.life.garden.basket.held,false);
      assert.deepEqual(s.life.garden.basket.position,s.life.garden.basket.homePosition);
      assert.deepEqual(j,saved,"scene never claims, modifies deadlines or awards resources");
      assert.ok(!JSON.stringify(captureForestMemory(s,world)).includes(j.id));
      syncForestJourneyTravel(s,world,null,start+1900_000,false);assert.equal(s.journeyTravel,undefined);
    }finally{session.release()}
  }
});

test("cancellation turns from current feet and stows an empty basket without waiting for a stale account response",()=>{
  for(const working of [false,true]) {
    const session=create(),s=session.state,j=job();
    try {
      syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
      if(working)walkUntil(s,j,start,()=>s.journeyTravel.phase==="gathering");
      else for(let n=0;n<50;n++)tick(s,j,start+n*50);
      const before={...s.clearing.position};s.director.elapsed+=21;
      syncForestJourneyTravel(s,world,j,start+100_000,false,[j.id]);
      assert.deepEqual(s.clearing.position,before);assert.equal(s.journeyTravel.cancelled,true);
      assert.equal(Boolean(forestJourneyGatheringFrame(s,world)?.filled),false);
      if(working){s.director.elapsed+=1.21;syncForestJourneyTravel(s,world,j,start+100_000,false,[j.id]);}
      assert.equal(s.journeyTravel.phase,"returning");
      walkUntil(s,j,start+100_000,()=>!s.journeyTravel,{cancelled:[j.id]});
      syncForestJourneyTravel(s,world,j,start+100_000,false,[j.id]);assert.equal(s.journeyTravel,undefined);
    }finally{session.release()}
  }
});

test("restoration, two cameras and account replacement do not replay departures or share another owner's assignment",()=>{
  const key="supply-shared-camera",circle=create(key,"circle",start+600_000),s=circle.state,j=job();
  let map,other;
  try {
    circle.configure("circle",true);syncForestJourneyTravel(s,world,j,start+600_000,false);
    assert.equal(s.journeyTravel.phase,"gathering");const travel=s.journeyTravel,feet={...s.clearing.position};
    map=create(key,"world",start+600_000);map.configure("world",true);assert.strictEqual(map.state,s);
    for(let n=0;n<10;n++)syncForestJourneyTravel(map.state,world,j,start+600_000,false);
    assert.strictEqual(s.journeyTravel,travel);assert.deepEqual(s.clearing.position,feet);
    other=create("supply-other-owner");assert.equal(other.state.journeyTravel,undefined);
    assert.notStrictEqual(other.state,s);
    map.release();map=null;assert.equal(circle.isOwner(),true);assert.deepEqual(s.clearing.position,feet);
  }finally{other?.release();map?.release();circle.release()}
});

test("reduced motion freezes actual feet and gesture; resuming after completion follows the same physical route",()=>{
  const session=create(),s=session.state,j=job();
  try {
    syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
    for(let n=0;n<40;n++)tick(s,j,start+n*50);
    const feet={...s.clearing.position};tick(s,j,start+10_000,{still:true});assert.deepEqual(s.clearing.position,feet);
    syncForestJourneyTravel(s,world,j,start+1800_000,true);assert.equal(s.journeyTravel.phase,"returning");
    assert.deepEqual(s.clearing.position,feet);
    const frame=forestJourneyGatheringFrame(s,world,true);s.director.elapsed+=100;
    assert.deepEqual(forestJourneyGatheringFrame(s,world,true),frame);
    walkUntil(s,j,start+1800_000,()=>s.journeyTravel.phase==="ready");
  }finally{session.release()}
});

test("ready supply presentation yields once to an authorized berry activity and cannot recreate itself on refresh",()=>{
  const session=create(),s=session.state,j=job();
  try {
    syncForestJourneyTravel(s,world,j,start+1800_000,false);assert.equal(s.journeyTravel.phase,"ready");
    s.pendingLife="harvest-berries";
    syncForestJourneyTravel(s,world,j,start+1800_000,false);assert.equal(forestJourneyGatheringFrame(s,world),null);
    s.pendingLife=null;
    for(let n=0;n<5;n++)syncForestJourneyTravel(s,world,j,start+1800_000,false);
    assert.equal(forestJourneyGatheringFrame(s,world),null);
    syncForestJourneyTravel(s,world,null,start+1800_000,false);assert.equal(s.journeyTravel,undefined);
  }finally{session.release()}
});

test("a sleeping Mochlik finishes the real doorway exit before the supply walk",()=>{
  const session=create(),s=session.state,j=job();
  try {
    assert.equal(requestClearingSleep(s.clearing),true);
    for(let n=0;n<2000&&s.clearing.stage!=="home-sleep";n++)advanceClearingActivity(s.clearing,.05,{enabled:true,blocked:false,homeAvailable:true,dusk:1,rain:0});
    assert.equal(s.clearing.stage,"home-sleep");const feet={...s.clearing.position};
    syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
    assert.deepEqual(s.clearing.position,feet);assert.equal(forestJourneyGatheringFrame(s,world),null,"a basket is not drawn through the closed doorway");
    walkUntil(s,j,start,()=>s.journeyTravel.phase==="gathering",{dusk:1});
    assert.deepEqual(s.clearing.position,forestTrailDestination(world,"foraging"));
  }finally{session.release()}
});

test("gathering variations pause, carry a finding only until its pack gesture, and sample without side effects",()=>{
  const first=gatheringGesture(13,0),next=gatheringGesture(41,0);
  assert.notEqual(first.item,next.item);assert.notEqual(first.direction,next.direction);
  assert.equal(gatheringGesture(25,0).action,"rest");assert.equal(gatheringGesture(25,0).itemVisible,false);
  assert.equal(gatheringGesture(10,0).itemVisible,false);assert.equal(gatheringGesture(11.5,0).itemVisible,true);
  assert.equal(gatheringGesture(18.8,0).itemVisible,false);
  assert.deepEqual(gatheringGesture(10,0,true),gatheringGesture(1000,0,true));
});

test("a replacement assignment finishes the current grounded gesture and starts from those feet",()=>{
  const session=create(),s=session.state,j=job(),next={...job("old_woodland"),startedAt:new Date(start+600_000).toISOString(),finishesAt:new Date(start+3000_000).toISOString()};
  try {
    syncForestJourneyTravel(s,world,j,start+600_000,false);
    s.director.elapsed=s.journeyTravel.gathering.phaseAt+11;
    const feet={...s.clearing.position},source=forestJourneyGatheringFrame(s,world);
    syncForestJourneyTravel(s,world,next,start+600_000,false);
    assert.equal(s.journeyTravel.jobId,j.id);assert.equal(s.journeyTravel.phase,"packing");
    assert.deepEqual(forestJourneyGatheringFrame(s,world).hand,source.hand,"the first stow frame preserves the current grip");
    for(let n=0;n<3;n++)syncForestJourneyTravel(s,world,next,start+600_000,false);
    assert.equal(s.journeyTravel.jobId,j.id,"a second camera cannot bypass the current cleanup");
    s.director.elapsed+=1.21;syncForestJourneyTravel(s,world,next,start+600_000,false);
    assert.equal(s.journeyTravel.jobId,j.id,"the one borrowed basket must be returned before a replacement takes it");
    assert.deepEqual(s.clearing.position,feet);
    walkUntil(s,next,start+600_000,()=>s.journeyTravel?.jobId===next.id);
    assert.notEqual(s.life.garden.basket.journeyOwner,j.id,"the old ownership is released at the real home marker");
    walkUntil(s,next,start+650_000,()=>s.journeyTravel?.phase==="gathering");
    assert.equal(s.life.garden.basket.journeyOwner,next.id);
  }finally{session.release()}
});

test("enabling reduced motion during final packing releases its animation at the same feet",()=>{
  const session=create(),s=session.state,j=job();
  try {
    syncForestJourneyTravel(s,world,j,start+600_000,false);const feet={...s.clearing.position};
    syncForestJourneyTravel(s,world,j,start+1800_000,false);assert.equal(s.journeyTravel.phase,"packing");
    syncForestJourneyTravel(s,world,j,start+1800_000,true);assert.equal(s.journeyTravel.phase,"returning");
    assert.deepEqual(s.clearing.position,feet);
    s.pendingLife="harvest-berries";syncForestJourneyTravel(s,world,j,start+1800_000,true);
    assert.equal(forestJourneyGatheringFrame(s,world,true),null,"accessibility never strands an authorized collection behind a paused cleanup");
  }finally{session.release()}
});

test("arriving lowers the real carried basket and cancellation preserves its current lift",()=>{
  const session=create(),s=session.state,j=job();
  try {
    syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
    walkUntil(s,j,start,()=>s.journeyTravel.phase==="gathering");
    const first=forestJourneyGatheringFrame(s,world);assert.equal(first.action,"setdown");assert.equal(first.held,true);
    s.director.elapsed=s.journeyTravel.gathering.phaseAt+.6;
    const midway=forestJourneyGatheringFrame(s,world);
    assert.ok(midway.basket.y>first.basket.y&&midway.basket.y<midway.y,"basket approaches its actual floor gradually");
    syncForestJourneyTravel(s,world,j,start+100_000,false,[j.id]);
    const stowing=forestJourneyGatheringFrame(s,world);
    assert.ok(Math.abs(stowing.basket.y-midway.basket.y)<1e-10);
    assert.ok(Math.hypot(stowing.hand.x-midway.hand.x,stowing.hand.y-midway.hand.y)<1e-10);
  }finally{session.release()}
});

test("a ready or released supply job hands off to a new shore or mine job in the same sync",()=>{
  const scene=previewWorldScene(TILED_WORLD,{...initialPreviewLevels(TILED_WORLD),quarry:1});
  for(const route of ["shore","cave"])for(const released of [false,true]) {
    const session=connectForestSession(undefined,scene,"world",start,0,()=>{},{persistence:false,sync:false}),s=session.state,j=job();
    try {
      syncForestJourneyTravel(s,scene,j,start+1800_000,false);
      assert.equal(s.journeyTravel.phase,"ready");
      if(released){s.pendingLife="harvest-berries";syncForestJourneyTravel(s,scene,j,start+1800_000,false);s.pendingLife=null;}
      const feet={...s.clearing.position},next={...job(route),startedAt:new Date(start+1800_000).toISOString(),finishesAt:new Date(start+2400_000).toISOString()};
      syncForestJourneyTravel(s,scene,next,start+1800_000,false);
      assert.equal(s.journeyTravel.jobId,next.id);assert.equal(s.journeyTravel.phase,"leaving");
      assert.equal(forestJourneyActorAway(s,next,start+1800_000),false,"no intermediate hidden frame between accepted assignments");
      assert.deepEqual(s.clearing.position,feet);
    }finally{session.release()}
  }
});

test("woodland borrows one physical garden basket only after reaching it and preserves its contents",()=>{
  const session=create(),s=session.state,j=job("old_woodland"),basket=s.life.garden.basket;
  try {
    basket.berries=3;
    syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
    assert.equal(forestJourneyGatheringFrame(s,world),null,"no imaginary basket before pickup");
    assert.ok(forestGardenGroundBasket(s.life.garden,s.clearing.size));
    walkUntil(s,j,start,()=>s.journeyTravel.gathering.basketStage==="pickup");
    assert.strictEqual(s.life.garden.basket,basket);assert.equal(basket.journeyOwner,j.id);
    assert.equal(forestGardenGroundBasket(s.life.garden,s.clearing.size),null,"the original painter yields its sole basket");
    const pickup=forestJourneyGatheringFrame(s,world);
    assert.deepEqual(s.journeyTravel.gathering.basketFrom,basket.homePosition);
    assert.ok(Math.hypot(pickup.basket.x-basket.homePosition.x,pickup.basket.y-basket.homePosition.y)<1,"pickup begins at the existing prop");
    walkUntil(s,j,start,()=>s.journeyTravel.phase==="gathering");
    syncForestJourneyTravel(s,world,j,start+100_000,false,[j.id]);
    walkUntil(s,j,start+100_000,()=>!s.journeyTravel,{cancelled:[j.id]});
    assert.strictEqual(s.life.garden.basket,basket);assert.equal(basket.berries,3);
    assert.equal(basket.journeyOwner,undefined);assert.equal(basket.held,false);
    assert.deepEqual(basket.position,basket.homePosition);assert.ok(forestGardenGroundBasket(s.life.garden,s.clearing.size));
  }finally{session.release()}
});

test("coastal deposits work on dry shore with a shovel and never borrow the garden basket",()=>{
  const session=create(),s=session.state,j=job("coastal_deposits"),basket=s.life.garden.basket,saved=structuredClone(basket);
  try {
    syncForestJourneyTravel(s,world,j,start+600_000,false);
    assert.equal(s.journeyTravel.phase,"gathering");assert.equal(s.journeyTravel.gathering.tool,"shovel");
    assert.deepEqual(s.clearing.position,forestTrailDestination(world,"fishing"));
    assert.ok(isWalkable(s.clearing.navigation,s.clearing.position));
    const frames=[0,8,15,20,27].map(age=>{s.director.elapsed=s.journeyTravel.gathering.phaseAt+age;return forestJourneyGatheringFrame(s,world)});
    assert.ok(frames.every(frame=>frame.tool==="shovel"&&frame.shovel));
    assert.ok(new Set(frames.map(frame=>frame.action)).size>=3,"digging alternates with quiet inspection");
    assert.strictEqual(s.life.garden.basket,basket);assert.deepEqual(basket,saved);
    assert.ok(forestGardenGroundBasket(s.life.garden,s.clearing.size));
    assert.equal(forestJourneyFishingFrame(s,world),null,"shore work does not also draw a fishing rod");
  }finally{session.release()}
});

test("reduced motion can cancel a paused pickup and finish a long assignment without stranding basket ownership",()=>{
  for(const pickup of [true,false]) {
    const session=create(),s=session.state,j=job("old_woodland");
    try {
      if(pickup) {
        syncForestJourneyTravel(s,world,null,start,false);syncForestJourneyTravel(s,world,j,start,false);
        walkUntil(s,j,start,()=>s.journeyTravel.gathering.basketStage==="pickup");
      } else syncForestJourneyTravel(s,world,j,start+600_000,false);
      const feet={...s.clearing.position};s.clearing.elapsed=2000;s.director.elapsed+=2000;
      syncForestJourneyTravel(s,world,j,start+1800_000,true,pickup?[j.id]:[]);
      assert.deepEqual(s.clearing.position,feet);assert.equal(s.journeyTravel.phase,"returning");
      assert.equal(s.life.garden.basket.journeyOwner,undefined);
      assert.equal(s.journeyTravel.beganAt,2000,"the return budget starts now, not when the long trip began");
      walkUntil(s,j,start+1800_000,()=>pickup?!s.journeyTravel:s.journeyTravel.phase==="ready",{cancelled:pickup?[j.id]:[]});
      assert.equal(s.life.garden.basket.journeyOwner,undefined);
    }finally{session.release()}
  }
});

test("a scene refresh stows the existing grounded prop before retargeting local work",()=>{
  const session=create(),s=session.state,j=job(),nextScene={...world};
  try {
    syncForestJourneyTravel(s,world,j,start+600_000,false);s.director.elapsed=s.journeyTravel.gathering.phaseAt+11;
    const before=forestJourneyGatheringFrame(s,world),feet={...s.clearing.position};
    syncForestJourneyTravel(s,nextScene,j,start+600_000,false);
    const after=forestJourneyGatheringFrame(s,nextScene);
    assert.equal(s.journeyTravel.phase,"packing");assert.equal(s.journeyTravel.gathering.resumeGathering,true);
    assert.deepEqual(after.basket,before.basket);assert.deepEqual(after.hand,before.hand);assert.deepEqual(s.clearing.position,feet);
    s.director.elapsed+=1.21;syncForestJourneyTravel(s,nextScene,j,start+600_000,false);
    assert.equal(s.journeyTravel.phase,"gathering","an unchanged safe work point resumes after the lift");
    assert.equal(s.life.garden.basket.journeyOwner,j.id);
  }finally{session.release()}
});

test("a new local assignment waits for fishing tackle without a hidden intermediate frame",()=>{
  for(const route of ["old_woodland","coastal_deposits"]) {
    const session=create(),s=session.state,previous=job("shore"),next={...job(route),startedAt:new Date(start+600_000).toISOString()};
    try {
      syncForestJourneyTravel(s,world,previous,start+600_000,false);assert.equal(s.journeyTravel.phase,"fishing");
      const feet={...s.clearing.position};
      for(let n=0;n<120&&s.journeyTravel?.jobId!==next.id;n++) {
        tick(s,next,start+600_000+n*50);
        assert.equal(forestJourneyActorAway(s,next,start+600_000+n*50),false,"cleanup and dispatch keep the body visible");
      }
      assert.equal(s.journeyTravel?.jobId,next.id);
      assert.ok(Math.hypot(s.clearing.position.x-feet.x,s.clearing.position.y-feet.y)<2,"new work departs from the finished tackle gesture");
    }finally{session.release()}
  }
});
