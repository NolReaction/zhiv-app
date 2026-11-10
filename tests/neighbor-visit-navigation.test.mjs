import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:neighbor-portal-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "neighbor-portal-hooks", enforce: "pre", resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots=[], cursor=0, effects=[];
      export function reset(){slots=[];cursor=0;effects=[];}
      export function render(){cursor=0;effects=[];}
      export function flush(){effects.forEach(fn=>fn());effects=[];}
      export function useRef(value){return slots[cursor++]??={current:value};}
      export function useState(value){const slot=useRef(value);return[slot.current,next=>{slot.current=typeof next==='function'?next(slot.current):next;}];}
      export function useEffect(fn,deps){const i=cursor++,prev=slots[i];if(!prev||deps.some((v,j)=>!Object.is(v,prev[j]))){slots[i]=deps;effects.push(fn);}}
    `; },
    transform(source, id) { if (id.endsWith("/features/world/world-portal.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(() => vite.close());
const { default: WorldPortal } = await vite.ssrLoadModule("/features/world/world-portal.tsx");
const hooks = await vite.ssrLoadModule(hooksId);
const originalDocument = globalThis.document;
let restored = 0;
globalThis.document = { querySelector() { return null; }, getElementById() { return { focus() { restored++; } }; } };
after(() => { globalThis.document = originalDocument; });
function nodes(tree) { const found = []; const visit = node => { if (!isValidElement(node)) return; found.push(node); Children.forEach(node.props.children, visit); }; visit(tree); return found; }
function fixture() {
  hooks.reset(); restored = 0;
  const props = { open: true, ownerPublicId: "OWNER-A", timeZone: "Europe/Moscow", origin: {}, world: {}, economy: {},
    displayName: "Я", level: 1, wakeSignal: 0, bestStreakDays: 0, onClose() {}, returnFocus() {} };
  return { props, render() { hooks.render(); const result = nodes(WorldPortal(props)); hooks.flush(); return result; } };
}
const own = tree => tree.find(node => node.props.escapeHandlerRef && node.props.onOpenNeighbor);
const neighbor = tree => tree.find(node => node.type?.name === "NeighborWorldVisit");
const guest = tree => tree.find(node => node.type?.name === "GuestWorldVisit");

test("a neighbor visit replaces the own world inside the same full-screen portal and returns with focus", () => {
  const h = fixture();
  own(h.render()).props.onOpenNeighbor();
  const visit = h.render();
  assert.equal(own(visit), undefined);
  assert.equal(neighbor(visit).props.ownerPublicId, "OWNER-A");
  assert.equal("target" in neighbor(visit).props, false, "no fabricated human relationship or public ID");
  neighbor(visit).props.onReturn();
  assert.ok(own(h.render()));
  assert.equal(restored, 1);
});

test("changing owner, closing the world, or opening a real friend permanently revokes the old NPC subject", () => {
  for (const revoke of [h => { h.props.ownerPublicId = "OWNER-B"; }, h => { h.props.open = false; },
    h => { h.props.friendVisit = { circleId: "real-circle", targetPublicId: "REAL-FRIEND", displayName: "Друг" }; }]) {
    const h = fixture(); own(h.render()).props.onOpenNeighbor(); assert.ok(neighbor(h.render()));
    revoke(h); const revoked = h.render(); assert.equal(neighbor(revoked), undefined);
    if (h.props.friendVisit) assert.ok(guest(revoked));
    h.props.ownerPublicId = "OWNER-A"; h.props.open = true; h.props.friendVisit = undefined;
    assert.equal(neighbor(h.render()), undefined, "a previous account or reopening cannot resurrect the visit");
    assert.ok(own(h.render()));
  }
});

test("Escape returns from the NPC world while an activity gate retains control and suspended worlds cannot start a visit", () => {
  const h = fixture(); h.props.suspended = true;
  own(h.render()).props.onOpenNeighbor(); assert.equal(neighbor(h.render()), undefined);
  h.props.suspended = false; own(h.render()).props.onOpenNeighbor();
  const visit = h.render(), content = visit.find(node => node.props.onEscapeKeyDown);
  let prevented = 0;
  const event = { preventDefault() { prevented++; }, stopPropagation() {} };
  globalThis.document.querySelector = () => ({});
  content.props.onEscapeKeyDown(event); assert.ok(neighbor(h.render()));
  globalThis.document.querySelector = () => null;
  content.props.onEscapeKeyDown(event); assert.equal(neighbor(h.render()), undefined);
  assert.equal(prevented, 2);
});
