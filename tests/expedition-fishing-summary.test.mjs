import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { economyCatalog, economyFishingSchema } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { ExpeditionFishingSummary } = await vite.ssrLoadModule("/features/economy/ui/fishing/expedition-fishing-summary.tsx");
const render = (routeId, { catalog = economyCatalog, fishing = economyFishingSchema.parse(undefined) } = {}) => renderToStaticMarkup(createElement(ExpeditionFishingSummary, {
  state: { catalog, fishing }, route: catalog.explorations.find(route => route.id === routeId),
}));
const withoutIcons = html => html.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, "");
const stat = (html, label, value) => assert.ok(withoutIcons(html).includes(`<dt>${label}</dt><dd>${value}</dd>`), `${label}: ${value}`);

test("the coast explains one shared catch: three guaranteed river fish and one special draw", () => {
  const html = render("shore");
  stat(html, "Всего рыб", 4);
  stat(html, "Речных гарантировано", 3);
  stat(html, "Попыток особого улова", 1);
  assert.match(html, /Не нужна/);
  assert.match(html, /Особые попытки входят в общий улов и тоже могут дать речную рыбу/);
  assert.doesNotMatch(html, /Теневая акула|легендарн|<select/);
});

test("the overnight shore camp promises only its guaranteed fish and consumes one bait for the whole trip", () => {
  const fishing = { ...economyFishingSchema.parse(undefined), equippedBaitId: economyCatalog.fishing.baits[0].itemId };
  const before = structuredClone(fishing);
  const html = render("shore_camp", { fishing });
  stat(html, "Всего рыб", 24);
  stat(html, "Речных гарантировано", 18);
  stat(html, "Попыток особого улова", 6);
  assert.match(withoutIcons(html), /<dt>Наживки за поход<\/dt><dd>1 <span>шт\.<\/span><\/dd>/);
  assert.deepEqual(fishing, before);
});

test("player summary follows the supplied catalog instead of fixed values from the default catalog", () => {
  const catalog = structuredClone(economyCatalog);
  catalog.explorations.find(route => route.id === "shore").rewards.fish = 9;
  catalog.fishing.collectionDrawsByRoute.shore = 4;
  const html = render("shore", { catalog });
  stat(html, "Всего рыб", 9);
  stat(html, "Речных гарантировано", 5);
  stat(html, "Попыток особого улова", 4);
});

test("non-fishing routes and legacy catalogs cannot display a fishing promise", () => {
  assert.equal(render("deep_cave"), "");
  const catalog = structuredClone(economyCatalog);
  delete catalog.fishing;
  assert.equal(render("shore", { catalog }), "");
});
