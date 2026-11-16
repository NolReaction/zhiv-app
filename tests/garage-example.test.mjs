import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {garageNodeContactPoint, getGarageNodeMatrix, transformGaragePoint, validateGarageScene} from '../features/world/dev/boat-garage/garage-scene-model.mjs';
const root=new URL('../',import.meta.url);
const readScene=async name=>validateGarageScene(JSON.parse(await readFile(new URL(`features/world/dev/boat-garage/${name}.json`,root),'utf8')));
const contact=(scene,id,socket)=>{const node=scene.nodes.find(row=>row.id===id);return transformGaragePoint(getGarageNodeMatrix(scene,id),garageNodeContactPoint(node,socket));};
const close=(actual,expected)=>assert(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`);

test('assembly example keeps both feet on the platform and fits independent support heights to the hull',async()=>{
 const scene=await readScene('garage-scene-example');
 for(const [id,socket]of [['stand-left','support-left'],['stand-right','support-right']]){
  const foot=contact(scene,id,'foot'),top=contact(scene,id,'contact'),hull=contact(scene,'starter-hull',socket);
  close(foot.y,700);close(top.x,hull.x);close(top.y,hull.y-5);
  assert.equal(scene.nodes.find(row=>row.id===id).parentId,null,'fixtures must not move with the boat');
 }
 assert.notEqual(scene.nodes.find(row=>row.id==='stand-left').scaleY,scene.nodes.find(row=>row.id==='stand-right').scaleY,'bow rise needs independent height');
 const clamp=contact(scene,'starter-motor','clamp'),transom=contact(scene,'starter-hull','engine');close(clamp.x,transom.x);close(clamp.y,transom.y);
});

test('new example assets retain original alpha frames and matching web dimensions',async()=>{
 const scene=await readScene('garage-scene-example');
 for(const id of ['starter-hull','starter-motor','stand-side']){
  const asset=scene.assets.find(row=>row.id===id);
  for(const file of [`art/world/boat-garage/${id}.png`,`public${asset.src}`]){
   const metadata=await sharp(await readFile(new URL(file,root))).metadata();
   assert.equal(metadata.width,asset.width);assert.equal(metadata.height,asset.height);assert.equal(metadata.hasAlpha,true);
  }
 }
});

test('the fitted example is separate from the original template and keeps old support art available',async()=>{
 const original=await readScene('garage-scene-default'),example=await readScene('garage-scene-example');
 assert.equal(original.nodes.some(row=>row.id==='starter-hull'),false,'opening existing/default scenes must not load the example automatically');
 assert.equal(original.assets.find(row=>row.id==='stand').src,example.assets.find(row=>row.id==='stand').src);
 assert.equal(example.nodes.find(row=>row.id==='starter-hull').assetId,'starter-hull');
 assert(example.nodes.find(row=>row.id==='starter-motor').zIndex<example.nodes.find(row=>row.id==='starter-hull').zIndex,'example clamp back section is occluded by hull');
});
