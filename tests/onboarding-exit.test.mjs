import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:onboarding-exit-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "onboarding-exit-hooks", enforce: "pre", resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `let slots=[], cursor=0;
      export function reset(){slots=[];cursor=0;} export function render(){cursor=0;}
      export function useRef(value){return slots[cursor++]??={current:value};}
      export function useState(value){const i=cursor++;slots[i]??={value};return [slots[i].value,next=>{slots[i].value=next;}];}
      export function useEffect(){} export function useId(){return 'guide-'+cursor++;}`; },
    transform(source, id) { if (id.endsWith("/features/onboarding/guide-coach.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hooksId);
const { GuideCoach } = await vite.ssrLoadModule("/features/onboarding/guide-coach.tsx");
const { GuideExitPrompt } = await vite.ssrLoadModule("/features/onboarding/guide-exit-prompt.tsx");
function nodes(tree) { const result=[]; const walk=node=>{if(!isValidElement(node))return;result.push(node);Children.forEach(node.props.children,walk);};walk(tree);return result; }
function setup(extra = {}) {
  hooks.reset(); const calls=[];
  const props = { open:true, flow:"world", stepId:"profile", title:"Первый шаг", text:"Открой профиль", pose:"greet",
    exitHelp:"Уровень → ? → Продолжить обучение", notice:"Справка с поиском — i", onPause:()=>calls.push("pause"), onSkip:()=>calls.push("skip"), ...extra };
  return { calls, props, render:()=>{hooks.render();return GuideCoach(props);} };
}
const button = (tree, flag) => nodes(tree).find(node => node.type === "button" && node.props[flag]);
const prompt = tree => nodes(tree).find(node => node.type === GuideExitPrompt);
test("minus opens an explanation; only explicit hide pauses, cancel keeps the lesson intact", () => {
  const env=setup(); let tree=env.render();button(tree,"data-guide-pause").props.onClick();assert.deepEqual(env.calls,[]);
  tree=env.render();assert.equal(prompt(tree).props.action,"pause");
  let panel=GuideExitPrompt(prompt(tree).props);button(panel,"data-guide-pause").props.onClick();
  assert.equal(prompt(env.render()),undefined);assert.deepEqual(env.calls,[]);
  button(env.render(),"data-guide-pause").props.onClick();panel=GuideExitPrompt(prompt(env.render()).props);
  nodes(panel).find(node=>node.type==="button"&&node.props.children==="Скрыть, сохранив шаг").props.onClick();
  assert.deepEqual(env.calls,["pause"]);
});
test("whole-course skip has a separate confirmation and never triggers pause", () => {
  const env=setup({welcome:true,stepId:"welcome"});
  nodes(env.render()).find(node=>node.type==="button"&&node.props.children==="Пропустить").props.onClick();
  assert.deepEqual(env.calls,[]);const panel=GuideExitPrompt(prompt(env.render()).props);
  assert.equal(panel.props["aria-label"],"Пропустить обучение?");
  nodes(panel).find(node=>node.type==="button"&&node.props.children==="Да, пропустить курс").props.onClick();
  assert.deepEqual(env.calls,["skip"]);
});
test("Escape asks before pausing and a second Escape cancels the question", () => {
  const env=setup();const event={key:"Escape",preventDefault(){},stopPropagation(){}};
  env.render().props.onKeyDown(event);assert.ok(prompt(env.render()));assert.deepEqual(env.calls,[]);
  env.render().props.onKeyDown(event);assert.equal(prompt(env.render()),undefined);assert.deepEqual(env.calls,[]);
});
test("early help notice is visible outside collapsed details and section guides keep their existing pause action", () => {
  const env=setup();const notice=nodes(env.render()).find(node=>node.type==="p"&&node.props.children===env.props.notice);
  assert.ok(notice);
  const section=setup({flow:"section",exitHelp:undefined});button(section.render(),"data-guide-pause").props.onClick();
  assert.deepEqual(section.calls,["pause"]);
});
