import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { getGarageNodeMatrix, transformGaragePoint, validateGarageScene } from "../features/world/dev/boat-garage/garage-scene-model.mjs";
import { GARAGE_RESIZE_HANDLES, garageTransformHandles, pointInsideGarageNode, resizeGarageNode, rotateGarageNode, scaleGarageNodeAroundPivot } from "../features/world/dev/boat-garage/garage-transform.mjs";
const base = JSON.parse(await readFile(new URL("../features/world/dev/boat-garage/garage-scene-default.json", import.meta.url), "utf8"));
const node = (id, changes = {}) => ({ id, name: id, assetId: null, parentId: null, socketId: null, x: 100, y: 80, width: 180, height: 100,
 scale: .8, rotation: 17, pivotX: .3, pivotY: .7, zIndex: 1, visible: true, locked: false, sockets: [], ...changes });
const fixture = () => validateGarageScene({ ...base, nodes: [node("parent", { x: 600, y: 300, scaleX: 1.7, scaleY: .6, skewX: 13, flipX: true, rotation: 31 }),
 node("part", { parentId: "parent", scaleX: .75, scaleY: 1.3, skewX: -8, flipY: true }), node("child", { parentId: "part", x: 20, y: 15, scale: .2 })] });
const close = (a, b) => assert(Math.abs(a-b) < 1e-7, `${a} != ${b}`);
const near = (a, b) => { close(a.x,b.x); close(a.y,b.y); };
const world = (s, p) => transformGaragePoint(getGarageNodeMatrix(s, "part"), p);

test("all resize handles keep their opposite authored anchor fixed under affine parents", () => {
 for (const handle of GARAGE_RESIZE_HANDLES) {
  const s=fixture(), n=s.nodes[1], anchor={x:(1-handle.x)*n.width,y:(1-handle.y)*n.height};
  const local={x:handle.x===.5?n.width/2:anchor.x+(handle.x*n.width-anchor.x)*1.6,
   y:handle.y===.5?n.height/2:anchor.y+(handle.y*n.height-anchor.y)*.65};
  const out=resizeGarageNode(s,"part",handle.id,world(s,local));
  near(world(out,anchor),world(s,anchor));near(world(out,{x:handle.x*n.width,y:handle.y*n.height}),world(s,local));
  assert.equal(out.nodes[1].parentId,"parent");
 }
});
test("free stretching changes axes independently; shift keeps their ratio", () => {
 const s=fixture(), n=s.nodes[1], m=getGarageNodeMatrix(s,"part");
 const target=world(s,{x:n.width*1.8,y:n.height*.65});
 const free=resizeGarageNode(s,"part","se",target), fm=getGarageNodeMatrix(free,"part");
 close(Math.hypot(fm[0],fm[1])/Math.hypot(m[0],m[1]),1.8);close(Math.hypot(fm[2],fm[3])/Math.hypot(m[2],m[3]),.65);
 const locked=resizeGarageNode(s,"part","se",target,{proportional:true}), lm=getGarageNodeMatrix(locked,"part");
 close(Math.hypot(lm[0],lm[1])/Math.hypot(m[0],m[1]),1.8);close(Math.hypot(lm[2],lm[3])/Math.hypot(m[2],m[3]),1.8);
 near(world(locked,{x:0,y:0}),world(s,{x:0,y:0}));
});
test("crossing a resize anchor mirrors artwork without collapsing the affine transform", () => {
 const s=fixture(), n=s.nodes[1], original=getGarageNodeMatrix(s,"part");
 const out=resizeGarageNode(s,"part","e",world(s,{x:-n.width*.5,y:n.height/2}));
 const next=getGarageNodeMatrix(out,"part");
 assert(Math.sign(original[0]*original[3]-original[1]*original[2])!==Math.sign(next[0]*next[3]-next[1]*next[2]));
 near(world(out,{x:0,y:n.height/2}),world(s,{x:0,y:n.height/2}));
 const minimal=resizeGarageNode(s,"part","e",world(s,{x:0,y:n.height/2}));assert(Number.isFinite(getGarageNodeMatrix(minimal,"part")[0]));
});
test("rotation preserves pivot and all distances, and children follow the same world turn", () => {
 const s=fixture(), n=s.nodes[1], pivot=world(s,{x:n.width*n.pivotX,y:n.height*n.pivotY});
 const out=rotateGarageNode(s,"part",{x:pivot.x+100,y:pivot.y},{x:pivot.x,y:pivot.y+100});
 near(world(out,{x:n.width*n.pivotX,y:n.height*n.pivotY}),pivot);
 for (const p of [{x:0,y:0},{x:n.width,y:n.height}]) {const a=world(s,p),b=world(out,p);near(b,{x:pivot.x-(a.y-pivot.y),y:pivot.y+a.x-pivot.x});}
 const child=transformGaragePoint(getGarageNodeMatrix(s,"child"),{x:0,y:0});
 near(transformGaragePoint(getGarageNodeMatrix(out,"child"),{x:0,y:0}),{x:pivot.x-(child.y-pivot.y),y:pivot.y+child.x-pivot.x});
});
test("rotation snaps to fifteen degree screen angles without moving the pivot", () => {
 const s=fixture(),n=s.nodes[1],pivot=world(s,{x:n.width*n.pivotX,y:n.height*n.pivotY});
 const out=rotateGarageNode(s,"part",{x:pivot.x+100,y:pivot.y},{x:pivot.x+91,y:pivot.y+41},{snap:true});
 const m=getGarageNodeMatrix(out,"part"),angle=Math.atan2(m[1],m[0])*180/Math.PI;
 close(angle/15,Math.round(angle/15));near(world(out,{x:n.width*n.pivotX,y:n.height*n.pivotY}),pivot);
 assert.equal(rotateGarageNode(s,"part",pivot,pivot),s);
});
test("hit testing follows true transformed frame and rotation handles use screen-size offsets", () => {
 const s=fixture(), n=s.nodes[1];assert(pointInsideGarageNode(s,"part",world(s,{x:50,y:30})));
 assert(!pointInsideGarageNode(s,"part",world(s,{x:-4,y:30})));assert(!pointInsideGarageNode(s,"missing",{x:0,y:0}));
 for(const scale of [.2,1,4]){const h=garageTransformHandles(s,"part",scale);assert.equal(h.handles.length,8);close(Math.hypot(h.rotation.x-h.top.x,h.rotation.y-h.top.y)*scale,32);}
 assert.equal(garageTransformHandles(s,"missing"),null);assert.throws(()=>resizeGarageNode(s,"part","e",{x:NaN,y:1}));
 const locked={...s,nodes:s.nodes.map(i=>i.id==="part"?{...i,locked:true}:i)};
 assert.throws(()=>resizeGarageNode(locked,"part","se",world(s,{x:n.width*2,y:n.height*2})),/открепите/);
});

