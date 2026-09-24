import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root=fileURLToPath(new URL('..',import.meta.url));
const vite=await createServer({appType:'custom',configFile:false,root,resolve:{alias:{'@':root}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const {createForestLife,triggerForestLife,cancelForestLife,interruptForestLife,advanceForestLife,forestLifeFrame}=await vite.ssrLoadModule('/features/world/forest-life.ts');
const {connectForestSession}=await vite.ssrLoadModule('/features/world/forest-session.ts');
const {isForestGroundClear}=await vite.ssrLoadModule('/features/world/forest-ground-weather.ts');
const {TILED_WORLD:scene}=await vite.ssrLoadModule('/features/world/presentation.ts');
const actor={...scene.actor.spawn,size:scene.actor.size};
const conditions={autoLife:false,dusk:0,rain:0};
const advance=(state,seconds,options=conditions)=>{for(let t=0;t<seconds-1e-8;t+=.05)advanceForestLife(state,Math.min(.05,seconds-t),options)};

test('mushroom patches follow authored spawn and skip buildings or unavailable ground',()=>{
 const life=createForestLife(scene);assert.ok(life.mushrooms.length>0&&life.mushrooms.length<=2);
 for(const m of life.mushrooms)assert.ok(isForestGroundClear(scene,m,actor.size*.09));
 const shift={x:250,y:130};
 const moved={...scene,width:scene.width+shift.x,height:scene.height+shift.y,focus:{...scene.focus,x:scene.focus.x+shift.x,y:scene.focus.y+shift.y},actor:{...scene.actor,spawn:{x:actor.x+shift.x,y:actor.y+shift.y}},sites:[],paths:[]};
 const origin={...scene,sites:[],paths:[]};
 assert.deepEqual(createForestLife(moved).mushrooms.map(m=>({x:m.x-shift.x,y:m.y-shift.y})),createForestLife(origin).mushrooms.map(({x,y})=>({x,y})));
 const blocked={...scene,sites:[{...scene.sites[0],bounds:{x:actor.x-100,y:actor.y-100,width:200,height:200}}]};
 assert.equal(createForestLife(blocked).mushrooms.length,0);assert.equal(createForestLife({...scene,actor:undefined}).mushrooms.length,0);
});

test('food is picked once, lifted to paws, bitten, swallowed, then regrows on active time',()=>{
 const life=createForestLife(scene);triggerForestLife(life,'mushroom');
 const picked=life.mushrooms.find(m=>m.id===life.routine.mushroomId);assert.ok(picked);
 advance(life,1.5);let frame=forestLifeFrame(life,actor,life.elapsed);
 assert.equal(frame.pose,'reach');assert.equal(frame.heldMushroom,null);assert.equal(picked.growth,1);
 advance(life,1);frame=forestLifeFrame(life,actor,life.elapsed);
 assert.equal(picked.growth,0);assert.ok(frame.heldMushroom);assert.equal(frame.pose,'hold');
 const remainingDelay=picked.regrowIn;advance(life,.3);assert.ok(picked.regrowIn<remainingDelay,'pickup does not reset regrowth every tick');
 advance(life,2.4);frame=forestLifeFrame(life,actor,life.elapsed);
 assert.equal(frame.pose,'chew');assert.ok(frame.heldMushroom.bite>0&&frame.heldMushroom.bite<1);
 assert.ok(Math.abs(frame.heldMushroom.x-actor.x)<actor.size*.15);assert.ok(frame.heldMushroom.y<actor.y);
 advance(life,1.6);frame=forestLifeFrame(life,actor,life.elapsed);
 assert.equal(frame.pose,'swallow');assert.equal(frame.heldMushroom,null);
 advance(life,2);assert.equal(life.routine,null);assert.equal(picked.growth,0);
 advance(life,40);assert.equal(picked.growth,1);assert.equal(life.routine,null);
});

test('static or DEV cancellation restores untouched food but never resurrects a bitten meal',()=>{
 for(const time of [2.6,5]){
  const life=createForestLife(scene);triggerForestLife(life,'mushroom');advance(life,time);
  const picked=life.mushrooms.find(m=>m.id===life.routine.mushroomId);cancelForestLife(life);
  const expected=time<4.1?1:0;
  assert.equal(picked.growth,expected);assert.equal(life.routine,null);assert.equal(forestLifeFrame(life,actor,life.elapsed).heldMushroom,null);
  advance(life,2);assert.equal(picked.growth,expected);
 }
 const switched=createForestLife(scene);triggerForestLife(switched,'mushroom');advance(switched,2.6);
 const picked=switched.mushrooms.find(m=>m.id===switched.routine.mushroomId);triggerForestLife(switched,'leaf');
 assert.equal(picked.growth,1);assert.equal(switched.routine.kind,'leaf');
});

test('DEV growth is visible over time and immediate feeding readies only a single mushroom',()=>{
 const life=createForestLife(scene);triggerForestLife(life,'butterfly');triggerForestLife(life,'grow-mushrooms');
 assert.equal(life.routine,null);assert.ok(life.mushrooms.every(m=>m.growth>0&&m.growth<.1));
 advance(life,1.5,{...conditions,autoLife:true});assert.ok(life.mushrooms.every(m=>m.growth>.2&&m.growth<.8));assert.equal(life.routine,null);
 advance(life,2.1,{...conditions,autoLife:true});assert.ok(life.mushrooms.every(m=>m.growth===1));assert.equal(life.routine,null);
 life.mushrooms.forEach(m=>{m.growth=0;m.regrowIn=22});triggerForestLife(life,'mushroom');
 assert.equal(life.routine?.kind,'mushroom');assert.equal(life.mushrooms.filter(m=>m.growth===1).length,1);
});

test('insect routines approach, pause near paws and leave without moving the hero anchor',()=>{
 for(const kind of ['butterfly','firefly']){
  const life=createForestLife(scene);triggerForestLife(life,kind);advance(life,.5);
  const approach=forestLifeFrame(life,actor,life.elapsed);assert.equal(approach.insect.kind,kind);
  advance(life,3.5);const perch=forestLifeFrame(life,actor,life.elapsed);assert.equal(perch.stage,'perch');assert.equal(perch.pose,'greet');assert.equal(perch.frame,0);
  assert.equal(perch.insect.x,actor.x+12*actor.size/48);assert.equal(perch.insect.y,actor.y-21*actor.size/48);
  assert.ok(Math.abs(perch.insect.x-actor.x)<actor.size*.3);assert.ok(perch.insect.y<actor.y);
  advance(life,2.3);const release=forestLifeFrame(life,actor,life.elapsed);assert.equal(release.stage,'release');
  assert.notEqual(release.insect.x,perch.insect.x);advance(life,2);assert.equal(life.routine,null);
 }
});

test('automatic routines respect day/night, weather, off switches and disabled auto',()=>{
 for(const dusk of [0,1]){
  const life=createForestLife(scene);advance(life,4.1,{...conditions,autoLife:true,dusk});
  assert.equal(life.routine.kind,dusk?'firefly':'butterfly');
 }
 const off=createForestLife(scene);advance(off,8,{...conditions,autoLife:true,butterflies:'off'});assert.notEqual(off.routine?.kind,'butterfly');
 const rainy=createForestLife(scene);advance(rainy,8,{...conditions,autoLife:true,rain:1});assert.notEqual(rainy.routine?.kind,'butterfly');
 const idle=createForestLife(scene);advance(idle,60);assert.equal(idle.routine,null);
 const before=structuredClone(idle);for(const dt of [0,-1,NaN,Infinity])advanceForestLife(idle,dt,conditions);assert.deepEqual(idle,before);
});

test('a reachable fallen leaf is lifted, turned in the paws and returned to the same ground point',()=>{
 const life=createForestLife(scene);assert.ok(life.leaf,'the current authored clearing has a reachable leaf');
 assert.ok(isForestGroundClear(scene,life.leaf,actor.size*.065));
 const ground=structuredClone(life.leaf);triggerForestLife(life,'leaf');
 advance(life,1.4);assert.equal(life.routine.picked,false);assert.equal(forestLifeFrame(life,actor,life.elapsed).pose,'reach');
 advance(life,1.8);const held=forestLifeFrame(life,actor,life.elapsed);
 assert.equal(life.routine.picked,true);assert.equal(held.stage,'examine');assert.ok(held.heldLeaf.y<actor.y);
 advance(life,.5);assert.notEqual(forestLifeFrame(life,actor,life.elapsed).heldLeaf.angle,held.heldLeaf.angle);
 advance(life,1.7);const lowering=forestLifeFrame(life,actor,life.elapsed);assert.equal(lowering.stage,'put-down');
 assert.ok(lowering.heldLeaf.y>held.heldLeaf.y);
 advance(life,.5);assert.equal(life.routine.picked,false);assert.equal(forestLifeFrame(life,actor,life.elapsed).heldLeaf,null);
 advance(life,2);assert.equal(life.routine,null);assert.deepEqual(life.leaf,ground);
 const noLeaf=createForestLife({...scene,actor:undefined});triggerForestLife(noLeaf,'leaf');assert.equal(noLeaf.routine,null);
});

test('manual blocking freezes the story and held food while independent mushrooms keep growing',()=>{
 const life=createForestLife(scene);triggerForestLife(life,'mushroom');advance(life,2.7);
 const routine=structuredClone(life.routine),frame=forestLifeFrame(life,actor,life.elapsed);
 const held=life.mushrooms.find(m=>m.id===routine.mushroomId);
 life.mushrooms.push({id:99,x:0,y:0,growth:0,regrowIn:0});
 advance(life,45,{...conditions,blocked:true,autoLife:true});
 assert.deepEqual(life.routine,routine);assert.deepEqual(forestLifeFrame(life,actor,life.elapsed),frame);
 assert.equal(held.growth,0,'a held mushroom must not regrow a duplicate during a long manual pose');
 assert.equal(life.mushrooms.find(m=>m.id===99).growth,1);
 advance(life,.5);assert.ok(life.routine.elapsed>routine.elapsed);
 const idle=createForestLife(scene);advance(idle,50,{...conditions,blocked:true,autoLife:true});assert.equal(idle.routine,null);
});

test('attention puts an untouched held mushroom back smoothly and repeated taps do not restart recovery',()=>{
 const life=createForestLife(scene);triggerForestLife(life,'mushroom');advance(life,3.1);
 const ground=life.mushrooms.find(m=>m.id===life.routine.mushroomId),before=forestLifeFrame(life,actor,life.elapsed);
 assert.equal(interruptForestLife(life),true);assert.deepEqual(forestLifeFrame(life,actor,life.elapsed).heldMushroom,before.heldMushroom);
 advance(life,.3);const midway=forestLifeFrame(life,actor,life.elapsed);assert.ok(midway.heldMushroom.y>before.heldMushroom.y);assert.equal(ground.growth,0);
 const elapsed=life.routine.interrupting.elapsed;assert.equal(interruptForestLife(life),true);assert.equal(life.routine.interrupting.elapsed,elapsed);
 advance(life,.31);assert.equal(life.routine,null);assert.equal(ground.growth,1);assert.equal(ground.regrowIn,0);
 assert.equal(forestLifeFrame(life,actor,life.elapsed).heldMushroom,null);assert.ok(life.nextRoutineAt>life.elapsed+8);
});

test('attention finishes a bitten meal without restoring it; before pickup there is no artificial delay',()=>{
 const life=createForestLife(scene);triggerForestLife(life,'mushroom');advance(life,5);
 const ground=life.mushrooms.find(m=>m.id===life.routine.mushroomId);
 assert.equal(interruptForestLife(life),true);advance(life,.5);assert.equal(forestLifeFrame(life,actor,life.elapsed).pose,'swallow');
 advance(life,.11);assert.equal(life.routine,null);assert.equal(ground.growth,0);
 const before=createForestLife(scene);triggerForestLife(before,'mushroom');advance(before,1.5);
 assert.equal(interruptForestLife(before),false);assert.equal(before.routine,null);assert.equal(before.mushrooms[0].growth,1);
});

test('attention lets a perched insect depart from its current position, and pauses preserve the departure',()=>{
 for(const kind of ['butterfly','firefly']){
  const life=createForestLife(scene);triggerForestLife(life,kind);advance(life,4);
  const before=forestLifeFrame(life,actor,life.elapsed).insect;assert.equal(interruptForestLife(life),true);
  assert.deepEqual(forestLifeFrame(life,actor,life.elapsed).insect,before);
  advance(life,.3);const departing=forestLifeFrame(life,actor,life.elapsed).insect;
  assert.ok(departing.x>before.x&&departing.y<before.y);assert.ok(departing.opacity<before.opacity);
  advance(life,10,{...conditions,blocked:true});assert.deepEqual(forestLifeFrame(life,actor,life.elapsed).insect,departing);
  advance(life,.31);assert.equal(life.routine,null);
 }
});

test('interrupted leaf inspection restores exactly one grounded leaf after a short put-down',()=>{
 const life=createForestLife(scene);triggerForestLife(life,'leaf');advance(life,3.5);
 const ground=structuredClone(life.leaf),before=forestLifeFrame(life,actor,life.elapsed).heldLeaf;
 assert.equal(interruptForestLife(life),true);assert.deepEqual(forestLifeFrame(life,actor,life.elapsed).heldLeaf,before);
 advance(life,.3);assert.equal(life.routine.picked,true);assert.ok(forestLifeFrame(life,actor,life.elapsed).heldLeaf.y>before.y);
 advance(life,.31);assert.equal(life.routine,null);assert.deepEqual(life.leaf,ground);assert.equal(forestLifeFrame(life,actor,life.elapsed).heldLeaf,null);
});

test('automatic clearing stories include distinct environment interactions and rain keeps insects away',()=>{
 const life=createForestLife(scene),seen=[];let previous=null;
 for(let elapsed=0;elapsed<105;elapsed+=.05){
  advanceForestLife(life,.05,{...conditions,autoLife:true});
  if(life.routine&&life.routine!==previous)seen.push(life.routine.kind);
  previous=life.routine;
 }
 assert.deepEqual(seen.slice(0,3),['butterfly','mushroom','leaf']);
 const rainy=createForestLife(scene);rainy.mushrooms.forEach(m=>{m.growth=0;m.regrowIn=100});
 advance(rainy,4.1,{...conditions,autoLife:true,rain:1});assert.equal(rainy.routine.kind,'leaf');
});

test('two cameras share life, wetness and clock with one eligible owner and event deduplication',async()=>{
 const a=connectForestSession('shared-test',scene,'circle',1000,0,()=>{}),b=connectForestSession('shared-test',scene,'world',9999,1,()=>{});
 try{
  a.configure('circle',true);assert.equal(a.isOwner(),true);assert.equal(b.isOwner(),false);
  assert.equal(a.state,b.state);assert.equal(b.state.timestamp,1000);
  a.state.wetness=.65;a.state.elapsed=22;triggerForestLife(a.state.life,'mushroom');advance(a.state.life,3);
  assert.equal(a.consumeEvent('life',7),true);assert.equal(b.consumeEvent('life',7),false);assert.equal(b.consumeEvent('life',6),false);
  b.configure('world',true);assert.equal(b.isOwner(),true);assert.equal(a.isOwner(),false);
  assert.equal(b.state.wetness,.65);assert.equal(b.state.elapsed,22);assert.equal(b.state.life.routine.picked,true);
  b.configure('world',false);assert.equal(a.isOwner(),true);assert.equal(a.state.life.routine.picked,true);
  a.configure('circle',false);assert.equal(a.isOwner(),false);assert.equal(b.isOwner(),false);
  await Promise.resolve();
 }finally{a.release();b.release()}
 const fresh=connectForestSession('shared-test',scene,'circle',4000,0,()=>{});
 try{assert.equal(fresh.state.wetness,0);assert.equal(fresh.state.elapsed,0);assert.equal(fresh.consumeEvent('life',7),true)}finally{fresh.release()}
});

test('account and anonymous sessions are isolated and disposed callbacks never run',async()=>{
 let calls=0;const a=connectForestSession('account-a',scene,'circle',0,0,()=>calls++),b=connectForestSession('account-b',scene,'world',0,0,()=>calls++);
 const c=connectForestSession(undefined,scene,'circle',0,0,()=>calls++),d=connectForestSession(undefined,scene,'world',0,0,()=>calls++);
 assert.notEqual(a.state,b.state);assert.notEqual(c.state,d.state);a.state.wetness=1;assert.equal(b.state.wetness,0);
 a.configure('circle',true);b.configure('world',true);c.configure('circle',true);d.configure('world',true);
 for(const s of [a,b,c,d]){s.release();s.release()}
 await Promise.resolve();assert.equal(calls,0);
});
