import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:earth-lifecycle-hooks", platformId = "virtual:earth-lifecycle-platform";
const platformCode = `
  export const maps=[];
  export const cache={snapshot:{pending:0,completed:0,failed:0,storedEntries:0,persistence:'granted',storage:'session'},
    getSnapshot(){return cache.snapshot;},subscribe(){return ()=>{};},resetProgress(){},async initialize(){},
    async requestPersistence(){},getBudgets(){return {tileEntries:32};},async readResource(){return {data:{}};},
    setView(){},async invalidate(){},transformRequest(){},protocol(){}};
  const noop=()=>{};
  class Canvas extends EventTarget {setAttribute(){}}
  export class MapMock {
    constructor(options){this.container=options.container;this.padding={top:0,bottom:0,left:0,right:0};this.listeners=new Map();this.canvas=new Canvas();this.complete=false;this.tilesComplete=false;this.sizeChanges=0;this.sourceChanges=0;
      this.style={sources:{'earth-streets':{type:'vector'}},layers:[]};this.sources=new Map();maps.push(this);}
    on(name,callback){const callbacks=this.listeners.get(name)??[];callbacks.push(callback);this.listeners.set(name,callbacks);return this;}
    off(name,callback){this.listeners.set(name,(this.listeners.get(name)??[]).filter(item=>item!==callback));return this;}
    emit(name,event={}){for(const callback of [...this.listeners.get(name)??[]])callback(event);}
    getCenter(){return {lng:35,lat:27};}getZoom(){return 1;}getBearing(){return 0;}getPitch(){return 0;}
    getContainer(){return this.container;}getPadding(){return this.padding;}easeTo(options){this.padding=options.padding??this.padding;return this;}
    getCanvas(){return this.canvas;}getStyle(){return this.style;}getSource(id){return this.sources.get(id);}
    addSource(id,source){this.sourceChanges++;this.style.sources[id]=source;this.sources.set(id,{...source,setData(){}});}
    getLayer(){return undefined;}addLayer(){}removeLayer(){}removeSource(id){this.sources.delete(id);}
    setProjection(){}setSky(){}setLayoutProperty(){}setSourceTileLodParams(){}refreshTiles(){}
    loaded(){return this.complete;}areTilesLoaded(){return this.tilesComplete;}isSourceLoaded(){return this.tilesComplete;}
    isMoving(){return false;}stop(){}resize(){this.sizeChanges++;}triggerRepaint(){}remove(){this.removed=true;this.emit('remove');}
  }
  export const sdk={Map:MapMock,Marker:class{},addProtocol:noop,setMaxParallelImageRequests:noop};
  export const loadEarthRuntime=async()=>sdk, EARTH_RUNTIME_DIRECTORY='/mock', EARTH_RUNTIME_VERSION='mock';
  export const earthResourceCache=cache, EARTH_CACHE_PROTOCOL='earth-cache';
  export const prepareEarthStyle=()=>({version:8,sources:{'earth-streets':{type:'vector'}},layers:[]});
  export const EARTH_ACCURACY_SOURCE='earth-accuracy',EARTH_CENTER=[35,27],EARTH_SKY={},EARTH_STYLE_URL='https://fixture.invalid/style';
  export const globeZoom=()=>1,positionZoom=()=>10,positionAccuracyData=()=>({type:'FeatureCollection',features:[]});
  export const installEarthMaterialImages=noop,registerEarthMaterialImage=noop,installEarthGlobeCamera=()=>noop;
  export const EARTH_OCEAN_MATERIAL_IMAGE='ocean',registerEarthOceanMaterialImage=noop;
  export const createEarthGlobeScene=()=>({setVisible:noop,setReady:noop,setWeather:noop,setBuildingsEnabled:noop,dispose:noop});
  export const createEarthTileLoadingOverlay=()=>({setVisible:noop,setStatus:noop,refresh:noop,observe:noop,dispose:noop});
  export const createEarthStars=()=>({setMode:noop,setVisible:noop,dispose:noop});
  export const createEarthWeatherProvider=noop;
  export const createEarthWeatherController=()=>({setEnabled:noop,setVisible:noop,setView:noop,dispose:noop});
  export const createEarthFriendMarkers=()=>({setVisible:noop,setSnapshot:noop,setSelfPosition:noop,focusFriend:()=>false,dispose:noop});
  export const createEarthMeetMap=()=>({setCameraPadding:noop,setVisible:noop,setSnapshot:noop,install:noop,dispose:noop});
`;
const hooksCode = `
  export {lazy,Suspense} from 'react';let current,cursor;
  const slot=create=>{const index=cursor++;return current.slots[index]??=create();};
  export function begin(state){current=state;cursor=0;state.dirty=false;}
  export const useRef=value=>slot(()=>({current:value}));
  export function useState(initial){const owner=current,state=slot(()=>({value:typeof initial==='function'?initial():initial}));
    return [state.value,value=>{const next=typeof value==='function'?value(state.value):value;if(!Object.is(state.value,next)){state.value=next;owner.dirty=true;}}];}
  export function useCallback(callback,deps){const state=slot(()=>({deps:null,callback}));if(!state.deps||deps.some((value,index)=>!Object.is(value,state.deps[index]))){state.deps=deps;state.callback=callback;}return state.callback;}
  export function useEffect(callback,deps){const state=slot(()=>({deps:null,cleanup:null}));if(!state.deps||deps.some((value,index)=>!Object.is(value,state.deps[index]))){state.deps=deps;current.pending.push(()=>{state.cleanup?.();state.cleanup=callback();});}}
  export const useLayoutEffect=useEffect,useSyncExternalStore=(subscribe,snapshot)=>snapshot();
  export function flush(state){for(const effect of state.pending.splice(0))effect();}
  export function dispose(state){for(const value of state.slots)value.cleanup?.();}
`;
const mocked = new Set(["./runtime-loader", "./resource-cache", "./map-style", "./land-material", "./globe-camera", "./globe-ocean",
  "./globe-scene", "./tile-loading-overlay", "./earth-stars", "./weather", "./friend-markers", "./meet-map"]);
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-lifecycle-platform", enforce: "pre",
    resolveId(id) { if (id === hooksId || id === platformId) return "\0" + id; },
    load(id) { if (id === "\0" + hooksId) return hooksCode; if (id === "\0" + platformId) return platformCode; },
    transform(source, id) {
      if (!id.endsWith("/features/earth/earth-map.tsx")) return;
      return source.replace(/from "([^"]+)";/g, (statement, path) => path === "react" ? `from "${hooksId}";`
        : mocked.has(path) ? `from "${platformId}";` : statement);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId), platform = await vite.ssrLoadModule(platformId);
