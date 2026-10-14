import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hookModule = "virtual:progression-economy-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{ name: "progression-economy-handlers", enforce: "pre",
    resolveId(id) { if (id === hookModule) return `\0${id}`; },
    load(id) { if (id === `\0${hookModule}`) return `
      let slots = [], cursor = 0;
      export function reset() { slots = []; cursor = 0; }
      export function render() { cursor = 0; }
      export function useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; }
      export function useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; }
      export function useId() { return 'economy-ui-' + cursor++; }
      export function useMemo(factory) { return factory(); }
      export function useCallback(callback) { return callback; }
      export function useEffect() {}
      export function useSyncExternalStore(subscribe, read, server) { return globalThis.window ? read() : server(); }
    `; },
    transform(source, id) {
      if (!/\/features\/progression\/(?:economy-panel|branch-page)\.tsx$/.test(id)) return;
      let code = source.replace('from "react";', `from "${hookModule}";`);
      if (id.endsWith("/economy-panel.tsx")) code += "\nexport { RecipeCalculator, SourceCalculator, ItemDetails };\n";
      return code;
    },
  }],
});
after(() => vite.close());
const { EconomyPanel, RecipeCalculator, SourceCalculator, ItemDetails } = await vite.ssrLoadModule("/features/progression/economy-panel.tsx");
const { BranchPage } = await vite.ssrLoadModule("/features/progression/branch-page.tsx");
const { progressionEconomy: data } = await vite.ssrLoadModule("/features/progression/economy-data.ts");
const hooks = await vite.ssrLoadModule(hookModule);
const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").replaceAll("&gt;", ">");
const item = id => data.items.find(value => value.id === id);
const recipe = id => data.recipes.find(value => value.id === id);
function elements(tree) {
  const result = [];
  const visit = node => { if (isValidElement(node)) { result.push(node); Children.forEach(node.props.children, visit); } };
  visit(tree); return result;
}
function harness(Component, props = {}) {
  hooks.reset();
  return { render() { hooks.render(); return Component(props); } };
}
const field = (tree, label) => {
  const value = elements(tree).find(node => node.props["aria-label"] === label);
  assert.ok(value, label); return value;
};
const listItems = tree => elements(tree).filter(node => node.type === "button" && node.props["data-item-id"]);

function withWindow(hash, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const state = { returnTo: "map", keep: 7 }, writes = [], events = [];
  const window = { location: { pathname: "/branch", search: "?from=test", hash }, history: { state,
    replaceState(value, unused, url) {
      writes.push({ value, url });
      const parsed = new URL(url, "https://fixture.invalid");
      window.location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
    } }, dispatchEvent(event) { events.push(event.type); }, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  try { return run({ window, state, writes, events }); }
  finally { if (previous) Object.defineProperty(globalThis, "window", previous); else delete globalThis.window; }
}

test("branch tabs connect their panels and retain the full economy catalog in server markup", () => {
  const tree = harness(BranchPage).render(), nodes = elements(tree);
  const tabs = nodes.filter(node => node.props.role === "tab"), panels = nodes.filter(node => node.props.role === "tabpanel");
  assert.deepEqual(tabs.map(node => node.props["data-branch-tab"]), ["world", "economy"]);
  assert.deepEqual(tabs.map(node => [node.props["aria-selected"], node.props.tabIndex]), [[true, 0], [false, -1]]);
  assert.deepEqual(panels.map(node => node.props.hidden), [false, true]);
  for (const tab of tabs) {
    const panel = panels.find(node => node.props.id === tab.props["aria-controls"]);
    assert.ok(panel); assert.equal(panel.props["aria-labelledby"], tab.props.id);
  }
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Ингредиенты и расчёты/);
  assert.equal((html.match(/data-item-id=/g) ?? []).length, 56);
  assert.match(html, /Рецептов<\/dt><dd>39/);
  assert.doesNotMatch(html, /\b(?:NaN|Infinity|undefined)\b/);
});

test("economy tab links preserve path, query and history ownership and initialize from deep links", () => {
  withWindow("#economy-ingredients", ({ window, state, writes, events }) => {
    const h = harness(BranchPage); let tree = h.render();
    assert.equal(tree.props["data-view"], "economy");
    const tabs = elements(tree).filter(node => node.props.role === "tab");
    assert.deepEqual(tabs.map(node => node.props["aria-selected"]), [false, true]);
    tabs[0].props.onClick();
    assert.equal(window.location.hash, "#world");
    assert.equal(writes[0].url, "/branch?from=test#world");
    assert.equal(writes[0].value, state);
    assert.deepEqual(events, ["hashchange"]);
    tree = h.render();
    elements(tree).find(node => node.props["data-branch-tab"] === "economy").props.onClick();
    assert.equal(h.render().props["data-view"], "economy");
    assert.equal(writes[1].url, "/branch?from=test#economy");
    assert.equal(writes[1].value, state);
  });
});

