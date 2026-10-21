import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:earth-satellite-visual-hooks", platformId = "virtual:earth-satellite-visual-platform";
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
const platformCode = `
  export const maps=[],scenes=[],satellites=[];
  const noop=()=>{};
  export const cache={snapshot:{pending:0,completed:0,failed:0,storedEntries:0,persistence:'granted',storage:'session'},
    getSnapshot(){return cache.snapshot;},subscribe(){return noop;},resetProgress(){},async initialize(){},
    async requestPersistence(){},getBudgets(){return {tileEntries:32};},async readResource(){return {data:{}};},
    setView(){},async invalidate(){},transformRequest(){},protocol(){}};
  class Canvas extends EventTarget{setAttribute(){}}
  class MapMock{
    constructor(options){this.container=options.container;this.padding={top:0,bottom:0,left:0,right:0};this.listeners=new Map();this.canvas=new Canvas();this.canvas.ownerDocument=options.container.ownerDocument;this.touchPitch={isEnabled:()=>true};this.complete=false;this.tilesComplete=false;
      this.style={sources:{'earth-streets':{type:'vector'}},layers:[]};this.sources=new Map();this.layout=[];maps.push(this);}
    on(name,callback){const callbacks=this.listeners.get(name)??[];callbacks.push(callback);this.listeners.set(name,callbacks);return this;}
    off(name,callback){this.listeners.set(name,(this.listeners.get(name)??[]).filter(item=>item!==callback));return this;}
    emit(name,event={}){for(const callback of [...this.listeners.get(name)??[]])callback(event);}
    getCenter(){return {lng:35,lat:27};}getZoom(){return 16;}getBearing(){return 0;}getPitch(){return 0;}
    getContainer(){return this.container;}getPadding(){return this.padding;}easeTo(options){this.padding=options.padding??this.padding;return this;}
    getCanvasContainer(){return this.canvas;}getMinPitch(){return 0;}getMaxPitch(){return 60;}setPitch(){return this;}
    getCanvas(){return this.canvas;}getStyle(){return this.style;}getSource(id){return this.sources.get(id);}
    addSource(id,source){this.style.sources[id]=source;this.sources.set(id,{...source,setData(){}});}
    getLayer(id){return id==='earth-buildings-3d'?{id,type:'fill-extrusion'}:undefined;}addLayer(){}removeLayer(){}removeSource(id){this.sources.delete(id);}
    setProjection(){}setSky(){}setLayoutProperty(...args){this.layout.push(args);}setSourceTileLodParams(){}refreshTiles(){}
    loaded(){return this.complete;}areTilesLoaded(){return this.tilesComplete;}isSourceLoaded(){return this.tilesComplete;}
    isMoving(){return false;}stop(){}resize(){}triggerRepaint(){}remove(){this.removed=true;this.emit('remove');}
  }
  export const sdk={Map:MapMock,Marker:class{},addProtocol:noop,setMaxParallelImageRequests:noop};
  export const loadEarthRuntime=async()=>sdk, EARTH_RUNTIME_DIRECTORY='/mock', EARTH_RUNTIME_VERSION='mock';
  export const earthResourceCache=cache, EARTH_CACHE_PROTOCOL='earth-cache';
  export const prepareEarthStyle=()=>({version:8,sources:{'earth-streets':{type:'vector'}},layers:[]});
  export const EARTH_ACCURACY_SOURCE='earth-accuracy',EARTH_CENTER=[35,27],EARTH_SKY={},EARTH_STYLE_URL='https://fixture.invalid/style';
  export const globeZoom=()=>1,positionZoom=()=>10,positionAccuracyData=()=>({type:'FeatureCollection',features:[]});
  export const installEarthMaterialImages=noop,registerEarthMaterialImage=noop,installEarthGlobeCamera=()=>noop;
  export const EARTH_OCEAN_MATERIAL_IMAGE='ocean',registerEarthOceanMaterialImage=noop;
  export const createEarthGlobeScene=()=>{
    const scene={buildings:null,history:[],setVisible:noop,setReady:noop,setWeather:noop,setLandmarkPreview:noop,
      setBuildingsEnabled(value){scene.buildings=value;scene.history.push(value);},dispose(){scene.disposed=true;}};
    scenes.push(scene);return scene;
  };
  export const createEarthTileLoadingOverlay=()=>({setVisible:noop,setStatus:noop,refresh:noop,observe:noop,dispose:noop});
  export const createEarthStars=()=>({setMode:noop,setVisible:noop,dispose:noop});
  export const createEarthWeatherProvider=noop;
  export const createEarthWeatherController=()=>({setEnabled:noop,setVisible:noop,setView:noop,dispose:noop});
  export const createEarthFriendMarkers=()=>({setVisible:noop,setSnapshot:noop,setSelfPosition:noop,focusFriend:()=>false,dispose:noop});
  export const createEarthMeetMap=()=>({setCameraPadding:noop,setVisible:noop,setSnapshot:noop,install:noop,dispose:noop});
  export const getAudioRuntime=()=>({}),playUiCue=noop;
  export const EARTH_SATELLITE_INITIAL_STATE=Object.freeze({enabled:false,status:'off',error:null,attribution:null,minZoom:10,imageryVisible:false});
  export function createEarthSatellite(map,options){
    let snapshot=EARTH_SATELLITE_INITIAL_STATE;
    const satellite={visible:false,getSnapshot:()=>snapshot,ownsError:()=>false,
      publish(value){snapshot={...snapshot,...value};options.onChange(snapshot);},
      setEnabled(value){satellite.publish({enabled:value,status:value?'loading':'off',imageryVisible:false,attribution:null});},
      setVisible(value){if(satellite.visible===value)return;satellite.visible=value;
        if(!value&&snapshot.enabled)satellite.publish({status:'paused',imageryVisible:false,attribution:null});},
      setOnline(value){if(!value&&snapshot.enabled)satellite.publish({status:'offline',imageryVisible:false,attribution:null});},
      dispose(){satellite.disposed=true;}};
    satellites.push(satellite);return satellite;
  }
`;
const mocked = new Set(["./runtime-loader", "./resource-cache", "./map-style", "./land-material", "./globe-camera", "./globe-ocean",
  "./globe-scene", "./tile-loading-overlay", "./earth-stars", "./weather", "./friend-markers", "./meet-map", "./satellite",
  "@/features/audio/runtime/audio-service", "@/features/audio/ui/audio-lifecycle"]);
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "earth-satellite-visual-platform", enforce: "pre",
    resolveId(id) { if (id === hooksId || id === platformId) return "\0" + id; },
    load(id) { if (id === "\0" + hooksId) return hooksCode; if (id === "\0" + platformId) return platformCode; },
    transform(source, id) {
      if (!id.endsWith("/features/earth/earth-map.tsx")) return;
      // Public fixture key only. Keep the real component's handlers/effects; enable
      // the lazy development editor without mounting that unrelated child UI.
      return source.replace('process.env.NEXT_PUBLIC_MAPTILER_KEY ?? ""', '"test-key"')
        .replace('const EarthModelEditor = process.env.NODE_ENV === "development"', "const EarthModelEditor = true")
        .replace(/from "([^"]+)";/g, (statement, path) => path === "react" ? `from "${hooksId}";`
          : mocked.has(path) ? `from "${platformId}";` : statement);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId), platform = await vite.ssrLoadModule(platformId);
