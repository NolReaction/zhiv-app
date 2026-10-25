import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookId = "virtual:workbench-test-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "workbench-test-hooks", enforce: "pre",
    resolveId(id) { if (id === hookId) return `\0${id}`; },
    load(id) { if (id === `\0${hookId}`) return `
      let state=[],cursor=0;
      export function reset(){state=[];cursor=0;}
      export function begin(){cursor=0;}
      export function useState(initial){const index=cursor++;if(!(index in state))state[index]=typeof initial==='function'?initial():initial;return[state[index],next=>{state[index]=typeof next==='function'?next(state[index]):next;}];}
      export function useId(){return 'test-workbench-'+cursor++;}
      export function useRef(value){const index=cursor++;if(!(index in state))state[index]={current:value};return state[index];}
      export function useMemo(factory){return factory();}
      export function useEffect(){}
    `; },
    transform(source, id) {
      if (!/\/features\/progression\/economy-(workbench|production-graph|production-planner)\.tsx$/.test(id)) return;
      return source.replace('from "react";', `from "${hookId}";`);
    },
  }],
});
after(() => vite.close());
const hooks = await vite.ssrLoadModule(hookId);
const { EconomyWorkbench, EconomyBalanceTable, sortEconomyRows } = await vite.ssrLoadModule("/features/progression/economy-workbench.tsx");
const { EconomyProductionGraph, productionGraphSelection, productionGraphLayout } = await vite.ssrLoadModule("/features/progression/economy-production-graph.tsx");
const { EconomyProductionPlanner } = await vite.ssrLoadModule("/features/progression/economy-production-planner.tsx");
const { economyCsv } = await vite.ssrLoadModule("/features/progression/economy-workbench-common.tsx");
const { buildEconomyAnalysis } = await vite.ssrLoadModule("/features/progression/economy-analysis.ts");
const analysis = buildEconomyAnalysis();
function elements(tree) {
  const result = [];
  function walk(node) { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, walk); } }
  walk(tree); return result;
}
function harness(Component, props = {}) { hooks.reset(); return { render() { hooks.begin(); return Component(props); } }; }
function field(tree, label) { const node = elements(tree).find(value => value.props["aria-label"] === label); assert(node, label); return node; }
const asText = tree => renderToStaticMarkup(tree).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("analysis tabs have a single focusable tab, linked hidden panels and preserve planner targets across navigation", () => {
  const h = harness(EconomyWorkbench, { onInspectItem() {} });
  let tree = h.render();
  const tabs = elements(tree).filter(node => node.props.role === "tab");
  assert.deepEqual(tabs.map(node => node.props["aria-selected"]), [true, false, false]);
  const panels = elements(tree).filter(node => node.props.role === "tabpanel");
  assert.deepEqual(panels.map(node => node.props.hidden), [false, true, true]);
  for (const tab of tabs) assert.equal(panels.find(panel => panel.props.id === tab.props["aria-controls"])?.props["aria-labelledby"], tab.props.id);
  elements(tree).find(node => node.type === EconomyProductionGraph).props.onPlan("ceramic_jar");
  tree = h.render();
  assert.deepEqual(elements(tree).find(node => node.type === EconomyProductionPlanner).props.targets, { dried_berries: 1, ceramic_jar: 1 });
  assert.equal(elements(tree).find(node => node.props["data-economy-tab"] === "plan").props["aria-selected"], true);
  elements(tree).find(node => node.type === EconomyProductionPlanner).props.onSelect("glass");
  tree = h.render();
  assert.equal(elements(tree).find(node => node.type === EconomyProductionGraph).props.selectedId, "glass");
  assert.equal(elements(tree).find(node => node.type === EconomyProductionPlanner).props.targets.ceramic_jar, 1);
});

test("analysis tab keyboard navigation wraps, focuses selected controls and leaves ordinary Tab alone", () => {
  const h = harness(EconomyWorkbench, { onInspectItem() {} }), focused = [];
  for (const [key, expected] of [["ArrowLeft", "plan"], ["Home", "chains"], ["ArrowRight", "balance"], ["End", "plan"]]) {
    let prevented = false;
    field(h.render(), "Инструмент анализа").props.onKeyDown({ key, preventDefault() { prevented = true; }, currentTarget: { querySelector(selector) { return { focus() { focused.push(selector); } }; } } });
    assert(prevented); assert.equal(elements(h.render()).find(node => node.props["data-economy-tab"] === expected).props.tabIndex, 0);
  }
  field(h.render(), "Инструмент анализа").props.onKeyDown({ key: "Tab", preventDefault() { assert.fail("Native Tab must remain available"); } });
  assert.equal(focused.length, 4);
});