test("tab keyboard navigation selects and focuses the matching tab without swallowing ordinary keys", () => {
  withWindow("#world", ({ writes }) => {
    const h = harness(BranchPage), focused = [];
    for (const [key, expected] of [["ArrowRight", "economy"], ["ArrowRight", "world"], ["ArrowLeft", "economy"], ["Home", "world"], ["End", "economy"]]) {
      const nav = field(h.render(), "Представление развития"); let prevented = 0;
      nav.props.onKeyDown({ key, preventDefault() { prevented++; }, currentTarget: { querySelector(selector) {
        assert.equal(selector, `[data-branch-tab="${expected}"]`); return { focus() { focused.push(expected); } };
      } } });
      assert.equal(prevented, 1);
      const tree = h.render(), tabs = elements(tree).filter(node => node.props.role === "tab");
      assert.equal(tree.props["data-view"], expected);
      assert.equal(tabs.find(tab => tab.props["data-branch-tab"] === expected).props.tabIndex, 0);
      assert.equal(tabs.filter(tab => tab.props.tabIndex === 0).length, 1);
    }
    const count = writes.length;
    field(h.render(), "Представление развития").props.onKeyDown({ key: "Tab", preventDefault() { assert.fail("Tab must retain native focus traversal"); } });
    assert.equal(writes.length, count); assert.equal(focused.length, 5);
  });
});

test("ingredient browser contains every real item, filters without changing prices, and can recover an empty search", () => {
  const h = harness(EconomyPanel); let tree = h.render();
  assert.deepEqual(new Set(listItems(tree).map(node => node.props["data-item-id"])), new Set(data.items.map(value => value.id)));
  assert.equal(listItems(tree).filter(node => node.props["aria-pressed"]).length, 1);
  field(tree, "Найти ингредиент").props.onChange({ target: { value: "балка" } });
  tree = h.render(); assert.deepEqual(listItems(tree).map(node => node.props["data-item-id"]), ["beams"]);
  assert.equal(elements(tree).find(node => node.type === ItemDetails).props.item.npcSellPrice, 600);
  field(tree, "Уровень дома для справочника").props.onChange({ target: { value: "1" } });
  assert.equal(listItems(h.render()).length, 0);
  field(h.render(), "Найти ингредиент").props.onChange({ target: { value: "неизвестный ингредиент" } });
  const empty = renderToStaticMarkup(h.render()); assert.match(empty, /Ничего не найдено/); assert.doesNotMatch(empty, /data-economy-item=/);
  field(h.render(), "Найти ингредиент").props.onChange({ target: { value: "" } });
  field(h.render(), "Уровень дома для справочника").props.onChange({ target: { value: "0" } });
  field(h.render(), "Категория ингредиентов").props.onChange({ target: { value: "special" } });
  tree = h.render(); assert.deepEqual(new Set(listItems(tree).map(node => node.props["data-item-id"])), new Set(["ancient_core", "living_resin", "moon_crystal"]));
  elements(tree).find(node => node.type === ItemDetails).props.onSelect("fiber");
  tree = h.render(); assert.equal(listItems(tree).length, 56); assert.equal(elements(tree).find(node => node.type === ItemDetails).props.item.id, "fiber");
  assert.equal(field(tree, "Категория ингредиентов").props.value, "all");
});

test("search matches word beginnings and item IDs while ignoring case and ё without matching the middle of Рыбалка", () => {
  const h = harness(EconomyPanel);
  for (const [query, expected] of [["БАЛКА", ["beams"]], ["веревка", ["rope"]], ["fish_soup", ["fish_soup"]]]) {
    field(h.render(), "Найти ингредиент").props.onChange({ target: { value: query } });
    assert.deepEqual(listItems(h.render()).map(node => node.props["data-item-id"]), expected);
  }
  field(h.render(), "Найти ингредиент").props.onChange({ target: { value: "малин" } });
  assert.deepEqual(new Set(listItems(h.render()).map(node => node.props["data-item-id"])), new Set(["berries", "berry_compote"]));
});

