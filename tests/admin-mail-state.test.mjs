import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hookModule = "virtual:admin-mail-hooks";
const targets = ["admin-mail-panel.tsx", "admin-adjustment-panel.tsx", "admin-grants-panel.tsx", "admin-player-dialog.tsx", "admin-rewards-dialog.tsx"];
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "admin-mail-state", enforce: "pre",
  resolveId(id) { if (id === hookModule) return `\0${id}`; },
  load(id) { if (id === `\0${hookModule}`) return `
    let slots=[],cursor=0,effects=[];
    export function reset(){for(const slot of slots)slot?.cleanup?.();slots=[];cursor=0;effects=[];}
    export function begin(){cursor=0;effects=[];}
    export function useState(initial){const i=cursor++;if(!(i in slots))slots[i]={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];}
    export function useRef(initial){const i=cursor++;return slots[i]??=( {current:initial} );}
    export function useMemo(callback,deps){const i=cursor++,prior=slots[i];if(!prior||deps.some((v,j)=>!Object.is(v,prior.deps[j])))slots[i]={value:callback(),deps};return slots[i].value;}
    export function useCallback(callback,deps){return useMemo(()=>callback,deps);}
    export function useEffect(callback,deps){const i=cursor++,prior=slots[i]?.deps;if(!prior||deps.some((v,j)=>!Object.is(v,prior[j])))effects.push({i,callback,deps});}
    export function commit(){const pending=effects;effects=[];for(const{i,callback,deps}of pending){slots[i]?.cleanup?.();slots[i]={deps,cleanup:callback()};}}
  `; },
  transform(source, id) { if (targets.some(name => id.endsWith(`/features/admin/${name}`))) return source.replace('from "react";', `from "${hookModule}";`); },
}] });
after(() => vite.close());
const { AdminMailPanel } = await vite.ssrLoadModule("/features/admin/admin-mail-panel.tsx");
const { AdminAdjustmentPanel } = await vite.ssrLoadModule("/features/admin/admin-adjustment-panel.tsx");
const { GrantWorkspace } = await vite.ssrLoadModule("/features/admin/admin-grants-panel.tsx");
const { AdminRewardsDialog } = await vite.ssrLoadModule("/features/admin/admin-rewards-dialog.tsx");
const { AdminPlayerDialog } = await vite.ssrLoadModule("/features/admin/admin-player-dialog.tsx");
const { readBroadcastAttempt } = await vite.ssrLoadModule("/features/admin/admin-mail-api.ts");
const { readAdjustmentAttempt } = await vite.ssrLoadModule("/features/admin/admin-adjustment-api.ts");
const { readLegacyRewardAttempt, readLegacyManageAttempt } = await vite.ssrLoadModule("/features/admin/admin-legacy-delivery-journal.ts");
const { readGrantAttempt } = await vite.ssrLoadModule("/features/admin/admin-grants-journal.ts");
const { newWorldState } = await vite.ssrLoadModule("/features/world/domain/model.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const original = { fetch: globalThis.fetch, window: globalThis.window };
afterEach(() => { hooks.reset(); Object.assign(globalThis, original); });
const actor = "7K3P-2Q9M-W8ZR", target = "7K3P-2Q9M-W8ZS", other = "7K3P-2Q9M-W8ZT", serverTime = "2026-10-18T12:00:00Z";
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function nodes(tree) { const result=[];function walk(n){if(!isValidElement(n))return;result.push(n);Children.forEach(n.props.children,walk);}walk(tree);return result; }
const text = value => typeof value === "string" ? value : Array.isArray(value) ? value.map(text).join("") : "";
const button = (view, label) => view.nodes.find(n => n.type === "button" && text(n.props.children) === label);
function field(view, label) { const node=view.nodes.find(n=>n.type==="label"&&text(n.props.children).startsWith(label));assert.ok(node,`field ${label}`);return nodes(node).find(n=>["input","textarea","select"].includes(n.type)); }
const change = (node, value) => node.props.onChange({ target: { value } });
function setup(Component, extras = {}, data = new Map(), sent = []) {
  hooks.reset(); const state={ actor, status:200, users:[], sent, changed:0, denied:[], post: req=>Response.json({requestId:req.requestId,recipientCount:1,changed:true,publicId:target,acceptedRevision:43,createdAt:serverTime,kind:req.kind,rewardId:req.rewardId,granted:true,action:req.action}) };
  const listeners=new Map();
  globalThis.window={ setTimeout:fn=>setTimeout(fn,0),clearTimeout,addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:(k,fn)=>{if(listeners.get(k)===fn)listeners.delete(k);},
    sessionStorage:{get length(){return data.size;},key:i=>[...data.keys()][i],getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)} };
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith("/access"))return state.status===200?Response.json({publicId:state.actor,displayName:"Админ",serverTime}):Response.json({code:"ACCESS_DENIED",message:"Нет доступа"},{status:state.status});
    if(options.method==="POST"){const req=JSON.parse(options.body);sent.push(req);return state.post(req,url);}
    if(url.includes("mail/broadcast?"))return Response.json({serverTime,total:0,offset:0,limit:20,broadcasts:[]});
    if(url.includes("users?"))return Response.json({serverTime,total:state.users.length,offset:0,limit:8,users:state.users});
    if(url.endsWith("/economy"))return Response.json({publicId:target,displayName:"Игрок",serverTime,updatedAt:null,economy:null,jobStatuses:[],ledger:[]});
    if(url.endsWith("/rewards"))return Response.json({publicId:target,serverTime,items:[],achievements:[]});
    if(url.endsWith("/security"))return Response.json({publicId:target,serverTime,watchlisted:false,manualWatchReason:null,tapSignalAt:null,securitySignalAt:null,signals:[]});
    if(url.endsWith("/player"))return Response.json({publicId:target,displayName:"Игрок",tag:null,watchlisted:false,bannedAt:null,banReason:null,world:newWorldState(),revision:0,serverTime});
    assert.fail(`Unexpected read ${url}`);
  };
  const user={publicId:target,displayName:"Игрок",isAdmin:false,tag:null};
  const props={actorPublicId:actor,targetPublicId:target,target:user,detail:{publicId:target,economy:{revision:42,wallet:{coins:100,pearls:7}}},disabled:false,onLockChange(){},onChanged:()=>state.changed++,onAccessLost:e=>state.denied.push(e),onClose(){},onGranted:()=>state.changed++,returnFocus(){},onTargetChange(){},onEconomy(){},onManage(){},onRewards(){},...extras};
  const render=()=>{hooks.begin();const tree=Component(props);hooks.commit();return{tree,nodes:nodes(tree)};};
  return{state,props,data,sent,render};
}
async function mailReady(app) { assert.equal(app.render().nodes.some(n=>n.type==="input"),false,"restore stays hidden until actor check");await tick();return app.render(); }
async function prepareMail(app) {
  let view=await mailReady(app);
  change(field(view,"Получатели"),"all");change(field(view,"Заголовок"),"Письмо игрокам");change(field(view,"Текст письма"),"Текст игроку");change(field(view,"Внутренняя причина"),"Служебная причина не для игрока");
  view=app.render();button(view,"Проверить рассылку").props.onClick();view=app.render();change(field(view,"Для подтверждения"),"ОТПРАВИТЬ");return app.render();
}