test("balance shows all items, filters by name and category, and sort keeps undefined estimates last", () => {
  const h = harness(EconomyBalanceTable, { onSelect() {} });
  const rows = tree => elements(tree).filter(node => node.props["data-balance-item"]);
  assert.equal(rows(h.render()).length, analysis.items.length);
  field(h.render(), "Поиск в таблице баланса").props.onChange({ target: { value: "МАЛИНА" } });
  assert.deepEqual(rows(h.render()).map(row => row.props["data-balance-item"]), ["berries"]);
  field(h.render(), "Категория в таблице баланса").props.onChange({ target: { value: "crafted" } });
  assert.equal(rows(h.render()).length, 0); assert.match(asText(h.render()), /Нет товаров/);
  const values = sortEconomyRows(analysis.items, "fullWorkSeconds", true).map(item => item.fullWorkSeconds);
  const firstUnknown = values.indexOf(null);
  assert(firstUnknown > 0); assert(values.slice(firstUnknown).every(value => value === null));
  assert(values.slice(1, firstUnknown).every((value, index) => value <= values[index]));
});

test("production graph keeps all upstream alternatives and direct usage quantities without retired operations", () => {
  const graph = productionGraphSelection(analysis.graph, "ceramic_jar", false);
  assert(graph.nodes.some(node => node.id === "item:clay"));
  assert(graph.nodes.some(node => node.id === "item:wood"));
  assert(graph.nodes.some(node => node.id === "item:packed_berries"));
  assert(graph.edges.some(edge => edge.from === "item:clay" && edge.quantity === 2));
  const focused = productionGraphSelection(analysis.graph, "ceramic_jar", false, false);
  assert(!productionGraphSelection(analysis.graph, "berries", false, false).nodes.some(node => node.id === "item:berry_compote"));
  assert(focused.nodes.some(node => node.id === "item:clay"));
  const all = productionGraphSelection(analysis.graph, "ceramic_jar", true);
  assert.equal(all.nodes.length, analysis.graph.nodes.length);
  const layout = productionGraphLayout(all.nodes, all.edges);
  assert.equal(layout.positions.size, all.nodes.length);
  assert(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  assert([...layout.positions.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0));
  const retired = new Set(analysis.sources.filter(source => source.retired).map(source => source.id));
  assert(all.nodes.every(node => !retired.has(node.id)));
});

test("planner exposes shared stock controls, slots and home restrictions without inventing missing-source deadlines", () => {
  const h = harness(EconomyProductionPlanner, { analysis, targets: { berries: 30, ceramic_jar: 1 }, onTargets() {}, onSelect() {} });
  const elapsed = tree => elements(tree).find(node => node.props["data-plan-elapsed"] !== undefined).props.children;
  const work = tree => elements(tree).find(node => node.props["data-plan-work"] !== undefined).props.children;
  const initial = elapsed(h.render()), initialWork = work(h.render());
  field(h.render(), "Места производства для плана").props.onChange({ target: { value: "3" } });
  assert.equal(work(h.render()), initialWork); assert.notEqual(elapsed(h.render()), initial);
  field(h.render(), "Хозяйство для плана").props.onChange({ target: { value: "1" } });
  assert.equal(elapsed(h.render()), "Не определено");
  assert.match(asText(h.render()), /Нужно получить другим способом/);
  field(h.render(), "Хозяйство для плана").props.onChange({ target: { value: "0" } });
  assert.notEqual(elapsed(h.render()), "Не определено");
  assert.match(asText(h.render()), /не прогноз прохождения/);
});

test("CSV preserves exact values, escapes semicolons and quotes and neutralizes spreadsheet formulas", () => {
  const csv = economyCsv([["name", "coins", "missing"], ['=HYPERLINK("example")', 1234.5, null], ["first;second", -7, "@SUM(A1)"]]);
  assert(csv.startsWith("\uFEFF"));
  assert(csv.includes('"\'=HYPERLINK(""example"")";"1234.5";""'));
  assert(csv.includes('"first;second";"-7";"\'@SUM(A1)"'));
});