test("selecting an item on a narrow view scrolls to its detail after the frame; wide view keeps native scrolling", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    for (const narrow of [true, false]) withWindow("#economy", ({ window }) => {
      const frames = [], scrolls = [];
      window.matchMedia = query => { assert.equal(query, "(max-width: 780px)"); return { matches: narrow }; };
      window.requestAnimationFrame = callback => frames.push(callback);
      Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById(id) {
        assert.equal(id, "economy-item-details"); return { scrollIntoView(options) { scrolls.push(options); } };
      } } });
      const h = harness(EconomyPanel);
      listItems(h.render()).find(node => node.props["data-item-id"] === "beams").props.onClick();
      assert.equal(elements(h.render()).find(node => node.type === ItemDetails).props.item.id, "beams");
      assert.deepEqual(scrolls, []);
      assert.equal(frames.length, narrow ? 1 : 0);
      frames.forEach(callback => callback());
      assert.deepEqual(scrolls, narrow ? [{ block: "start" }] : []);
    });
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
});

test("following an ingredient clears filters then scrolls and focuses the new keyed card after rerender", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try { withWindow("#economy", ({ window }) => {
    const frames = [], lookups = [], calls = [];
    window.requestAnimationFrame = callback => frames.push(callback);
    let currentCard = { itemId: "wood", scrollIntoView() { assert.fail("the old card must not be scrolled"); }, focus() { assert.fail("the removed card must not retain focus"); } };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById(id) {
      lookups.push([id, currentCard.itemId]); return currentCard;
    } } });
    const h = harness(EconomyPanel);
    field(h.render(), "Категория ингредиентов").props.onChange({ target: { value: "material" } });
    field(h.render(), "Уровень дома для справочника").props.onChange({ target: { value: "1" } });
    field(h.render(), "Найти ингредиент").props.onChange({ target: { value: "бревно" } });
    const tree = h.render(), detail = elements(tree).find(node => node.type === ItemDetails);
    assert.equal(detail.props.item.id, "wood");
    const library = elements(tree).find(node => node.props.id === "economy-ingredients");
    library.props.ref.current = { scrollIntoView() { assert.fail("navigation should reveal the card rather than the filters"); } };
    const oldCard = ItemDetails(detail.props);
    const link = elements(oldCard).find(node => node.type === "button" && text(renderToStaticMarkup(node)).includes("Распилить доску"));
    assert.ok(link); link.props.onClick();
    assert.equal(frames.length, 1); assert.deepEqual(lookups, []); assert.deepEqual(calls, []);
    const updated = h.render();
    assert.equal(elements(updated).find(node => node.type === ItemDetails).props.item.id, "planks");
    assert.equal(field(updated, "Найти ингредиент").props.value, "");
    assert.equal(field(updated, "Категория ингредиентов").props.value, "all");
    assert.equal(field(updated, "Уровень дома для справочника").props.value, 0);
    assert.equal(listItems(updated).length, 56);
    currentCard = { itemId: "planks", scrollIntoView(options) { calls.push(["scroll", options]); }, focus(options) { calls.push(["focus", options]); } };
    frames[0]();
    assert.deepEqual(lookups, [["economy-item-details", "planks"]]);
    assert.deepEqual(calls, [["scroll", { block: "start" }], ["focus", { preventScroll: true }]]);
  }); } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
});

test("selected sources and uses navigate to the actual ingredient while fish records keep their inventory class", () => {
  const calls = [], h = harness(ItemDetails, { item: item("wood"), home: 0, onSelect(id) { calls.push(id); } });
  const tree = h.render(), next = elements(tree).find(node => node.type === "button" && text(renderToStaticMarkup(node)).includes("Распилить доску"));
  assert.ok(next); next.props.onClick(); assert.deepEqual(calls, ["planks"]);
  const fish = harness(ItemDetails, { item: item("fish_mooncarp"), home: 0, onSelect(id) { calls.push(id); } }).render();
  assert.match(text(renderToStaticMarkup(fish)), /Вид рыбы.*В рецептах учитывается как/);
  const inventory = elements(fish).find(node => node.type === "button" && node.props.children === item("fish_mooncarp").inventoryItemId);
  const conversion = inventory ?? elements(fish).find(node => node.type === "button" && node.props.children === item(item("fish_mooncarp").inventoryItemId).name);
  assert.ok(conversion); conversion.props.onClick(); assert.equal(calls.at(-1), "fish_rare");
});

test("calculate from a source explicitly scrolls and focuses the selected recipe", () => {
  const h = harness(ItemDetails, { item: item("wood"), home: 0, onSelect() {} }), tree = h.render(), calls = [];
  const section = elements(tree).find(node => node.type === "section" && node.props.ref && node.props.tabIndex === -1);
  assert.ok(section);
  section.props.ref.current = { scrollIntoView(options) { calls.push(["scroll", options]); }, focus(options) { calls.push(["focus", options]); } };
  const calculate = elements(tree).find(node => node.type === "button" && text(renderToStaticMarkup(node)).includes("Рассчитать"));
  assert.ok(calculate); calculate.props.onClick();
  assert.deepEqual(calls, [["scroll", { block: "start" }], ["focus", { preventScroll: true }]]);
  assert.equal(elements(h.render()).find(node => node.type === RecipeCalculator).props.recipe.id, "gather_wood");
});

