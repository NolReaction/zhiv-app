import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, cacheDir: `/tmp/boat-side-ui-${process.pid}`,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false, ws: false } });
after(() => vite.close());
const { BoatArt } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-art.tsx");
const { BoatGarage } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-garage.tsx");
const { BoatModuleThumbnail } = await vite.ssrLoadModule("/features/economy/ui/boat/boat-module-thumbnail.tsx");
const { economyCatalog } = await vite.ssrLoadModule("/features/economy/domain/model.ts");
const { newEconomyState } = await vite.ssrLoadModule("/features/economy/domain/rules.ts");
const html = (component, props) => renderToStaticMarkup(createElement(component, props));

test("side-profile BoatArt shows SVG baseline parts with no crate for owned or previewed storage", () => {
  for (const props of [{ repaired: false }, { repaired: true, crate: true }, { repaired: true, previewModule: "crate" }]) {
    const result = html(BoatArt, props);
    assert.match(result, /viewBox="0 185 1000 400"/);
    assert.equal([...result.matchAll(/<image /g)].length, 4);
    assert.doesNotMatch(result, /module-crate|data-boat-part="crate"/);
    assert.match(result, /engine_l0\.svg/); assert.match(result, /tank_l0\.svg/);
    assert.match(result, props.repaired ? /hull_l1\.svg/ : /hull_l0\.svg/);
  }
  const oars = html(BoatArt, { repaired: true, oars: true });
  assert.match(oars, /module-oars\.webp/); assert.doesNotMatch(oars, /engine_l1\.svg/);
  assert.doesNotMatch(oars, /stand-side|data-garage-supports/);
});

test("storage thumbnail uses a capacity symbol without a crate image", () => {
  const result = html(BoatModuleThumbnail, { module: "crate" });
  assert.match(result, /data-boat-capacity-icon/); assert.doesNotMatch(result, /<image|module-crate/);
});

test("garage keeps the storage upgrade rail and bonus but removes its spatial marker and fitting", () => {
  const state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 3, workshopLevel: 3 });
  state.catalog = economyCatalog; state.boat.level = 1;
  const upgrade = economyCatalog.boat.upgrades.find(entry => entry.id === "crate");
  state.boat.work = { id: "00000000-0000-4000-8000-000000000001", upgradeId: "crate", cost: upgrade.cost,
    startedAt: "2026-11-09T15:00:00Z", finishesAt: "2026-11-09T15:15:00Z" };
  const before = structuredClone(state);
  const result = html(BoatGarage, { state, boat: state.boat, config: economyCatalog.boat,
    now: Date.parse("2026-11-09T15:05:00Z"), disabled: false,
    onUpgrade() { assert.fail("Rendering must not spend materials"); }, onClaim() { assert.fail("Rendering must not claim an upgrade"); } });
  assert.match(result, /data-boat-module="crate"/); assert.match(result, />Трюм</);
  assert.match(result, /data-boat-garage-art/);
  assert.equal([...result.matchAll(/href="\/world\/boat-garage\/stand-side\.svg"/g)].length, 2);
  assert.match(result, /Рыбы за один выход/); assert.match(result, />5</);
  assert.doesNotMatch(result, /Выбрать: Трюм|Примерить модуль|module-crate|data-boat-part="crate"/);
  assert.deepEqual(state, before);
});
