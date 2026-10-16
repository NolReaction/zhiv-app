import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Children, createElement, isValidElement } from "react";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url)), hooksId = "virtual:construction-carousel-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "construction-carousel-hooks", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) { if (id === `\0${hooksId}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; }
      export function useState(value) { const ref = useRef(value); return [ref.current, value => { ref.current = value; }]; }
      export function useId() { return 'construction-carousel'; }
    `; },
    transform(source, id) { if (id.endsWith("/features/economy/ui/construction/upgrade-benefit-carousel.tsx")) return source.replace('from "react";', `from "${hooksId}";`); },
  }] });
const hooks = await vite.ssrLoadModule(hooksId);
const { UpgradeBenefitCarousel } = await vite.ssrLoadModule("/features/economy/ui/construction/upgrade-benefit-carousel.tsx");
after(() => vite.close());
function nodes(tree) {
  const found = [];
  const visit = node => { if (isValidElement(node)) { found.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return found;
}

test("swiping and keyboard navigation show only the selected opportunity's full prerequisites", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
  try {
    hooks.reset();
    const changed = [], scrolls = [];
    const cards = [
      { id: "home", label: "Дом", content: createElement("p", null, "Облик") },
      { id: "mine", label: "Шахта", content: createElement("p", null, "Добыча"), details: createElement("p", null, "Мастерская ур. 1") },
      { id: "market", label: "Рынок", content: createElement("p", null, "Торговля"), details: createElement("p", null, "Мост ур. 1") },
    ];
    const render = () => { hooks.render(); return nodes(UpgradeBenefitCarousel({ cards, onCardChange: id => changed.push(id) })); };
    const track = view => view.find(node => node.props["aria-roledescription"] === "карусель");
    const children = Object.assign([{ offsetLeft: 0 }, { offsetLeft: 250 }, { offsetLeft: 500 }], { item(index) { return this[index]; } });
    const element = { children, scrollLeft: 0, scrollTo(options) { scrolls.push(options); this.scrollLeft = options.left; } };
    let view = render(); track(view).props.ref.current = element;
    assert.ok(!view.some(node => node.props["aria-label"]?.startsWith("Подробнее:")));
    element.scrollLeft = 250; track(view).props.onScroll(); view = render();
    assert.ok(view.some(node => node.props["aria-label"] === "Подробнее: Шахта"));
    assert.ok(!view.some(node => node.props["aria-label"] === "Подробнее: Рынок"));
    let handled = 0;
    const current = {};
    track(view).props.onKeyDown({ target: current, currentTarget: current, key: "End", preventDefault() { handled++; }, stopPropagation() { handled++; } });
    assert.deepEqual(scrolls.at(-1), { left: 500, behavior: "instant" });
    assert.equal(handled, 2);
    track(view).props.onScroll(); view = render();
    assert.ok(view.some(node => node.props["aria-label"] === "Подробнее: Рынок"));
    assert.ok(!view.some(node => node.props["aria-label"] === "Подробнее: Шахта"));
    element.scrollLeft = 0; track(view).props.onScroll(); view = render();
    assert.ok(!view.some(node => node.props["aria-label"]?.startsWith("Подробнее:")));
    assert.deepEqual(changed, ["mine", "market", "home"]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete globalThis.window;
  }
});