test("every current recipe is reachable from its item and choosing a variant supplies that exact calculation", () => {
  const reachable = new Set();
  for (const value of data.items) {
    const h = harness(ItemDetails, { item: value, home: 0, onSelect() {} });
    const select = elements(h.render()).find(node => node.props["aria-label"] === "Вариант рецепта");
    if (!select) continue;
    for (const option of elements(select).filter(node => node.type === "option")) {
      reachable.add(option.props.value);
      select.props.onChange({ target: { value: option.props.value } });
      const calculator = elements(h.render()).find(node => node.type === RecipeCalculator);
      assert.ok(calculator); assert.equal(calculator.props.recipe.id, option.props.value);
      assert.equal(calculator.key, option.props.value, "changing recipe resets the quantity calculator through its React key");
    }
  }
  assert.equal(reachable.size, 39);
  assert.deepEqual(reachable, new Set(data.recipes.map(value => value.id)));
});

test("two beams show exact NPC value added, expanded raw inputs and separate production queues", () => {
  const h = harness(RecipeCalculator, { recipe: recipe("make_beams"), onSelect() {} });
  field(h.render(), "Количество готовых предметов").props.onChange({ target: { value: "2" } });
  const html = renderToStaticMarkup(h.render()), value = text(html);
  assert.match(value, /Стоимость ингредиентов у NPC 860 монет/);
  assert.match(value, /Выкуп готового товара NPC 1 200 монет/);
  assert.match(value, /Прирост стоимости переработки \+340 монет/);
  assert.match(value, /Таймер выбранного производства 2 ч/);
  assert.match(value, /Крепкое бревно ×8/); assert.match(value, /Растительное волокно ×4/);
  assert.match(value, /Верстак 2 ч 6 мин/);
  assert.match(value, /Лесозаготовки 1 ч 24 мин/);
  assert.match(value, /не длительность прохождения/);
  assert.match(value, /Один запуск занимает одно место; следующий запускается вручную/);
});

test("soup quantity scales sale and intermediate inputs without inventing fishing time or hiding collection", () => {
  const h = harness(RecipeCalculator, { recipe: recipe("cook_fish_soup"), onSelect() {} });
  field(h.render(), "Количество готовых предметов").props.onChange({ target: { value: "3" } });
  const value = text(renderToStaticMarkup(h.render()));
  assert.match(value, /Стоимость ингредиентов у NPC 420 монет/);
  assert.match(value, /Выкуп готового товара NPC 660 монет/);
  assert.match(value, /Прирост стоимости переработки \+240 монет/);
  assert.match(value, /Таймер выбранного производства 1 ч 30 мин/);
  assert.match(value, /Обычная рыба ×6/); assert.match(value, /Малина ×3/); assert.match(value, /Бревно ×3/);
  assert.match(value, /Ягодный куст 3 мин \+ 24 с сбора/);
  assert.match(value, /Отдельно получить: Обычная рыба/);
  assert.match(value, /Время случайного улова или находки не подставляется/);
  assert.match(value, /2 предметов · 440 монет за час/);
  assert.match(value, /это валовая выручка/);
});

test("stone defaults to unit mining and ten stones require ten jobs, thirty minutes and 400 NPC coins", () => {
  const detail = harness(ItemDetails, { item: item("stone"), home: 0, onSelect() {} }).render();
  const calculator = elements(detail).find(node => node.type === SourceCalculator);
  assert.ok(calculator); assert.equal(calculator.props.source.routeId, "quarry_stone");
  assert.equal(calculator.props.targetId, "stone");
  const h = harness(SourceCalculator, calculator.props);
  field(h.render(), "Нужное количество материала").props.onChange({ target: { value: "10" } });
  const value = text(renderToStaticMarkup(h.render()));
  assert.match(value, /Цель: Камень ×10\. Запусков маршрута: 10/);
  assert.match(value, /весь гарантированный набор: Камень ×10/);
  assert.match(value, /Очередь выбранного маршрута 30 мин/);
  assert.match(value, /Стоимость затрат у NPC 0 монет/);
  assert.match(value, /Выкуп гарантированного набора NPC 400 монет/);
  assert.match(value, /Прирост стоимости \+400 монет/);
  for (const quantity of ["0", "2.5", "1000"]) {
    field(h.render(), "Нужное количество материала").props.onChange({ target: { value: quantity } });
    const tree = h.render(), html = renderToStaticMarkup(tree);
    assert.equal(field(tree, "Нужное количество материала").props["aria-invalid"], true);
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /Выкуп гарантированного набора NPC|NaN|Infinity/);
  }
});