test("broadcast never sends on render; all audience and confirmation word are reviewed before sending", async()=>{
  const app=setup(AdminMailPanel);let view=await prepareMail(app);assert.equal(app.sent.length,0);
  change(field(view,"Для подтверждения"),"не подтверждаю");view=app.render();button(view,"Отправить письмо").props.onClick();await tick();assert.equal(app.sent.length,0);
  change(field(view,"Для подтверждения"),"ОТПРАВИТЬ");view=app.render();button(view,"Отправить письмо").props.onClick();await tick();
  assert.equal(app.sent.length,1);assert.deepEqual(app.sent[0].publicIds,[]);assert.equal(app.sent[0].audience,"all");assert.equal(app.sent[0].notify,false);
  assert.equal(app.sent[0].body,"Текст игроку");assert.ok(!app.sent[0].body.includes(app.sent[0].reason));assert.equal(readBroadcastAttempt(actor),null);
});

test("selected-player mail reviews exact public IDs, deduplicates rapid additions and disables banned recipients",async()=>{
  const app=setup(AdminMailPanel);
  const user={publicId:target,displayName:"Игрок",createdAt:serverTime,lastCheckInAt:null,checkInCount:0,friendCount:0,lifetimeTaps:0,bestSeries:0,monthlyTaps:0,leaderboardOptIn:false,activeSessions:1,loginMethods:[],isAdmin:false};
  app.state.users=[user,{...user,publicId:other,displayName:"Заблокирован",bannedAt:serverTime}];
  let view=await mailReady(app);await new Promise(resolve=>setTimeout(resolve,5));await tick();view=app.render();
  const choose=button(view,`Игрок · ${target}`);assert.ok(choose);choose.props.onClick();choose.props.onClick();
  assert.equal(button(view,`Заблокирован · ${other}`).props.disabled,true);
  change(field(view,"Заголовок"),"Личное письмо");change(field(view,"Текст письма"),"Текст получателю");change(field(view,"Внутренняя причина"),"Административная причина");
  view.nodes.find(n=>n.type==="input"&&n.props.type==="checkbox").props.onChange({target:{checked:true}});
  view=app.render();button(view,"Проверить рассылку").props.onClick();view=app.render();change(field(view,"Для подтверждения"),"ОТПРАВИТЬ");view=app.render();button(view,"Отправить письмо").props.onClick();await tick();
  assert.deepEqual(app.sent[0].publicIds,[target]);assert.equal(app.sent[0].audience,"players");assert.equal(app.sent[0].notify,true);
});