const { EarthMap } = await vite.ssrLoadModule("/features/earth/earth-map.tsx");

function harness(initialPreference = true) {
  const globals = new Map(["window", "document", "navigator", "ResizeObserver", "IntersectionObserver"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let nextTimer = 0;
  const timers = new Map(), window = Object.assign(new EventTarget(), {
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    devicePixelRatio: 1, matchMedia: () => ({ matches: true }),
  });
  const document = Object.assign(new EventTarget(), { hidden: false, createElement: () => ({ getContext: () => ({ getExtension: () => null }) }) });
  document.defaultView = window; document.querySelectorAll = () => [];
  window.requestAnimationFrame = callback => window.setTimeout(callback); window.cancelAnimationFrame = id => window.clearTimeout(id);
  for (const [name, value] of Object.entries({ window, document, navigator: { onLine: true }, ResizeObserver: undefined, IntersectionObserver: undefined }))
    Object.defineProperty(globalThis, name, { value, configurable: true });
  platform.maps.length = platform.scenes.length = platform.satellites.length = 0;
  let preferences = { weatherEnabled: true, lightingMode: "auto", eveningCenter: null, buildings3d: initialPreference };
  const saves = [], state = { slots: [], pending: [], dirty: false };
  const cameraSession = { read: () => null, save() {}, readPreferences: () => ({ ...preferences }),
    savePreferences(value) { preferences = { ...value }; saves.push({ ...value }); } };
  const props = { position: null, active: true, visible: true, cameraSession, focusRequest: 0, isOnline: true,
    onLocate() {}, locating: false, locationActive: false, locationDetails: null, infoOpen: true, onInfoOpenChange() {} };
  const host = { clientWidth: 800, clientHeight: 600, ownerDocument: document, closest: () => null,
    querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  let nodes;
  function render() {
    for (let pass = 0; pass < 20; pass++) {
      hooks.begin(state); const tree = EarthMap(props); nodes = [];
      const walk = node => { if (isValidElement(node)) { nodes.push(node); Children.forEach(node.props.children, walk); } };
      walk(tree);
      const container = nodes.find(node => node.type === "div" && node.props.ref);
      if (container) container.props.ref.current = host;
      hooks.flush(state);
      if (!state.dirty) return;
    }
    throw new Error("EarthMap did not settle");
  }
  async function settle() { for (let pass = 0; pass < 6; pass++) { await Promise.resolve(); render(); } }
  const button = label => nodes.find(node => node.type === "button" && Children.toArray(node.props.children).includes(label));
  const toggle = () => nodes.find(node => node.type === "button" && node.props["aria-labelledby"] === "earth-buildings-label");
  return { props, saves, render, settle, preference: () => preferences.buildings3d,
    satellite: () => platform.satellites.at(-1), scene: () => platform.scenes.at(-1), checked: () => toggle().props["aria-checked"],
    async mount() { render(); await settle(); const map = platform.maps.at(-1); map.emit("style.load"); map.complete = map.tilesComplete = true; map.emit("render"); await settle(); return map; },
    async selectSatellite() { const control = button("Спутник"); assert.equal(control.props.disabled, false); control.props.onClick(); await settle(); },
    async toggleBuildings() { toggle().props.onClick({ type: "click", pointerType: "touch" }); await settle(); },
    async setEditorOpen(value) { nodes.find(node => node.props.map && node.props.onOpenChange)?.props.onOpenChange(value); await settle(); },
    async publish(value) { platform.satellites.at(-1).publish(value); await settle(); },
    dispose() { hooks.dispose(state); for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    } },
  };
}

test("EarthMap leaves models alone during metadata loading and suppresses them only for installed imagery", async () => {
  const app = harness();
  try {
    await app.mount(); assert.equal(app.scene().buildings, true);
    await app.selectSatellite();
    assert.equal(app.scene().buildings, true, "a pending TileJSON request does not change the base view");
    assert.equal(app.preference(), true); assert.equal(app.checked(), true);
    await app.publish({ status: "ready", imageryVisible: true });
    assert.equal(app.scene().buildings, false, "real raster installation suppresses landmark meshes and their label targets");
    assert.equal(app.preference(), true, "suppression is not persisted as the user's 3D setting"); assert.equal(app.checked(), true);
    await app.publish({ status: "error", enabled: false, imageryVisible: false, error: "Fixture fallback" });
    assert.equal(app.scene().buildings, true); assert.equal(app.preference(), true);
  } finally { app.dispose(); }
});

test("pointer 3D toggles during satellite preserve the latest preference without restoring models on the photo", async () => {
  const app = harness();
  try {
    await app.mount(); await app.selectSatellite(); await app.publish({ status: "ready", imageryVisible: true });
    await app.toggleBuildings(); assert.equal(app.checked(), false); assert.equal(app.preference(), false); assert.equal(app.scene().buildings, false);
    await app.toggleBuildings(); assert.equal(app.checked(), true); assert.equal(app.preference(), true); assert.equal(app.scene().buildings, false);
    await app.toggleBuildings();
    await app.publish({ status: "zoom-required", imageryVisible: false });
    assert.equal(app.scene().buildings, false, "zoom fallback uses the latest OFF preference, not the pre-satellite value");
    await app.toggleBuildings(); assert.equal(app.preference(), true); assert.equal(app.scene().buildings, true);
    await app.publish({ status: "ready", imageryVisible: true }); assert.equal(app.scene().buildings, false);
    await app.publish({ status: "off", enabled: false, imageryVisible: false });
    assert.equal(app.scene().buildings, true, "ordinary map restores the latest ON preference");
    assert.deepEqual(app.saves.map(value => value.buildings3d), [true, false, true, false, true]);
  } finally { app.dispose(); }
});

test("style recreation and development editor apply the same installed-raster guard", async () => {
  const app = harness();
  try {
    const map = await app.mount(); await app.selectSatellite(); await app.publish({ status: "ready", imageryVisible: true });
    const oldScene = app.scene(); map.emit("style.load"); await app.settle();
    assert.equal(oldScene.disposed, true); assert.notEqual(app.scene(), oldScene); assert.equal(app.scene().buildings, false);
    await app.setEditorOpen(true);
    assert.equal(app.satellite().visible, false, "editor entry removes imagery through the real EarthMap layout effect");
    assert.equal(app.scene().buildings, true, "editor can work with models once the raster is removed"); assert.equal(app.preference(), true);
    await app.setEditorOpen(false); assert.equal(app.satellite().visible, true);
    await app.publish({ status: "loading", imageryVisible: true }); assert.equal(app.scene().buildings, false);
  } finally { app.dispose(); }
});
