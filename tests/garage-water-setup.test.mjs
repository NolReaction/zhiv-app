import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {garageWaterRigIds,garageWaterSetup} from '../features/world/dev/boat-garage/garage-water-setup.mjs';
const example=JSON.parse(await readFile(new URL('../features/world/dev/boat-garage/garage-scene-example.json',import.meta.url),'utf8'));

test('floating assembly includes motor descendants and excludes independent supports and garage',()=>{
 const ids=garageWaterRigIds(example,'boat');
 assert(ids.has('boat')&&ids.has('starter-hull')&&ids.has('starter-motor'));
 for(const id of ['garage','stand-left','stand-right'])assert(!ids.has(id));
 assert.equal(garageWaterRigIds(example,'missing').size,0);
});
test('water preview defaults are transient and stored author settings take precedence',()=>{
 const original=JSON.stringify(example),defaults=garageWaterSetup(example);
 assert(defaults.hasArtwork);assert.equal(defaults.config.rootId,'boat');assert.equal(defaults.config.waterlineY,example.canvas.height*.62);
 assert.equal(JSON.stringify(example),original);
 const config={rootId:'starter-hull',waterlineY:610,beam:710,amplitude:3};
 const next=garageWaterSetup({...example,waterPreview:config});assert.deepEqual(next.config,config);assert(next.ids.has('starter-motor'));assert(!next.ids.has('boat'));
});
test('empty boat group is identified instead of promising to animate invisible modules',()=>{
 const scene={...example,nodes:example.nodes.filter(node=>node.id!=='starter-hull'&&node.id!=='starter-motor')};
 assert.equal(garageWaterSetup(scene).hasArtwork,false);
});

test('hidden parent assemblies do not claim a visible floating hull',()=>{
 const scene={...example,nodes:example.nodes.map(node=>node.id==='boat'?{...node,visible:false}:node)};
 assert.equal(garageWaterSetup(scene).hasArtwork,false);
});
