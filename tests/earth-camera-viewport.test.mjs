import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const vite = await createServer({ appType: "custom", configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { earthCameraViewport, earthViewportPadding, createEarthCameraViewport } = await vite.ssrLoadModule("/features/earth/camera-viewport.ts");
const overlap = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const header = width => ({ left:16, top:16, right:width-16, bottom:60 });

test("phone camera leaves the measured atlas sheet, header and controls clear", () => {
  for (const width of [320,390]) {
    const blocks = [header(width), {left:16,top:335,right:width-16,bottom:730}, {left:width-60,top:76,right:width-16,bottom:280}, {left:0,top:760,right:width,bottom:844}];
    const viewport = earthCameraViewport(width,844,blocks);
    assert.ok(blocks.every(block=>!overlap(viewport,block)));
    assert.ok(viewport.right-viewport.left > 200);
    assert.ok(viewport.bottom <=335 && viewport.top>=60);
    const padding = earthViewportPadding(width,844,viewport);
    assert.equal((padding.left + width-padding.right)/2,(viewport.left+viewport.right)/2);
    assert.equal((padding.top + 844-padding.bottom)/2,(viewport.top+viewport.bottom)/2);
  }
});

test("desktop uses space beside a tall panel and mirrors a right settings panel", () => {
  for(const side of ["left","right"]) {
    const panel = side === "left" ? {left:16,right:376,top:180,bottom:780} : {left:904,right:1264,top:180,bottom:780};
    const viewport = earthCameraViewport(1280,900,[header(1280),panel]);
    assert.ok(!overlap(viewport,panel));
    assert.ok(viewport.right-viewport.left>=880);
    assert.ok(viewport.bottom-viewport.top>=800);
    assert.ok(side === "left" ? viewport.left>376 : viewport.right<904);
  }
});

test("empty, offscreen, invalid and fully obscured layouts remain finite", () => {
  const empty = earthCameraViewport(390,844,[]);
  assert.deepEqual(empty,{left:12,top:12,right:378,bottom:832});
  assert.deepEqual(earthCameraViewport(390,844,[{left:-500,right:-20,top:0,bottom:100},{left:NaN,right:500,top:0,bottom:100}]),empty);
  for(const [w,h] of [[0,0],[NaN,Infinity],[390,844]]) {
    const viewport = earthCameraViewport(w,h,[{left:0,right:10000,top:0,bottom:10000}]);
    assert.ok(Object.values(viewport).every(Number.isFinite));
    assert.ok(viewport.right>viewport.left && viewport.bottom>viewport.top);
  }
});

function harness() {
  let next=0,moving=false,padding={left:0,right:0,top:0,bottom:0};
  const frames=new Map(),events=new Map(),windowEvents=new Map(),calls=[];
  const panel={getBoundingClientRect:()=>({left:16,right:374,top:330,bottom:730,width:358,height:400})};
  const window={requestAnimationFrame(fn){frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id),
    getComputedStyle:()=>({visibility:"visible"}),matchMedia:()=>({matches:false}),
    addEventListener:(name,fn)=>windowEvents.set(name,fn),removeEventListener:name=>windowEvents.delete(name)};
  const owner={hidden:false,defaultView:window,querySelectorAll:()=>[]};
  const scope={querySelectorAll:()=>[panel]};
  const container={clientWidth:390,clientHeight:844,ownerDocument:owner,closest:()=>scope,getBoundingClientRect:()=>({left:0,top:0})};
  const map={getContainer:()=>container,getCenter:()=>({lng:2.3,lat:48.8}),getPadding:()=>padding,isMoving:()=>moving,
    easeTo(options){padding=options.padding;calls.push(options);},on:(name,fn)=>events.set(name,fn),off:name=>events.delete(name)};
  const controller=createEarthCameraViewport(map);
  return {controller,calls,frames,events,windowEvents,owner,setMoving:value=>moving=value,
    resize(top){panel.getBoundingClientRect=()=>({left:16,right:374,top,bottom:730,width:358,height:730-top});windowEvents.get("resize")?.();},
    flush(){for(const [id,fn] of [...frames]){frames.delete(id);fn();}}};
}

test("layout changes preserve geographic focus, defer gestures and stop all work when hidden/disposed", () => {
  const h=harness();
  h.controller.refresh();assert.equal(h.calls.length,0);
  h.controller.setEnabled(true);assert.equal(h.calls.length,1);assert.equal(h.calls[0].duration,0);
  assert.deepEqual(h.calls[0].center,{lng:2.3,lat:48.8});
  h.controller.refresh();assert.equal(h.calls.length,1,"unchanged geometry cannot move the map");
  h.setMoving(true);h.resize(250);h.resize(240);assert.equal(h.frames.size,1);
  h.controller.setEnabled(true);assert.equal(h.calls.length,1,"repeated foreground signals cannot interrupt movement");
  h.flush();assert.equal(h.calls.length,1,"never interrupt a drag/flyTo");
  h.setMoving(false);h.events.get("moveend")();assert.equal(h.calls.length,2);assert.equal(h.calls[1].duration,320);
  h.controller.setEnabled(false);h.resize(180);h.flush();assert.equal(h.calls.length,2);
  h.owner.hidden=true;h.controller.setEnabled(true);h.controller.refresh(false);assert.equal(h.calls.length,2);
  h.controller.setEnabled(false);h.owner.hidden=false;h.controller.setEnabled(true);assert.equal(h.calls.length,3);
  h.resize(200);h.controller.dispose();h.flush();h.controller.setEnabled(true);
  assert.equal(h.calls.length,3);assert.equal(h.frames.size,0);assert.equal(h.events.size,0);assert.equal(h.windowEvents.size,0);
});