test("thirty-one stones from the deep cave round up to two full routes and retain every guaranteed output and cost", () => {
  const source = item("stone").sources.find(value => value.routeId === "deep_cave");
  assert.ok(source);
  const detail = harness(ItemDetails, { item: item("stone"), home: 3, onSelect() {} });
  field(detail.render(), "Маршрут добычи").props.onChange({ target: { value: source.id } });
  const calculator = elements(detail.render()).find(node => node.type === SourceCalculator);
  assert.ok(calculator); assert.equal(calculator.props.source.routeId, "deep_cave");
  assert.equal(calculator.key, source.id);
  const h = harness(SourceCalculator, calculator.props);
  field(h.render(), "Нужное количество материала").props.onChange({ target: { value: "31" } });
  const html = renderToStaticMarkup(h.render()), value = text(html);
  assert.match(value, /Цель: Камень ×31\. Запусков маршрута: 2/);
  assert.match(value, /Камень ×60 Железная руда ×30/);
  assert.match(value, /Потребуется Сушёные ягоды ×2 Копчёная рыба ×2/);
  assert.match(value, /Очередь выбранного маршрута 8 ч/);
  assert.match(value, /Стоимость затрат у NPC 500 монет/);
  assert.match(value, /Выкуп гарантированного набора NPC 4 200 монет/);
  assert.match(value, /Прирост стоимости \+3 700 монет/);
  assert.deepEqual(new Set([...html.matchAll(/data-item-icon="([^"]+)"/g)].map(match => match[1])), new Set(["stone", "ore", "dried_berries", "smoked_fish"]));
  assert.match(value, /Случайные находки и улов не прибавлены/);
});

test("invalid quantities suppress calculations and recover with valid integral input", () => {
  const h = harness(RecipeCalculator, { recipe: recipe("make_beams"), onSelect() {} });
  for (const quantity of ["", "0", "-1", "1.5", "1000", "abc"]) {
    field(h.render(), "Количество готовых предметов").props.onChange({ target: { value: quantity } });
    const tree = h.render(), html = renderToStaticMarkup(tree);
    assert.equal(field(tree, "Количество готовых предметов").props["aria-invalid"], true);
    assert.match(html, /role="alert"/); assert.match(html, /Введите целое количество от 1 до 999/);
    assert.doesNotMatch(html, /Выкуп готового товара NPC|Вся цепочка до сырья|NaN|Infinity/);
  }
  field(h.render(), "Количество готовых предметов").props.onChange({ target: { value: "1" } });
  assert.match(text(renderToStaticMarkup(h.render())), /Выкуп готового товара NPC 600 монет/);
});

test("stage and pearl summaries distinguish guaranteed project gates from chance rewards and optional warehouse", () => {
  const value = text(renderToStaticMarkup(harness(EconomyPanel).render()));
  assert.match(value, /Всего обязательного ожидания: 7 дн\.; затем стройка дома 1 дн\./);
  assert.match(value, /Жемчуг не сокращает интервалы поставок/);
  assert.match(value, /Гарантированная награда за весь проект Живая смола ×1/);
  assert.match(value, /49 шаблонов · 3 активные карточки/);
  assert.match(value, /5 бесплатных мест, максимум 10/);
  assert.match(value, /Все расширения вместе: 680 жемчужин/);
  assert.match(value, /Ускорение стройки: 1 жемчужина за начатые 10 мин/);
  assert.match(value, /Предварительный баланс/);
  assert.match(value, /Кладовая не входит в обязательные стройки/);
  assert.match(value, /Старт \+ вводные заказы − стройки: 100 \+ 330 − 380 = 50 монет/);
});

test("inactive panels are actually hidden and narrow layouts have explicit single-column scroll containment", () => {
  const branch = readFileSync(new URL("../features/progression/branch-page.module.css", import.meta.url), "utf8");
  const economy = readFileSync(new URL("../features/progression/economy-panel.module.css", import.meta.url), "utf8");
  assert.match(branch, /\.viewPanel\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(economy, /\.panel\s*\{[^}]*overflow:\s*auto/);
  assert.match(economy, /@media\s*\(max-width:\s*780px\)/);
  assert.match(economy, /\.stageGrid,\s*\.pearlGrid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
