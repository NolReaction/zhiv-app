import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const root=fileURLToPath(new URL('..',import.meta.url));
const vite=await createServer({appType:'custom',configFile:false,root,server:{middlewareMode:true,hmr:false}});
const {connectHabitat}=await vite.ssrLoadModule('/lib/mochlik/session.ts');
const {createHabitat}=await vite.ssrLoadModule('/lib/mochlik/habitat.ts');
after(()=>vite.close());
const advance=(world,seconds)=>{for(let i=0;i<seconds*40;i++)world.update(.025)};
function until(world,condition,max=180){for(let i=0;i<max*40&&!condition(world.state);i++)world.update(.025);assert.ok(condition(world.state),world.state.activity)}
test('circle and world share exact choreography and one clock, then release ownership',()=>{
 let restored=0;const init=()=>restored++;
 const circle=connectHabitat('transfer','circle',true,init,()=>{},1000);
 circle.world.moveTo({x:.65,y:.7});circle.world.update(.025);const before=structuredClone(circle.world.state);
 const map=connectHabitat('transfer','world',true,init,()=>{},1000);
 assert.equal(restored,1);assert.equal(circle.world,map.world);assert.equal(circle.isOwner(),false);assert.equal(map.isOwner(),true);
 assert.deepEqual(map.world.state.position,before.position);assert.equal(map.world.state.activityTime,before.activityTime);
 circle.advance(2000,true);map.advance(2000,true);assert.equal(map.world.state.ecologyTime,before.ecologyTime+1);
 map.advance(1000,true);map.advance(2000,true);assert.equal(map.world.state.ecologyTime,before.ecologyTime+1);
 const position=structuredClone(map.world.state.position);map.release();assert.equal(circle.isOwner(),true);assert.deepEqual(circle.world.state.position,position);
 circle.release();const fresh=connectHabitat('transfer','circle',true,init,()=>{},2000);assert.equal(restored,2);fresh.release();
});
test('active world wakes deep sleep automatically and suppresses inactivity sleep',()=>{
 const circle=connectHabitat('wake','circle',true,w=>w.restAfterAbsence(true),()=>{},0);
 const map=connectHabitat('wake','world',true,()=>assert.fail('must not initialize twice'),()=>{},0);
 until(map.world,s=>s.activity==='greet',30);assert.equal(map.world.state.wakeTapsNeeded,1);
 advance(map.world,360);assert.equal(map.world.state.resting,false);assert.equal(map.world.state.inactiveFor,0);
 map.release();advance(circle.world,120);assert.equal(circle.world.state.activity,'sleep');circle.release();
});
test('changing view on the same handle also wakes the character',()=>{
 const session=connectHabitat('same','circle',true,w=>w.restAfterAbsence(true),()=>{},0);
 session.configure('world',true);until(session.world,s=>s.activity==='greet',30);advance(session.world,80);assert.equal(session.world.state.resting,false);session.release();
});
test('departure waves, walks and fades; recalling preserves the chosen exit',()=>{
 for(const river of [false,true]){
  const world=createHabitat();const position=structuredClone(world.state.position);world.setAway(true,true,river);
  assert.deepEqual(world.state.position,position);assert.equal(world.state.travel,'departing');assert.equal(world.state.activity,'greet');
  until(world,s=>s.activity==='depart',15);until(world,s=>s.travel==='away',15);
  assert.deepEqual(world.state.position,{x:.8,y:river?.53:.73});world.setAway(false);
  assert.deepEqual(world.state.position,{x:.8,y:river?.53:.73});assert.equal(world.state.travel,'home');
 }
});
test('fast recall does not teleport a departing character',()=>{
 const world=createHabitat();world.setAway(true);advance(world,.5);const position=structuredClone(world.state.position);
 world.setAway(false);assert.deepEqual(world.state.position,position);assert.equal(world.state.travel,'home');
});
test('departure finishes atomic jumps and eating without losing the consumed mushroom',()=>{
 const world=createHabitat();until(world,s=>s.activity==='jump');advance(world,.2);const position=structuredClone(world.state.position);world.setAway(true);
 assert.equal(world.state.activity,'jump');world.update(.025);assert.ok(Math.hypot(position.x-world.state.position.x,position.y-world.state.position.y)<.01);
 until(world,s=>s.travel==='away',30);
 const eater=createHabitat();eater.elapse(140);eater.notice();eater.invite('mushrooms');until(eater,s=>s.activity==='eat');
 const id=eater.state.feedingId;eater.setAway(true);until(eater,s=>s.travel==='away',35);
 assert.equal(eater.state.eaten,1);assert.ok(eater.state.mushrooms.find(m=>m.id===id).growth<.5);
});