test("lost broadcast ACK then MAIL_BUSY keeps the original audience, text, delivery and UUID until resolution",async()=>{
  const app=setup(AdminMailPanel);let tries=0;
  app.state.post=req=>{if(!tries++)throw new TypeError("ACK lost");if(tries===2)return Response.json({code:"MAIL_BUSY",message:"Повторите прежний запрос"},{status:409});return Response.json({requestId:req.requestId,recipientCount:5,changed:true,createdAt:serverTime});};
  let view=await prepareMail(app);button(view,"Отправить письмо").props.onClick();await tick();view=app.render();const original=structuredClone(app.sent[0]);
  assert.equal(readBroadcastAttempt(actor).requestId,original.requestId);assert.equal(field(view,"Заголовок").props.value,original.title);
  change(field(view,"Заголовок"),"Изменение из устаревшего callback");view=app.render();button(view,"Проверить прежнюю рассылку").props.onClick();await tick();
  assert.ok(readBroadcastAttempt(actor));view=app.render();button(view,"Проверить прежнюю рассылку").props.onClick();await tick();
  assert.deepEqual(app.sent,[original,original,original]);assert.equal(readBroadcastAttempt(actor),null);
});

test("POST 200 then verification 401 preserves an actor-bound broadcast; another account never sees it and original actor retries the same UUID",async()=>{
  const data=new Map(),sent=[];let app=setup(AdminMailPanel,{},data,sent);
  app.state.post=req=>{app.state.status=401;return Response.json({requestId:req.requestId,recipientCount:5,changed:true,createdAt:serverTime});};
  let view=await prepareMail(app);button(view,"Отправить письмо").props.onClick();await tick();
  const frozen=structuredClone(sent[0]);assert.equal(app.state.denied[0].status,401);assert.ok(readBroadcastAttempt(actor));
  assert.equal(app.render().nodes.some(n=>n.type==="input"),false,"access failure hides private draft immediately");
  app=setup(AdminMailPanel,{actorPublicId:other},data,sent);app.state.actor=other;view=await mailReady(app);
  assert.equal(field(view,"Заголовок").props.value,"");assert.equal(readBroadcastAttempt(other),null);assert.equal(sent.length,1);
  app=setup(AdminMailPanel,{},data,sent);view=await mailReady(app);assert.equal(sent.length,1,"relogin does not send automatically");
  button(view,"Проверить прежнюю рассылку").props.onClick();await tick();assert.deepEqual(sent,[frozen,frozen]);assert.equal(readBroadcastAttempt(actor),null);
});

test("blocked journal fails closed and actor prop changes hide retained mail data immediately",async()=>{
  const app=setup(AdminMailPanel);let view=await prepareMail(app);
  globalThis.window.sessionStorage.setItem=()=>{throw new Error("Blocked storage");};button(view,"Отправить письмо").props.onClick();await tick();assert.equal(app.sent.length,0);
  app.props.actorPublicId=other;app.state.actor=other;assert.equal(app.render().tree,null);
});

test("correction previews signed visible units, rejects missing confirmation and freezes revision across an uncertain retry",async()=>{
  const app=setup(AdminAdjustmentPanel);let tries=0;app.state.post=req=>{if(!tries++)throw new TypeError("ACK lost");return Response.json({requestId:req.requestId,publicId:target,changed:true,acceptedRevision:43,createdAt:serverTime});};
  let view=app.render();change(field(view,"Изменение монет"),"-10");change(field(view,"Изменение жемчуга"),"+3");change(field(view,"Внутренняя причина"),"Исправление списания");view=app.render();
  assert.equal(button(view,"Проверить корректировку").props.disabled,true);change(field(view,"Подтвердите ID"),target);view=app.render();
  const delivery=view.nodes.find(n=>n.type.name==="AdminDeliveryFields");delivery.props.onDelivery("notify");delivery.props.onTitle("Поправка");delivery.props.onBody("Баланс исправлен");
  view=app.render();button(view,"Проверить корректировку").props.onClick();view=app.render();button(view,"Подтвердить корректировку").props.onClick();await tick();
  const frozen=structuredClone(app.sent[0]);assert.equal(frozen.expectedRevision,42);assert.equal(frozen.pearlsDelta,3);assert.equal(frozen.delivery,"notify");
  app.props.detail={publicId:target,economy:{revision:99,wallet:{coins:90,pearls:13}}};view=app.render();assert.equal(view.nodes.some(n=>n.props["aria-label"]==="Предпросмотр корректировки"),false,"current balance cannot double the old preview");
  button(view,"Проверить прежнюю корректировку").props.onClick();await tick();assert.deepEqual(app.sent,[frozen,frozen]);assert.equal(readAdjustmentAttempt(actor,target),null);
});

