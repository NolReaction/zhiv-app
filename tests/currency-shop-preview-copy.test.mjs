import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
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

test("gold offers show totals and bonuses without service mathematics or enabled cash purchases", () => {
  const state = { catalog: economyCatalog, buildings: { home: 3 }, jobs: [] };
  const html = renderToStaticMarkup(CurrencyShopPanel({ state }));
  assert.match(html, /Включая \+250 бонусом \(10%\)/);
  assert.match(html, /Включая \+1 000 бонусом \(20%\)/);
  assert.doesNotMatch(html, /пяти минут|базовой работы|Одинаковый курс|Обмен скоро|₽/);
  assert.equal((html.match(/data-shop-offer=/g) ?? []).length, shop.GOLD_SHOP_PACKAGES.length);
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*aria-label="Обменять/g) ?? []).length, 3, "missing controller cannot exchange");
});

test("shop help describes the active exchange and matching visible package sizes", () => {
  const topic = worldHelpTopics().find(entry => entry.id === "currency-shop-exchange");
  const answer = [...topic.paragraphs ?? [], ...topic.steps ?? [], topic.note ?? ""].join(" ");
  for (const pack of shop.GOLD_SHOP_PACKAGES) assert.ok(answer.includes(formatPearls(pack.pearls)));
  assert.doesNotMatch(answer, /Обмен пока недоступен|пяти минут|базовой работы/);
  assert.match(answer, /подтверд|Подтверд/);
  assert.ok(answer.length <= 1100);
});
