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

function fixture(cards) {
  hooks.reset();
  const scrolls = [];
  const render = () => { hooks.render(); return nodes(UpgradeBenefitCarousel({ cards })); };
  const track = view => view.find(node => node.props["aria-roledescription"] === "карусель");
  const children = Object.assign(cards.map((_, index) => ({ offsetLeft: index * 250 })), { item(index) { return this[index]; } });
  const element = { children, scrollLeft: 0, scrollTo(options) { scrolls.push(options); this.scrollLeft = options.left; } };
  let view = render(); track(view).props.ref.current = element;
  return { render, track, element, scrolls, view };
}
const triggers = view => view.filter(node => node.type === "button" && typeof node.props["aria-expanded"] === "boolean");
const details = view => view.filter(node => node.type === "section" && node.props["aria-label"]?.startsWith("Подробнее:"));
const click = (trigger, detail = 0) => trigger.props.onClick({ detail, preventDefault() {} });

function withWindow(run) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
  try { run(); } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete globalThis.window;
  }
}

test("every future benefit starts collapsed and expands only after an explicit card press", () => withWindow(() => {
  const cards = ["building", "route", "market", "fishing", "recipe"].map(kind => ({ id: kind, label: kind,
    recipeId: kind === "recipe" ? "make_planks" : undefined,
    content: createElement("span", null, kind), details: createElement("p", null, `${kind} requirements`) }));
  const f = fixture(cards);
  let view = f.view;
  assert.equal(details(view).length, 0);
  assert.equal(triggers(view).length, cards.length);
  assert.ok(triggers(view).every(trigger => trigger.props["aria-expanded"] === false));
  for (let index = 0; index < cards.length; index++) {
    f.element.scrollLeft = index * 250; f.track(view).props.onScroll(); view = f.render();
    assert.equal(details(view).length, 0, `browsing ${cards[index].id} never reveals its conditions`);
    click(triggers(view)[index]); view = f.render();
    assert.equal(details(view).length, 1);
    assert.equal(details(view)[0].props["aria-label"], `Подробнее: ${cards[index].label}`);
    assert.equal(triggers(view)[index].props["aria-expanded"], true);
    assert.equal(triggers(view)[index].props["aria-controls"], details(view)[0].props.id);
    assert.equal(details(view)[0].props["aria-labelledby"], triggers(view)[index].props.id);
    click(triggers(view)[index]); view = f.render();
    assert.equal(details(view).length, 0, "pressing the same card closes its details");
  }
  assert.equal(triggers(view).at(-1).props["data-recipe"], "make_planks");
}));

test("swipes and carousel keys clear a disclosure instead of opening the next opportunity", () => withWindow(() => {
  const f = fixture(["Дом", "Шахта", "Рынок"].map(label => ({ id: label, label, content: createElement("span", null, label), details: createElement("p", null, "Условия") })));
  let view = f.view;
  click(triggers(view)[0]); view = f.render(); assert.equal(details(view).length, 1);
  f.element.scrollLeft = 250; f.track(view).props.onScroll(); view = f.render();
  assert.equal(details(view).length, 0);
  click(triggers(view)[1]); view = f.render();
  let handled = 0;
  const current = {};
  f.track(view).props.onKeyDown({ target: current, currentTarget: current, key: "End", preventDefault() { handled++; }, stopPropagation() { handled++; } });
  assert.deepEqual(f.scrolls.at(-1), { left: 500, behavior: "instant" });
  assert.equal(handled, 2);
  f.track(view).props.onScroll(); view = f.render();
  assert.equal(details(view).length, 0);
  f.element.scrollLeft = 250; f.track(view).props.onScroll(); view = f.render();
  assert.equal(details(view).length, 0, "returning to a card does not restore an old disclosure");
}));

test("dragging a card or cancelling a touch never toggles it, while native keyboard activation still works", () => withWindow(() => {
  const f = fixture([{ id: "mine", label: "Шахта", content: createElement("span", null, "Шахта"), details: createElement("p", null, "Условия") }]);
  let view = f.view;
  f.track(view).props.onPointerDownCapture({ clientX: 80, clientY: 70 });
  f.track(view).props.onPointerMoveCapture({ clientX: 60, clientY: 70 });
  click(triggers(view)[0], 1); view = f.render();
  assert.equal(details(view).length, 0);
  click(triggers(view)[0], 0); view = f.render();
  assert.equal(details(view).length, 1, "Enter/Space dispatch native button clicks without pointer details");
  f.track(view).props.onPointerDownCapture({ clientX: 80, clientY: 70 });
  f.track(view).props.onPointerCancelCapture();
  click(triggers(view)[0], 1); view = f.render();
  assert.equal(details(view).length, 1);
  f.track(view).props.onPointerDownCapture({ clientX: 80, clientY: 70 });
  f.track(view).props.onPointerMoveCapture({ clientX: 81, clientY: 72 });
  click(triggers(view)[0], 1); view = f.render();
  assert.equal(details(view).length, 0, "a normal tap still toggles after an earlier drag");
  assert.ok(!view.some(node => node.props["aria-label"] === "Следующая возможность"), "one card needs no carousel arrows");
}));