test("an explicit stale-revision rejection releases the correction for a fresh reviewed revision, while unknown 409 does not",async()=>{
  const app=setup(AdminAdjustmentPanel);let view=app.render();change(field(view,"Изменение монет"),"5");change(field(view,"Внутренняя причина"),"Исправление списания");change(field(view,"Подтвердите ID"),target);view=app.render();button(view,"Проверить корректировку").props.onClick();view=app.render();
  app.state.post=()=>Response.json({code:"UNKNOWN_LOCK",message:"Retry"},{status:409});button(view,"Подтвердить корректировку").props.onClick();await tick();assert.ok(readAdjustmentAttempt(actor,target));
  app.state.post=()=>Response.json({code:"ECONOMY_REVISION_CONFLICT",message:"Refresh"},{status:409});view=app.render();button(view,"Проверить прежнюю корректировку").props.onClick();await tick();assert.equal(readAdjustmentAttempt(actor,target),null);assert.equal(app.state.changed,1);
  app.props.detail={publicId:target,economy:{revision:44,wallet:{coins:120,pearls:7}}};view=app.render();change(field(view,"Подтвердите ID"),target);view=app.render();button(view,"Проверить корректировку").props.onClick();view=app.render();
  app.state.post=req=>Response.json({requestId:req.requestId,publicId:target,changed:true,acceptedRevision:45,createdAt:serverTime});button(view,"Подтвердить корректировку").props.onClick();await tick();assert.equal(app.sent[2].expectedRevision,44);assert.notEqual(app.sent[2].requestId,app.sent[0].requestId);
});

test("correction POST 200 followed by auth loss keeps its exact pending UUID for the original administrator",async()=>{
  const data=new Map(),sent=[];let app=setup(AdminAdjustmentPanel,{},data,sent);let view=app.render();
  change(field(view,"Изменение монет"),"-5");change(field(view,"Внутренняя причина"),"Исправление списания");change(field(view,"Подтвердите ID"),target);view=app.render();button(view,"Проверить корректировку").props.onClick();view=app.render();
  app.state.post=req=>{app.state.status=403;return Response.json({requestId:req.requestId,publicId:target,changed:true,acceptedRevision:43,createdAt:serverTime});};button(view,"Подтвердить корректировку").props.onClick();await tick();assert.equal(app.state.denied[0].status,403);assert.ok(readAdjustmentAttempt(actor,target));assert.equal(app.render().nodes.some(n=>n.type==="input"),false);
  const frozen=structuredClone(sent[0]);app=setup(AdminAdjustmentPanel,{},data,sent);view=app.render();button(view,"Проверить прежнюю корректировку").props.onClick();await tick();assert.deepEqual(sent,[frozen,frozen]);
});

test("economy and legacy rewards expose the same silent/notify choice and keep player text in durable lost-ACK attempts",async()=>{
  for(const [Component,kind] of [[GrantWorkspace,"economy"],[AdminRewardsDialog,"reward"],[AdminPlayerDialog,"world"]]){
    const app=setup(Component);app.render();await tick();let view=app.render();
    const options=view.nodes.find(n=>n.type.name==="AdminDeliveryFields");assert.ok(options,kind);assert.equal(options.props.delivery,"silent");options.props.onDelivery("notify");options.props.onTitle("Игроку");options.props.onBody("Отдельное сообщение");
    if(kind==="economy"){
      button(view,"Добавить в выдачу").props.onClick();change(field(view,"Причина выдачи"),"Внутренняя причина");view=app.render();button(view,"Проверить и выдать ").props.onClick();view=app.render();view.nodes.find(n=>n.type==="input"&&n.props.type==="checkbox").props.onChange({target:{checked:true}});view=app.render();
    }else{change(field(view,kind==="reward"?"Причина выдачи":"Причина изменения"),"Внутренняя причина");change(field(view,kind==="reward"?"Подтвердите ID получателя":"Подтвердите ID игрока"),target);if(kind==="world")change(field(view,"Предмет"),"fern");view=app.render();}
    app.state.post=()=>{throw new TypeError("ACK lost");};button(view,kind==="economy"?"Выдать игроку":kind==="reward"?"Выдать награду":"Выдать предмет").props.onClick();await tick();
    assert.equal(app.sent.length,1,kind);assert.equal(app.sent[0].delivery,"notify");assert.deepEqual(app.sent[0].playerMessage,{title:"Игроку",body:"Отдельное сообщение"});
    const restored=kind==="economy"?readGrantAttempt(actor,target):kind==="reward"?readLegacyRewardAttempt(actor,target):readLegacyManageAttempt(actor,target);assert.deepEqual(restored,app.sent[0]);hooks.reset();
  }
});