test("uniform scale preserves pivot, shape, reflection and child placement through affine parents", () => {
 const s=fixture(),n=s.nodes[1],pivot=world(s,{x:n.width*n.pivotX,y:n.height*n.pivotY});
 const out=scaleGarageNodeAroundPivot(s,"part",{x:pivot.x+100,y:pivot.y},{x:pivot.x,y:pivot.y+160});
 near(world(out,{x:n.width*n.pivotX,y:n.height*n.pivotY}),pivot);
 for(const p of [{x:0,y:0},{x:n.width,y:n.height}]){const a=world(s,p);near(world(out,p),{x:pivot.x+(a.x-pivot.x)*1.6,y:pivot.y+(a.y-pivot.y)*1.6});}
 const m=getGarageNodeMatrix(s,"part"),after=getGarageNodeMatrix(out,"part");
 assert.equal(Math.sign(m[0]*m[3]-m[1]*m[2]),Math.sign(after[0]*after[3]-after[1]*after[2]));
 const child=transformGaragePoint(getGarageNodeMatrix(s,"child"),{x:0,y:0});
 near(transformGaragePoint(getGarageNodeMatrix(out,"child"),{x:0,y:0}),{x:pivot.x+(child.x-pivot.x)*1.6,y:pivot.y+(child.y-pivot.y)*1.6});
 assert.equal(out.nodes[1].parentId,"parent");
});

test("uniform scaling handles zero radius, bounded noncollapsed size, snapping and invalid pointers", () => {
 const s=fixture(),n=s.nodes[1],pivot=world(s,{x:n.width*n.pivotX,y:n.height*n.pivotY}),start={x:pivot.x+100,y:pivot.y};
 assert.equal(scaleGarageNodeAroundPivot(s,"part",pivot,start),s);
 assert.equal(scaleGarageNodeAroundPivot(s,"part",start,start),s);
 const snapped=scaleGarageNodeAroundPivot(s,"part",start,{x:pivot.x+143,y:pivot.y},{snap:true});
 const a=world(s,{x:0,y:0}),b=world(snapped,{x:0,y:0});close(Math.hypot(b.x-pivot.x,b.y-pivot.y)/Math.hypot(a.x-pivot.x,a.y-pivot.y),1.4);
 const minimal=scaleGarageNodeAroundPivot(s,"part",start,pivot);assert(getGarageNodeMatrix(minimal,"part").every(Number.isFinite));
 assert.throws(()=>scaleGarageNodeAroundPivot(s,"part",start,{x:Infinity,y:0}),/Неверная/);
 assert.throws(()=>scaleGarageNodeAroundPivot(s,"missing",start,start),/не найден/);
 const locked={...s,nodes:s.nodes.map(i=>i.id==="part"?{...i,locked:true}:i)};
 assert.throws(()=>scaleGarageNodeAroundPivot(locked,"part",start,{x:pivot.x+150,y:pivot.y}),/открепите/);
});
