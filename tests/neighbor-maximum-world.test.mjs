import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:neighbor-max-world-state";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "neighbor-max-world-state", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `let slots=[],index=0;export function begin(){index=0;}export function useState(value){let n=index++;if(!(n in slots))slots[n]=value;return[slots[n],next=>{slots[n]=typeof next==='function'?next(slots[n]):next;}];}`; },
    transform(source, id) { if (id.endsWith("/features/admin/admin-neighbor-settings.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }] });
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { neighborDefaultSettings } = await vite.ssrLoadModule("/features/economy/domain/neighbor-model.ts");
const { AdminNeighborSettingsForm } = await vite.ssrLoadModule("/features/admin/admin-neighbor-settings.tsx");
const hooks = await vite.ssrLoadModule(hooksId);
const maximum = Object.fromEntries(economyCatalog.buildings.map(building => [building.id, Math.max(...building.levels.map(level => level.level))]));
function nodes(tree) { const result=[];const walk=node=>{if(!isValidElement(node))return;result.push(node);Children.forEach(node.props.children,walk);};walk(tree);return result; }
const text = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : isValidElement(node) ? text(node.props.children) : "";

test("a fresh neighbor has every catalog building at its real maximum", () => {
  assert.deepEqual(neighborDefaultSettings.buildings, maximum);
  assert.equal(maximum.home, 5); assert.equal(maximum.warehouse, 10);
});

test("maximum-settlement preset stages all buildings without saving or overwriting unrelated settings", () => {
  const settings = structuredClone(neighborDefaultSettings), reviewed=[];
  settings.buildings.home=2;settings.buildings.workshop=1;settings.name="Ручное имя";settings.dailyBudgetCoins=1234;
  const before=JSON.stringify(settings);
  const render=()=>{hooks.begin();return AdminNeighborSettingsForm({settings,disabled:false,onReview:(value,reason)=>reviewed.push({value,reason})});};
  const preset=nodes(render()).find(node=>node.type==="button"&&text(node).trim()==="Максимальное поселение");
  assert.ok(preset);assert.equal(preset.props.type,"button");preset.props.onClick();
  assert.deepEqual(reviewed,[]);assert.equal(JSON.stringify(settings),before);
  const reason=nodes(render()).find(node=>node.type==="textarea"&&node.props.minLength===8);reason.props.onChange({target:{value:"Показательное поселение"}});
  render().props.onSubmit({preventDefault(){}});
  assert.equal(reviewed.length,1);assert.deepEqual(reviewed[0].value.buildings,maximum);
  assert.equal(reviewed[0].value.name,"Ручное имя");assert.equal(reviewed[0].value.dailyBudgetCoins,1234);
  assert.equal(reviewed[0].reason,"Показательное поселение");
});