const { EarthMap } = await vite.ssrLoadModule("/features/earth/earth-map.tsx");

function harness() {
  const globals = new Map(["window", "document", "navigator", "ResizeObserver", "IntersectionObserver"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let timerId = 0;
  const timers = new Map(), window = Object.assign(new EventTarget(), {
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    devicePixelRatio: 1, matchMedia: () => ({ matches: true }),
  });
  const document = Object.assign(new EventTarget(), { hidden: false, createElement: () => ({ getContext: () => ({ getExtension: () => null }) }) });
  document.defaultView=window;document.querySelectorAll=()=>[];
  window.requestAnimationFrame=callback=>window.setTimeout(callback);window.cancelAnimationFrame=id=>window.clearTimeout(id);
  for (const [name, value] of Object.entries({ window, document, navigator: { onLine: true }, ResizeObserver: undefined, IntersectionObserver: undefined }))
    Object.defineProperty(globalThis, name, { value, configurable: true });
  platform.maps.length = 0;
  const state = { slots: [], pending: [], dirty: false }, ready = [];
  const props = { position: null, active: true, visible: true, onReadyChange: value => ready.push(value),
    focusRequest: 0, isOnline: true, onLocate() {}, locating: false, locationActive: false, locationDetails: null,
    infoOpen: false, onInfoOpenChange() {} };
  const host = { clientWidth: 800, clientHeight: 600, ownerDocument:document, closest:()=>null,
    querySelectorAll:()=>[],getBoundingClientRect:()=>({left:0,top:0}) };
  let nodes;
  function render() {
    for (let pass = 0; pass < 20; pass++) {
      hooks.begin(state); const tree = EarthMap(props); nodes = [];
      const walk = node => { if (isValidElement(node)) { nodes.push(node); Children.forEach(node.props.children, walk); } };
      walk(tree);
      // Only the map host is mounted. Native layout and WebGL are outside this test.
      const container = nodes.find(node => node.type === "div" && node.props.ref);
      if (container) container.props.ref.current = host;
      hooks.flush(state);
      if (!state.dirty) return nodes;
    }
    throw new Error("EarthMap did not settle");
  }
  async function settle() { for (let pass = 0; pass < 6; pass++) { await Promise.resolve(); render(); } }
  return {
    props, document, ready, render, settle, host,
    phase: () => nodes.find(node => node.props["data-earth-map"] !== undefined)?.props["data-map-status"],
    async mount() { render(); await settle(); return platform.maps.at(-1); },
    async prepare(map) { map.emit("style.load"); map.complete = map.tilesComplete = true; map.emit("render"); await settle(); },
    dispose() { hooks.dispose(state); for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    } },
  };
}

test("initial readiness still requires both loaded cartography and a rendered frame", async () => {
  const app = harness();
  try {
    const map = await app.mount();
    assert.equal(app.phase(), "loading");
    map.emit("style.load"); map.complete = map.tilesComplete = true; map.emit("sourcedata");
    await app.settle(); assert.equal(app.phase(), "loading", "source readiness alone never reveals an unpainted canvas");
    map.emit("render"); await app.settle(); assert.equal(app.phase(), "ready");
  } finally { app.dispose(); }
});

test("a ready retained map survives a normal People round trip without creating another SDK instance", async () => {
  const app = harness();
  try {
    const map = await app.mount(); await app.prepare(map);
    app.props.visible = false; app.host.clientWidth = 0; app.render();
    app.props.visible = true; app.host.clientWidth = 800; app.render(); await app.settle();
    assert.equal(app.phase(), "ready"); assert.equal(platform.maps.length, 1); assert.ok(map.sizeChanges > 0);
  } finally { app.dispose(); }
});

test("a failed foreground map gets one fresh installation when returning from another section", async () => {
  const app = harness();
  try {
    const map = await app.mount(); await app.prepare(map);
    map.canvas.dispatchEvent(new Event("webglcontextlost")); await app.settle(); assert.equal(app.phase(), "failed");
    app.props.visible = false; app.render(); app.props.visible = true; app.render(); await app.settle();
    assert.equal(platform.maps.length, 2); assert.equal(map.removed, true); assert.equal(app.phase(), "loading");
    await app.settle(); assert.equal(platform.maps.length, 2, "a pending fresh installation never recursively retries");
    await app.prepare(platform.maps[1]); assert.equal(app.phase(), "ready");
  } finally { app.dispose(); }
});

test("WebGL restoration only restarts a visible failed map and ignores late old style callbacks", async () => {
  const app = harness();
  try {
    const old = await app.mount(); await app.prepare(old);
    old.canvas.dispatchEvent(new Event("webglcontextlost")); await app.settle();
    app.props.visible = false; app.render();
    const sourceChanges = old.sourceChanges;
    old.canvas.dispatchEvent(new Event("webglcontextrestored")); old.emit("style.load"); await app.settle();
    assert.equal(platform.maps.length, 1); assert.equal(app.phase(), "failed");
    assert.equal(old.sourceChanges, sourceChanges, "a late restored style never installs layers into the aborted map");
    app.props.visible = true; app.render(); await app.settle(); assert.equal(platform.maps.length, 2);
    const replacement = platform.maps[1]; await app.prepare(replacement);
    old.canvas.dispatchEvent(new Event("webglcontextrestored")); old.emit("style.load"); await app.settle();
    assert.equal(platform.maps.length, 2); assert.equal(app.phase(), "ready");
    replacement.canvas.dispatchEvent(new Event("webglcontextlost")); await app.settle();
    replacement.canvas.dispatchEvent(new Event("webglcontextrestored")); await app.settle();
    assert.equal(platform.maps.length, 3); assert.equal(app.phase(), "loading");
  } finally { app.dispose(); }
});
