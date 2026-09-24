import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const vite = await createServer({ configFile:false, server:{ middlewareMode:true, hmr:false } });
after(() => vite.close());
const { createForestFauna, advanceForestFauna, requestFaunaInteraction, canRequestFaunaInteraction,
  interruptFaunaInteraction, cancelFaunaInteraction, faunaInteractionFrame, faunaRenderFrame, emitFaunaStimulus } =
  await vite.ssrLoadModule('/features/world/forest-fauna.ts');
const { heroHandAnchor, heroSourceAnchor } = await vite.ssrLoadModule('/features/world/hero-anchors.ts');
const { forestAtmosphereFrame } = await vite.ssrLoadModule('/features/world/forest-atmosphere.ts');
const rectangle = (x,y,w,h) => [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const actor = {x:150,y:165,size:56};
const scene = { schemaVersion:1,id:'fauna-test',width:300,height:300,focus:{x:40,y:40,width:220,height:220},
  actor:{spawn:actor,size:56},sites:[],paths:[],habitats:[
    {id:'flowers',species:'butterfly',capacity:6,points:rectangle(100,100,100,90),anchors:[
      {id:'leaf',kind:'rest',position:{x:130,y:140}}, {id:'bush',kind:'shelter',position:{x:115,y:115}}]},
    {id:'grass',species:'firefly',capacity:12,points:rectangle(90,100,120,100),anchors:[
      {id:'grass-tip',kind:'rest',position:{x:190,y:180}}, {id:'grass-base',kind:'shelter',position:{x:195,y:190}}]},
  ]};
const conditions = {actor,dusk:0,rain:0};
const advance = (state,seconds,options=conditions,inspect) => {
  for(let t=0;t<seconds-1e-9;t+=.025){advanceForestFauna(state,Math.min(.025,seconds-t),options);inspect?.(state)}
};
const getPartner = state => state.entities.find(e=>e.id===state.encounter?.entityId);
const speed = e=>Math.hypot(e.vx,e.vy);

test('fallback population begins on the existing atmosphere orbit with stable appearance and identity',()=>{
  const legacy = {...scene};delete legacy.habitats;
  const fauna=createForestFauna(legacy),copy=createForestFauna(legacy);
  const original=forestAtmosphereFrame(legacy,{elapsed:0,timestamp:0,dusk:0,reducedMotion:false,weather:'clear',butterflies:'on',fireflies:'on'});
  assert.equal(fauna.entities.length,18);assert.deepEqual(fauna,copy);
  for(const [name,species] of [['butterflies','butterfly'],['fireflies','firefly']]){
    const ours=faunaRenderFrame(fauna)[name];assert.equal(ours.length,original[name].length);
    ours.forEach((e,i)=>{for(const key of ['x','y','size','phase'])assert.ok(Math.abs(e[key]-original[name][i][key])<1e-10,`${species} ${i} ${key}`)});
  }
  assert.equal(new Set(fauna.entities.map(e=>e.id)).size,18);
  assert.deepEqual(createForestFauna({...scene,habitats:[]}).entities,[],'explicit empty authoring has no hidden fallback');
});

test('the reserved ambient individual flies continuously to the real paw and returns to a current orbit',()=>{
  const state=createForestFauna(scene),before=structuredClone(state.entities);
  assert.equal(requestFaunaInteraction(state,'butterfly',actor,conditions),true);
  const e=getPartner(state),id=e.id,appearance={size:e.size,phase:e.phase,opacity:e.opacity};
  assert.equal(state.entities.length,18);
  assert.deepEqual({x:e.x,y:e.y,vx:e.vx,vy:e.vy},{x:before.find(a=>a.id===id).x,y:before.find(a=>a.id===id).y,
    vx:before.find(a=>a.id===id).vx,vy:before.find(a=>a.id===id).vy},'reservation never edits position or velocity');
  let previous={x:e.x,y:e.y,vx:e.vx,vy:e.vy},perched=false,released=false,returned=false;
  advance(state,24,conditions,()=>{
    assert.ok(Math.hypot(e.x-previous.x,e.y-previous.y)<=23*.025+1e-6,'bounded flight displacement');
    assert.ok(Math.hypot(e.vx-previous.vx,e.vy-previous.vy)<=45*.025+1e-6,'bounded acceleration across phase changes');
    previous={x:e.x,y:e.y,vx:e.vx,vy:e.vy};
    assert.deepEqual({size:e.size,phase:e.phase,opacity:e.opacity},appearance);
    assert.equal(faunaRenderFrame(state).butterflies.filter(p=>p.id===id).length,1);
    if(state.encounter?.phase==='perch'){
      const frame=faunaInteractionFrame(state),hand=heroHandAnchor(actor,frame);
      assert.ok(Math.hypot(e.x-hand.x,e.y-hand.y)<.7);assert.ok(speed(e)<1.7);assert.equal(frame.pose,'greet');perched=true;
    }
    if(perched&&!state.encounter){released=true;assert.ok(e.cooldownUntil>state.elapsed)}
    if(released&&e.mode==='fly')returned=true;
  });
  assert.ok(perched,'contact is reached physically');assert.ok(released);assert.ok(returned);
  assert.deepEqual(actor,{x:150,y:165,size:56},'encounter never relocates the actor');
  assert.equal(state.entities.find(a=>a.id===id),e,'individual survives return');
});

test('perching waits for actual arrival instead of a fixed scene timer',()=>{
  const state=createForestFauna(scene);state.entities=state.entities.filter(e=>e.species==='butterfly').slice(0,1);
  const e=state.entities[0];e.x=actor.x-120;e.y=actor.y-20;e.vx=-5;e.vy=0;
  assert.equal(requestFaunaInteraction(state,'butterfly',actor,conditions,true),true);
  advance(state,3.4);assert.equal(e.mode,'approach');assert.equal(state.encounter.phase,'approach');
  advance(state,6);assert.ok(['perch','depart','return'].includes(e.mode),'actual late arrival completes the contract');
});

test('repeat taps preserve a single departure, release the hero within 600ms and never fade or remove the animal',()=>{
  const state=createForestFauna(scene);requestFaunaInteraction(state,'butterfly',actor,conditions);
  const e=getPartner(state),id=e.id;
  while(state.encounter?.phase!=='perch'&&state.elapsed<12)advance(state,.025);
  assert.equal(state.encounter.phase,'perch');const before={x:e.x,y:e.y,vx:e.vx,vy:e.vy,opacity:e.opacity};
  assert.equal(interruptFaunaInteraction(state),true);
  assert.deepEqual({x:e.x,y:e.y,vx:e.vx,vy:e.vy,opacity:e.opacity},before);
  const destination=structuredClone(e.departure);advance(state,.3);
  const elapsed=state.encounter.phaseElapsed;interruptFaunaInteraction(state);
  assert.equal(state.encounter.phaseElapsed,elapsed);assert.deepEqual(e.departure,destination);
  advance(state,.3);assert.equal(state.encounter,null);assert.equal(e.mode,'depart');
  assert.equal(faunaRenderFrame(state).butterflies.find(p=>p.id===id).opacity,before.opacity);
  advance(state,15);assert.equal(state.entities.length,18);assert.equal(state.entities.find(a=>a.id===id),e);
});

test('conditions, individual cooldown and distance gate even explicit DEV requests',()=>{
  for(const options of [{rain:1},{dusk:1},{blocked:true},{butterflies:'off'}]){
    const state=createForestFauna(scene);assert.equal(requestFaunaInteraction(state,'butterfly',actor,{...conditions,...options},true),false);
    assert.ok(state.lastReason);assert.equal(state.encounter,null);
  }
  const state=createForestFauna(scene);
  assert.equal(requestFaunaInteraction(state,'firefly',actor,conditions,true),false);
  assert.equal(requestFaunaInteraction(state,'firefly',actor,{...conditions,dusk:1},true),true);
  const e=getPartner(state);cancelFaunaInteraction(state);assert.equal(state.encounter,null);assert.equal(e.mode,'depart');
  const far={...actor,x:1000};assert.equal(canRequestFaunaInteraction(createForestFauna(scene),'butterfly',far,conditions,true),false);
  const tired=createForestFauna(scene);tired.entities.forEach(e=>e.cooldownUntil=30);
  assert.equal(requestFaunaInteraction(tired,'butterfly',actor,conditions,true),false);
});

test('rain, a missing participant and actor relocation cancel without a stranded reservation',()=>{
  for(const cause of ['rain','missing','move']){
    const state=createForestFauna(scene);requestFaunaInteraction(state,'butterfly',actor,conditions);
    const e=getPartner(state),before=structuredClone(e);
    let options=conditions;
    if(cause==='rain')options={...conditions,rain:1};
    if(cause==='missing')state.entities=state.entities.filter(a=>a!==e);
    if(cause==='move')options={...conditions,actor:{...actor,x:actor.x+10}};
    advance(state,.025,options);assert.equal(state.encounter.phase,'interrupt');
    if(cause!=='missing')assert.ok(Math.hypot(e.x-before.x,e.y-before.y)<1);
    advance(state,.6,options);assert.equal(state.encounter,null);
  }
});

test('weather preserves the population and moves it to authored refuges; night activates the same fireflies',()=>{
  const state=createForestFauna(scene),ids=state.entities.map(e=>e.id);
  advance(state,16,{...conditions,rain:1});
  assert.deepEqual(state.entities.map(e=>e.id),ids);assert.equal(faunaRenderFrame(state).butterflies.length,6);
  const sheltered=state.entities.filter(e=>e.mode==='refuge');assert.equal(sheltered.length,18);
  for(const e of sheltered){const h=scene.habitats.find(h=>h.id===e.habitatId),a=h.anchors.find(a=>a.id===e.anchorId);
    assert.ok(Math.hypot(e.x-a.position.x,e.y-a.position.y)<4,'resting bodies are drawn on the real shelter foliage');
    assert.ok(Math.hypot(e.x-a.position.x-e.anchorOffset.x,e.y-a.position.y-e.anchorOffset.y)<1)}
  advance(state,16,{...conditions,dusk:1});
  assert.ok(state.entities.filter(e=>e.species==='firefly').every(e=>e.mode!=='refuge'));
  assert.deepEqual(state.entities.map(e=>e.id),ids);
});

test('pause and reduced motion preserve exact state including perched/contact motion and phase',()=>{
  const state=createForestFauna(scene);requestFaunaInteraction(state,'butterfly',actor,conditions);advance(state,2);
  const frozen=structuredClone(state),frame=faunaRenderFrame(state);
  for(const options of [{paused:true},{reducedMotion:true}])advance(state,20,{...conditions,...options});
  for(const dt of [0,-1,NaN,Infinity])advanceForestFauna(state,dt,conditions);
  assert.deepEqual(state,frozen);assert.deepEqual(faunaRenderFrame(state),frame);
  cancelFaunaInteraction(state);const detached=structuredClone(state.entities);advance(state,5,{...conditions,reducedMotion:true});
  assert.deepEqual(state.entities,detached);assert.equal(state.encounter,null);
  advance(state,.025);assert.ok(state.entities.some((e,i)=>e.x!==detached[i].x||e.y!==detached[i].y));
});

test('local rustle affects only nearby unreserved fauna with a bounded cooldown',()=>{
  const state=createForestFauna(scene);requestFaunaInteraction(state,'butterfly',actor,conditions);
  const reserved=getPartner(state),before=structuredClone(state.entities);
  const count=emitFaunaStimulus(state,{x:reserved.x,y:reserved.y,kind:'rustle',radius:90});
  assert.ok(count>0&&count<=4);assert.equal(reserved.mode,'approach');
  state.entities.forEach((e,i)=>assert.deepEqual({x:e.x,y:e.y,vx:e.vx,vy:e.vy},{x:before[i].x,y:before[i].y,vx:before[i].vx,vy:before[i].vy}));
  const changed=state.entities.filter(e=>e.mode==='depart');assert.equal(changed.length,count);
  emitFaunaStimulus(state,{x:reserved.x,y:reserved.y,kind:'rustle',radius:90});
  changed.forEach(e=>assert.equal(e.stimulusCooldownUntil,7));
  assert.equal(emitFaunaStimulus(state,{x:1000,y:1000,kind:'rustle'}),0);
});

test('hand anchor uses the same rig scale, sole, lift and compression as the grounded hero',()=>{
  const pose={pose:'greet',frame:0,direction:'front'};
  assert.deepEqual(heroHandAnchor({x:100,y:200,size:48},pose),{x:110,y:177});
  assert.deepEqual(heroHandAnchor({x:100,y:200,size:96,lift:10,compression:1},pose),{x:117.2,y:160.1});
  assert.deepEqual(heroSourceAnchor({x:100,y:200,size:48},{x:24,y:46},{pose:'walk',frame:1,direction:'left'}),{x:100,y:200});
  for(const direction of ['front','back','left','right'])assert.deepEqual(heroHandAnchor({x:100,y:200,size:48},{...pose,direction}),{x:110,y:177});
});

test('fireflies use the same continuous reservation and keep their phase and body after nighttime contact',()=>{
  const state=createForestFauna(scene),night={...conditions,dusk:1};
  assert.equal(requestFaunaInteraction(state,'firefly',actor,night),true);
  const e=getPartner(state),identity={id:e.id,size:e.size,phase:e.phase};let perch=false;
  advance(state,16,night,()=>{
    if(e.mode==='perch')perch=true;
    const frames=faunaRenderFrame(state).fireflies;
    assert.equal(frames.filter(f=>f.id===e.id).length,1);
    assert.deepEqual({id:e.id,size:e.size,phase:e.phase},identity);
  });
  assert.ok(perch);assert.equal(state.encounter,null);assert.equal(e.interactionToken,null);assert.equal(state.entities.length,18);
});

test('freezing a manual actor never freezes independent ambient life or restarts the contract',()=>{
  const state=createForestFauna(scene);requestFaunaInteraction(state,'butterfly',actor,conditions);advance(state,2);
  const partner=getPartner(state),snapshot=structuredClone(partner),contract=structuredClone(state.encounter);
  const neighbor=state.entities.find(e=>e.species==='butterfly'&&e!==partner),before={x:neighbor.x,y:neighbor.y};
  advance(state,2,{...conditions,freezeEncounter:true,blocked:true});
  assert.deepEqual(partner,snapshot);assert.deepEqual(state.encounter,contract);
  assert.ok(neighbor.x!==before.x||neighbor.y!==before.y);
  assert.equal(requestFaunaInteraction(state,'butterfly',actor,conditions),true);
  assert.deepEqual(state.encounter,contract);
  assert.equal(requestFaunaInteraction(state,'firefly',actor,{...conditions,dusk:1}),false);
  advance(state,.025);assert.ok(state.encounter.elapsed>contract.elapsed);
});

test('real authored clearing supports both species without moving or conjuring a partner',async()=>{
  const {TILED_WORLD:authored}=await vite.ssrLoadModule('/features/world/presentation.ts');
  const hero={...authored.actor.spawn,size:authored.actor.size};
  for(const kind of ['butterfly','firefly']){
    const state=createForestFauna(authored),options={actor:hero,dusk:kind==='firefly'?1:0,rain:0};
    const ids=state.entities.map(e=>e.id);assert.equal(ids.length,18);
    assert.equal(requestFaunaInteraction(state,kind,hero,options),true);
    const id=state.encounter.entityId;assert.ok(ids.includes(id));let perched=false;
    advance(state,12,options,()=>{if(state.encounter?.phase==='perch')perched=true});
    assert.ok(perched);assert.equal(state.encounter,null);assert.deepEqual(state.entities.map(e=>e.id),ids);
  }
});

test('firefly emission follows dusk independently of body visibility and paused simulation',()=>{
  const state=createForestFauna(scene);advance(state,3);
  const day=faunaRenderFrame(state);assert.equal(day.fireflies.length,12);assert.ok(day.fireflies.every(e=>e.glow===0&&e.opacity>0));
  const frozen=structuredClone(state),night=faunaRenderFrame(state,{dusk:1});
  assert.ok(night.fireflies.every(e=>e.glow===1));assert.deepEqual(state,frozen);
  assert.ok(faunaRenderFrame(state,{dusk:.4}).fireflies.every(e=>e.glow===.4));
  assert.ok(faunaRenderFrame(state,{dusk:0,fireflies:'on'}).fireflies.every(e=>e.glow===1));
});
