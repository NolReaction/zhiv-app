import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const hooksId = "virtual:currency-shop-preview-copy-hooks";
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: "currency-shop-preview-copy", enforce: "pre",
    resolveId(id) { if (id === hooksId) return `\0${id}`; },
    load(id) {
      if (id === `\0${hooksId}`) return `
        export const useState = () => ['gold', () => {}];
        export const useRef = initial => ({ current: initial });
        export const useId = () => 'shop-preview-copy';
      `;
    },
    transform(source, id) {
      if (id.endsWith("/features/economy/ui/market/currency-shop-panel.tsx")) {
        return source.replace('from "react";', `from "${hooksId}";`);
      }
    },
  }],
});
after(() => vite.close());
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const shop = await vite.ssrLoadModule("/features/economy/domain/currency-shop.ts");
const { CurrencyShopPanel } = await vite.ssrLoadModule("/features/economy/ui/market/currency-shop-panel.tsx");
const { worldHelpTopics } = await vite.ssrLoadModule("/features/world/ui/help/world-help-content.ts");
const { formatPearls } = await vite.ssrLoadModule("/features/economy/domain/money.ts");

test("gold preview explains the current production bonus and has no exchange action", () => {
  const state = { catalog: economyCatalog, buildings: { home: 3, workshop: 3, garden: 2, woodlot: 2,
    warehouse: 10, bridge: 1, lighthouse: 1 }, jobs: [] };
  const tree = CurrencyShopPanel({ state });
  const html = renderToStaticMarkup(tree);
  assert.ok(html.includes(`За дом: +${shop.HOME_BONUS_PERCENT.join(" / ")}%`));
  assert.ok(html.includes(`ещё до +${shop.MAX_BUILDING_BONUS_PERCENT}%`));
  assert.match(html, /Производства/);
  assert.match(html, /Сейчас 7 из 30/);
  assert.match(html, /Кладовая, мост и маяк бонус не увеличивают/);
  assert.doesNotMatch(html, /остальных построек|до \+100%|600%/);
  assert.match(html, /Покупки и обмен пока недоступны/);
  const actions = [];
  function visit(element) {
    if (!isValidElement(element)) return;
    if (element.type === "button" && element.props.role !== "tab") actions.push(element);
    Children.forEach(element.props.children, visit);
  }
  visit(tree);
  assert.equal(actions.length, shop.GOLD_SHOP_PACKAGES.length);
  for (const action of actions) {
    assert.equal(action.props.disabled, true);
    assert.equal(action.props.onClick, undefined);
    assert.equal(action.props.formAction, undefined);
  }
});

test("shop help gives the same current unit ratio, costs and completed-production terms", () => {
  const topic = worldHelpTopics().find(entry => entry.id === "currency-shop-exchange");
  assert.ok(topic);
  const answer = [...topic.paragraphs ?? [], ...topic.steps ?? [], topic.note ?? ""].join(" ");
  assert.ok(answer.includes(shop.GOLD_SHOP_PACKAGES.map(pack => formatPearls(pack.pearls)).join(" / ")));
  assert.ok(answer.includes(`${shop.BASE_COINS_PER_PEARL * 2} монет за видимую жемчужину`));
  assert.ok(answer.includes(`+${shop.HOME_BONUS_PERCENT.join(" / ")}%`));
  assert.ok(answer.includes(`до +${shop.MAX_BUILDING_BONUS_PERCENT}%`));
  assert.match(answer, /Кладовая, мост, маяк и стройка до получения результата курс не увеличивают/);
  assert.match(answer, /Обмен пока недоступен/);
  assert.ok(answer.length <= 900);
});
