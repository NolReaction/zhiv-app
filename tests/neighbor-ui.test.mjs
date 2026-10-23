import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:neighbor-test-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "neighbor-test-hooks", enforce: "pre", resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots=[], cursor=0, effects=[], layouts=[], cleanup=[];
      export function reset(){ slots=[]; cursor=0; effects=[]; layouts=[]; cleanup=[]; }
      export function render(){cursor=0; effects=[]; layouts=[];}
      export function flush(){layouts.forEach(fn=>{const c=fn();if(c)cleanup.push(c);});effects.forEach(fn=>{const c=fn();if(c)cleanup.push(c);});}
      export function unmount(){cleanup.forEach(fn=>fn());cleanup=[];}
      export function useRef(initial){const i=cursor++;return slots[i]??={current:initial};}
      export function useState(initial){const s=useRef(typeof initial==='function'?initial():initial);return[s.current,v=>{s.current=typeof v==='function'?v(s.current):v;}];}
      export function useId(){return 'neighbor-test-'+cursor++;}
      function queue(fn,deps,list){const i=cursor++,prev=slots[i];if(!prev||deps.some((v,j)=>!Object.is(v,prev[j]))){slots[i]=deps;list.push(fn);}}
      export function useLayoutEffect(fn,deps){queue(fn,deps,layouts);}
      export function useEffect(fn,deps){queue(fn,deps,effects);}
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/neighbor/neighbor-dialog.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(() => vite.close());
const { NeighborShop, NeighborStationInfo } = await vite.ssrLoadModule("/features/economy/ui/neighbor/neighbor-dialog.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { neighborStationProducts } = await vite.ssrLoadModule("/features/economy/ui/neighbor/neighbor-station-products.ts");
const { readOnlyWorldScene } = await vite.ssrLoadModule("/features/world/ui/visits/friend-world-state.ts");
const hooks = await vite.ssrLoadModule(hooksId), now = Date.parse("2026-10-23T12:00:00Z");
function fixture() {
  const offer = { id: "00000000-0000-4000-8000-000000000003", itemId: "wood", quantity: 3, totalPrice: 30, purchased: false };
  const neighbor = { ownerPublicId: "ME", serverTime: new Date(now).toISOString(), character: { id: "berest", name: "Дубок", kind: "world_character" },
    shop: { cycleId: "2026-10-23", refreshAt: "2026-10-24T00:00:00.000Z", available: true, reason: null, offers: [offer] } };
  const economy = { snapshot: { ownerPublicId: "ME", revision: 2, wallet: { coins: 1000, pearls: 0 }, inventory: {},
    unlockedItems: ["wood"], itemUnlockVersion: 1, completedExplorations: 0, buildings: { home: 2, bridge: 1 }, storage: { available: 50 }, catalog: structuredClone(economyCatalog) },
    now, retryAt: 0, snapshotConfirmed: true, busy: false, uncertain: false, syncPending: false, directActionsAvailable: true, error: null, notice: "",
    actNeighbor() { assert.fail("A visit or quote must not spend coins"); }, retry() { assert.fail("Recovery needs an explicit press"); } };
  return { economy, neighbor, offer, timeZone: "Europe/Moscow", onRefresh() {} };
}
function elements(tree) { const found=[];const visit=node=>{if(isValidElement(node)){found.push(node);Children.forEach(node.props.children,visit);}};visit(tree);return found; }
function harness(props) { hooks.reset(); return { render() { hooks.render(); const tree = NeighborShop(props), nodes=elements(tree);
  for(const node of nodes)if(node.props.ref)node.props.ref.current={focus(){},querySelector(){return{focus(){}};}};
  hooks.flush();return{tree,nodes}; } }; }
const choose = view => view.nodes.find(node=>node.type==="button"&&node.props["data-neighbor-offer"]);
const confirm = view => view.nodes.find(node=>node.type==="button"&&node.props["aria-label"]?.startsWith("Подтвердить покупку:"));

test("the server's renamed NPC stays explicitly labeled, and choosing needs a second explicit full-lot confirmation",()=>{
  const p=fixture(), calls=[], h=harness(p);p.economy.actNeighbor=(...args)=>{calls.push(args);return true;};
  const first=h.render();assert.ok(first.nodes.some(n=>n.type==="h3"&&n.props.children.join("")==="Лавка: Дубок"));
  assert.ok(first.nodes.some(n=>n.type==="span"&&n.props.children==="Персонаж мира"));
  assert.ok(first.nodes.some(n=>n.type==="strong"&&typeof n.props.children==="string"&&n.props.children.startsWith("03:00")), "refresh clock follows the supplied profile timezone");
  choose(first).props.onClick();assert.deepEqual(calls,[]);const view=h.render();assert.match(confirm(view).props["aria-label"],/3 шт. за 30 монет/);
  confirm(view).props.onClick();confirm(view).props.onClick();confirm(h.render()).props.onClick();assert.deepEqual(calls,[[p.offer.id,3,30]]);
});

test("captured buy handlers reject changed account, revision, cycle, balance, offer, deadline, connectivity, and unmount",()=>{
  for(const change of [p=>{p.economy.snapshot.ownerPublicId="OTHER";},p=>{p.economy.snapshot.revision++;},p=>{p.neighbor.ownerPublicId="OTHER";},
    p=>{p.economy.snapshot.wallet.coins=1;},p=>{p.economy.snapshot.storage.available=1;},p=>{p.offer.totalPrice++;},p=>{p.offer.purchased=true;},
    p=>{p.economy.now+=120000;},p=>{p.neighbor.shop.cycleId="2026-10-24";},p=>{p.economy.directActionsAvailable=false;},p=>{p.economy.uncertain=true;},
    p=>{p.refreshing=true;},()=>hooks.unmount()]){
    const p=fixture(), calls=[], h=harness(p);p.economy.actNeighbor=(...args)=>{calls.push(args);return true;};
    choose(h.render()).props.onClick();const captured=confirm(h.render()).props.onClick;change(p);if(!change.toString().includes("unmount"))h.render();captured();assert.deepEqual(calls,[],change.toString());
  }
});

test("unknown purchase uses session retry, a successful ACK clears confirmation, and bought cards stay disabled",()=>{
  const p=fixture(),calls=[],retries=[],h=harness(p);p.economy.actNeighbor=(...args)=>{calls.push(args);return true;};p.economy.retry=()=>retries.push("same receipt");
  choose(h.render()).props.onClick();confirm(h.render()).props.onClick();p.economy.uncertain=true;p.economy.error="Ответ потерялся";
  const pending=h.render();assert.equal(confirm(pending).props.disabled,true);pending.nodes.find(n=>n.type==="button"&&n.props.children==="Проверить результат").props.onClick();
  assert.deepEqual(retries,["same receipt"]);assert.equal(calls.length,1);
  p.economy.uncertain=false;p.economy.error=null;p.economy.snapshot.revision++;p.economy.notice="Партия куплена";p.offer.purchased=true;
  h.render();assert.equal(confirm(h.render()),undefined);assert.equal(choose(h.render()).props.disabled,true);assert.equal(calls.length,1);
});

test("empty locked or paused shelves explain the reason instead of promising available goods",()=>{
  for(const [reason,fragment]of [["market_locked",/откроете рынок/],["paused",/временно закрыта/]]){
    const p=fixture();p.neighbor.shop.available=false;p.neighbor.shop.reason=reason;p.neighbor.shop.offers=[];
    const view=harness(p).render();assert.ok(view.nodes.some(n=>n.type==="p"&&typeof n.props.children==="string"&&fragment.test(n.props.children)));
    assert.equal(choose(view),undefined);
  }
});

test("NPC projection uses its scene namespace without a publicId and never changes the player's world",()=>{
  const world={buildings:{home:5,workshop:4,bridge:1},equipment:{palette:"moss",head:null,neck:null,rod:null},gifts:[],hiddenGifts:[],jobs:[]};
  const before=structuredClone(world),scene=readOnlyWorldScene(world,"world-character:berest",new Date(now).toISOString());
  assert.equal(scene.state.houseLevel,5);assert.equal(scene.residents.ownerPublicId,"world-character:berest");assert.deepEqual(scene.state.inventory,[]);
  scene.buildings.home=2;assert.deepEqual(world,before);assert.equal("user"in world,false);assert.equal("publicId"in world,false);
});


test("station capabilities follow the neighbor's actual home, own station and dependency levels",()=>{
  const world={buildings:{home:3,workshop:2,kiln:1,dryer:1,garden:2,woodlot:2,quarry:2},equipment:{palette:"moss",head:null,neck:null,rod:null},gifts:[],hiddenGifts:[],jobs:[]};
  const before=structuredClone(world),work=neighborStationProducts(world,"workshop"),kiln=neighborStationProducts(world,"kiln");
  assert.ok(work.some(p=>p.outputs.some(o=>o.itemId==="planks"&&o.quantity===1)));
  assert.ok(work.some(p=>p.outputs.some(o=>o.itemId==="rope")));
  assert.equal(work.some(p=>p.outputs.some(o=>o.itemId==="metal_parts")),false,"kiln2 dependency is not met");
  assert.ok(kiln.some(p=>p.outputs.some(o=>o.itemId==="charcoal")));
  assert.equal(kiln.some(p=>p.outputs.some(o=>o.itemId==="iron_ingot")),false,"kiln level is too low");
  assert.equal(neighborStationProducts({...world,buildings:{...world.buildings,home:1}},"workshop").some(p=>p.outputs.some(o=>o.itemId==="rope")),false);
  assert.equal(neighborStationProducts({...world,buildings:{...world.buildings,kiln:0}},"kiln").length,0);
  const garden=neighborStationProducts(world,"garden");assert.equal(garden.filter(p=>p.outputs.some(o=>o.itemId==="berries")).length,1,"alternate methods of identical output stay one entry");
  assert.ok(neighborStationProducts(world,"quarry").length>0,"mine exposes real routes rather than invented production");
  assert.deepEqual(world,before,"inspecting capabilities never changes levels or creates work");
});

test("station preview renders bounded real outputs and explains recipe learning without inventing ongoing jobs",()=>{
  const world={buildings:Object.fromEntries(economyCatalog.buildings.map(b=>[b.id,b.levels.at(-1).level])),equipment:{palette:"moss",head:null,neck:null,rod:null},gifts:[],hiddenGifts:[],jobs:[]};
  for(const stationId of ["workshop","kiln","dryer","quarry"]){
    const all=neighborStationProducts(world,stationId),html=renderToStaticMarkup(NeighborStationInfo({world,stationId}));
    assert.equal((html.match(/<li>/g)??[]).length,Math.min(4,all.length));
    for(const product of all.slice(0,4))for(const output of product.outputs)assert.ok(html.includes(`${output.name} × ${output.quantity}`));
    if(all.length>4)assert.match(html,/Ещё вариантов:/);
    assert.doesNotMatch(html,/Осталось|Готово|Ожидает хозяина|<button|claim_job|start_production/);
  }
  const cook=renderToStaticMarkup(NeighborStationInfo({world:{...world,buildings:{...world.buildings,dryer:1,home:3}},stationId:"dryer"}));
  assert.match(cook,/Для некоторых блюд сначала осваивают предыдущие рецепты/);
  const baseFire=renderToStaticMarkup(NeighborStationInfo({world:{...world,buildings:{...world.buildings,dryer:0}},stationId:"dryer"}));
  assert.match(baseFire,/Обычный костёр/);assert.match(baseFire,/Пожарить рыбу/);assert.doesNotMatch(baseFire,/Ещё не построено/);
  assert.match(renderToStaticMarkup(NeighborStationInfo({world,stationId:"workshop"})),/Верстак/);
  assert.match(renderToStaticMarkup(NeighborStationInfo({world,stationId:"kiln"})),/Печь/);
});
