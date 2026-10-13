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

test("the coast explains that every caught fish has a class and collection species", () => {
  const html = render("shore");
  stat(html, "Всего рыб", 2);
  assert.match(html, /Не нужна/);
  assert.match(html, /Каждая рыба пополняет запас своего класса/);
  assert.doesNotMatch(html, /Теневая акула|легендарн|<select/);
});

test("the shore camp rolls every fish and consumes one bait for the whole trip", () => {
  const fishing = { ...economyFishingSchema.parse(undefined), equippedBaitId: economyCatalog.fishing.baits[0].itemId };
  const before = structuredClone(fishing);
  const html = render("shore_camp", { fishing });
  stat(html, "Всего рыб", 8);
  assert.match(withoutIcons(html), /<dt>Наживки за поход<\/dt><dd>1 <span>шт\.<\/span><\/dd>/);
  assert.deepEqual(fishing, before);
});

test("player summary follows the supplied catalog instead of fixed values from the default catalog", () => {
  const catalog = structuredClone(economyCatalog);
  catalog.explorations.find(route => route.id === "shore").rewards.fish_common = 4;
  catalog.fishing.collectionDrawsByRoute.shore = 4;
  const html = render("shore", { catalog });
  stat(html, "Всего рыб", 4);
});

test("non-fishing routes and legacy catalogs cannot display a fishing promise", () => {
  assert.equal(render("deep_cave"), "");
  const catalog = structuredClone(economyCatalog);
  delete catalog.fishing;
  assert.equal(render("shore", { catalog }), "");
});
